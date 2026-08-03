/**
 * 持久定时任务的调度核心（Durable Tasks，AUT-101）——**headless，不依赖 Vue**。
 *
 * ## 为什么调度器必须活在主进程、且不依赖任何窗口
 *
 * 用户关掉窗口，任务还得跑。因此调度状态全在 sqlite（`task-store`），推进逻辑
 * 全在主进程；渲染进程只是这份状态的一个观察者，它在不在都不影响任务是否触发。
 * 本文件因此**不 import 任何 renderer / Vue / BrowserWindow**——它只依赖时钟、
 * 存储、触发接口三样，全部可注入。
 *
 * ## 全部时序都经可注入时钟，因此 DST / 回拨 / 错过 / sleep-wake 都测得了
 *
 * `tick(now)` 是唯一的推进入口，`now` 由调用方给（生产是 `setInterval` 喂
 * `clock.now()`，单测是 `ManualClock`）。把「现在几点」变成参数之后，「时钟往回
 * 跳一小时」「App 关了三天」这些时序可以在单测里真的制造出来再断言，而不是
 * 只能断言「函数被调用了」。
 *
 * ## 四个已知坑的落地
 *
 *   - **idempotency**：每个墙钟槽位一个 key，`task-store` 的 UNIQUE 约束保证
 *     同一槽位的第二次尝试建不出 run —— 非幂等 action 不被重复执行。
 *   - **lease**：run 一开跑就占一个带过期时间的 lease；崩溃后重启，过期 lease
 *     的孤儿 run 被 `recover()` 判死（crash recovery）。
 *   - **misfire policy**：错过的运行按用户选的 skip / run-once / catch-up 处理
 *     （`planMisfire`）。
 *   - **并发策略**：allow / forbid / queue，据 `hasActiveRun` 判断。
 */
import type { CapabilityGrant, RunInputSnapshot, RunRecord, TaskRecord } from "@pibuddy/contract";
import { randomUUID } from "node:crypto";

import type { Clock } from "./clock.js";
import { planMisfire } from "./misfire.js";
import { computeNextRun } from "./schedule.js";
import { evaluateScheduledPermissions } from "./task-permission.js";
import { agentRunTrigger, type AgentRunTrigger } from "./task-trigger.js";
import type { TaskStore } from "./task-store.js";

/** run 的 lease 有效期：一次 run 正常远小于此；超过即视为孤儿（进程崩了没人收尾）。 */
export const LEASE_TTL_MS = 5 * 60_000;

export interface SchedulerDeps {
  store: TaskStore;
  clock: Clock;
  /** 触发实现（默认注入的 stub，后台池落地时替换） */
  trigger?: () => AgentRunTrigger;
  /** 读某工作区落盘的能力授权表（决策数据源，只读 workspace grants） */
  workspaceGrants: (workspaceId: string) => readonly CapabilityGrant[];
  /** 审计日志（可选，不 import electron 才能被单测直跑） */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

function snapshotOf(task: TaskRecord): RunInputSnapshot {
  return { provider: task.agent.provider, model: task.agent.model, prompt: task.agent.prompt };
}

export class Scheduler {
  /** 本次进程运行的 lease 归属标识；重启即换一个，因此旧进程的 lease 天然过期。 */
  private readonly owner = `sched-${randomUUID().slice(0, 8)}`;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.clock.now();
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.deps.log?.(event, fields);
  }

  private trigger(): AgentRunTrigger {
    return this.deps.trigger ? this.deps.trigger() : agentRunTrigger();
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 启动：先做崩溃恢复，再挂一个周期性 tick。
   *
   * `intervalMs` 是唤醒粒度（生产 30s 足够——分钟级 cron 也只需要每分钟醒一次
   * 之内的精度）。单测不调 start，直接调 tick。
   */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.recover(this.now());
    void this.tick(this.now());
    this.timer = setInterval(() => {
      void this.tick(this.now());
    }, intervalMs);
    // unref：调度器活着是因为 app / 窗口活着，不是因为这个定时器。若一切都退了
    // （app 正在退出），这个定时器不该单独把进程钉住。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ------------------------------------------------------------ 崩溃恢复

  /**
   * 崩溃恢复：把上次进程崩溃时留下的孤儿 run（running/pending 且 lease 过期）
   * 判死。
   *
   * 不盲目重跑——重跑一个「可能已经产生过副作用」的非幂等 run 正是要防的事。
   * 判死为 failed 并留原因；用户可在界面上对它点「重试」（那会走幂等 key 之外
   * 的新 key，是一次**显式**的、他知情的重来）。
   */
  recover(now: number): number {
    const stale = this.deps.store.staleRuns(now);
    for (const run of stale) {
      this.deps.store.updateRun(run.id, {
        status: "failed",
        finishedAt: now,
        error: "进程中断后恢复：该 run 的 lease 已过期，判定为失败（未自动重跑，避免重复副作用）",
        appendLog: "crash-recovery：lease 过期，判死",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
    if (stale.length > 0) this.log("tasks_recover", { count: stale.length, owner: this.owner });
    return stale.length;
  }

  // ------------------------------------------------------------ 主循环

  /** 推进到 now：处理所有 active 任务的到期 / 错过槽位。 */
  async tick(now: number): Promise<void> {
    for (const task of this.deps.store.activeDueTasks()) {
      if (task.nextRunAt === null) continue;
      if (task.nextRunAt > now) continue; // 还没到点
      await this.processTask(task, now);
    }
  }

  /** 处理单个到期任务：按 misfire 策略展开槽位，逐个尝试。 */
  private async processTask(task: TaskRecord, now: number): Promise<void> {
    const anchor = task.nextRunAt;
    if (anchor === null) return;

    const plan = planMisfire({
      schedule: task.schedule,
      timeZone: task.timezone,
      // 排他下界取 nextRunAt-1，使枚举从 nextRunAt 这个槽位本身起。
      sinceMs: anchor - 1,
      now,
      policy: task.misfirePolicy,
    });

    if (plan.dropped > 0) {
      this.log("tasks_misfire_dropped", { taskId: task.id, dropped: plan.dropped });
    }

    for (const slot of plan.dueSlots) {
      await this.fireSlot(task, slot, now);
    }

    // 无论跑没跑，都把 next 推进到 now 之后，绝不停在一个已经过去的槽位上。
    this.deps.store.updateTask(
      task.id,
      {
        nextRunAt: plan.nextAfter,
        lastRunAt: plan.dueSlots.length > 0 ? now : task.lastRunAt,
      },
      now
    );
  }

  /** 触发一个具体槽位的 run（scheduled）。 */
  private async fireSlot(task: TaskRecord, slot: number, now: number): Promise<void> {
    const key = `${task.id}#${slot}`;

    // 并发策略：forbid 时上一次没结束就跳过这一槽（记一条 skipped，标记该槽已处理）。
    if (task.concurrencyPolicy === "forbid" && this.deps.store.hasActiveRun(task.id)) {
      this.recordSkipped(task, slot, key, "并发被禁止：上一次运行尚未结束", now);
      return;
    }

    // 权限预授权判定：只看 workspace 授权，绝不继承交互会话的 allow-once/session。
    const grants = this.deps.workspaceGrants(task.workspaceId);
    const perm = evaluateScheduledPermissions(task.requiredPermissions, task.workspaceId, grants);
    if (!perm.allowed) {
      this.blockAwaitingAuth(task, slot, key, perm.missing, now);
      return;
    }

    const run = this.deps.store.createRun({
      taskId: task.id,
      workspaceId: task.workspaceId,
      scheduledFor: slot,
      idempotencyKey: key,
      attempt: 1,
      input: snapshotOf(task),
      status: "pending",
      now,
    });
    // createRun 返回 null = 该槽位已被处理过（时钟回拨 / 双重触发）——绝不重复执行。
    if (!run) {
      this.log("tasks_idempotent_skip", { taskId: task.id, slot, key });
      return;
    }

    // queue 策略下若已有在跑的，就把这条留作 pending，等下一 tick 再执行。
    if (task.concurrencyPolicy === "queue" && this.deps.store.hasActiveRun(task.id)) {
      this.deps.store.updateRun(run.id, { appendLog: "并发策略 queue：排队等待上一次结束" });
      return;
    }

    await this.executeRun(task, run, now);
  }

  /**
   * 执行一条 run：占 lease → 触发 → 按结果收尾，失败时按策略在同一条 run 上
   * 递增 attempt 重试（backoff 记入日志，不阻塞调度线程——真实退避定时器留给
   * 后台池接线时补，见 task-trigger 的接线说明）。
   */
  private async executeRun(task: TaskRecord, run0: RunRecord, now: number): Promise<void> {
    let run = run0;
    // 本次执行允许的尝试次数（自动重试）。run 的 attempt 从它自己的初始值起算——
    // 手动 retryRun 建的 run 初始 attempt 已是 prev+1，不能被内部循环重置回 1。
    const maxTries = task.failurePolicy.retry ? task.failurePolicy.maxAttempts : 1;
    let attempt = run0.attempt;

    for (let tries = 1; tries <= maxTries; tries++) {
      const startedAt = this.now();
      this.deps.store.updateRun(run.id, {
        status: "running",
        startedAt: run.startedAt ?? startedAt,
        attempt,
        leaseOwner: this.owner,
        leaseExpiresAt: startedAt + LEASE_TTL_MS,
        appendLog: tries === 1 ? "开始执行" : `第 ${attempt} 次尝试（退避 ${task.failurePolicy.backoffMs}ms）`,
      });

      let outcome;
      try {
        outcome = await this.trigger().trigger({
          runId: run.id,
          taskId: task.id,
          workspaceId: task.workspaceId,
          input: run.input,
          timeoutMs: task.timeoutMs,
          budgetUsd: task.budgetUsd,
        });
      } catch (err) {
        outcome = {
          status: "failed" as const,
          sessionId: null,
          artifactIds: [],
          costUsd: null,
          error: (err as Error).message,
          note: "触发实现抛错",
        };
      }

      // 执行期间被取消？（cancelRun 会把状态改成 cancelled）——尊重它，不覆盖。
      const latest = this.deps.store.getRun(run.id);
      if (latest && latest.status === "cancelled") {
        this.log("tasks_run_cancelled_midflight", { runId: run.id });
        return;
      }

      const finishedAt = this.now();
      if (outcome.status === "succeeded") {
        this.deps.store.updateRun(run.id, {
          status: "succeeded",
          finishedAt,
          sessionId: outcome.sessionId,
          artifactIds: outcome.artifactIds,
          costUsd: outcome.costUsd,
          appendLog: outcome.note,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        this.log("tasks_run_succeeded", { runId: run.id, taskId: task.id, attempt });
        return;
      }

      // 失败：还有尝试次数就继续循环（递增 attempt），否则收尾为 failed。
      const isLast = tries >= maxTries;
      this.deps.store.updateRun(run.id, {
        status: isLast ? "failed" : "running",
        finishedAt: isLast ? finishedAt : null,
        error: outcome.error ?? "执行失败",
        appendLog: `${outcome.note}${isLast ? "（已达最大尝试次数）" : "（将重试）"}`,
        leaseOwner: isLast ? null : this.owner,
        leaseExpiresAt: isLast ? null : finishedAt + LEASE_TTL_MS,
      });
      if (isLast) {
        this.log("tasks_run_failed", { runId: run.id, taskId: task.id, attempts: attempt });
        return;
      }
      attempt++;
      run = this.deps.store.requireRun(run.id);
    }
  }

  private recordSkipped(
    task: TaskRecord,
    slot: number,
    key: string,
    reason: string,
    now: number
  ): void {
    const run = this.deps.store.createRun({
      taskId: task.id,
      workspaceId: task.workspaceId,
      scheduledFor: slot,
      idempotencyKey: key,
      attempt: 1,
      input: snapshotOf(task),
      status: "skipped",
      now,
    });
    if (run) {
      this.deps.store.updateRun(run.id, {
        status: "skipped",
        finishedAt: now,
        error: reason,
        appendLog: reason,
      });
      this.log("tasks_run_skipped", { runId: run.id, taskId: task.id, reason });
    }
  }

  private blockAwaitingAuth(
    task: TaskRecord,
    slot: number,
    key: string,
    missing: string[],
    now: number
  ): void {
    const reason = `等待 owner 授权：当前工作区尚未预授权 ${missing.join("、")}`;
    const run = this.deps.store.createRun({
      taskId: task.id,
      workspaceId: task.workspaceId,
      scheduledFor: slot,
      idempotencyKey: key,
      attempt: 1,
      input: snapshotOf(task),
      status: "failed",
      now,
    });
    if (run) {
      this.deps.store.updateRun(run.id, {
        status: "failed",
        finishedAt: now,
        error: reason,
        appendLog: `${reason}（授权后可在此 run 上重试）`,
      });
      this.log("tasks_run_blocked", { runId: run.id, taskId: task.id, missing });
    }
  }

  // ------------------------------------------------------------ 手动操作

  /**
   * 立即触发一次（不改计划）。
   *
   * run-now 的 idempotency key 带时间戳 + 随机段，永远唯一——它是显式的手动
   * 额外触发，不与任何墙钟槽位去重。并发 forbid 不拦 run-now（用户明确点了它）。
   * 权限判定照样走：无预授权的危险任务，run-now 也只会被登记为等待授权。
   */
  async runNow(task: TaskRecord): Promise<RunRecord | null> {
    const now = this.now();
    const key = `${task.id}#run-now#${now}#${randomUUID().slice(0, 6)}`;

    const grants = this.deps.workspaceGrants(task.workspaceId);
    const perm = evaluateScheduledPermissions(task.requiredPermissions, task.workspaceId, grants);
    if (!perm.allowed) {
      this.blockAwaitingAuth(task, now, key, perm.missing, now);
      return this.deps.store.runByIdempotency(key);
    }

    const run = this.deps.store.createRun({
      taskId: task.id,
      workspaceId: task.workspaceId,
      scheduledFor: now,
      idempotencyKey: key,
      attempt: 1,
      input: snapshotOf(task),
      status: "pending",
      now,
    });
    if (!run) return null;
    await this.executeRun(task, run, now);
    return this.deps.store.getRun(run.id);
  }

  /** 取消一条 run（pending / running）。已终结的不动。 */
  cancelRun(runId: string): RunRecord | null {
    const run = this.deps.store.getRun(runId);
    if (!run) return null;
    if (run.status !== "pending" && run.status !== "running") return run;
    return this.deps.store.updateRun(runId, {
      status: "cancelled",
      finishedAt: this.now(),
      error: "已取消",
      appendLog: "用户取消",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /**
   * 重试一条已终结的 run：建一条**新** run（新 idempotency key、attempt+1），
   * 立即执行。这是一次显式的、用户知情的重来，因此不受原槽位去重约束。
   */
  async retryRun(runId: string): Promise<RunRecord | null> {
    const prev = this.deps.store.getRun(runId);
    if (!prev) return null;
    const task = this.deps.store.getTask(prev.taskId);
    if (!task) return null;

    const now = this.now();
    const key = `${task.id}#${prev.scheduledFor}#retry#${randomUUID().slice(0, 6)}`;

    const grants = this.deps.workspaceGrants(task.workspaceId);
    const perm = evaluateScheduledPermissions(task.requiredPermissions, task.workspaceId, grants);
    if (!perm.allowed) {
      this.blockAwaitingAuth(task, prev.scheduledFor, key, perm.missing, now);
      return this.deps.store.runByIdempotency(key);
    }

    const run = this.deps.store.createRun({
      taskId: task.id,
      workspaceId: task.workspaceId,
      scheduledFor: prev.scheduledFor,
      idempotencyKey: key,
      attempt: prev.attempt + 1,
      input: prev.input,
      status: "pending",
      now,
    });
    if (!run) return null;
    await this.executeRun(task, run, now);
    return this.deps.store.getRun(run.id);
  }
}

/** 计算一条任务在某时刻之后的下一次运行（供 create / resume / update 复用）。 */
export function nextRunAfter(task: Pick<TaskRecord, "schedule" | "timezone">, now: number): number | null {
  return computeNextRun(task.schedule, task.timezone, now);
}

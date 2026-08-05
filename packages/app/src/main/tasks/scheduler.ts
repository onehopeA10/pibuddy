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
import {
  resolveToolDispatchVerdict,
  type ToolDispatchBoundary,
  type ToolDispatchLedger,
  type ToolDispatchVerdict,
} from "../tool-recovery/dispatch-guard.js";
import { uncertainOutcomeFromError } from "../tool-recovery/tool-guards.js";

/** run 的 lease 有效期：一次 run 正常远小于此；超过即视为孤儿（进程崩了没人收尾）。 */
export const LEASE_TTL_MS = 5 * 60_000;

/**
 * 工具账本接线（可选）。**不注入时行为与从前一字不差**：孤儿 run 一律判死。
 *
 * 注入之后，触发实现被夹在 T1 / T2 之间，`recover` 因此第一次有了判据去分辨
 * 「压根没跑」与「可能跑过了」—— 前者可以安全自动重跑，后者仍然判死。
 */
export interface SchedulerRecovery {
  /** T1/T2 夹逼（含派发护栏）。 */
  boundary: ToolDispatchBoundary;
  /** 恢复判据要读的账本（只读一个方法）。 */
  ledger: Pick<ToolDispatchLedger, "readLedger">;
}

export interface SchedulerDeps {
  store: TaskStore;
  clock: Clock;
  /** 触发实现（默认注入的 stub，后台池落地时替换） */
  trigger?: () => AgentRunTrigger;
  /** 读某工作区落盘的能力授权表（决策数据源，只读 workspace grants） */
  workspaceGrants: (workspaceId: string) => readonly CapabilityGrant[];
  /** 审计日志（可选，不 import electron 才能被单测直跑） */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** 崩溃恢复账本（可选，见 {@link SchedulerRecovery}） */
  recovery?: SchedulerRecovery;
}

/**
 * 一次 run 的某一次尝试在工具账本里的身份。
 *
 * `invocationId` 钉 run（跨尝试不变，账本的 spine 校验因此成立），
 * `providerToolCallId` 钉尝试次数（每次尝试是一次独立派发，各有各的 T1/T2）。
 * 两者都能在崩溃后从 run 记录上重算出来 —— 这正是 operationId 必须确定性派生
 * 的理由（见 operation-id.ts 文件头）。
 */
function runDispatchIdentity(runId: string, attempt: number): {
  invocationId: string;
  providerToolCallId: string;
} {
  return { invocationId: `task-run:${runId}`, providerToolCallId: `attempt-${attempt}` };
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
   * 崩溃恢复：处理上次进程崩溃时留下的孤儿 run（running/pending 且 lease 过期）。
   *
   * ## 从「一律判死」到「按判据分两半」
   *
   * 从前这里一律判死，注释写着「未自动重跑，避免重复副作用」——保守的一端：
   * 压根没跑的 run 也被误杀，用户得手动重试。接上工具账本之后，「不知道」被
   * 拆成两半（判据全文见 recovery-resolver.ts 文件头）：
   *
   *   - `definitely_not_dispatched`：账本上有协议标记、却没有这次执行的派发
   *     事实。而 T1 严格早于触发实现，所以它**一定没被调用过** —— 自动重跑
   *     不可能产生第二次副作用，可以安全重跑。
   *   - `indeterminate` / `parked` / `corruption`：证据不足以断言「没发生」。
   *     维持判死，并把 resolver 给出的**确切理由**写进 run 的 error 文案 ——
   *     用户据它知道为什么这一条没被自动重试，而不是只看到一句「判定为失败」。
   *
   * 没接账本时（`deps.recovery` 未注入）行为与从前一字不差：全部判死。
   */
  recover(now: number): number {
    const stale = this.deps.store.staleRuns(now);
    const resumable: RunRecord[] = [];
    for (const run of stale) {
      const verdict = this.dispatchVerdict(run);
      if (verdict?.retrySafe) {
        this.deps.store.updateRun(run.id, {
          status: "pending",
          startedAt: null,
          finishedAt: null,
          error: null,
          appendLog: `crash-recovery：${verdict.explain}，自动重跑`,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        resumable.push(run);
        continue;
      }
      // 判死时给出确切理由。没有判据（未接账本 / 读账本失败）时也如实说明，
      // 不假装我们知道。
      const why = verdict?.explain ?? "尚未接入工具账本，无法证明它没有执行过";
      this.deps.store.updateRun(run.id, {
        status: "failed",
        finishedAt: now,
        error: `进程中断后恢复：该 run 的 lease 已过期，判定为失败（未自动重跑，避免重复副作用）——${why}`,
        appendLog: `crash-recovery：lease 过期，判死（${why}）`,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
    if (stale.length > 0) {
      this.log("tasks_recover", {
        count: stale.length,
        resumed: resumable.length,
        owner: this.owner,
      });
    }
    // 可安全重跑的立刻重跑。不 await：recover 是 start() 的同步前置，而一次
    // 重跑要跑多久由触发实现决定，不该把启动挡在这里。
    for (const run of resumable) {
      const task = this.deps.store.getTask(run.taskId);
      const latest = this.deps.store.getRun(run.id);
      if (task && latest) void this.executeRun(task, latest, now);
    }
    return stale.length;
  }

  /**
   * 一条孤儿 run 的恢复判据。未接账本、或账本读不动时返回 null（= 无判据，
   * 走保守分支）。**绝不因为读不到证据就假设它没跑。**
   */
  private dispatchVerdict(run: RunRecord): ToolDispatchVerdict | null {
    const recovery = this.deps.recovery;
    if (!recovery) return null;
    try {
      return resolveToolDispatchVerdict({
        events: recovery.ledger.readLedger(run.workspaceId),
        identity: runDispatchIdentity(run.id, run.attempt),
        dispatchedNotBefore: run.startedAt ?? run.createdAt,
      });
    } catch {
      return null;
    }
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
      // 「不知道有没有生效」独立于「失败」：它禁止自动重试（见 tool-guards）。
      let uncertain = false;
      try {
        outcome = await this.dispatch(task, run, attempt, () =>
          this.trigger().trigger({
            runId: run.id,
            taskId: task.id,
            workspaceId: task.workspaceId,
            input: run.input,
            timeoutMs: task.timeoutMs,
            budgetUsd: task.budgetUsd,
          })
        );
      } catch (err) {
        const unknown = uncertainOutcomeFromError(err);
        uncertain = unknown !== undefined;
        outcome = {
          status: "failed" as const,
          sessionId: null,
          artifactIds: [],
          costUsd: null,
          error: unknown?.detail ?? (err as Error).message,
          note: uncertain ? "结算事实未落地：这次执行的结果不确定，不自动重试" : "触发实现抛错",
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
      // 不确定档一律当作最后一次：`retrySafe:false` 的字面意思就是不许自动重跑。
      const isLast = uncertain || tries >= maxTries;
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

  /**
   * 把一次触发夹进 T1 / T2。
   *
   * 未接账本时**直接调 impl**，与从前逐字一致。接了账本时：T1 先落派发事实，
   * 失败直接抛（异常穿透到 executeRun 的 catch，那次 run 整体失败）——绝不
   * 在这里 catch 成一个「继续往下跑」的分支，那样就会产生一次没有派发事实的
   * 真实副作用，而恢复时它会被判成「没跑过」再跑一遍。
   */
  private dispatch<T>(
    task: TaskRecord,
    run: RunRecord,
    attempt: number,
    impl: () => Promise<T>
  ): Promise<T> {
    const recovery = this.deps.recovery;
    if (!recovery) return impl();
    return recovery.boundary.run(
      {
        workspaceId: task.workspaceId,
        sessionId: `task:${task.id}`,
        ...runDispatchIdentity(run.id, attempt),
        runId: run.id,
        // 同一条 run 的所有尝试共用一条执行脊（账本的 invocation 身份校验要求
        // 同 invocationId 的事实落在同一条 (session, run, turn) 上）。
        turnId: "run",
        toolName: "tasks.run",
        args: {
          taskId: task.id,
          runId: run.id,
          attempt,
          provider: run.input.provider,
          model: run.input.model,
          prompt: run.input.prompt,
        },
      },
      impl
    );
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

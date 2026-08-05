/**
 * home.automation 的域服务：把规则仓库、规则引擎、基座执行口、tasks 投递口
 * 装配成按 workspaceId 分区的一台机器。
 *
 * ## 依赖全部注入
 *
 * 基座动作面（service call / 状态解析 / state_changed 订阅 / 消费者登记）与
 * tasks 动作面（建 / 改 / 删 / 投递 event task）都是窄端口——E2E
 * （test/home-automation-e2e.spec.ts）用假 HA + 真基座服务 + 临时 TaskStore
 * 走完整链，不需要 electron 权限框。生产接线在 automation-ipc.ts。
 *
 * ## 两条执行路（规则 ≠ 特殊 task）
 *
 *   - **确定性动作**（service / notify）：命中即经 `home.callService` 直接
 *     执行——生产实现是基座 HomeAssistantService.executeTool(call_service)，
 *     其内部**每一次**都重过 authorizeLocalEndpoint（授权被撤 → 该次动作
 *     失败且零出站，E2E 对拍钉着这一点）。不为开一盏灯起 Agent run。
 *   - **Agent 动作**：规则保存时落成 tasks 域 `kind:"event"` 的真 task
 *     （tasks.ensureTask），命中时 `tasks.deliver` 投递——权限预授权判定、
 *     幂等 key、池化触发、成本审计全继承 tasks，不重造。
 *
 * ## 状态触发规则 = 一个常驻实体缓存消费者
 *
 * 某工作区存在启用中的状态触发规则时，向基座实体缓存 acquire() 一个消费者
 * （维持 WS 订阅，state_changed 才有得听）；没有了就 release（缓存的引用
 * 计数 / linger 语义不变，本域不开旁路）。
 */
import { randomUUID } from "node:crypto";

import type { AutomationAction, AutomationRule, AutomationRuleSpec } from "@pibuddy/contract";

import type { ToolDispatchBoundary } from "../tool-recovery/dispatch-guard.js";
import {
  RULE_TICK_INTERVAL_MS,
  RuleEngine,
  evaluateCondition,
  type EngineRule,
  type StateEvent,
} from "./rule-engine.js";
import type { AutomationStore, StoredRule } from "./automation-store.js";

/** 基座动作面（生产 = home-ipc 的 homeAssistantService 闭包）。 */
export interface AutomationHomePort {
  /** 确定性动作的执行口；内部每次重过授权，撤权即抛、零出站。 */
  callService(
    workspaceId: string,
    args: { domain: string; service: string; entity_id?: string; data?: Record<string, unknown> }
  ): Promise<void>;
  /** 条件求值的状态解析（读基座缓存，无 WS 时按 TTL 走 REST）。 */
  getStates(
    workspaceId: string,
    entityIds: string[]
  ): Promise<{ id: string; state: string | null }[]>;
  /** 状态触发源（基座实体缓存转发 ha-ws-session 的 state_changed）。 */
  onStateChanged(workspaceId: string, fn: (e: StateEvent) => void): () => void;
  /** 实体缓存消费者登记（维持 WS 订阅）；返回幂等释放函数。 */
  acquireConsumer(workspaceId: string): () => void;
}

/** tasks 动作面（生产 = taskStore + deliverTaskEvent 的薄适配）。 */
export interface AutomationTaskPort {
  /** 为某个 Agent 动作确保一条 kind:"event" 的真 task 存在（建或改），返回 taskId。 */
  ensureTask(input: {
    workspaceId: string;
    ruleId: string;
    ruleName: string;
    prompt: string;
    timezone: string;
    existingTaskId: string | null;
  }): string;
  deleteTask(taskId: string): void;
  /** 投递一次事件（tasks 的 runNow 纪律：权限 / 幂等 / 审计全继承）。 */
  deliver(taskId: string): Promise<void>;
}

export interface AutomationServiceDeps {
  store: AutomationStore;
  home: AutomationHomePort;
  tasks: AutomationTaskPort;
  now?(): number;
  schedule?(fn: () => void, ms: number): () => void;
  /** 引擎对齐 tick 间隔（E2E 压缩用）。 */
  tickIntervalMs?: number;
  log?(event: string, fields: Record<string, unknown>): void;
  /**
   * T1/T2 夹逼（可选）。**不注入时行为一字不变。**
   *
   * 只夹**确定性动作**（service / notify）：开灯、关锁、推通知是真实世界的
   * 副作用，重复执行的代价实实在在。Agent 动作不在这里夹 —— 它落到 tasks 域
   * 的 run 上，那条路自己已经夹过一遍，再套一层只会造出两个互不相干的
   * operation 去描述同一次执行。
   */
  recovery?: ToolDispatchBoundary;
}

interface EngineEntry {
  engine: RuleEngine;
  unsubscribe: () => void;
  releaseConsumer: (() => void) | null;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/** 系统时区（规则未显式给 timezone 时的缺省）。 */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function toPublic(rule: StoredRule): AutomationRule {
  const { agentTaskIds: _internal, ...pub } = rule;
  return pub;
}

export class AutomationService {
  private readonly engines = new Map<string, EngineEntry>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly tickIntervalMs: number;
  /**
   * 一次命中的账本身份前缀：进程实例随机段 + 单调序号。
   *
   * 不用 `(ruleId, slot)`：状态触发的 slot 是毫秒级的 now，同一毫秒内的两次
   * 命中会撞成同一个 operationId，第二次直接被 T1 判成「重复派发」而拒执行 ——
   * 一次本该发生的开灯就这么没了。随机段还挡住了重启后与上一进程撞号。
   * 代价是命中身份不可在崩溃后重算（规则命中不需要：它没有需要与在途调用
   * 对号入座的恢复流程，账本在这里的作用是留下「这盏灯到底开没开」的证据）。
   */
  private readonly fireScope = randomUUID().slice(0, 8);
  private fireSeq = 0;

  constructor(private readonly deps: AutomationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.tickIntervalMs = deps.tickIntervalMs ?? RULE_TICK_INTERVAL_MS;
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.deps.log?.(event, fields);
  }

  // ------------------------------------------------------------ CRUD

  list(workspaceId: string): AutomationRule[] {
    return this.deps.store.listRules(workspaceId).map(toPublic);
  }

  /** 建（id null）或整份替换（id 给定）。返回受影响的规则。 */
  upsert(workspaceId: string, id: string | null, spec: AutomationRuleSpec): AutomationRule {
    const now = this.now();
    const timezone = spec.timezone ?? systemTimezone();
    let rule: StoredRule;
    if (id === null) {
      rule = this.deps.store.createRule(
        {
          workspaceId,
          name: spec.name,
          trigger: spec.trigger,
          condition: spec.condition ?? null,
          actions: [...spec.actions],
          timezone,
        },
        now
      );
    } else {
      const current = this.requireRule(workspaceId, id);
      const updated = this.deps.store.updateRuleSpec(
        current.id,
        {
          name: spec.name,
          trigger: spec.trigger,
          condition: spec.condition ?? null,
          actions: [...spec.actions],
          timezone,
        },
        now
      );
      if (!updated) throw new Error(`AUTOMATION_RULE_UNKNOWN: ${id}`);
      rule = updated;
    }
    this.syncAgentTasks(this.deps.store.getRule(rule.id) ?? rule);
    this.refreshEngine(workspaceId);
    this.log("automation_rule_upserted", { ruleId: rule.id, created: id === null });
    return toPublic(this.deps.store.getRule(rule.id) ?? rule);
  }

  setEnabled(workspaceId: string, id: string, enabled: boolean): AutomationRule {
    this.requireRule(workspaceId, id);
    const rule = this.deps.store.setEnabled(id, enabled, this.now());
    if (!rule) throw new Error(`AUTOMATION_RULE_UNKNOWN: ${id}`);
    this.refreshEngine(workspaceId);
    this.log("automation_rule_toggled", { ruleId: id, enabled });
    return toPublic(rule);
  }

  /** 删除规则 + 它的 Agent 动作 backing task（规则没了，事件永远不会再投递）。 */
  remove(workspaceId: string, id: string): void {
    const rule = this.requireRule(workspaceId, id);
    for (const taskId of Object.values(rule.agentTaskIds)) {
      try {
        this.deps.tasks.deleteTask(taskId);
      } catch {
        /* backing task 已被用户删掉：规则删除照常完成 */
      }
    }
    this.deps.store.deleteRule(id);
    this.refreshEngine(workspaceId);
    this.log("automation_rule_deleted", { ruleId: id });
  }

  private requireRule(workspaceId: string, id: string): StoredRule {
    const rule = this.deps.store.getRule(id);
    if (!rule || rule.workspaceId !== workspaceId) {
      throw new Error(`AUTOMATION_RULE_UNKNOWN: ${id}`);
    }
    return rule;
  }

  // ------------------------------------------------------------ Agent 动作的 task 接线

  /**
   * 保存后同步 Agent 动作 ↔ backing task：新增的建、还在的改（prompt / 名字
   * 跟着规则走）、不再是 Agent 动作的删。索引键 = 动作在 actions 里的下标。
   */
  private syncAgentTasks(rule: StoredRule): void {
    const next: Record<string, string> = {};
    for (const [index, action] of rule.actions.entries()) {
      if (action.kind !== "agent") continue;
      const key = String(index);
      next[key] = this.deps.tasks.ensureTask({
        workspaceId: rule.workspaceId,
        ruleId: rule.id,
        ruleName: rule.name,
        prompt: action.prompt,
        timezone: rule.timezone,
        existingTaskId: rule.agentTaskIds[key] ?? null,
      });
    }
    for (const [key, taskId] of Object.entries(rule.agentTaskIds)) {
      if (next[key] === taskId) continue;
      try {
        this.deps.tasks.deleteTask(taskId);
      } catch {
        /* 已不存在：目标状态一致 */
      }
    }
    this.deps.store.setAgentTaskIds(rule.id, next, this.now());
  }

  // ------------------------------------------------------------ 引擎装配

  /** activate 时把每个有规则的工作区的引擎拉起来（headless：不等面板打开）。 */
  startAll(): void {
    for (const workspaceId of this.deps.store.workspaceIds()) {
      this.refreshEngine(workspaceId);
    }
  }

  /** 该工作区引擎不存在则建，然后重灌规则集并对齐消费者占用。 */
  private refreshEngine(workspaceId: string): void {
    let entry = this.engines.get(workspaceId);
    if (!entry) {
      const engine = new RuleEngine({
        now: this.now,
        schedule: this.schedule,
        fire: (rule, slot, cause) => {
          void this.fireRule(workspaceId, rule.id, slot, cause);
        },
      });
      const unsubscribe = this.deps.home.onStateChanged(workspaceId, (e) =>
        engine.handleStateChanged(e)
      );
      entry = { engine, unsubscribe, releaseConsumer: null };
      this.engines.set(workspaceId, entry);
      engine.start(this.tickIntervalMs);
    }
    entry.engine.setRules(
      this.deps.store.listRules(workspaceId).map(
        (rule): EngineRule => ({
          id: rule.id,
          enabled: rule.enabled,
          trigger: rule.trigger,
          timezone: rule.timezone,
        })
      )
    );
    this.syncConsumer(workspaceId, entry);
  }

  /** 有启用中的状态触发规则 ⇔ 占一个实体缓存消费者（WS 常驻的唯一理由）。 */
  private syncConsumer(workspaceId: string, entry: EngineEntry): void {
    const wanted = entry.engine.hasEnabledStateRules();
    if (wanted && entry.releaseConsumer === null) {
      try {
        entry.releaseConsumer = this.deps.home.acquireConsumer(workspaceId);
      } catch {
        /* 基座未配置 / 未授权：缓存退回纯 REST，状态触发自然收不到事件 */
      }
    } else if (!wanted && entry.releaseConsumer !== null) {
      entry.releaseConsumer();
      entry.releaseConsumer = null;
    }
  }

  /** 仅供单测：直取某工作区引擎（注入时钟推进 tick 用）。 */
  __engine(workspaceId: string): RuleEngine | null {
    return this.engines.get(workspaceId)?.engine ?? null;
  }

  // ------------------------------------------------------------ 命中执行

  /**
   * 一次命中：条件求值（纯函数，状态现解析）→ 逐个执行动作 → 结果落库。
   * 单个动作失败不阻断后续动作；最后一个失败原因记入 lastError。
   * 授权判定不在这里缓存：确定性动作的每一次执行都在 callService 内部
   * 重过三道关（对拍：撤权后命中 → 动作失败且零出站）。
   */
  private async fireRule(
    workspaceId: string,
    ruleId: string,
    slot: number,
    cause: "state" | "time"
  ): Promise<void> {
    const rule = this.deps.store.getRule(ruleId);
    if (!rule || !rule.enabled || rule.workspaceId !== workspaceId) return;
    const now = this.now();

    const condition = rule.condition;
    if (condition !== null) {
      let stateOf: (entityId: string) => string | null = () => null;
      if (condition.kind === "state") {
        const wanted = condition.entityId;
        let resolved: string | null = null;
        try {
          const rows = await this.deps.home.getStates(workspaceId, [wanted]);
          resolved = rows[0]?.state ?? null;
        } catch {
          resolved = null; // 状态取不到 = 未知，条件语义见 evaluateCondition
        }
        stateOf = (entityId) => (entityId === wanted ? resolved : null);
      }
      const pass = evaluateCondition(condition, {
        stateOf,
        nowMs: now,
        timeZone: rule.timezone,
      });
      if (!pass) {
        this.log("automation_condition_blocked", { ruleId, cause });
        return;
      }
    }

    const fireId = `${rule.id}:${slot}:${cause}:${this.fireScope}-${++this.fireSeq}`;
    let lastError: string | null = null;
    for (const [index, action] of rule.actions.entries()) {
      try {
        await this.runAction(workspaceId, rule, index, action, fireId);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log("automation_action_failed", { ruleId, index, detail: lastError });
      }
    }
    this.deps.store.recordFired(ruleId, now, lastError);
    this.log("automation_rule_fired", { ruleId, cause, slot, ok: lastError === null });
  }

  private async runAction(
    workspaceId: string,
    rule: StoredRule,
    index: number,
    action: AutomationAction,
    fireId: string
  ): Promise<void> {
    switch (action.kind) {
      case "service": {
        const args = {
          domain: action.domain,
          service: action.service,
          ...(action.entityId !== undefined ? { entity_id: action.entityId } : {}),
          ...(action.data !== undefined ? { data: action.data } : {}),
        };
        await this.dispatch(workspaceId, rule, index, fireId, "home.automation.service", args, () =>
          this.deps.home.callService(workspaceId, args)
        );
        return;
      }
      case "notify": {
        // 通知也是确定性动作：落成 HA 的 persistent_notification.create，
        // 走与 service 完全同一条受控出站路（同样每次重过授权）。
        const args = {
          domain: "persistent_notification",
          service: "create",
          data: { message: action.message, title: `PiBuddy 自动化：${rule.name}` },
        };
        await this.dispatch(workspaceId, rule, index, fireId, "home.automation.notify", args, () =>
          this.deps.home.callService(workspaceId, args)
        );
        return;
      }
      case "agent": {
        const taskId = rule.agentTaskIds[String(index)];
        if (taskId === undefined) {
          throw new Error("AUTOMATION_AGENT_TASK_MISSING: Agent 动作缺 backing task（请重新保存规则）");
        }
        await this.deps.tasks.deliver(taskId);
        return;
      }
    }
  }

  /**
   * 把一次确定性动作夹进 T1 / T2。未注入账本时直接调 impl（行为一字不变）。
   *
   * T1 失败直接抛：异常穿透到 fireRule 的 per-action catch，那条动作记为失败
   * 并写进 lastError。**这里没有「记一笔然后照样执行」的分支** —— 那样会产生
   * 一次没有派发事实的开灯，而恢复判据会据「没有派发事实」断言它没发生。
   */
  private dispatch<T>(
    workspaceId: string,
    rule: StoredRule,
    index: number,
    fireId: string,
    toolName: string,
    args: unknown,
    impl: () => Promise<T>
  ): Promise<T> {
    const boundary = this.deps.recovery;
    if (!boundary) return impl();
    return boundary.run(
      {
        workspaceId,
        sessionId: `automation:${rule.id}`,
        invocationId: `automation-fire:${fireId}`,
        runId: rule.id,
        // 一次命中的所有动作共用一条执行脊（账本要求同 invocationId 的事实
        // 落在同一条 (session, run, turn) 上）。
        turnId: "fire",
        providerToolCallId: `action-${index}`,
        toolName,
        args,
      },
      impl
    );
  }

  // ------------------------------------------------------------ 拆卸

  /** 全量拆卸（disposeAutomationResources / E2E 收尾）。规则数据不动。 */
  dispose(): void {
    for (const entry of this.engines.values()) {
      entry.engine.stop();
      entry.unsubscribe();
      entry.releaseConsumer?.();
      entry.releaseConsumer = null;
    }
    this.engines.clear();
  }
}

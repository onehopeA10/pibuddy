/**
 * 自动化规则引擎（home.automation / 智能家居 Phase B）——**纯逻辑，可直接对拍**。
 *
 * ## 规则 ≠ 特殊 task：这里只做匹配与对齐，不做执行
 *
 * 引擎回答的问题只有一个：「此刻哪条规则该触发」。触发之后发生什么（条件
 * 求值所需的状态解析、每次执行前重过授权、确定性动作经基座出站、Agent 动作
 * 投递给 tasks 域）全部在注入的 `fire` 回调里，由 automation-service 接线——
 * 引擎因此不 import electron、不 import net/、不碰 sqlite，全部行为在单测里
 * 用假时钟与记录器走真。
 *
 * ## 两类触发源
 *
 *   - **state**：`handleStateChanged` 由接线层挂在实体缓存的 state_changed
 *     订阅上（源头是 ha-ws-session 的 EventEmitter）。引擎自持一张「最近
 *     所见状态」表做 from 匹配与相同状态去重——resync 的全量拉取不产生
 *     事件，所以这张表只被真实增量喂，不会被补拉冲刷出假触发。
 *   - **time**：每日墙钟时间。下一次绝对时刻用 tasks 的纯模块
 *     `schedule.ts`（computeNextRun 的 daily 分支）解出——DST gap / overlap
 *     的策略与定时任务逐字一致，不另立一套。推进靠自持对齐 tick（生产
 *     30s 一醒、unref，经注入的 schedule；单测直接调 `tick(now)`）。
 *
 * ## 轻量规则的 misfire 语义（诚实声明）
 *
 * 时间触发**不补跑**：睡眠 / 关机跨过多个槽位时，tick 醒来只触发一次并把
 * 下一次从「现在」起重算（相当于 tasks 的 run-once 档）；引擎重建（重启 /
 * setRules）时下一次也从「现在」起算，错过的槽位如实丢弃。开一盏灯补跑
 * 三次没有意义；需要完整 misfire 策略的 Agent 动作走 tasks 域的真 task，
 * 那边的 misfire / 预算 / 审计一样不少。
 */
import type { AutomationCondition, AutomationTrigger } from "@pibuddy/contract";

import { computeNextRun, zonedParts } from "../tasks/schedule.js";

/** 生产 tick 间隔：30s 足够分钟级墙钟精度。 */
export const RULE_TICK_INTERVAL_MS = 30_000;

/** 一条进入引擎的规则（执行细节引擎不关心，actions 不在此形状里）。 */
export interface EngineRule {
  id: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** IANA 时区（time 触发解墙钟用） */
  timezone: string;
}

/** 归一化的状态事件（ha-ws-session 的 HaStateChanged 剪影）。 */
export interface StateEvent {
  entityId: string;
  /** 新状态；实体被移除时为 null */
  state: string | null;
}

// ---------------------------------------------------------------- 纯函数

/**
 * state 触发是否命中。
 *
 * `prev` 是引擎所见的上一个状态（从未见过为 null）。相同状态的重复事件
 * （HA 在 attributes 变化时也发 state_changed）不算命中——否则「灯亮时
 * 开壶」会在灯亮期间被每次亮度调节反复触发。`from` 指定时 prev 必须逐字
 * 相等（prev 未知 = 不命中，不猜）。实体移除（state null）不是状态命中。
 */
export function stateTriggerMatches(
  trigger: AutomationTrigger,
  event: StateEvent,
  prev: string | null
): boolean {
  if (trigger.kind !== "state") return false;
  if (trigger.entityId !== event.entityId) return false;
  if (event.state === null) return false;
  if (prev !== null && prev === event.state) return false;
  if (trigger.to !== undefined && event.state !== trigger.to) return false;
  if (trigger.from !== undefined && prev !== trigger.from) return false;
  return true;
}

/** `HH:MM` → 当日分钟数（入参形态已被 WALL_TIME_RE 钉死）。 */
function minutesOf(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * 条件求值（纯函数）。
 *
 *   - state：实体当前状态与 value 的 eq / neq 比较。状态未知（null）时
 *     eq 恒 false、neq 恒 true——「不等于」对未知世界如实成立。
 *   - time_window：nowMs 在时区墙钟下是否落在 [after, before) 窗口内；
 *     after > before 表示跨午夜（22:00–06:00）；after === before 是空窗口。
 */
export function evaluateCondition(
  condition: AutomationCondition,
  ctx: { stateOf(entityId: string): string | null; nowMs: number; timeZone: string }
): boolean {
  switch (condition.kind) {
    case "state": {
      const state = ctx.stateOf(condition.entityId);
      return condition.op === "neq" ? state !== condition.value : state === condition.value;
    }
    case "time_window": {
      const parts = zonedParts(ctx.nowMs, ctx.timeZone);
      const now = parts.hour * 60 + parts.minute;
      const after = minutesOf(condition.after);
      const before = minutesOf(condition.before);
      return after <= before ? now >= after && now < before : now >= after || now < before;
    }
  }
}

/**
 * time 触发的下一次绝对时刻（严格晚于 fromMs）。
 *
 * 直接走 tasks 的 computeNextRun daily 分支：DST gap（2:30 不存在 → 滚到
 * 3:30）与 overlap（1:30 两遍 → 取较早且只算一次）语义因此逐字继承，
 * 对拍见 rule-engine.spec 的 DST 用例。
 */
export function nextTimeFire(
  trigger: AutomationTrigger,
  timeZone: string,
  fromMs: number
): number | null {
  if (trigger.kind !== "time") return null;
  return computeNextRun({ kind: "daily", time: trigger.time }, timeZone, fromMs);
}

// ---------------------------------------------------------------- 引擎

export interface RuleEngineDeps {
  now(): number;
  /** 定时器注入（返回取消函数）；生产为 setTimeout + unref */
  schedule(fn: () => void, ms: number): () => void;
  /**
   * 触发回调（接线层实现：条件求值 → 每次执行前重过授权 → 执行动作）。
   * slot 是命中时刻（time 触发为解出的墙钟槽位 epoch；state 触发为 now）。
   */
  fire(rule: EngineRule, slot: number, cause: "state" | "time"): void;
}

export class RuleEngine {
  private readonly rules = new Map<string, EngineRule>();
  /** time 规则的下一次绝对时刻（enabled 的才有条目）。 */
  private readonly nextFireAt = new Map<string, number>();
  /** 引擎所见的最近状态（from 匹配与相同状态去重用）。 */
  private readonly lastStates = new Map<string, string | null>();
  private cancelTick: (() => void) | null = null;

  constructor(private readonly deps: RuleEngineDeps) {}

  /** 整份替换规则集（CRUD 后由接线层重灌）。time 规则的下一次从现在起算。 */
  setRules(rules: readonly EngineRule[]): void {
    this.rules.clear();
    this.nextFireAt.clear();
    const now = this.deps.now();
    for (const rule of rules) {
      this.rules.set(rule.id, rule);
      if (rule.enabled && rule.trigger.kind === "time") {
        const next = nextTimeFire(rule.trigger, rule.timezone, now);
        if (next !== null) this.nextFireAt.set(rule.id, next);
      }
    }
  }

  /** 是否存在启用中的状态触发规则（接线层据它决定要不要占实体缓存消费者）。 */
  hasEnabledStateRules(): boolean {
    for (const rule of this.rules.values()) {
      if (rule.enabled && rule.trigger.kind === "state") return true;
    }
    return false;
  }

  /** 状态事件入口（接线层挂在实体缓存的 state_changed 订阅上）。 */
  handleStateChanged(event: StateEvent): void {
    const prev = this.lastStates.get(event.entityId) ?? null;
    this.lastStates.set(event.entityId, event.state);
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (stateTriggerMatches(rule.trigger, event, prev)) {
        this.deps.fire(rule, this.deps.now(), "state");
      }
    }
  }

  /**
   * 时钟推进入口（唯一）。到点的 time 规则触发一次，下一次从 now 重算——
   * 跨多个槽位的错过因此只触发一次（见文件头的 misfire 语义声明）。
   */
  tick(now: number): void {
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.trigger.kind !== "time") continue;
      const due = this.nextFireAt.get(rule.id);
      if (due === undefined || due > now) continue;
      this.deps.fire(rule, due, "time");
      const next = nextTimeFire(rule.trigger, rule.timezone, now);
      if (next === null) this.nextFireAt.delete(rule.id);
      else this.nextFireAt.set(rule.id, next);
    }
  }

  /** 自持对齐 tick（生产 30s、unref 经注入 schedule）。幂等。 */
  start(intervalMs = RULE_TICK_INTERVAL_MS): void {
    if (this.cancelTick) return;
    const loop = (): void => {
      this.cancelTick = this.deps.schedule(() => {
        this.tick(this.deps.now());
        loop();
      }, intervalMs);
    };
    loop();
  }

  /** 幂等拆卸：取消 tick。 */
  stop(): void {
    if (this.cancelTick) {
      this.cancelTick();
      this.cancelTick = null;
    }
  }

  /** 仅供单测：某条 time 规则当前排定的下一次。 */
  __nextFireAt(ruleId: string): number | null {
    return this.nextFireAt.get(ruleId) ?? null;
  }
}

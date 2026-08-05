/**
 * 「触发一次 Agent run」的接线点（可注入）。
 *
 * ## 为什么是一个接口而不是直接调用
 *
 * 触发 Agent run 的机制现在归**后台池 agent**在改（`main/agent-pool/**` /
 * `pi-supervisor` / `event-forwarder`——都在硬边界之外，本批不碰）。本批把
 * 「触发」抽成一个窄接口：scheduler 只依赖 `AgentRunTrigger`，默认注入一个
 * 如实标注的 stub。将来后台池落地时，只替换这**一个**注入实现即可，scheduler
 * 一行不用动。
 *
 * ## 将来怎么接后台池（记在这里，免得下一个人重新摸）
 *
 * 后台池就绪后，实现一个 `AgentRunTrigger`：拿 `ctx.input`（冻结的 provider /
 * model / prompt）向后台池申请一个无人值守会话，把返回的 sessionId 回填，
 * 跑完后据其结果 / 费用 / 产物填 `TriggerOutcome`。超时与预算由 `ctx` 传入，
 * 由触发实现（或后台池）执行。**在此之前绝不用交互会话的 pi:prompt 去驱动**——
 * 那会把一个无人值守任务塞进用户当前正在看的会话里。
 */
import type { RunInputSnapshot } from "@pibuddy/contract";

export interface TriggerContext {
  runId: string;
  taskId: string;
  workspaceId: string;
  /** 触发时冻结的输入（provider / model / prompt） */
  input: RunInputSnapshot;
  /** 单次超时（ms）；null=不限 */
  timeoutMs: number | null;
  /** 预算上限（美元）；null=不限 */
  budgetUsd: number | null;
}

export interface TriggerOutcome {
  status: "succeeded" | "failed";
  /** Agent 会话 id；stub 下为 null */
  sessionId: string | null;
  artifactIds: string[];
  costUsd: number | null;
  error: string | null;
  /** 追加到 run 日志的一行说明 */
  note: string;
  /**
   * 本次尝试**是否已经产生了用户可见的输出**（assistant 消息 / 产物）。
   *
   * 调度器的重试判据要它（`shouldRetryProviderFailure` 的四条合取前置条件之一）：
   * 一次已经吐过字的尝试再重试，用户在会话里看到的是同一段话被说了两遍。
   *
   * `sessionId` 不能代替它 —— 会话被派生出来只说明「有个壳」，还没说过任何话
   * 的失败（设不上 model、投递落空、握手超时）重跑是安全的。**只有真的说过话
   * 才不能重来**，所以这是一个独立字段，而不是从别的字段推。
   *
   * 缺省视为 false：报不出来的实现按「没产出」处理，最坏是多重试一次，而反过来
   * 猜成 true 会让本该自动重试的失败静默不再重试。
   */
  observableOutput?: boolean;
}

export interface AgentRunTrigger {
  trigger(ctx: TriggerContext): Promise<TriggerOutcome>;
}

/**
 * 默认 stub：如实走完 run 生命周期，但**不真的驱动 Agent**。
 *
 * 它让 run now / pause / cancel / 崩溃恢复这些调度行为可以端到端跑通、可真机
 * 取证，而不必等后台池。日志里明确写着「待接线」，不谎称跑过一次真实 Agent。
 */
export const noopAgentRunTrigger: AgentRunTrigger = {
  async trigger(): Promise<TriggerOutcome> {
    return {
      status: "succeeded",
      sessionId: null,
      artifactIds: [],
      costUsd: null,
      error: null,
      note: "Agent 触发为待接线点（后台池接口尚未接入），本次未驱动真实 Agent。",
    };
  },
};

let current: AgentRunTrigger = noopAgentRunTrigger;

/** 注入触发实现（后台池落地 / 单测替换用）。 */
export function setAgentRunTrigger(trigger: AgentRunTrigger): void {
  current = trigger;
}

export function agentRunTrigger(): AgentRunTrigger {
  return current;
}

/** 仅供单测：还原为默认 stub。 */
export function __resetAgentRunTrigger(): void {
  current = noopAgentRunTrigger;
}

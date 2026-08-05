/**
 * T1/T2 提交边界的**接线件**：把 commit-sink.ts 文件头那四条落成一段没有第二
 * 条路径的代码，并在同一段路上挂上派发护栏（tool-guards.ts）。
 *
 * 接线方（tool-bridge 的派发路径 / tasks 的 run / home.automation 的规则动作）
 * 只调 {@link ToolDispatchBoundary.run}，四条约定由它一次性守住：
 *
 *   ① T1 严格早于 impl，失败**直接抛**。本文件里没有任何一条把 T1 失败转成
 *      结果的路径 —— 转成结果就意味着 impl 后面那行仍然会跑，于是产生一次
 *      没有 dispatch 事实的副作用，恢复时它会被判 `definitely_not_dispatched`
 *      并被自动重跑。
 *   ② `created:false` 也算失败：同一个 operationId 之前已经 prepare 过。正常
 *      路径上不可能发生，出现即重复派发或恢复流程撞车，两种都不能往下走 impl。
 *   ③ T1 之前重新检查 abort：权限审批是 async 的，进入工具时检查过的信号到
 *      这一刻已经过期。
 *   ④ T2 在把结果交还给调用方（= 发布）之前。顺序反了，上层已当成功而账本
 *      仍是 prepared，账本与对话历史就此分叉。
 *
 * ## 协议标记盖在哪：某工作区账本的**第一条**事件
 *
 * `ToolLedgerEvent.protocol` 只允许出现在账本首位（ledger-scanner 文件头），
 * 因为它宣告的是「从这一行起，本账本承诺 dispatch 事实必然先于任何副作用落地」。
 * 所以盖章点唯一：{@link ToolDispatchBoundary} 在 T1 组装 call 事实时，若该
 * 工作区账本为空就带上标记，否则不带。
 *
 * 由此得到的性质正是三态判据要的：
 *   - 全新工作区 → 第一次 T1 盖章 → 此后「没有 dispatch 事实」才**可能**被判
 *     `definitely_not_dispatched`；
 *   - 已有老数据的账本（非空、无标记）→ 永远不补盖 → 一律 legacy → 保守判
 *     `indeterminate`。**绝不把老数据升级成新协议来证明工具没执行。**
 *
 * ## 「账本里根本没有这条 operation」怎么判
 *
 * {@link resolveToolDispatchVerdict} 比 resolver 多回答一个问题：一条已知的
 * 执行（tasks 的 run、规则的一次动作）在账本里**完全没有痕迹**时算什么。
 *
 * T1 严格早于 impl ⇒ 没有 T1 就没有 impl。所以「无痕迹」在新协议账本上就是
 * 「没派发」。但有一个边界必须堵死：**标记落地之前的老执行同样没有痕迹**。
 * 一条比标记还早的执行，它当年跑没跑，这份账本回答不了。因此判据带一个时间
 * 下界 `dispatchedNotBefore`：早于标记事件的执行一律退回 `indeterminate`。
 */
import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  TOOL_DISPATCH_PROTOCOL_V1,
  buildToolOperationId,
  canonicalToolArgsHash,
  toolCallEventId,
  toolDispatchEventId,
  toolResponseEventId,
  type ToolRecoveryMode,
} from "./operation-id";
import { RuntimeCommitBoundaryError, type RuntimeCommitSink } from "./commit-sink";
import type { ToolLedgerEvent } from "./ledger-scanner";
import {
  resolveToolRecovery,
  type ToolRecoveryDecisionReason,
} from "./recovery-resolver";
import {
  ToolLoopGate,
  ToolOutcomeUnknownError,
  formatLoopGateText,
  formatToolArgsViolationText,
  toolUncertainOutcome,
  type ToolUncertainOutcome,
} from "./tool-guards";

/**
 * 边界需要的账本能力：写两个事务 + 读一遍账本（判断是不是首位、给恢复用）。
 * `ToolRecoveryStore` 的方法签名刻意与之对齐，直接当它用。
 */
export interface ToolDispatchLedger extends RuntimeCommitSink {
  readLedger(workspaceId: string): ToolLedgerEvent[];
}

export interface ToolDispatchRequest {
  workspaceId: string;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  args: unknown;
  recoveryMode?: ToolRecoveryMode;
  /** 参数 schema：实参违规时用来生成教学式回执（读不出来就什么都不说）。 */
  parameters?: unknown;
  /** 实参校验。抛错即违规——在 T1 之前，因此不会留下任何 dispatch 事实。 */
  validateArgs?: () => void;
  /** ③ T1 之前重新检查 abort。 */
  aborted?: () => boolean;
}

/** 派发前被拦（循环闸 / 参数违规）。`message` 是直接给模型看的话。 */
export class ToolDispatchBlockedError extends Error {
  override readonly name = "ToolDispatchBlockedError";
  readonly kind: "loop_gate" | "invalid_args";

  constructor(kind: "loop_gate" | "invalid_args", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** T1 之前发现会话已被 abort。impl 绝不会跑。 */
export class ToolDispatchAbortedError extends Error {
  override readonly name = "ToolDispatchAbortedError";
}

export class ToolDispatchBoundary {
  /** 循环闸按边界实例持有：一条 bridge / 一个调度器就是一条连击线。 */
  readonly loopGate = new ToolLoopGate();

  constructor(
    private readonly ledger: ToolDispatchLedger,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * 夹逼执行一次工具调用。
   *
   * 顺序写死：护栏 → ③abort → ①T1 →（副作用）→ ④T2 → 返回。任何一步失败都
   * **抛**，绝不返回一个「看起来成功」的值。
   */
  async run<T>(request: ToolDispatchRequest, impl: () => Promise<T>): Promise<T> {
    const signature = this.loopGate.signatureOf(
      request.toolName,
      request.args,
      request.providerToolCallId
    );

    // 循环闸：拦住的这次**不记账**，连击停在阈值上，之后每次一模一样的重复
    // 都继续被拦（见 tool-guards 文件头）。
    if (this.loopGate.blocked(signature)) {
      throw new ToolDispatchBlockedError("loop_gate", formatLoopGateText(request.toolName));
    }

    if (request.validateArgs) {
      try {
        request.validateArgs();
      } catch (error) {
        this.loopGate.record(signature, true);
        throw new ToolDispatchBlockedError(
          "invalid_args",
          formatToolArgsViolationText({
            toolName: request.toolName,
            ...(request.parameters === undefined ? {} : { parameters: request.parameters }),
            args: request.args,
            error,
          })
        );
      }
    }

    // ③ 重新检查 abort：审批期间用户可能已经取消。不重查就会出现「用户取消了，
    // dispatch 事实照样落地，impl 照样跑」。
    if (request.aborted?.()) {
      this.loopGate.record(signature, true);
      throw new ToolDispatchAbortedError(`工具 ${request.toolName} 在派发前已被取消`);
    }

    // ① T1。这里没有 catch-转结果 的分支：失败一路抛到调用栈上层。
    const operationId = await this.commitPrepared(request);

    let result: T;
    try {
      result = await impl();
    } catch (error) {
      // impl 失败：错误也是一条结算事实，同样要在回包之前落地。落不下去时
      // commitOutcome 抛的不确定档会盖过原始错误 —— 那是更严重的一件事。
      try {
        await this.commitOutcome(request, operationId, true);
      } finally {
        this.loopGate.record(signature, true);
      }
      throw error;
    }

    // 连击在 impl 成功的这一刻就清零：循环闸问的是「这次调用失败没失败」，
    // 而它没失败。之后 T2 若落不下去，那是结算问题，不是打转。
    this.loopGate.record(signature, false);
    // ④ T2 在返回（= 把结果交给调用方发布）之前。
    await this.commitOutcome(request, operationId, false);
    return result;
  }

  // ------------------------------------------------------------------ T1

  private async commitPrepared(request: ToolDispatchRequest): Promise<string> {
    const operationId = buildToolOperationId({
      invocationId: request.invocationId,
      providerToolCallId: request.providerToolCallId,
    });
    let created: boolean;
    try {
      const canonicalArgsHash = canonicalToolArgsHash(request.toolName, request.args);
      const committedAt = this.now();
      const spine = {
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        invocationId: request.invocationId,
        runId: request.runId,
        turnId: request.turnId,
      };
      // 协议标记：只在这个工作区账本还空着的时候盖，且只盖在这一条上。
      const firstInLedger = this.ledger.readLedger(request.workspaceId).length === 0;
      const callEvent: ToolLedgerEvent = {
        id: toolCallEventId(operationId),
        ...spine,
        ts: committedAt,
        ...(firstInLedger ? { protocol: { toolBoundary: TOOL_BOUNDARY_PROTOCOL_V1 } } : {}),
        call: {
          toolCallId: request.providerToolCallId,
          toolName: request.toolName,
          args: request.args,
        },
      };
      const recoveryMode: ToolRecoveryMode = request.recoveryMode ?? "reconcile";
      const dispatchEvent: ToolLedgerEvent = {
        id: toolDispatchEventId(operationId),
        ...spine,
        ts: committedAt,
        dispatch: {
          protocol: TOOL_DISPATCH_PROTOCOL_V1,
          operationId,
          providerToolCallId: request.providerToolCallId,
          toolName: request.toolName,
          canonicalArgsHash,
          recoveryMode,
        },
        refs: { operationId, toolCallId: request.providerToolCallId },
      };
      const outcome = await this.ledger.commitToolPrepared({
        workspaceId: request.workspaceId,
        operationId,
        callEvent,
        dispatchEvent,
        providerToolCallId: request.providerToolCallId,
        toolName: request.toolName,
        canonicalArgsHash,
        recoveryMode,
        committedAt,
      });
      created = outcome.created;
    } catch (error) {
      throw new RuntimeCommitBoundaryError(
        "T1",
        `派发事实落地失败：${error instanceof Error ? error.message : String(error)}`,
        operationId
      );
    }
    // ② created:false = 这个 operationId 之前已经 prepare 过。重复派发或恢复
    // 流程撞车，两种都不能继续往下走 impl。
    if (!created) {
      throw new RuntimeCommitBoundaryError(
        "T1",
        "该 operationId 已经派发过（重复派发或与恢复流程撞车），拒绝再次执行",
        operationId
      );
    }
    return operationId;
  }

  // ------------------------------------------------------------------ T2

  private async commitOutcome(
    request: ToolDispatchRequest,
    operationId: string,
    isError: boolean
  ): Promise<void> {
    try {
      await this.ledger.commitToolOutcome({
        workspaceId: request.workspaceId,
        operationId,
        outcomeEvent: {
          id: toolResponseEventId(operationId),
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          invocationId: request.invocationId,
          runId: request.runId,
          turnId: request.turnId,
          ts: this.now(),
          response: {
            toolCallId: request.providerToolCallId,
            toolName: request.toolName,
            isError,
          },
          refs: { operationId, toolCallId: request.providerToolCallId },
        },
        committedAt: this.now(),
      });
    } catch (error) {
      // T2 失败：impl **已经**跑了。这条 operation 留在 prepared，交给下次启动
      // 的恢复流程去 reconcile；对调用方它是「不知道有没有生效」，不是失败。
      throw new ToolOutcomeUnknownError(
        `工具 ${request.toolName} 已执行，但结算事实没能落地（operation ${operationId} 仍是 prepared，将在下次启动时对账）`,
        {
          cause: new RuntimeCommitBoundaryError(
            "T2",
            error instanceof Error ? error.message : String(error),
            operationId
          ),
        }
      );
    }
  }
}

// ---------------------------------------------------------------- 恢复判据

export type ToolDispatchVerdictStatus =
  | "settled"
  | "definitely_not_dispatched"
  | "indeterminate"
  | "parked"
  | "corruption";

export interface ToolDispatchVerdict {
  status: ToolDispatchVerdictStatus;
  reason: ToolRecoveryDecisionReason;
  /** 只有 `definitely_not_dispatched` 为真。自动重跑的唯一许可位。 */
  retrySafe: boolean;
  /** 人能读的确切理由（写进 run 的 error 文案，用户据它知道为什么没自动重试）。 */
  explain: string;
  /** 非 settled、非 retrySafe 时的不确定信号（与护栏的不确定档同一形状）。 */
  uncertain?: ToolUncertainOutcome;
}

const REASON_TEXT: Record<ToolRecoveryDecisionReason, string> = {
  matching_response: "账本里有这次执行的结算事实，它已经跑完了",
  recovery_bundle_completed: "上一次恢复已经对账并判定它跑完了",
  dispatch_without_response: "派发事实已经落地但没有结算：工具可能已经产生了副作用",
  new_protocol_before_dispatch: "账本已启用工具边界协议，且这次执行没有派发事实：它一定没被调用过",
  legacy_dispatch_unknown: "账本还没有工具边界协议标记，缺少派发事实不携带任何信息",
  protocol_marker_invalid: "账本的协议标记无法解释（版本不认识或不在首位）",
  orphan_dispatch: "账本里有一条没有对应调用的派发事实",
  orphan_response: "账本里有一条没有对应调用的结算事实",
  duplicate_call: "账本里同一次调用出现了两条调用事实",
  duplicate_operation: "账本里同一个 operationId 绑到了两次不同的调用",
  duplicate_dispatch: "账本里同一次调用出现了两条派发事实",
  duplicate_response: "账本里同一次调用出现了两条结算事实",
  canonical_args_hash_conflict: "派发事实声称的实参哈希与调用事实里的实参对不上",
  identity_conflict: "账本里这几条事实的执行身份互相矛盾",
  invocation_identity_conflict: "同一次 invocation 的事实落在了不同的会话 / run / turn 上",
  event_order_conflict: "账本里这几条事实的物理顺序与因果顺序矛盾",
  recovery_fact_corruption: "上一次恢复只落了半截，无法解释当时判了什么",
  reconcile_matches_prior_state: "读回真实世界后看到的是执行前的状态，无法断定它是没跑还是跑了又被改回去",
  reconcile_diverged: "读回真实世界后看到的状态与两种预期都不符",
  reconcile_unreadable: "读不回真实世界的状态，无法对账",
};

/**
 * 一条已知执行的恢复结论。
 *
 * 按**元组身份**（invocationId, providerToolCallId）而不是 operationId 去认领：
 * 一条只有 call 事实、还没来得及派发的记录压根没有 operationId（它是随 dispatch
 * 事实一起落地的），而那恰恰正是最需要判出 `definitely_not_dispatched` 的那一条。
 *
 * `dispatchedNotBefore` 是这次执行**进入派发路径**的时刻（run 的
 * startedAt / createdAt）。它只在「账本里查无此条」时才起作用：早于协议标记
 * 落地的执行，这份账本回答不了它跑没跑，一律退回 indeterminate。
 */
export function resolveToolDispatchVerdict(input: {
  events: readonly ToolLedgerEvent[];
  identity: { invocationId: string; providerToolCallId: string };
  dispatchedNotBefore: number;
}): ToolDispatchVerdict {
  const resolution = resolveToolRecovery(input.events);
  const decision = resolution.decisions.find(
    (d) =>
      d.invocationId === input.identity.invocationId &&
      d.toolCallId === input.identity.providerToolCallId
  );

  // 账本自身有损坏时，不对任何单条 operation 给出可执行结论（resolver 的口径）。
  if (resolution.hasCorruption) {
    const reason =
      decision?.status === "corruption"
        ? decision.reason
        : resolution.protocolMarker.status === "invalid"
          ? "protocol_marker_invalid"
          : "recovery_fact_corruption";
    return verdict("corruption", reason);
  }

  if (decision) {
    switch (decision.status) {
      case "completed":
        return verdict("settled", decision.reason);
      case "definitely_not_dispatched":
        return verdict("definitely_not_dispatched", decision.reason);
      case "parked":
        return verdict("parked", decision.reason);
      default:
        return verdict("indeterminate", decision.reason);
    }
  }

  // 账本里查无此条。协议标记不 valid ⇒ 什么都推不出来。
  if (resolution.protocolMarker.status !== "valid") {
    return verdict("indeterminate", "legacy_dispatch_unknown");
  }
  const markerTs = input.events[0]?.ts;
  if (markerTs === undefined || markerTs > input.dispatchedNotBefore) {
    // 这次执行比标记还早：那时候的代码写不写派发事实，这份账本证明不了。
    return verdict("indeterminate", "legacy_dispatch_unknown");
  }
  return verdict("definitely_not_dispatched", "new_protocol_before_dispatch");
}

function verdict(
  status: ToolDispatchVerdictStatus,
  reason: ToolRecoveryDecisionReason
): ToolDispatchVerdict {
  const explain = REASON_TEXT[reason];
  const retrySafe = status === "definitely_not_dispatched";
  return {
    status,
    reason,
    retrySafe,
    explain,
    ...(status === "settled" || retrySafe ? {} : { uncertain: toolUncertainOutcome(explain) }),
  };
}

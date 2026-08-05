/**
 * T1/T2 提交边界的**接口契约**。本文件只定义契约，不接线。
 *
 * ===========================================================================
 * 接线方（下一个任务）必须遵守的四条。违反其中任何一条，整套夹逼失效。
 * ===========================================================================
 *
 * ### ① T1 严格早于 impl，且失败直接 `throw`（不是返回错误结果）
 *
 * ```ts
 * await sink.commitToolPrepared(prepared);   // ← 必须在这里
 * const result = await tool.impl(args);      // ← 副作用发生在这之后
 * ```
 *
 * T1 提交失败时必须让异常**穿透**到调用栈上层，而不是 catch 住转成一条
 * `{ ok: false, error }` 的工具结果。原因：转成结果就意味着 impl 后面那行
 * 仍然会跑（或者某个 catch 分支里补跑了一次），于是产生了一次**没有 dispatch
 * 事实**的副作用。恢复时它会被判成 `definitely_not_dispatched` 并被自动重跑
 * ——同一个副作用做两次，而这正是整套机制要防的事。
 *
 * 记住这条判据的方向：**dispatch 事实缺失 ⇒ 断言 impl 没跑过。** 任何让
 * impl 在 T1 未成功时也能跑的代码路径，都是在制造这个断言的反例。
 *
 * ### ② `created: false` 也算失败
 *
 * `commitToolPrepared` 返回 `{ created: false }` 表示「这个 operationId 之前
 * 已经 prepare 过了」。在正常调用路径上这**不可能**发生 —— operationId 由
 * `(invocationId, providerToolCallId)` 确定性派生，同一次调用只会 prepare
 * 一次。它出现只有两种可能：调用方在同一次 invocation 里重复派发了同一个
 * toolCallId，或者恢复流程和正常流程撞车了。
 *
 * 两种都不能继续往下走 impl：前者会重复副作用，后者会让恢复流程读到一个
 * 「已 prepared」但其实是新调用的记录。接线方必须把 `created === false` 当作
 * 边界失败，`throw new RuntimeCommitBoundaryError("T1", ...)`。
 *
 * ### ③ T1 之前重新检查 abort
 *
 * 权限审批、参数确认这些前置动作是 async 的，中间用户可能已经点了取消 /
 * 会话已经被 abort。abort 信号是在**进入**工具调用时检查的，等到 T1 这一刻
 * 已经过去了一段时间。不重新检查就会出现：用户取消了，dispatch 事实照样落
 * 地，impl 照样跑 —— 一次用户明确拒绝过的副作用。
 *
 * ```ts
 * if (signal.aborted) throw new AbortError();   // ← 重新检查
 * await sink.commitToolPrepared(prepared);
 * ```
 *
 * ### ④ T2 在把结果发布给模型/上层之前
 *
 * ```ts
 * const result = await tool.impl(args);
 * await sink.commitToolOutcome(outcome);     // ← 必须在这里
 * emitToolResult(result);                    // ← 发布在这之后
 * ```
 *
 * 顺序反了的后果：结果已经进了对话历史（模型据此产生了下一步动作），但账本
 * 上这条 operation 仍然是 `prepared`。崩溃重开后恢复流程会把它判成
 * `indeterminate` 并去 park / reconcile 一个**上层早已当成成功**的调用。账本
 * 与对话历史分叉，之后每一步推理都建立在两套互相矛盾的事实上。
 *
 * ===========================================================================
 *
 * 另：本文件不 import electron，也不依赖任何具体 store 实现。接线方自己把
 * `RecoveryStore` 适配成 `RuntimeCommitSink` 即可（store 的方法签名是刻意对齐
 * 这个接口的）。
 */
import type { ToolLedgerEvent } from "./ledger-scanner";
import type { ToolRecoveryMode } from "./operation-id";

export interface ToolPreparedCommit {
  workspaceId: string;
  operationId: string;
  /** 模型可见的 function_call 事实。等审批时它可能已经先落过了。 */
  callEvent: ToolLedgerEvent;
  /** 非模型可见的规范事实：T1 已跨过。 */
  dispatchEvent: ToolLedgerEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface ToolOutcomeCommit {
  workspaceId: string;
  operationId: string;
  outcomeEvent: ToolLedgerEvent;
  committedAt: number;
}

export interface RuntimeCommitResult {
  /**
   * `true` = 本次调用真的写入了。`false` = 同 operationId 的记录已存在且逐字节
   * 相同（幂等短路）。**接线方在 T1 路径上必须把 `false` 当失败**（见 ②）。
   */
  created: boolean;
  /** 写入后该 operation 的账本行数，用于日志对账。 */
  ledgerSeq: number;
}

export interface RuntimeCommitSink {
  commitToolPrepared(input: ToolPreparedCommit): Promise<RuntimeCommitResult>;
  commitToolOutcome(input: ToolOutcomeCommit): Promise<RuntimeCommitResult>;
}

/**
 * 提交边界失败。`boundary` 指明是哪一侧，因为两侧的补救完全不同：
 *
 *   - `T1` 失败 → impl **绝不能**跑。向上抛，让这次工具调用整体失败。
 *   - `T2` 失败 → impl **已经**跑了。结果绝不能发布出去；这条 operation 留在
 *     `prepared`，交给下次启动的恢复流程去 reconcile。
 */
export class RuntimeCommitBoundaryError extends Error {
  override readonly name = "RuntimeCommitBoundaryError";
  readonly boundary: "T1" | "T2";
  readonly operationId: string | undefined;

  constructor(boundary: "T1" | "T2", message: string, operationId?: string) {
    super(`[${boundary}] ${message}`);
    this.boundary = boundary;
    this.operationId = operationId;
  }
}

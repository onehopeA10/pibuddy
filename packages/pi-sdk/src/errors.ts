/**
 * pi-sdk 的具名错误类型。
 *
 * 之所以不复用裸 Error：调用方（主进程 supervisor / 渲染进程）需要按类别
 * 决定 UI 文案与是否重启运行时。超时与 abort 是「请求级」失败，进程仍活着；
 * JsonlOverflowError 是「链路级」失败，必须重启才能恢复分帧同步。
 */

/** RPC 请求超过 timeoutMs 仍未收到 response。 */
export class RpcTimeoutError extends Error {
  readonly name = "RpcTimeoutError";
  constructor(
    readonly requestId: string,
    readonly timeoutMs: number,
    readonly commandType: string
  ) {
    super(`RPC 命令 ${commandType} 超时（${timeoutMs}ms, id=${requestId}）`);
  }
}

/** 调用方通过 AbortSignal 主动放弃了该 RPC 请求。 */
export class RpcAbortedError extends Error {
  readonly name = "RpcAbortedError";
  constructor(
    readonly requestId: string,
    readonly commandType: string
  ) {
    super(`RPC 命令 ${commandType} 已被取消（id=${requestId}）`);
  }
}

/** JSONL 单行或累计缓冲越界。发生后 reader 会丢弃当前行直到下一个 \n。 */
export class JsonlOverflowError extends Error {
  readonly name = "JsonlOverflowError";
  constructor(
    readonly kind: "line" | "buffer",
    readonly size: number,
    readonly limit: number
  ) {
    super(
      `JSONL ${kind === "line" ? "单行" : "累计缓冲"}超限：${size} > ${limit}`
    );
  }
}

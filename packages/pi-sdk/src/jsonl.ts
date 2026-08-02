import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { JsonlOverflowError } from "./errors.js";

/**
 * 单行上限。超过即认为对端行为异常（或我们与它失去了分帧同步），
 * 继续累积只会把主进程内存吃干净。
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * 累计缓冲上限。即使每行都不超限，长时间没有换行也必须止损。
 *
 * 注：这里用 JS 字符串长度（UTF-16 code unit）做度量，对 UTF-8 字节数而言
 * 是一个保守下界 —— 也就是说真实字节数只会更大，用它做闸门不会漏判。
 */
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface JsonlReaderHandle {
  /** 当前未成行的缓冲长度。越界重置后应为 0。 */
  bufferLength(): number;
  /** 摘除监听器（窗口销毁 / 运行时代际切换时调用）。 */
  detach(): void;
}

/**
 * 严格 JSONL 分帧：仅以 LF (\n) 作为记录分隔符，容忍尾部 \r。
 * 不能使用 Node readline —— 它还会按 U+2028/U+2029 分行，
 * 而这两个字符在 JSON 字符串中是合法内容（见 pi docs/rpc.md）。
 *
 * 越界处理：报错后把 buffer 清零，并进入「丢弃直到下一个 \n」状态，
 * 否则超长行的后续分片会不断重复触发同一个错误。
 */
export function attachJsonlReader(
  stream: Readable,
  onLine: (line: string) => void,
  onError?: (err: JsonlOverflowError) => void
): JsonlReaderHandle {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  /** 上一行越界后，丢弃后续分片直到遇见换行为止。 */
  let discarding = false;

  const overflow = (kind: "line" | "buffer", size: number, limit: number): void => {
    buffer = "";
    discarding = true;
    onError?.(new JsonlOverflowError(kind, size, limit));
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (discarding) {
        // 越界行的残尾在这里被吃掉，下一行重新开始正常分帧。
        discarding = false;
        continue;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > MAX_LINE_BYTES) {
        overflow("line", line.length, MAX_LINE_BYTES);
        continue;
      }
      if (line.length > 0) onLine(line);
    }

    if (discarding) {
      buffer = "";
      return;
    }
    // 还没出现换行但已经攒到超限：先按单行超限判，再按累计缓冲判。
    if (buffer.length > MAX_LINE_BYTES) {
      overflow("line", buffer.length, MAX_LINE_BYTES);
      return;
    }
    if (buffer.length > MAX_BUFFER_BYTES) {
      overflow("buffer", buffer.length, MAX_BUFFER_BYTES);
    }
  };

  const onEnd = (): void => {
    buffer += decoder.end();
    if (discarding) {
      buffer = "";
      return;
    }
    if (buffer.length > MAX_LINE_BYTES) {
      overflow("line", buffer.length, MAX_LINE_BYTES);
      return;
    }
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
    buffer = "";
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return {
    bufferLength: () => buffer.length,
    detach: () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      buffer = "";
    },
  };
}

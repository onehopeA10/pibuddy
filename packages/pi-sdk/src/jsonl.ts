import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * 严格 JSONL 分帧：仅以 LF (\n) 作为记录分隔符，容忍尾部 \r。
 * 不能使用 Node readline —— 它还会按 U+2028/U+2029 分行，
 * 而这两个字符在 JSON 字符串中是合法内容（见 pi docs/rpc.md）。
 */
export function attachJsonlReader(
  stream: Readable,
  onLine: (line: string) => void
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
  });
}

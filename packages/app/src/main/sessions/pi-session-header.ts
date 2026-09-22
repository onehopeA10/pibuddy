/**
 * pi 认会话文件的规则（session-manager.loadEntriesFromFile）：
 * 跳过空行 / 坏 JSON 后，**第一条**必须是 `{ type: "session", id }`。
 * 否则 size>0 时直接抛 `Session file is not a valid pi session`，进程退出。
 *
 * 本文件只做同样的头部判定，避免把坏文件交给 spawn / switch_session。
 */
import { open } from "node:fs/promises";

export const INVALID_PI_SESSION_USER_MESSAGE =
  "这条会话文件已经损坏，无法打开。请再开一条新对话。";

/** 与 session-index 取样长度一致：session 头一定在文件最前面。 */
const HEAD_BYTES = 64 * 1024;

export function firstPiSessionHeader(text: string): { id: string } | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let entry: { type?: unknown; id?: unknown };
    try {
      entry = JSON.parse(line) as { type?: unknown; id?: unknown };
    } catch {
      continue;
    }
    if (entry.type === "session" && typeof entry.id === "string" && entry.id) {
      return { id: entry.id };
    }
    return null;
  }
  return null;
}

export function hasPiSessionHeader(head: Buffer | string): boolean {
  const text = typeof head === "string" ? head : head.toString("utf8");
  return firstPiSessionHeader(text) !== null;
}

/** size>0 且没有 session 头：pi 会当成损坏文件退出。空文件可以初始化，不算坏。 */
export function isBrokenPiSessionFile(sizeBytes: number, head: Buffer | string): boolean {
  return sizeBytes > 0 && !hasPiSessionHeader(head);
}

export function isInvalidPiSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not a valid pi session|会话文件已经损坏/.test(msg);
}

/** 读文件头。文件不存在时返回 null，交给调用方按「开新会话」处理。 */
export async function peekPiSessionFile(
  sessionPath: string
): Promise<{ size: number; head: Buffer } | null> {
  let fh;
  try {
    fh = await open(sessionPath, "r");
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    const len = Math.min(HEAD_BYTES, st.size);
    const head = Buffer.alloc(len);
    if (len > 0) await fh.read(head, 0, len, 0);
    return { size: st.size, head };
  } finally {
    await fh.close();
  }
}

/**
 * spawn / switch_session 之前调用。坏文件直接抛中文错误，不要把路径交给 pi。
 * 空文件或文件还不存在：pi 可以自己写头，放行。
 */
export async function assertLaunchablePiSessionFile(sessionPath: string): Promise<void> {
  const peeked = await peekPiSessionFile(sessionPath);
  if (!peeked) return;
  if (isBrokenPiSessionFile(peeked.size, peeked.head)) {
    throw new Error(INVALID_PI_SESSION_USER_MESSAGE);
  }
}

import type { PiRpcClient } from "@pibuddy/pi-sdk";
import { isInvalidPiSessionError } from "../sessions/pi-session-header.js";

/** 前台 client 还活着、还能发 RPC。休眠 / 拆进程之后这里是 false。 */
export function isForegroundClientUsable(client: PiRpcClient | null): client is PiRpcClient {
  if (!client || !client.running) return false;
  try {
    client.assertUsable();
    return true;
  } catch {
    return false;
  }
}

/** switch_session 中途被 stop() failAll，或 clientFor 撞上已死进程。 */
export function shouldRespawnAfterSwitchFailure(err: unknown): boolean {
  // 坏 jsonl 再 spawn --session 会把新进程也拉崩，前台被 dispose 后连点都会报错。
  if (isInvalidPiSessionError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /客户端已停止|进程已退出|进程未运行|运行时不可用|尚未启动|正在停止/.test(msg);
}

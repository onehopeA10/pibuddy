/**
 * 搜索子进程的入口（跑在 Electron 的 utility process 里）。
 *
 * 这个文件被 electron-vite 单独打成 `out/main/search-entry.js`，由
 * `search-worker.ts` 用 `utilityProcess.fork` 拉起。它**不碰任何 electron
 * API**：唯一的对外接口是 `process.parentPort` 上的两条消息。
 *
 * 为什么必须是独立进程：内容搜索要把成千上万个文件读进来逐行比对，
 * 在主进程里做这件事的表现是「一搜索整个界面就卡住」——而主进程同时
 * 还在跑 pi 的流式输出转发，卡住的不只是搜索框。
 */
import type { WorkspaceSearchPage } from "@pibuddy/contract";

import { runSearchScan, type ScanParams } from "./search-scan.js";

/** 宿主 → 子进程。 */
export type SearchWorkerRequest =
  | ({ type: "search"; requestId: string } & ScanParams)
  | { type: "cancel"; requestId: string };

/** 子进程 → 宿主。 */
export type SearchWorkerReply =
  | { type: "result"; requestId: string; page: WorkspaceSearchPage }
  | { type: "error"; requestId: string; message: string };

/** 已被取消的 requestId。扫描内层循环每一轮都查它。 */
const cancelled = new Set<string>();

/**
 * 处理一条请求。导出出来是为了让单测直接驱动它 —— 起一个真的
 * utility process 只是为了验证一段纯逻辑，代价与收益完全不成比例。
 */
export function handleSearchRequest(
  message: SearchWorkerRequest,
  reply: (out: SearchWorkerReply) => void
): void {
  if (message.type === "cancel") {
    cancelled.add(message.requestId);
    return;
  }
  const { requestId } = message;
  cancelled.delete(requestId);
  try {
    const page = runSearchScan(message, () => cancelled.has(requestId));
    reply({ type: "result", requestId, page });
  } catch (err) {
    reply({ type: "error", requestId, message: (err as Error).message });
  } finally {
    cancelled.delete(requestId);
  }
}

// parentPort 只在真正被 fork 成 utility process 时存在；被单测 import 时为
// undefined，于是本文件在两种场景下都能安全加载。
const parentPort = (process as NodeJS.Process & { parentPort?: NodeJS.EventEmitter & { postMessage(v: unknown): void } })
  .parentPort;

parentPort?.on("message", (event: { data: SearchWorkerRequest }) => {
  handleSearchRequest(event.data, (out) => parentPort.postMessage(out));
});

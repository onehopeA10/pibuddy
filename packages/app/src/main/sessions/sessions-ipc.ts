/**
 * 会话中心的 IPC handler（SES-101）——**恰 11 条通道，一条不多**。
 *
 * 跨进程边界上只有不透明的 `sessionId` / `externalId`：JSONL 的绝对路径
 * （sourcePath）与工作目录的真实路径（workspaceRoot）都只活在主进程里，
 * 由索引表在这里反查（CT-15）。渲染进程拿到一个 sessionId 也推断不出磁盘布局。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 */
import { app } from "electron";
import path from "node:path";
import {
  CHANNELS,
  readHistoryRequestSchema,
  sessionIdRequestSchema,
  sessionImportRunRequestSchema,
  sessionImportScanRequestSchema,
  sessionQuerySchema,
  sessionRenameRequestSchema,
  sessionSaveDraftRequestSchema,
  sessionSetPinnedRequestSchema,
  sessionSetStatusRequestSchema,
  type InvokeChannel,
  type SessionHistoryPage,
  type SessionImportScanResult,
  type SessionImportRunResult,
  type SessionRow,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { tryClientFor } from "../pi/pi-ipc.js";
import { loadSettings } from "../settings.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { readEntriesBefore } from "./session-history.js";
import { importPiSessions, scanPiSessions } from "./import-pi.js";
import { resolveSessionDir } from "./session-dir.js";
import { sessionIndex, toSessionRow, type IndexedSession } from "./session-index.js";
import { renameSession } from "./session-rename.js";

/**
 * 本域注册的全部通道。
 *
 * 导出成常量而不是散在下面的调用里：单测据它断言「恰 11 条」，多挂一条
 * 或漏挂一条都会立刻失败，而不是等到用户点到那个按钮才发现。
 */
export const SESSIONS_CHANNELS: InvokeChannel[] = [
  CHANNELS.sessionsQuery,
  CHANNELS.sessionsRename,
  CHANNELS.sessionsSetPinned,
  CHANNELS.sessionsSetStatus,
  CHANNELS.sessionsPurge,
  CHANNELS.sessionsGetDraft,
  CHANNELS.sessionsSaveDraft,
  CHANNELS.sessionsExportHtml,
  CHANNELS.sessionsReadHistory,
  CHANNELS.sessionsImportScan,
  CHANNELS.sessionsImportRun,
];

/**
 * (workspaceId, sessionId) → 索引行。
 *
 * **查不到时先同步一次再查**：pi 在启动时会立刻创建一个新的会话文件，而
 * 那多半发生在上一次 syncWorkspace 之后 —— 于是「开一个新任务，随手给它
 * 改个名字」这条最常见的路径会直接报 SESSION_UNKNOWN。同步一次是廉价的
 * （mtime+size 双命中的文件一个字节都不读）。
 *
 * 工作区取自入参而不是 `loadSettings().workspace`：后者是「上一次选过的
 * 目录」，多窗口开着两个工作区时它只对其中一个成立，另一个窗口的整理动作
 * 会去同步别人的目录。
 *
 * 同步之后仍然查不到才抛：拿不到路径的动作绝不能静默变成 no-op。
 */
async function tryRow(
  workspaceId: string,
  sessionId: string
): Promise<IndexedSession | null> {
  const index = sessionIndex();
  const hit = index.bySessionId(sessionId, workspaceId);
  if (hit) return hit;

  const root = requireWorkspaceRoot(workspaceId);
  await index.syncWorkspace(root, loadSettings());
  return index.bySessionId(sessionId, workspaceId);
}

/** 同上，但查不到就抛 —— 拿不到路径的动作绝不能静默变成 no-op。 */
async function requireRow(
  workspaceId: string,
  sessionId: string
): Promise<IndexedSession> {
  const row = await tryRow(workspaceId, sessionId);
  if (!row) throw new Error(`SESSION_UNKNOWN: ${sessionId}`);
  return row;
}

export function registerSessionsIpc(): void {
  // ------------------------------------------------------------ 查询

  registerHandler(
    CHANNELS.sessionsQuery,
    sessionQuerySchema,
    async (filter): Promise<SessionRow[]> => {
      const root = requireWorkspaceRoot(filter.workspaceId);
      const index = sessionIndex();
      // 先增量同步：目录没变化时这一步一个字节都不读。
      await index.syncWorkspace(root, loadSettings());
      return index.query(filter).map(toSessionRow);
    }
  );

  // ------------------------------------------------------------ 整理

  registerHandler(CHANNELS.sessionsRename, sessionRenameRequestSchema, async (payload, event) => {
    const client = tryClientFor(event.sender.id);
    // 「是不是当前打开的那个会话」由 pi 自己报的 sessionId 判定，而不是我们
    // 猜 —— 猜错就会把名字改到另一个会话头上。
    let isActive = false;
    if (client) {
      try {
        isActive = (await client.getState()).sessionId === payload.sessionId;
      } catch {
        isActive = false;
      }
    }
    // 索引里查不到是**正常情况**（新建会话在发出第一条消息前没有文件），
    // 因此这里用 tryRow 而不是 requireRow：当前会话照样能经 RPC 改名。
    const row = await tryRow(payload.workspaceId, payload.sessionId);
    if (!row && !isActive) throw new Error(`SESSION_UNKNOWN: ${payload.sessionId}`);
    await renameSession({
      index: sessionIndex(),
      sourcePath: row?.sourcePath ?? null,
      name: payload.name,
      isActive,
      client,
    });
  });

  registerHandler(CHANNELS.sessionsSetPinned, sessionSetPinnedRequestSchema, async (payload) => {
    const row = await requireRow(payload.workspaceId, payload.sessionId);
    sessionIndex().setPinned(row.sourcePath, payload.pinned);
  });

  registerHandler(CHANNELS.sessionsSetStatus, sessionSetStatusRequestSchema, async (payload) => {
    // 归档 / 回收站 / 恢复都只改索引里的状态列，.jsonl 一个字节都不动。
    const row = await requireRow(payload.workspaceId, payload.sessionId);
    sessionIndex().setStatus(row.sourcePath, payload.status);
  });

  registerHandler(CHANNELS.sessionsPurge, sessionIdRequestSchema, async (payload) => {
    // 只有这一条会真正动到会话文件，而且是交给系统回收站，不是 unlink。
    // 也正因为不可逆，(workspaceId, sessionId) 联合定位在这条上最要紧。
    const row = await requireRow(payload.workspaceId, payload.sessionId);
    await sessionIndex().purge(row.sourcePath);
  });

  // ------------------------------------------------------------ 草稿

  registerHandler(CHANNELS.sessionsGetDraft, sessionIdRequestSchema, async (payload) =>
    sessionIndex().getDraft(
      (await requireRow(payload.workspaceId, payload.sessionId)).sourcePath
    )
  );

  registerHandler(CHANNELS.sessionsSaveDraft, sessionSaveDraftRequestSchema, (payload) => {
    const row = sessionIndex().bySessionId(payload.sessionId, payload.workspaceId);
    // 会话不在索引里：返回 false，绝不 upsert 出一条没有会话文件的孤儿行。
    if (!row) return false;
    return sessionIndex().saveDraft(row.sourcePath, payload.draft);
  });

  // ------------------------------------------------------------ 导出

  registerHandler(CHANNELS.sessionsExportHtml, sessionIdRequestSchema, async (payload, event) => {
    const client = tryClientFor(event.sender.id);
    if (!client) throw new Error("智能体运行时不可用：请先打开这个会话再导出");
    // export_html 导出的是 pi **当前打开的**那个会话（rpc.md:574-596），
    // 因此这里刻意不查索引：一个刚新建、还没发过消息的会话在磁盘上根本
    // 没有文件（pi 是惰性写入的），查索引只会得到一句 SESSION_UNKNOWN。
    // 真正该拦的是「导出的不是你以为的那个会话」。
    const state = await client.getState();
    if (state.sessionId && state.sessionId !== payload.sessionId) {
      throw new Error("只能导出当前打开的会话，请先切换到它再导出");
    }
    // 输出目录由主进程决定（用户的下载目录），渲染进程给不出路径。
    const outputPath = path.join(
      app.getPath("downloads"),
      `pibuddy-${payload.sessionId}-${Date.now()}.html`
    );
    return client.send({ type: "export_html", outputPath });
  });

  // ------------------------------------------------------ 向更早翻页

  registerHandler(
    CHANNELS.sessionsReadHistory,
    readHistoryRequestSchema,
    async (payload): Promise<SessionHistoryPage> => {
      const index = sessionIndex();
      let row = await requireRow(payload.workspaceId, payload.sessionId);
      const first = await readEntriesBefore({
        sourcePath: row.sourcePath,
        beforeOffset: payload.beforeOffset,
        limit: payload.limit,
        expect: { mtimeMs: row.mtimeMs, sizeBytes: row.sizeBytes },
      });
      if (!first.stale) return first;

      // 索引过期：同步一次再**重试一次**（只一次 —— 会话正在流式写入时，
      // 无限重试会把主进程钉在这里）。
      await index.syncWorkspace(row.workspaceRoot, loadSettings());
      row = await requireRow(payload.workspaceId, payload.sessionId);
      const second = await readEntriesBefore({
        sourcePath: row.sourcePath,
        beforeOffset: Math.max(payload.beforeOffset, row.sizeBytes),
        limit: payload.limit,
        expect: { mtimeMs: row.mtimeMs, sizeBytes: row.sizeBytes },
      });
      if (!second.stale) return second;
      // 文件还在被追加：切会话预览不能因此空窗，按当前磁盘尽力读。
      return readEntriesBefore({
        sourcePath: row.sourcePath,
        beforeOffset: Math.max(payload.beforeOffset, row.sizeBytes),
        limit: payload.limit,
      });
    }
  );

  registerHandler(
    CHANNELS.sessionsImportScan,
    sessionImportScanRequestSchema,
    async (payload): Promise<SessionImportScanResult> => {
      const root = requireWorkspaceRoot(payload.workspaceId);
      const destDir = resolveSessionDir(root, loadSettings());
      const scanned = await scanPiSessions(destDir);
      return {
        items: scanned.map(({ sourceFile: _sourceFile, ...item }) => item),
      };
    }
  );

  registerHandler(
    CHANNELS.sessionsImportRun,
    sessionImportRunRequestSchema,
    async (payload): Promise<SessionImportRunResult> => {
      const root = requireWorkspaceRoot(payload.workspaceId);
      const settings = loadSettings();
      const destDir = resolveSessionDir(root, settings);
      const result = await importPiSessions(destDir, payload.externalIds);
      await sessionIndex().syncWorkspace(root, settings);
      return result;
    }
  );
}

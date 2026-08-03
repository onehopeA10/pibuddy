/**
 * 会话树可视化的 IPC handler（common.session-tree，恰 1 条通道）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * ## 只有 `session-tree:graph` 一条，读的是持久化的会话 JSONL
 *
 * 树的真相源是会话 JSONL（append-only、每条 entry 带 parentId），据它重建即可
 * （见 session-tree-graph.ts 的文件头）。**刻意不走 pi 的 get_tree**：取它要
 * 持有 pi client，而 client 索引住在 pi 域，一个 common 能力去 import pi 域会
 * 撞穿 kernel-boundary.spec.ts 的「内核不得 import pi 域」（允许表只减不增）。
 * 读 JSONL 只用到 workspace.read，且天然按 workspaceId + sessionId 分区。
 *
 * ## 分叉 / 克隆不在这里
 *
 * fork / clone / get_fork_messages 是 pi runtime 的内核动作
 * （`window.piBuddy.pi.*`，恒可用、可被扩展否决），本能力只画树、不重复内核
 * 已有的动作面。
 *
 * ## 反查 sourcePath 的方式与会话中心一致
 *
 * (workspaceId, sessionId) → 索引行 → sourcePath，查不到先同步一次再查
 * （新建会话在发出第一条消息前没有文件）。仍查不到则返回一棵**空树**而不是
 * 抛错：一个还没落盘的新会话，它的树本来就是空的，这不是错误。
 */
import { readFile } from "node:fs/promises";
import {
  CHANNELS,
  sessionTreeGraphRequestSchema,
  type SessionTreeGraph,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { sessionIndex } from "../sessions/session-index.js";
import { loadSettings } from "../settings.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { buildSessionTreeGraph } from "./session-tree-graph.js";

/** 本能力注册的全部通道。导出成常量供 drift test 与自测对账「恰 1 条」。 */
export const SESSION_TREE_CHANNELS = [CHANNELS.sessionTreeGraph] as const;

const EMPTY_GRAPH: SessionTreeGraph = {
  nodes: [],
  rootIds: [],
  currentLeafId: null,
  totalNodes: 0,
  truncated: false,
};

export function registerSessionTreeIpc(): void {
  registerHandler(
    CHANNELS.sessionTreeGraph,
    sessionTreeGraphRequestSchema,
    async (payload): Promise<SessionTreeGraph> => {
      const index = sessionIndex();
      let row = index.bySessionId(payload.sessionId, payload.workspaceId);
      if (!row) {
        // 查不到先同步一次：pi 启动时立刻创建会话文件，多半在上一次 sync 之后。
        await index.syncWorkspace(requireWorkspaceRoot(payload.workspaceId), loadSettings());
        row = index.bySessionId(payload.sessionId, payload.workspaceId);
      }
      // 仍查不到 = 会话还没落盘（新会话未发首条消息）：空树，不是错误。
      if (!row) return EMPTY_GRAPH;

      const text = await readFile(row.sourcePath, "utf8");
      const entries: unknown[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch {
          // 单行坏掉只丢这一行：整棵树因为一行残缺而消失，比少一个节点难查得多。
        }
      }
      return buildSessionTreeGraph(entries);
    }
  );
}

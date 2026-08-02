/**
 * `window.piBuddy.sessions` —— 会话中心（SES-101）。
 *
 * 每个方法都只接受**不透明 sessionId**：JSONL 的绝对路径是主进程内部标识，
 * 由索引表在 main 侧反查（CT-15）。这条边界一旦松掉，渲染进程就能据路径
 * 推断出磁盘布局，capability 化也就白做了。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  DraftRecord,
  SessionHistoryPage,
  SessionQuery,
  SessionRow,
  SessionStatus,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const sessions = {
  /**
   * 列表 + 搜索 + 筛选。不带条件即「本工作区的活动会话，置顶在前」。
   *
   * `workspaceId` 是**不透明**的工作区标识（sha256(canonical realpath) 派生，
   * 跨重启稳定），提成独立首参而不是塞在 filter 里 —— 少传它就编译不过，
   * 而「忘了限定工作区」意味着把别的工作区的会话也列出来。
   */
  query: (workspaceId: string, filter: Omit<SessionQuery, "workspaceId"> = {}) =>
    invoke<SessionRow[]>(CHANNELS.sessionsQuery, { ...filter, workspaceId }),
  /** 会话是当前打开的那个时，同时经 set_session_name 落到会话文件里。 */
  rename: (sessionId: string, name: string) =>
    invoke<void>(CHANNELS.sessionsRename, { sessionId, name }),
  setPinned: (sessionId: string, pinned: boolean) =>
    invoke<void>(CHANNELS.sessionsSetPinned, { sessionId, pinned }),
  /** 归档 / 移入回收站 / 恢复。**不动 .jsonl**，只改索引里的状态列。 */
  setStatus: (sessionId: string, status: SessionStatus) =>
    invoke<void>(CHANNELS.sessionsSetStatus, { sessionId, status }),
  /** 彻底删除：会话文件被送进**系统回收站**，还有一次挽回机会。 */
  purge: (sessionId: string) => invoke<void>(CHANNELS.sessionsPurge, { sessionId }),
  getDraft: (sessionId: string) =>
    invoke<DraftRecord | null>(CHANNELS.sessionsGetDraft, { sessionId }),
  /** 目标会话不在索引里时返回 false，不会静默造出一条孤儿草稿。 */
  saveDraft: (sessionId: string, draft: DraftRecord) =>
    invoke<boolean>(CHANNELS.sessionsSaveDraft, { sessionId, draft }),
  exportHtml: (sessionId: string) =>
    invoke<{ success: boolean; error?: string; data?: { path: string } }>(
      CHANNELS.sessionsExportHtml,
      { sessionId }
    ),
  /**
   * 向**更早**翻一页。
   *
   * 这条路不经 pi RPC：`get_entries` 的 since 只返回 strictly after 的条目，
   * 全协议没有 before / limit（rpc.md:694-723），反向分页在协议层不存在。
   * main 侧按 JSONL 字节 offset 本地读取。`beforeOffset` 首屏用
   * `SessionRow.sizeBytes`，之后用上一页返回的 `nextBeforeOffset`。
   *
   * 返回 `stale: true` 表示会话在两次调用之间被追加过，main 已自动同步并
   * 重试了一次；仍为 true 时调用方原样再请求一次即可。
   */
  readHistoryBefore: (args: { sessionId: string; beforeOffset: number; limit: number }) =>
    invoke<SessionHistoryPage>(CHANNELS.sessionsReadHistory, args),
};

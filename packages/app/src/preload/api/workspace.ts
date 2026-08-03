/**
 * `window.piBuddy.workspace` —— 文件树、搜索、读写、变更集。
 *
 * **每一个出入参都是 relativePath**：这一层没有任何字段能承载绝对路径，
 * 于是「顺手把真实位置带出去」在结构上就表达不出来。渲染进程拿到的
 * 相对路径既推断不出磁盘布局，也无法用来够工作区外的东西。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod）——
 * 理由见 bridge.ts：从主入口做值导入会把 140KB 的 zod 打进一个开着 sandbox
 * 的安全边界，或者更糟，让整个 preload 静默失败。
 */
import { CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract/channels";
import type {
  AttachmentDescriptor,
  ChangesetApplyResult,
  ChangesetBatchResult,
  ChangesetQueryResult,
  ChangesetStatus,
  FileMutateKind,
  FileMutateResult,
  FileReadResult,
  FileSaveResult,
  FileTreePage,
  WorkspaceSearchPage,
} from "@pibuddy/contract";
import { invoke, subscribe } from "./bridge.js";

export const workspace = {
  // ---------------------------------------------------------------- 树

  /** 列一层目录。relativePath 为空串 = 工作区根。 */
  listDir: (
    workspaceId: string,
    relativePath: string,
    options: { includeIgnored?: boolean; limit?: number } = {}
  ) => invoke<FileTreePage>(CHANNELS.workspaceTreeList, { workspaceId, relativePath, ...options }),

  /** 开始 / 停止监听一层目录。折叠时务必传 false，否则句柄会一路泄漏。 */
  watchDir: (workspaceId: string, relativePath: string, watching: boolean) =>
    invoke<void>(CHANNELS.workspaceTreeWatch, { workspaceId, relativePath, watching }),

  /** 订阅「某一层脏了」。载荷只有 {workspaceId, relativePath}。 */
  onTreeChanged: (callback: (payload: unknown) => void) =>
    subscribe(PUSH_CHANNELS.workspaceTreeEvent, callback),

  /**
   * 释放一个工作区在主进程侧的 watcher 与搜索子进程。
   *
   * 切换工作区 / 卸载面板时必须调。不调不会有任何报错 —— 只是句柄和
   * utility process 会随切换次数一路往上走，直到文件树悄悄停止刷新。
   */
  release: (workspaceId: string) =>
    invoke<void>(CHANNELS.workspaceRelease, { workspaceId }),

  // ------------------------------------------------------------- 搜索

  search: (params: {
    workspaceId: string;
    query: string;
    mode?: "name" | "content";
    limit?: number;
    cursor?: string | null;
    requestId: string;
  }) => invoke<WorkspaceSearchPage>(CHANNELS.workspaceSearch, params),

  /** 取消一次在跑的搜索（用户又敲了一个字）。 */
  cancelSearch: (requestId: string) =>
    invoke<void>(CHANNELS.workspaceSearchCancel, { requestId }),

  // ------------------------------------------------------------- 读写

  readFile: (workspaceId: string, relativePath: string) =>
    invoke<FileReadResult>(CHANNELS.workspaceFileRead, { workspaceId, relativePath }),

  /**
   * 保存。`baseSha256` 必须是 readFile 回来的那一个 —— 它是冲突判定的
   * 唯一权威，传错等于关掉了并发写保护。
   */
  saveFile: (params: {
    workspaceId: string;
    relativePath: string;
    content: string;
    baseMtimeMs: number;
    baseSha256: string;
    overwrite?: boolean;
  }) => invoke<FileSaveResult>(CHANNELS.workspaceFileSave, params),

  /** 新建 / 重命名 / 移动 / 复制 / 回收站。 */
  mutate: (params: {
    workspaceId: string;
    kind: FileMutateKind;
    relativePath: string;
    targetPath?: string;
  }) => invoke<FileMutateResult>(CHANNELS.workspaceFileMutate, params),

  /** 工作区里的文件 → 结构化附件引用（八字段，标识恒为 token）。 */
  createAttachment: (
    workspaceId: string,
    relativePath: string,
    capability: "read" | "read-write" = "read"
  ) =>
    invoke<AttachmentDescriptor>(CHANNELS.workspaceAttachmentCreate, {
      workspaceId,
      relativePath,
      capability,
    }),

  // ----------------------------------------------------------- 变更集

  changesets: (params: {
    workspaceId: string;
    sessionId?: string;
    status?: ChangesetStatus;
    limit?: number;
  }) => invoke<ChangesetQueryResult>(CHANNELS.changesetQuery, params),

  acceptChange: (id: string, hunkIndexes?: number[]) =>
    invoke<ChangesetApplyResult>(CHANNELS.changesetAccept, { id, hunkIndexes }),

  rejectChange: (id: string) =>
    invoke<ChangesetApplyResult>(CHANNELS.changesetReject, { id }),

  acceptAll: (ids: string[]) =>
    invoke<ChangesetBatchResult>(CHANNELS.changesetAcceptBatch, { ids }),
};

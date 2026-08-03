/**
 * `window.piBuddy.artifacts` —— 产物库（ART-102）。
 *
 * 每一个方法的入参都是不透明 artifactId：产物的真实落盘位置只活在
 * 主进程。导出的落盘位置由主进程的系统保存对话框决定，这一层连一个
 * 能承载路径的字段都没有。
 *
 * CHANNELS 走 `@pibuddy/contract/channels` 子入口（不依赖 zod），
 * 理由见 preview.ts 与 bridge.ts。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  ArtifactComparison,
  ArtifactExportResult,
  ArtifactMutationResult,
  ArtifactQueryResult,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const artifacts = {
  /** 搜索 / 筛选。trashed:true 即回收站视图。 */
  query: (params: {
    workspaceId: string;
    query?: string;
    kind?: string;
    status?: string;
    sessionId?: string;
    trashed?: boolean;
    latestOnly?: boolean;
    limit?: number;
  }) => invoke<ArtifactQueryResult>(CHANNELS.artifactsQuery, params),

  rename: (id: string, name: string) =>
    invoke<ArtifactMutationResult>(CHANNELS.artifactsRename, { id, name }),

  /** 复制一份。新条目是独立的产物，不是原链的下一版。 */
  duplicate: (id: string) =>
    invoke<ArtifactMutationResult>(CHANNELS.artifactsDuplicate, { id }),

  /** 导出。主进程弹保存对话框，返回值只有文件名与字节数。 */
  export: (id: string) => invoke<ArtifactExportResult>(CHANNELS.artifactsExport, { id }),

  showInFolder: (id: string) => invoke<void>(CHANNELS.artifactsShowInFolder, { id }),

  /** 移入回收站。**只改状态，磁盘文件不动。** */
  trash: (id: string) => invoke<ArtifactMutationResult>(CHANNELS.artifactsTrash, { id }),

  restore: (id: string) => invoke<ArtifactMutationResult>(CHANNELS.artifactsRestore, { id }),

  compare: (id: string, otherId: string) =>
    invoke<ArtifactComparison>(CHANNELS.artifactsCompareVersions, { id, otherId }),
};

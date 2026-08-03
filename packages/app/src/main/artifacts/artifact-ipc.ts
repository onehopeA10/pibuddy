/**
 * Artifact 仓库的 IPC handler（ART-102）——**恰 8 条通道**。
 *
 * 入参一律是不透明的 artifactId：产物的真实落盘位置只活在主进程，
 * 渲染进程连「这个文件在哪」都问不出来。导出走系统保存对话框，
 * 落盘位置由**用户**决定而不是由渲染进程指定 —— 否则产物库会变成
 * 一条「往任意路径写文件」的通用旁路。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 */
import { dialog, shell } from "electron";
import {
  CHANNELS,
  artifactCompareRequestSchema,
  artifactIdRequestSchema,
  artifactQueryRequestSchema,
  artifactRenameRequestSchema,
  type ArtifactComparison,
  type ArtifactExportResult,
  type ArtifactMutationResult,
  type ArtifactQueryResult,
  type InvokeChannel,
} from "@pibuddy/contract";
import fsp from "node:fs/promises";
import path from "node:path";

import { registerHandler } from "../ipc-guard.js";
import { artifactStore, closeArtifactStore } from "./artifact-store.js";
import { disposeArtifactTracking } from "./artifact-tracker.js";

/** 本域注册的全部通道。单测据它断言逐一出现在 ipc-guard 的注册表里。 */
export const ARTIFACT_CHANNELS: InvokeChannel[] = [
  CHANNELS.artifactsQuery,
  CHANNELS.artifactsRename,
  CHANNELS.artifactsDuplicate,
  CHANNELS.artifactsExport,
  CHANNELS.artifactsShowInFolder,
  CHANNELS.artifactsTrash,
  CHANNELS.artifactsRestore,
  CHANNELS.artifactsCompareVersions,
];

function failure(message: string): ArtifactMutationResult {
  return { ok: false, record: null, message };
}

export function registerArtifactIpc(): void {
  registerHandler<
    { workspaceId: string; query?: string; trashed?: boolean; latestOnly?: boolean },
    ArtifactQueryResult
  >(CHANNELS.artifactsQuery, artifactQueryRequestSchema, (request) =>
    artifactStore().query(request)
  );

  registerHandler<{ id: string; name: string }, ArtifactMutationResult>(
    CHANNELS.artifactsRename,
    artifactRenameRequestSchema,
    (request) => {
      try {
        return { ok: true, record: artifactStore().rename(request.id, request.name) };
      } catch (err) {
        return failure((err as Error).message);
      }
    }
  );

  registerHandler<{ id: string }, ArtifactMutationResult>(
    CHANNELS.artifactsDuplicate,
    artifactIdRequestSchema,
    async (request) => {
      try {
        return { ok: true, record: await artifactStore().duplicate(request.id) };
      } catch (err) {
        return failure((err as Error).message);
      }
    }
  );

  /**
   * 导出。
   *
   * 即便产物是 failed 状态也照样允许导出：工具失败时写了一半的文件
   * 对用户仍然可能有用，而且那是**他的**文件 —— 我们没有资格因为
   * 自己的一次失败就把它扣下。
   */
  registerHandler<{ id: string }, ArtifactExportResult>(
    CHANNELS.artifactsExport,
    artifactIdRequestSchema,
    async (request) => {
      const store = artifactStore();
      let record;
      try {
        record = store.require(request.id);
      } catch (err) {
        return { ok: false, savedName: null, sizeBytes: 0, message: (err as Error).message };
      }
      const source = store.absolutePathOf(record);
      const chosen = await dialog.showSaveDialog({
        title: "导出产物",
        defaultPath: record.name,
      });
      if (chosen.canceled || !chosen.filePath) {
        return { ok: false, savedName: null, sizeBytes: 0, message: "已取消" };
      }
      try {
        await fsp.copyFile(source, chosen.filePath);
        const stat = await fsp.stat(chosen.filePath);
        // 只回文件名，不回用户选的那个绝对路径 —— 渲染进程不需要知道
        // 用户把东西存到了哪里。
        return { ok: true, savedName: path.basename(chosen.filePath), sizeBytes: stat.size };
      } catch (err) {
        return { ok: false, savedName: null, sizeBytes: 0, message: (err as Error).message };
      }
    }
  );

  registerHandler<{ id: string }, void>(
    CHANNELS.artifactsShowInFolder,
    artifactIdRequestSchema,
    (request) => {
      const store = artifactStore();
      const record = store.require(request.id);
      shell.showItemInFolder(store.absolutePathOf(record));
    }
  );

  registerHandler<{ id: string }, ArtifactMutationResult>(
    CHANNELS.artifactsTrash,
    artifactIdRequestSchema,
    (request) => {
      try {
        // 软删：只写 status 与 deleted_at，磁盘文件一个字节不动。
        return { ok: true, record: artifactStore().setStatus(request.id, "trashed") };
      } catch (err) {
        return failure((err as Error).message);
      }
    }
  );

  registerHandler<{ id: string }, ArtifactMutationResult>(
    CHANNELS.artifactsRestore,
    artifactIdRequestSchema,
    (request) => {
      try {
        const store = artifactStore();
        const restored = store.setStatus(request.id, "ready");
        // 恢复之后立刻复核一次 hash：文件在回收站期间可能被外部改过，
        // 直接置 ready 等于对外宣称一个不再成立的 sha256。
        return { ok: true, record: store.verify(restored.id) };
      } catch (err) {
        return failure((err as Error).message);
      }
    }
  );

  registerHandler<{ id: string; otherId: string }, ArtifactComparison>(
    CHANNELS.artifactsCompareVersions,
    artifactCompareRequestSchema,
    (request) => artifactStore().compare(request.id, request.otherId)
  );
}

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）。
 *
 * 在途跟踪表 + sqlite 句柄。**artifacts.db 里的记录与磁盘上的产物文件一个
 * 都不动** —— 规则 5：卸载与删数据是两个动作。禁用产物库之后再启用，用户
 * 应该原样看到他之前的东西。
 */
export function disposeArtifactResources(): void {
  disposeArtifactTracking();
  closeArtifactStore();
}

/**
 * Workspace 文件服务的 IPC handler（FS-101）——**恰 8 条通道**。
 *
 * 跨进程边界上只有 relativePath：canonical root 与文件真实位置只活在主
 * 进程。任何一条 handler 的返回值里出现绝对路径，都会让 TASK-007 建立的
 * capability 化在这一域失效 —— 单测据此断言返回值 JSON 序列化后不含
 * workspace canonical root 子串。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame / schema / 尺寸 / 限流）在那里写死。
 */
import { BrowserWindow } from "electron";
import {
  CHANNELS,
  PUSH_CHANNELS,
  attachmentCreateRequestSchema,
  fileMutateRequestSchema,
  fileReadRequestSchema,
  fileSaveRequestSchema,
  treeListRequestSchema,
  treeWatchRequestSchema,
  workspaceSearchCancelSchema,
  workspaceSearchRequestSchema,
  type AttachmentDescriptor,
  type FileMutateResult,
  type FileTreePage,
  type InvokeChannel,
  type WorkspaceSearchPage,
} from "@pibuddy/contract";
import fsp from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";

import { createAttachment } from "../attachment-registry.js";
import { registerHandler } from "../ipc-guard.js";
import { resolveInWorkspace, requireWorkspaceRoot } from "../workspace-registry.js";
import {
  closeAllWatchers,
  closeWatchers,
  listDir,
  setTreeChangeListener,
  unwatchDir,
  watchDir,
} from "./file-tree.js";
import { readFile, saveFile } from "./file-editor.js";
import { disposeAllSearchWorkers, disposeSearchWorker, search } from "./search-worker.js";
import { workspaceStore } from "./workspace-store.js";

/**
 * 本域注册的全部通道。
 *
 * 导出成常量而不是散在下面的调用里：单测据它断言「恰 8 条且逐一出现在
 * ipc-guard 的注册表中」，多挂一条或漏挂一条都会立刻失败，而不是等到
 * 用户点到那个按钮才发现。
 */
export const WORKSPACE_CHANNELS: InvokeChannel[] = [
  CHANNELS.workspaceTreeList,
  CHANNELS.workspaceTreeWatch,
  CHANNELS.workspaceSearch,
  CHANNELS.workspaceSearchCancel,
  CHANNELS.workspaceFileRead,
  CHANNELS.workspaceFileSave,
  CHANNELS.workspaceFileMutate,
  CHANNELS.workspaceAttachmentCreate,
];

/** 破坏性动作预览里最多列出的条目数。 */
const AFFECTED_PREVIEW_LIMIT = 20;

/** requestId → AbortController，供 workspace:search-cancel 取消在跑的搜索。 */
const inflight = new Map<string, AbortController>();

/**
 * 递归列出一个目录下的相对路径（用于「删除会影响哪些文件」的精确预览）。
 *
 * 上限 AFFECTED_PREVIEW_LIMIT + 1：用户要的是「大概多少、都有啥」，
 * 为了一个确认对话框去遍历十万个文件是本末倒置。
 */
async function affectedUnder(absDir: string, baseRel: string): Promise<string[]> {
  const out: string[] = [];
  const stack: { abs: string; rel: string }[] = [{ abs: absDir, rel: baseRel }];
  while (stack.length > 0 && out.length <= AFFECTED_PREVIEW_LIMIT) {
    const cur = stack.pop() as { abs: string; rel: string };
    let entries;
    try {
      entries = await fsp.readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = `${cur.rel}/${entry.name}`;
      out.push(rel);
      if (out.length > AFFECTED_PREVIEW_LIMIT) break;
      if (entry.isDirectory()) stack.push({ abs: path.join(cur.abs, entry.name), rel });
    }
  }
  return out;
}

/**
 * 目标路径的收容校验。
 *
 * rename / move / copy 的目标**通常还不存在**，而 resolveInWorkspace 会
 * realpath 目标、对不存在的路径直接抛错。因此这里先解析它的父目录（那是
 * 存在的、且要经收容判定），再把文件名拼上去 —— 收容判定仍然只有
 * resolveInWorkspace 一个实现（CT-18），本函数不新增第二套判据。
 */
async function resolveNewPath(workspaceId: string, relativePath: string): Promise<string> {
  const posix = relativePath.split(path.sep).join("/");
  const slash = posix.lastIndexOf("/");
  const parentRel = slash === -1 ? "" : posix.slice(0, slash);
  const name = slash === -1 ? posix : posix.slice(slash + 1);
  if (name === "" || name === "." || name === "..") {
    throw new Error(`PATH_INVALID: ${relativePath}`);
  }
  const parent = await resolveInWorkspace(workspaceId, parentRel);
  if (!parent.isDirectory) throw new Error(`PATH_NOT_A_DIRECTORY: ${parentRel}`);
  return path.join(parent.realPath, name);
}

/** untrusted 工作区一律不给写：信任是用户明确表过态的，不是默认值。 */
function assertWritable(workspaceId: string): void {
  const profile = workspaceStore().get(workspaceId);
  if (profile && profile.trust === "untrusted") {
    throw new Error("WORKSPACE_UNTRUSTED");
  }
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export function registerWorkspaceIpc(): void {
  // 文件树的变更事件转成 push：只说「这一层脏了」，不推整层条目 ——
  // 推整层的话，一次 npm install 会在几秒内推出几万条消息。
  setTreeChangeListener((workspaceId, relativePath) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(PUSH_CHANNELS.workspaceTreeEvent, { workspaceId, relativePath });
    }
  });

  // ------------------------------------------------------------------ 树

  registerHandler(
    CHANNELS.workspaceTreeList,
    treeListRequestSchema,
    async (payload): Promise<FileTreePage> => {
      // 首次访问某工作区时补一条档案（ignore 策略 / 默认模型挂在它上面）
      workspaceStore().open(requireWorkspaceRoot(payload.workspaceId));
      return listDir(payload.workspaceId, payload.relativePath, {
        includeIgnored: payload.includeIgnored,
        limit: payload.limit,
      });
    }
  );

  registerHandler(CHANNELS.workspaceTreeWatch, treeWatchRequestSchema, async (payload) => {
    if (payload.watching) await watchDir(payload.workspaceId, payload.relativePath);
    else unwatchDir(payload.workspaceId, payload.relativePath);
  });

  // --------------------------------------------------------------- 搜索

  registerHandler(
    CHANNELS.workspaceSearch,
    workspaceSearchRequestSchema,
    async (payload): Promise<WorkspaceSearchPage> => {
      // 同一个 requestId 再来一次 = 用户又敲了一个字：先取消上一次
      inflight.get(payload.requestId)?.abort();
      const controller = new AbortController();
      inflight.set(payload.requestId, controller);
      try {
        return await search({
          workspaceId: payload.workspaceId,
          query: payload.query,
          mode: payload.mode,
          limit: payload.limit,
          cursor: payload.cursor ?? null,
          requestId: payload.requestId,
          signal: controller.signal,
        });
      } finally {
        if (inflight.get(payload.requestId) === controller) inflight.delete(payload.requestId);
      }
    }
  );

  registerHandler(CHANNELS.workspaceSearchCancel, workspaceSearchCancelSchema, (payload) => {
    inflight.get(payload.requestId)?.abort();
  });

  // --------------------------------------------------------------- 读写

  registerHandler(CHANNELS.workspaceFileRead, fileReadRequestSchema, (payload) =>
    readFile({ workspaceId: payload.workspaceId, relativePath: payload.relativePath })
  );

  registerHandler(CHANNELS.workspaceFileSave, fileSaveRequestSchema, (payload) => {
    assertWritable(payload.workspaceId);
    return saveFile(payload);
  });

  // ------------------------------------------------------------ 文件变更

  registerHandler(
    CHANNELS.workspaceFileMutate,
    fileMutateRequestSchema,
    async (payload): Promise<FileMutateResult> => {
      assertWritable(payload.workspaceId);
      try {
        switch (payload.kind) {
          case "create-dir": {
            const abs = await resolveNewPath(payload.workspaceId, payload.relativePath);
            await fsp.mkdir(abs, { recursive: true });
            return { ok: true, relativePath: toPosix(payload.relativePath) };
          }
          case "create-file": {
            const abs = await resolveNewPath(payload.workspaceId, payload.relativePath);
            // wx：目标已存在就失败，绝不悄悄清空一个同名文件
            await fsp.writeFile(abs, "", { flag: "wx" });
            return { ok: true, relativePath: toPosix(payload.relativePath) };
          }
          case "rename":
          case "move": {
            if (!payload.targetPath) throw new Error("TARGET_REQUIRED");
            const from = await resolveInWorkspace(payload.workspaceId, payload.relativePath);
            const to = await resolveNewPath(payload.workspaceId, payload.targetPath);
            await fsp.rename(from.realPath, to);
            return { ok: true, relativePath: toPosix(payload.targetPath) };
          }
          case "copy": {
            if (!payload.targetPath) throw new Error("TARGET_REQUIRED");
            const from = await resolveInWorkspace(payload.workspaceId, payload.relativePath);
            const to = await resolveNewPath(payload.workspaceId, payload.targetPath);
            await fsp.cp(from.realPath, to, { recursive: true, force: false, errorOnExist: true });
            return { ok: true, relativePath: toPosix(payload.targetPath) };
          }
          case "trash": {
            const target = await resolveInWorkspace(payload.workspaceId, payload.relativePath);
            // 破坏性动作要显示精确范围：删一个目录时到底会带走哪些东西
            const affected = target.isDirectory
              ? await affectedUnder(target.realPath, toPosix(target.relativePath))
              : [toPosix(target.relativePath)];
            // 走系统回收站而不是 unlink：用户还能捞回来
            await shell.trashItem(target.realPath);
            return { ok: true, relativePath: toPosix(target.relativePath), affected };
          }
          default:
            return { ok: false, errorCode: "missing", message: "不支持的操作" };
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (code === "EACCES" || code === "EPERM") {
          return { ok: false, errorCode: "permission", message: "没有权限执行这个操作" };
        }
        if (code === "ENOSPC") {
          return { ok: false, errorCode: "disk", message: "磁盘空间不足" };
        }
        return { ok: false, errorCode: "missing", message: (err as Error).message };
      }
    }
  );

  // ------------------------------------------------------ 结构化附件引用

  registerHandler(
    CHANNELS.workspaceAttachmentCreate,
    attachmentCreateRequestSchema,
    async (payload): Promise<AttachmentDescriptor> => {
      const resolved = await resolveInWorkspace(payload.workspaceId, payload.relativePath, {
        requireFile: true,
      });
      return createAttachment(resolved.realPath, {
        workspaceId: payload.workspaceId,
        access: payload.capability ?? "read",
      });
    }
  );
}

/**
 * 关闭一个工作区时的整批清理。
 *
 * watcher 与搜索子进程都是**看不见的**泄漏：前者的表现是几小时后文件树
 * 停止刷新，后者的表现是任务管理器里越攒越多的子进程。两者都不会报错。
 */
export function disposeWorkspaceResources(workspaceId: string): void {
  closeWatchers(workspaceId);
  disposeSearchWorker(workspaceId);
}

/** 应用退出时的整体清理。 */
export function disposeAllWorkspaceResources(): void {
  setTreeChangeListener(null);
  closeAllWatchers();
  disposeAllSearchWorkers();
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
}

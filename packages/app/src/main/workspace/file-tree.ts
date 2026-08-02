/**
 * 惰性文件树：列一层、监听一层（FS-101）。
 *
 * ## 为什么只列一层
 *
 * 递归列目录在「用户的工作文件夹」这个场景下是没有上界的：一个装了
 * `node_modules` 的前端仓库轻松上十万个文件，一次递归 readdir 就把主进程
 * 按住好几秒，而这几秒里窗口是完全不响应的。惰性展开把代价摊到用户真正
 * 点开的那几层上。
 *
 * ## 为什么单层还要再设 5000 的上限
 *
 * 「一层」也可以很大 —— 缓存目录、日志目录、导出的图片目录，几万个同级
 * 文件是常态。超过上限返回 `{truncated:true, total}` 让 UI 显示「目录过大，
 * 已折叠」，而不是把几万个条目序列化过 IPC 再建几万个 DOM 节点。
 *
 * ## 符号链接为什么不跟随
 *
 * 跟随符号链接有两个后果，都不可接受：一是 `a → ..` 这类自指链接让遍历
 * 无限循环；二是指向工作区外的链接会把外部文件当成工作区内容展示出来 ——
 * 而收容判定（resolveInWorkspace）在**每次**解析路径时都会 realpath，
 * 于是 UI 里看得见、点开就报错，是最难排查的一类不一致。这里用 lstat
 * 判定并标记 `isSymlink`，展开动作在 UI 层就不给。
 *
 * ## watcher 的引用计数
 *
 * 展开一次建一个 watcher、折叠时不关，是 fs.watch 句柄泄漏最常见的写法。
 * 表现极其隐蔽：应用开着几小时之后文件树突然不再自动刷新（句柄用尽），
 * 而这期间没有任何报错。这里对同一目录做引用计数，归零即 close，
 * 工作区关闭时整批 close。
 */
import type { FileTreeEntry, FileTreePage } from "@pibuddy/contract";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { buildIgnoreMatcher, isIgnored } from "./ignore-rules.js";
import { resolveInWorkspace, requireWorkspaceRoot } from "../workspace-registry.js";
import { ignorePolicyFor } from "./workspace-store.js";

/** 单层目录的默认条目上限。超过它即 truncated。 */
export const DIR_ENTRY_LIMIT = 5000;

// ---------------------------------------------------------------- 列目录

export interface ListDirOptions {
  includeIgnored?: boolean;
  limit?: number;
}

/**
 * 列一层目录。
 *
 * `relativePath` 为空串表示 workspace root 自身 —— 这是全计划唯一口径
 * （CT-18），收容判定复用 resolveInWorkspace，本文件不另建原语。
 */
export async function listDir(
  workspaceId: string,
  relativePath: string,
  options: ListDirOptions = {}
): Promise<FileTreePage> {
  const resolved = await resolveInWorkspace(workspaceId, relativePath);
  if (!resolved.isDirectory) throw new Error(`PATH_NOT_A_DIRECTORY: ${relativePath}`);

  const root = requireWorkspaceRoot(workspaceId);
  const matcher = buildIgnoreMatcher(root, ignorePolicyFor(workspaceId));
  const limit = options.limit ?? DIR_ENTRY_LIMIT;

  const dirents = await fsp.readdir(resolved.realPath, { withFileTypes: true });
  const entries: FileTreeEntry[] = [];
  /** 该目录的真实条目总数（含被 ignore 掉的）。UI 上「多大」按它显示。 */
  let total = 0;
  /**
   * 因为**撞上限**而没被返回的条目数。
   *
   * 与「被 ignore 规则挡掉」严格分开：早先两者混在一个 `total > entries.length`
   * 的判据里，于是任何含 node_modules 的目录都会被报成「目录过大」——
   * 工作区根几乎必然中招，用户第一眼看到的就是一条说 9 个文件太多的提示，
   * 而真正的五千项目录反倒一声不吭地把五千个节点铺进 DOM。
   */
  let omittedByLimit = 0;

  for (const dirent of dirents) {
    const childRel = (resolved.relativePath ? `${resolved.relativePath}/` : "") + dirent.name;
    const posixRel = childRel.split(path.sep).join("/");
    // isDirectory() 在 withFileTypes 下对符号链接恒为 false（readdir 不跟随），
    // 因此这里的 isDir 已经是「真目录」的含义。
    const isSymlink = dirent.isSymbolicLink();
    const isDir = dirent.isDirectory();
    const ignored = isIgnored(matcher, posixRel, isDir);
    if (ignored && !options.includeIgnored) {
      // 仍然计入 total：UI 上「目录过大」的判断要按真实条目数算
      total++;
      continue;
    }
    total++;
    if (entries.length >= limit) {
      omittedByLimit++;
      continue;
    }

    let sizeBytes = 0;
    let mtimeMs = 0;
    try {
      // lstat 而不是 stat：符号链接指向的东西可能在工作区外，甚至根本不存在
      const st = await fsp.lstat(path.join(resolved.realPath, dirent.name));
      sizeBytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // 列目录到一半文件被删了：跳过尺寸，条目本身仍然列出来
    }
    entries.push({
      relativePath: posixRel,
      name: dirent.name,
      isDirectory: isDir,
      isSymlink,
      sizeBytes,
      mtimeMs,
      ignored,
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });

  return {
    relativePath: resolved.relativePath.split(path.sep).join("/"),
    entries,
    truncated: omittedByLimit > 0,
    total,
  };
}

// ---------------------------------------------------------------- watcher

interface WatchEntry {
  watcher: fs.FSWatcher;
  refCount: number;
}

const watchers = new Map<string, WatchEntry>();

function watchKey(workspaceId: string, relativePath: string): string {
  return `${workspaceId}::${relativePath}`;
}

export type TreeChangeListener = (workspaceId: string, relativePath: string) => void;

let listener: TreeChangeListener | null = null;

/** 注册文件树变更的回调（由 workspace-ipc 接到 push 通道上）。 */
export function setTreeChangeListener(next: TreeChangeListener | null): void {
  listener = next;
}

/**
 * 监听一层目录。同一目录重复调用只增加引用计数，不会建第二个 watcher。
 */
export async function watchDir(workspaceId: string, relativePath: string): Promise<void> {
  const key = watchKey(workspaceId, relativePath);
  const existing = watchers.get(key);
  if (existing) {
    existing.refCount++;
    return;
  }
  const resolved = await resolveInWorkspace(workspaceId, relativePath);
  if (!resolved.isDirectory) throw new Error(`PATH_NOT_A_DIRECTORY: ${relativePath}`);
  const posixRel = resolved.relativePath.split(path.sep).join("/");

  // recursive:false 是刻意的：递归监听在 Windows 上会把整棵子树挂上去，
  // 一次 `npm install` 能打出几十万个事件。
  const watcher = fs.watch(resolved.realPath, { persistent: false }, () => {
    listener?.(workspaceId, posixRel);
  });
  // watcher 自身出错（目录被删/被移走）不该把主进程带崩
  watcher.on("error", () => unwatchDir(workspaceId, relativePath));
  watchers.set(key, { watcher, refCount: 1 });
}

/** 取消监听。引用计数归零时才真的 close。 */
export function unwatchDir(workspaceId: string, relativePath: string): void {
  const key = watchKey(workspaceId, relativePath);
  const entry = watchers.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  entry.watcher.close();
  watchers.delete(key);
}

/** 当前活跃 watcher 数量。单测据它断言句柄不泄漏。 */
export function activeWatcherCount(): number {
  return watchers.size;
}

/** 关闭某个工作区的全部 watcher（切换 / 关闭工作区时调用）。 */
export function closeWatchers(workspaceId: string): number {
  let closed = 0;
  for (const [key, entry] of [...watchers]) {
    if (!key.startsWith(`${workspaceId}::`)) continue;
    entry.watcher.close();
    watchers.delete(key);
    closed++;
  }
  return closed;
}

/** 关闭全部 watcher（应用退出）。 */
export function closeAllWatchers(): number {
  const count = watchers.size;
  for (const entry of watchers.values()) entry.watcher.close();
  watchers.clear();
  return count;
}

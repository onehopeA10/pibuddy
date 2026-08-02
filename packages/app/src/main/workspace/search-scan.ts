/**
 * 搜索的实际扫描逻辑（FS-101）。
 *
 * 本文件**不 import electron**：它既跑在 utility process 里，也被单测直接
 * 调用。把「怎么扫」和「跑在哪个进程里」分开的好处是，扫描本身可以被
 * 完整测到，而不必在测试里起一个真的子进程。
 *
 * 三条硬约束写死在这里，而不是交给调用方自觉：
 *   1. 结果里只有 relativePath —— 绝对路径连出口都没有；
 *   2. preview 硬截断到 200 字符 —— 一行 40 万字符的压缩产物能把 IPC 打满；
 *   3. 命中数达到 limit 立刻停 —— 「搜一个 e」不该扫完整个仓库。
 */
import type { WorkspaceSearchHit, WorkspaceSearchPage } from "@pibuddy/contract";
import fs from "node:fs";
import path from "node:path";

import { buildIgnoreMatcher, isIgnored } from "./ignore-rules.js";

/** 单条预览的最大字符数。 */
export const SEARCH_PREVIEW_MAX = 200;

/** 单次搜索的默认命中上限。 */
export const SEARCH_DEFAULT_LIMIT = 200;

/** 参与正文搜索的单文件字节上限。超过它只按文件名匹配。 */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;

/** 一次扫描最多遍历的文件数，防止在符号链接环上打转。 */
const MAX_FILES_PER_SCAN = 50000;

export interface ScanParams {
  root: string;
  query: string;
  mode: "name" | "content";
  limit: number;
  /** `${fileIndex}:${lineIndex}`，从上一页的 nextCursor 原样带回来 */
  cursor: string | null;
  ignorePolicy: string[];
}

function parseCursor(cursor: string | null): { fileIndex: number; lineIndex: number } {
  if (!cursor) return { fileIndex: 0, lineIndex: 0 };
  const [f, l] = cursor.split(":");
  return { fileIndex: Number(f) || 0, lineIndex: Number(l) || 0 };
}

/**
 * 广度优先枚举工作区里的文件，返回相对路径列表（顺序稳定）。
 *
 * 顺序必须稳定，否则分页游标 `${fileIndex}:${lineIndex}` 在两次调用之间
 * 指向的不是同一个文件 —— 表现是翻页时结果跳来跳去还会漏。
 */
function collectFiles(root: string, ignorePolicy: string[]): string[] {
  const matcher = buildIgnoreMatcher(root, ignorePolicy);
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && out.length < MAX_FILES_PER_SCAN) {
    const rel = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // 符号链接一律不跟随：`a -> ..` 这类自指链接会让遍历无限打转
      if (entry.isSymbolicLink()) continue;
      const isDir = entry.isDirectory();
      if (isIgnored(matcher, childRel, isDir)) continue;
      if (isDir) stack.push(childRel);
      else out.push(childRel);
    }
  }
  out.sort();
  return out;
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SEARCH_PREVIEW_MAX ? oneLine.slice(0, SEARCH_PREVIEW_MAX) : oneLine;
}

/**
 * 执行一次扫描。
 *
 * `shouldStop` 由调用方提供（子进程收到 cancel 后翻转它）：没有它的话，
 * 「取消搜索」只能等这一趟扫完，而在一个大仓库上那可能是好几秒。
 */
export function runSearchScan(
  params: ScanParams,
  shouldStop: () => boolean = () => false
): WorkspaceSearchPage {
  const needle = params.query.toLowerCase();
  const limit = params.limit > 0 ? params.limit : SEARCH_DEFAULT_LIMIT;
  const start = parseCursor(params.cursor);
  const files = collectFiles(params.root, params.ignorePolicy);

  const items: WorkspaceSearchHit[] = [];
  let nextCursor: string | null = null;
  let truncated = false;

  for (let fi = start.fileIndex; fi < files.length; fi++) {
    if (shouldStop()) return { items, nextCursor, truncated, cancelled: true };
    const rel = files[fi];

    if (params.mode === "name") {
      if (rel.toLowerCase().includes(needle)) {
        items.push({ relativePath: rel, line: 0, preview: clip(rel) });
        if (items.length >= limit) {
          truncated = fi + 1 < files.length;
          nextCursor = truncated ? `${fi + 1}:0` : null;
          return { items, nextCursor, truncated, cancelled: false };
        }
      }
      continue;
    }

    const abs = path.join(params.root, rel);
    let text: string;
    try {
      if (fs.statSync(abs).size > SEARCH_MAX_FILE_BYTES) continue;
      const buffer = fs.readFileSync(abs);
      // NUL 字节 = 二进制，正文搜索对它没有意义
      if (buffer.includes(0)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    const from = fi === start.fileIndex ? start.lineIndex : 0;
    for (let li = from; li < lines.length; li++) {
      if (shouldStop()) return { items, nextCursor, truncated, cancelled: true };
      if (!lines[li].toLowerCase().includes(needle)) continue;
      items.push({ relativePath: rel, line: li + 1, preview: clip(lines[li]) });
      if (items.length >= limit) {
        truncated = true;
        nextCursor = `${fi}:${li + 1}`;
        return { items, nextCursor, truncated, cancelled: false };
      }
    }
  }

  return { items, nextCursor: null, truncated: false, cancelled: false };
}

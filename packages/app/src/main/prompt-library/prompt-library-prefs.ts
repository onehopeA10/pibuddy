/**
 * 提示词库的界面偏好（收藏 / 隐藏预置项）。
 *
 * ## 为什么不写进 .md 文件
 *
 * `~/.pi/agent/prompts/*.md` 是 **pi 的资源**：往 frontmatter 里塞
 * `pibuddy-favorite` 之类的界面状态，等于让「用户点了个星标」去改动 pi 的
 * 加载面文件（mtime 变、diff 变、同步工具全跟着动）。收藏与隐藏是 PiBuddy
 * 自己的展示偏好，落在 userData 的独立 JSON 里 —— 与 capability-prefs.json
 * 同一手法（独立文件、坏了回默认、绝不让应用起不来）。
 *
 * 键是 prompt 的 name（文件名去 .md）：它跨重启稳定，且用户在终端里改文件
 * 内容也不会让收藏丢失。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "../fs-atomic.js";

export const PROMPT_LIBRARY_PREFS_FILENAME = "prompt-library-prefs.json";

export interface PromptLibraryPrefs {
  schemaVersion: number;
  /** 收藏的 prompt name 集合 */
  favorites: string[];
  /** 被隐藏的**预置** prompt name 集合（文件不动，只是列表里不显示） */
  hidden: string[];
}

/** 测试注入用；生产环境恒为 null。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把偏好文件指向临时目录。 */
export function __setPromptLibraryPrefsDir(dir: string | null): void {
  dataDirOverride = dir;
}

function prefsPath(): string {
  return path.join(dataDirOverride ?? app.getPath("userData"), PROMPT_LIBRARY_PREFS_FILENAME);
}

function normalize(raw: unknown): PromptLibraryPrefs {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : [];
  return { schemaVersion: 1, favorites: names(source.favorites), hidden: names(source.hidden) };
}

export function loadPromptLibraryPrefs(): PromptLibraryPrefs {
  try {
    return normalize(JSON.parse(fs.readFileSync(prefsPath(), "utf8")));
  } catch {
    return normalize(null);
  }
}

export function savePromptLibraryPrefs(prefs: PromptLibraryPrefs): void {
  writeJsonAtomic(prefsPath(), { ...prefs, schemaVersion: 1 });
}

/** 在集合里增删一个 name（幂等）。 */
export function togglePrefName(list: string[], name: string, present: boolean): string[] {
  const set = new Set(list);
  if (present) set.add(name);
  else set.delete(name);
  return [...set];
}

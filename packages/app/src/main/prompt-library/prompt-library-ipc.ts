/**
 * 提示词库的 IPC handler（common.prompt-library，恰 6 条）。
 *
 * 与 memory-ipc / pi-resources-ipc 同构：本文件不出现 ipcMain.handle，注册
 * 一律经 ipc-guard 的 registerHandler；注册与否由 CapabilityRegistry 的解析
 * 结果决定（能力未启用时本函数一次都不被调用），因此这里没有 feature gate 的 if。
 *
 * ## 两条边界
 *
 *  1. **渲染进程给不出路径**。六条通道的入参只有不透明 entry id 与结构化
 *     文本字段；id → 文件路径的换算靠本模块的扫描缓存（与 pi-resources 的
 *     lastScan 同一手法），缓存里查不到就重扫一次。
 *  2. **预置项可隐藏不可删不可改**。这条规则钉在文件层
 *     （prompt-library-files.ts 按归属标记拒绝），这里只是把错误原样抛给
 *     渲染进程 —— 两处各自把关，绕过任何一处都还有另一处。
 *
 * ## 物化时机
 *
 * 预置提示词的物化挂在 `list` 的最前面（listPromptLibrary 内部），不挂在
 * 应用启动钩子上：主界面挂载即拉一次列表，首启动因此就会把预置铺进
 * `~/.pi/agent/prompts/`；此后每次 list 因幂等而零成本。挂启动钩子的问题
 * 是单测里 registerAllIpc 会真的往开发者的 home 里写文件。
 */
import { app } from "electron";
import os from "node:os";
import path from "node:path";

import {
  CHANNELS,
  promptCreateRequestSchema,
  promptIdRequestSchema,
  promptSetFavoriteRequestSchema,
  promptSetHiddenRequestSchema,
  promptUpdateRequestSchema,
  voidRequestSchema,
  type PromptLibraryListResult,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import {
  createUserPromptFile,
  deleteUserPromptFile,
  listPromptLibrary,
  updateUserPromptFile,
  type ScannedPrompt,
} from "./prompt-library-files.js";
import {
  loadPromptLibraryPrefs,
  savePromptLibraryPrefs,
  togglePrefName,
} from "./prompt-library-prefs.js";

/** 本能力的 6 条通道。单测据它断言注册面。 */
export const PROMPT_LIBRARY_CHANNELS = [
  CHANNELS.promptLibraryList,
  CHANNELS.promptLibraryCreate,
  CHANNELS.promptLibraryUpdate,
  CHANNELS.promptLibraryDelete,
  CHANNELS.promptLibrarySetFavorite,
  CHANNELS.promptLibrarySetHidden,
] as const;

/** 测试注入用的目录覆盖；生产环境恒为 null。 */
let dirsOverride: { presetDir: string; promptsDir: string } | null = null;

/** 仅供单测：把预置目录与 prompts 目录指向临时位置。 */
export function __setPromptLibraryDirs(
  dirs: { presetDir: string; promptsDir: string } | null
): void {
  dirsOverride = dirs;
  lastScan.clear();
}

function resolveDirs(): { presetDir: string; promptsDir: string } {
  if (dirsOverride) return dirsOverride;
  // 打包形态：extraResources 把 resources/prompt-library 投递到
  // process.resourcesPath/prompt-library（electron-builder.yml）。
  // 开发形态：直接读仓库里的 packages/app/resources/prompt-library。
  const presetDir = app.isPackaged
    ? path.join(process.resourcesPath, "prompt-library")
    : path.join(app.getAppPath(), "resources", "prompt-library");
  return {
    presetDir,
    promptsDir: path.join(os.homedir(), ".pi", "agent", "prompts"),
  };
}

/**
 * 最近一次扫描结果，按 id 索引。
 *
 * 存在的唯一理由是 update / delete：渲染进程只持有不透明 id，文件路径
 * 得由主进程换。查不到就重扫一次 —— 静默失败会让「删除」按钮变成一个
 * 点了没反应的装饰品（与 pi-resources 的 lastScan 同一取舍）。
 */
const lastScan = new Map<string, ScannedPrompt>();

async function doList(): Promise<PromptLibraryListResult> {
  const dirs = resolveDirs();
  const result = await listPromptLibrary(dirs);
  const prefs = loadPromptLibraryPrefs();
  const favorites = new Set(prefs.favorites);
  const hidden = new Set(prefs.hidden);

  lastScan.clear();
  for (const prompt of result.prompts) lastScan.set(prompt.entry.id, prompt);

  return {
    entries: result.prompts.map((p) => ({
      ...p.entry,
      favorite: favorites.has(p.entry.name),
      // 隐藏只对预置有意义：用户项不可隐藏（可删），预置项不可删（可隐藏）。
      hidden: p.entry.preset && hidden.has(p.entry.name),
    })),
    errors: result.errors,
  };
}

async function requirePrompt(id: string): Promise<ScannedPrompt> {
  if (!lastScan.has(id)) await doList();
  const prompt = lastScan.get(id);
  if (!prompt) throw new Error(`PROMPT_UNKNOWN: ${id}`);
  return prompt;
}

export function registerPromptLibraryIpc(): void {
  registerHandler(CHANNELS.promptLibraryList, voidRequestSchema, () => doList());

  registerHandler(CHANNELS.promptLibraryCreate, promptCreateRequestSchema, async (payload) => {
    const dirs = resolveDirs();
    await createUserPromptFile({
      promptsDir: dirs.promptsDir,
      title: payload.title,
      description: payload.description,
      category: payload.category,
      content: payload.content,
    });
    return doList();
  });

  registerHandler(CHANNELS.promptLibraryUpdate, promptUpdateRequestSchema, async (payload) => {
    const prompt = await requirePrompt(payload.id);
    const { id: _id, ...patch } = payload;
    await updateUserPromptFile({ filePath: prompt.filePath, patch });
    return doList();
  });

  registerHandler(CHANNELS.promptLibraryDelete, promptIdRequestSchema, async (payload) => {
    const prompt = await requirePrompt(payload.id);
    await deleteUserPromptFile(prompt.filePath);
    return doList();
  });

  registerHandler(
    CHANNELS.promptLibrarySetFavorite,
    promptSetFavoriteRequestSchema,
    async (payload) => {
      const prompt = await requirePrompt(payload.id);
      const prefs = loadPromptLibraryPrefs();
      savePromptLibraryPrefs({
        ...prefs,
        favorites: togglePrefName(prefs.favorites, prompt.entry.name, payload.favorite),
      });
      return doList();
    }
  );

  registerHandler(
    CHANNELS.promptLibrarySetHidden,
    promptSetHiddenRequestSchema,
    async (payload) => {
      const prompt = await requirePrompt(payload.id);
      if (!prompt.entry.preset) {
        throw new Error("PROMPT_NOT_PRESET: 只有预置提示词需要隐藏；自建的可以直接删除");
      }
      const prefs = loadPromptLibraryPrefs();
      savePromptLibraryPrefs({
        ...prefs,
        hidden: togglePrefName(prefs.hidden, prompt.entry.name, payload.hidden),
      });
      return doList();
    }
  );
}

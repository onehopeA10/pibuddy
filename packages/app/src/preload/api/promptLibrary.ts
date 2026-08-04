/**
 * `window.piBuddy.promptLibrary`（common.prompt-library / REQ-0001 R1）。
 *
 * 六个方法、六条窄通道：整库快照 / 新建 / 编辑 / 删除 / 收藏 / 隐藏预置项。
 * 渲染进程能表达的极限就是这六个意图 —— 没有任何路径或文件名形参，写到
 * 哪个文件由主进程按不透明 id 换算。「一键填入输入框」不在这里：快照里
 * 已带模板正文，填入是渲染侧对 composer 的一次赋值，不需要通道。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  PromptCategory,
  PromptLibraryListResult,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const promptLibrary = {
  /** 整库快照（按分类分组、搜索、收藏都在渲染侧做，不再发第二条通道）。 */
  list: () => invoke<PromptLibraryListResult>(CHANNELS.promptLibraryList),

  /** 新建一条用户提示词（文件名由主进程从标题生成，绝不覆盖现有文件）。 */
  create: (input: {
    title: string;
    description: string;
    category: PromptCategory;
    content: string;
  }) => invoke<PromptLibraryListResult>(CHANNELS.promptLibraryCreate, input),

  /** 编辑一条用户提示词（预置项主进程直接拒绝）。 */
  update: (input: {
    id: string;
    title?: string;
    description?: string;
    category?: PromptCategory;
    content?: string;
  }) => invoke<PromptLibraryListResult>(CHANNELS.promptLibraryUpdate, input),

  /** 删除一条用户提示词（预置项不可删，只能隐藏）。 */
  delete: (id: string) => invoke<PromptLibraryListResult>(CHANNELS.promptLibraryDelete, { id }),

  /** 收藏 / 取消收藏（预置与用户项都可收藏）。 */
  setFavorite: (id: string, favorite: boolean) =>
    invoke<PromptLibraryListResult>(CHANNELS.promptLibrarySetFavorite, { id, favorite }),

  /** 隐藏 / 恢复一条预置提示词（文件不动，pi 里照常可用）。 */
  setHidden: (id: string, hidden: boolean) =>
    invoke<PromptLibraryListResult>(CHANNELS.promptLibrarySetHidden, { id, hidden }),
};

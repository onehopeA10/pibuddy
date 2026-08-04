/**
 * `window.piBuddy.edu`（edu.kids / REQ-0001 R3，首个真内容垂直包）。
 *
 * 三个方法、三条窄通道。渲染进程能表达的极限是「读/写当前工作区的孩子档案、
 * 读当前工作区的错题本」——**没有**任何路径形参（错题本位置是 SKILL.md 与
 * 主进程共同钉死的工作区相对约定），也没有「生成题目」入口：出题是 pi 回路
 * 内工具（edu.kids.math_worksheet），在会话里由 agent 调用，主进程与 preload
 * 都不复制一份出题面。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { EduMistakeListResult, EduProfileResult, EduSubjectId } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const edu = {
  /** 读当前工作区的孩子档案；还没设置过时 profile 为 null。 */
  profileGet: (workspaceId: string) =>
    invoke<EduProfileResult>(CHANNELS.eduProfileGet, { workspaceId }),

  /** 整份替换孩子档案（updatedAt 由主进程盖）。 */
  profileSet: (workspaceId: string, childName: string, grade: number, subjects: EduSubjectId[]) =>
    invoke<EduProfileResult>(CHANNELS.eduProfileSet, { workspaceId, childName, grade, subjects }),

  /** 读工作区错题本（edu-kids/mistakes.jsonl），按日期倒序、条数有界。 */
  mistakeList: (workspaceId: string, limit = 200) =>
    invoke<EduMistakeListResult>(CHANNELS.eduMistakeList, { workspaceId, limit }),
};

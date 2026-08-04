/**
 * 儿童教育能力包的 IPC handler（edu.kids，恰 3 条通道）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * ## 三条通道就是全部的主进程面
 *
 * 档案读写（userData 分区落盘）+ 错题本读取（工作区固定相对路径）。出题
 * 不在这里——`edu.kids.math_worksheet` 是 pi 回路内工具（extension），由
 * R4 物化通道装进 ~/.pi/agent/extensions，agent 在会话里调用；讲解、复习卷
 * 生成归 prompts / skills（模型侧）。主进程不复制任何一份出题逻辑到 IPC 面，
 * 「一键出卷」在渲染侧只是把组好的指令填进输入框。
 *
 * ## 错题本路径为什么写死
 *
 * `EDU_MISTAKE_FILE_RELATIVE` 是 SKILL.md（agent 写入）与本文件（面板读取）
 * 共同钉死的工作区相对路径。入参只有 workspaceId——渲染进程在结构上表达
 * 不出「读任意文件」，根经 requireWorkspaceRoot 收容（与 session-tree 读
 * 会话 JSONL 同一手法）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CHANNELS,
  EDU_MISTAKE_FILE_RELATIVE,
  eduMistakeListRequestSchema,
  eduProfileGetRequestSchema,
  eduProfileSetRequestSchema,
  type EduMistakeListResult,
  type EduProfileResult,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { parseMistakeJsonl } from "./edu-mistakes.js";
import { loadEduProfile, saveEduProfile } from "./edu-profile-store.js";

/** 本能力注册的全部通道。导出成常量供 drift test 与自测对账「恰 3 条」。 */
export const EDU_CHANNELS = [
  CHANNELS.eduProfileGet,
  CHANNELS.eduProfileSet,
  CHANNELS.eduMistakeList,
] as const;

export function registerEduIpc(): void {
  registerHandler(
    CHANNELS.eduProfileGet,
    eduProfileGetRequestSchema,
    async (payload): Promise<EduProfileResult> => ({
      profile: loadEduProfile(payload.workspaceId),
    })
  );

  registerHandler(
    CHANNELS.eduProfileSet,
    eduProfileSetRequestSchema,
    async (payload): Promise<EduProfileResult> => ({
      profile: saveEduProfile(payload),
    })
  );

  registerHandler(
    CHANNELS.eduMistakeList,
    eduMistakeListRequestSchema,
    async (payload): Promise<EduMistakeListResult> => {
      const root = requireWorkspaceRoot(payload.workspaceId);
      const file = path.join(root, ...EDU_MISTAKE_FILE_RELATIVE.split("/"));
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        // 还没记过错题：不是错误，面板据 exists=false 显示空态与记录指引。
        return { exists: false, entries: [], skipped: 0, total: 0 };
      }
      const parsed = parseMistakeJsonl(text, payload.limit);
      return { exists: true, ...parsed };
    }
  );
}

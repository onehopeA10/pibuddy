/**
 * 预置办公技能包的 IPC handler（common.office-skills，恰 1 条通道）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * ## 只有 `office-skills:list` 一条，读的是 R4 归属账本
 *
 * 这个能力包的真正载荷是三个 pi 技能目录（capability-assets 随包分发，
 * 启动对账时由 syncCapabilityAssetsOnStartup 物化到 ~/.pi/agent/skills/）。
 * 技能的**执行**发生在 pi agent 里（/skill:<name>），不经过任何 IPC——
 * 因此本能力唯一需要的动作面是「告诉面板：声明的三个技能，账本里真的
 * 物化了哪些」。判据只有归属账本（pibuddy-assets.json）一个：它是物化器
 * 唯一的归属真相源，这里不自己发明第二套判断（比如去 stat 磁盘），否则
 * 「账本说有、磁盘被用户删了」这类中间态会在两套判据之间来回横跳。
 * 用户删了文件的受支持做法是重启（启用态自愈重建）或停用本包。
 *
 * ## 为什么申请 workspace.read
 *
 * 账本读取用的是 fs 的 readFile（只读、不写、不开外部程序、不出站、不碰
 * 密钥）。与 common.session-tree 读会话 JSONL 同一口径：只读文件 =
 * workspace.read，drift test 的权限对账（双向）据此闭合。
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CHANNELS,
  OFFICE_SKILLS,
  OFFICE_SKILLS_CAPABILITY_ID,
  voidRequestSchema,
  type OfficeSkillsState,
  type OfficeSkillStatus,
} from "@pibuddy/contract";

import { ASSET_LEDGER_FILENAME } from "../capability/capability-assets.js";
import { registerHandler } from "../ipc-guard.js";

/** 本能力注册的全部通道。导出成常量供 drift test 与自测对账「恰 1 条」。 */
export const OFFICE_SKILLS_CHANNELS = [CHANNELS.officeSkillsList] as const;

/** 包版本。manifest 与状态通道都引它，改版本只改这一处。 */
export const OFFICE_SKILLS_PACK_VERSION = "1.0.0";

/**
 * 读归属账本里本包名下的文件表（dest → sha256）。
 *
 * 账本不存在 / 解析失败都折成 null：面板据此显示「待重启物化」，而不是
 * 把一次坏读伪装成「三个技能都没装」以外的任何结论。
 */
async function readOwnedFiles(): Promise<Record<string, string> | null> {
  const ledgerPath = path.join(os.homedir(), ".pi", "agent", ASSET_LEDGER_FILENAME);
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const packs = (parsed as { packs?: unknown }).packs;
    if (!packs || typeof packs !== "object") return null;
    const entry = (packs as Record<string, unknown>)[OFFICE_SKILLS_CAPABILITY_ID];
    if (!entry || typeof entry !== "object") return {};
    const files = (entry as { files?: unknown }).files;
    if (!files || typeof files !== "object") return {};
    return files as Record<string, string>;
  } catch {
    return null;
  }
}

export function registerOfficeSkillsIpc(): void {
  registerHandler(
    CHANNELS.officeSkillsList,
    voidRequestSchema,
    async (): Promise<OfficeSkillsState> => {
      const owned = await readOwnedFiles();
      const skills: OfficeSkillStatus[] = OFFICE_SKILLS.map((def) => {
        const prefix = `skills/${def.name}/`;
        const files = owned === null ? [] : Object.keys(owned).filter((d) => d.startsWith(prefix));
        return {
          name: def.name,
          title: def.title,
          summary: def.summary,
          usageHint: def.usageHint,
          command: `/skill:${def.name}`,
          // 物化的判据是「账本里记着该技能的 SKILL.md」：SKILL.md 是 pi 技能
          // 发现的锚点文件，辅助文件在而它不在的话技能照样不加载。
          materialized: files.includes(`${prefix}SKILL.md`),
          fileCount: files.length,
        };
      });
      return {
        packId: OFFICE_SKILLS_CAPABILITY_ID,
        packVersion: OFFICE_SKILLS_PACK_VERSION,
        ledgerFound: owned !== null,
        skills,
      };
    }
  );
}

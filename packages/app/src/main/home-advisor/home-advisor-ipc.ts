/**
 * 智能家居场景/联动建议包的 IPC handler（home.advisor，恰 1 条通道）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * ## 只有 `advisor:skills-status` 一条，读的是 R4 归属账本
 *
 * 这个能力包的真正载荷是两个 pi 技能目录（capability-assets 随包分发，
 * 启动对账时由 syncCapabilityAssetsOnStartup 物化到 ~/.pi/agent/skills/）。
 * 技能的**执行**发生在 pi agent 里（用 home.assistant 基座的工具盘点与
 * 查询状态），不经过任何 IPC——因此本能力唯一需要的动作面是「告诉面板：
 * 声明的两个技能，账本里真的物化了哪些」。判据只有归属账本
 * （pibuddy-assets.json）一个：它是物化器唯一的归属真相源，这里不自己
 * 发明第二套判断（比如去 stat 磁盘），否则「账本说有、磁盘被用户删了」
 * 这类中间态会在两套判据之间来回横跳。用户删了文件的受支持做法是重启
 * （启用态自愈重建）或停用本包。与 office-skills-ipc 同一口径。
 *
 * ## 为什么申请 workspace.read
 *
 * 账本读取用的是 fs 的 readFile（只读、不写、不开外部程序、不出站、不碰
 * 密钥）。与 common.office-skills 读同一账本同一口径：只读文件 =
 * workspace.read，drift test 的权限对账（双向）据此闭合。
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CHANNELS,
  HOME_ADVISOR_SKILLS,
  HOME_ADVISOR_CAPABILITY_ID,
  voidRequestSchema,
  type HomeAdvisorState,
  type AdvisorSkillStatus,
} from "@pibuddy/contract";

import { ASSET_LEDGER_FILENAME } from "../capability/capability-assets.js";
import { registerHandler } from "../ipc-guard.js";

/** 本能力注册的全部通道。导出成常量供 drift test 与自测对账「恰 1 条」。 */
export const HOME_ADVISOR_CHANNELS = [CHANNELS.advisorSkillsStatus] as const;

/** 包版本。manifest 与状态通道都引它，改版本只改这一处。 */
export const HOME_ADVISOR_PACK_VERSION = "1.0.0";

/**
 * 读归属账本里本包名下的文件表（dest → sha256）。
 *
 * 账本不存在 / 解析失败都折成 null：面板据此显示「待重启物化」，而不是
 * 把一次坏读伪装成「两个技能都没装」以外的任何结论。
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
    const entry = (packs as Record<string, unknown>)[HOME_ADVISOR_CAPABILITY_ID];
    if (!entry || typeof entry !== "object") return {};
    const files = (entry as { files?: unknown }).files;
    if (!files || typeof files !== "object") return {};
    return files as Record<string, string>;
  } catch {
    return null;
  }
}

export function registerHomeAdvisorIpc(): void {
  registerHandler(
    CHANNELS.advisorSkillsStatus,
    voidRequestSchema,
    async (): Promise<HomeAdvisorState> => {
      const owned = await readOwnedFiles();
      const skills: AdvisorSkillStatus[] = HOME_ADVISOR_SKILLS.map((def) => {
        const prefix = `skills/${def.name}/`;
        const files = owned === null ? [] : Object.keys(owned).filter((d) => d.startsWith(prefix));
        return {
          name: def.name,
          title: def.title,
          summary: def.summary,
          usageHint: def.usageHint,
          // 物化的判据是「账本里记着该技能的 SKILL.md」：SKILL.md 是 pi 技能
          // 发现的锚点文件，辅助文件在而它不在的话技能照样不加载。
          materialized: files.includes(`${prefix}SKILL.md`),
          fileCount: files.length,
        };
      });
      return {
        packId: HOME_ADVISOR_CAPABILITY_ID,
        packVersion: HOME_ADVISOR_PACK_VERSION,
        ledgerFound: owned !== null,
        skills,
      };
    }
  );
}

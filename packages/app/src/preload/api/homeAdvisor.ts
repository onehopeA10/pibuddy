/**
 * `window.piBuddy.homeAdvisor`（home.advisor，智能家居场景/联动建议包）。
 *
 * 一个方法、一条通道。渲染进程能表达的极限是「告诉我预置建议技能的清单与
 * 物化状态」——技能的执行发生在 pi agent 里（用 home.assistant 基座的工具），
 * 不经过这里；物化 / 收回是内核的启动对账动作，这里也没有任何触发入口。
 * 无入参、无路径字段。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { HomeAdvisorState } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const homeAdvisor = {
  /** 预置建议技能清单 + 各自的物化状态（判据：R4 归属账本）。 */
  skillsStatus: () => invoke<HomeAdvisorState>(CHANNELS.advisorSkillsStatus),
};

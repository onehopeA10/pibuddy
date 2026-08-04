/**
 * `window.piBuddy.officeSkills`（common.office-skills，REQ-0001 R2）。
 *
 * 一个方法、一条通道。渲染进程能表达的极限是「告诉我预置技能的清单与
 * 物化状态」——技能的执行发生在 pi agent 里（/skill:<name>），不经过这里；
 * 物化 / 收回是内核的启动对账动作，这里也没有任何触发入口。无入参、无
 * 路径字段。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { OfficeSkillsState } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const officeSkills = {
  /** 预置技能清单 + 各自的物化状态（判据：R4 归属账本）。 */
  list: () => invoke<OfficeSkillsState>(CHANNELS.officeSkillsList),
};

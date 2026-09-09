/**
 * 能力清单：预置办公技能包（common / office-skills，REQ-0001 R2）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * drift test 要能直接 import 它做对账。
 *
 * ## 第一个内容型能力包
 *
 * 它的真正载荷不是通道，而是 `piResources.skills` 声明的三个 pi 技能目录
 * （文件在 packages/app/resources/capability-assets/common.office-skills/ 下，
 * 经 electron-builder extraResources 随应用分发）。启用时 R4 物化器把整棵
 * 技能目录树复制到 ~/.pi/agent/skills/，pi 按 SKILL.md 的 frontmatter 注册成
 * `/skill:office-*` 命令；停用时按归属账本收回。启停都要重启才生效——与
 * 通道注册同一口径（capability-catalog 的 restartRequired）。
 *
 * ## 为什么技能目录名从 OFFICE_SKILLS 派生
 *
 * 技能的 name / 标题 / 摘要被 manifest、状态通道、面板三处使用，唯一定义点
 * 在契约包（office-skills.ts 的 OFFICE_SKILLS）。这里派生而不是手抄：手抄的
 * 那份一旦少一个技能，结构断言（capability-assets.spec）只会对着少的那份
 * 恒绿，包里多出来的技能目录就成了没人认领的暗资产。
 *
 * ## 为什么没有 extensions / tools
 *
 * 三个技能都是**给 pi agent 看的操作规程**（SKILL.md + 零依赖辅助脚本），
 * 执行时用的是 pi 自己的读写 / bash 工具，各自走 pi 侧既有的权限确认。本包
 * 不携带回路内工具（extensions），因此 tools 为空不触发 R4.3 的钉子。
 */
import { defineCapability, CHANNELS, OFFICE_SKILLS, OFFICE_SKILLS_CAPABILITY_ID } from "@pibuddy/contract";

export { OFFICE_SKILLS_CAPABILITY_ID };

export const officeSkillsCapability = defineCapability({
  manifestVersion: 1,
  id: OFFICE_SKILLS_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "办公技能包",
  description:
    "预置三个面向办公场景的 pi 技能：文件批量整理、表格数据处理、文档格式转换。启用后物化到 pi 的技能目录，会话里用 /skill:office-* 或直接吩咐即可。",
  // 内置能力不可能比宿主更老（同一份构建一起出厂），appMin 恒 "0.0.0"。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 状态通道读 R4 归属账本（fs readFile，只读）；与 session-tree 同一口径。
  permissions: ["workspace.read"],
  channels: [CHANNELS.officeSkillsList],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.office-skills.panel",
      title: "办公技能",
      module: "renderer/src/components/OfficeSkillsPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  // 本包不持有自有持久化数据：物化文件的归属记在内核的 R4 账本里（那是
  // 内核数据，不随本包的 dataSchemaVersion 走），因此 0。
  dataSchemaVersion: 0,
  runtime: {
    // 面板是一组静态卡片 + 一条只读通道，无重依赖、无 watcher / worker /
    // 子进程，inline 且无 teardown。
    loading: "inline",
    heavyDependencies: [],
    teardown: [],
  },
  exposure: {
    module: "main/office-skills/office-skills-ipc.ts",
    register: "registerOfficeSkillsIpc",
  },
  // 三个技能目录，相对 capability-assets/common.office-skills/ 的 posix 路径。
  // 从契约的唯一定义点派生，见文件头。
  piResources: {
    prompts: [],
    skills: OFFICE_SKILLS.map((skill) => `skills/${skill.name}`),
    extensions: [],
  },
});

/**
 * 能力清单：智能家居场景/联动建议包（vertical / home.advisor）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * drift test 要能直接 import 它做对账。
 *
 * ## 家居四包里最轻的一个
 *
 * 真正的载荷不是通道，而是 `piResources.skills` 声明的两个 pi 技能目录
 * （场景与联动建议、能耗与使用习惯回顾，文件在
 * packages/app/resources/capability-assets/home.advisor/ 下，经
 * electron-builder extraResources 随应用分发）。启用时 R4 物化器把整棵
 * 技能目录树复制到 ~/.pi/agent/skills/，停用时按归属账本收回。
 *
 * 上下文成本剖面（家居四包按此切分）：本包只占 skill 的渐进披露——
 * name + description 常驻（每个 ~几十 token），正文按需加载；不带任何
 * extension，工具面零增量。关掉本包省掉的就是那两行渐进披露。
 *
 * ## 为什么 dependencies 是 home.assistant
 *
 * 两个技能的操作规程都以基座的三个工具（home_list_entities / home_get_state /
 * home_call_service）为前提。依赖交给装配期不动点拒绝（capability-registry
 * 的 resolve）：基座未注册/未启用时本包拒绝启用并给出可读原因，零运行期
 * 降级代码。落地自动化用的 home_automation_manage_rule 属 home.automation 包，
 * 刻意**不**声明为依赖——没有 automation 时建议照样能给（技能文本里写明
 * 「如实告知用户去启用」），硬依赖会把「只想要建议」的用户也拦在门外。
 *
 * ## 为什么权限恰是一条 workspace.read
 *
 * 唯一通道 advisor:skills-status 读 R4 归属账本（fs readFile，只读）——与
 * common.office-skills 的 office-skills:list 同一口径：只读文件 =
 * workspace.read，drift 的权限对账（双向）据此闭合。技能文本本身不需要
 * 任何权限：家居工具的权限归属各工具所在包（基座 / automation）。
 */
import { defineCapability, CHANNELS, HOME_ADVISOR_SKILLS, HOME_ADVISOR_CAPABILITY_ID } from "@pibuddy/contract";

export const homeAdvisorCapability = defineCapability({
  manifestVersion: 1,
  id: HOME_ADVISOR_CAPABILITY_ID,
  version: "1.0.0",
  tier: "vertical",
  displayName: "家居场景建议",
  description:
    "智能家居的场景与联动顾问：盘点全屋设备 + 作息访谈，推理适合你家的场景（离家/回家/睡前/观影等）" +
    "与节能建议，每条建议给出触发条件、动作序列与风险提示，经你确认后才落地。纯技能包，零常驻工具。",
  // 内置能力不可能比宿主更老（同一份构建一起出厂），appMin 恒 "0.0.0"。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 基座未启用时装配期直接拒绝（"依赖未启用"，reason 下发 UI），不静默降级。
  dependencies: ["home.assistant"],
  // 状态通道读 R4 归属账本（fs readFile，只读）；与 office-skills 同一口径。
  permissions: ["workspace.read"],
  channels: [CHANNELS.advisorSkillsStatus],
  pushChannels: [],
  // 无回路内工具：建议是 skill 文本，执行用的是基座 / automation 包的工具，
  // 权限归属各工具所在包。tools 为空不触发 R4.3 的钉子。
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "home.advisor.panel",
      title: "家居建议",
      module: "renderer/src/components/HomeAdvisorPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  // 本包不持有自有持久化数据：物化文件的归属记在内核的 R4 账本里（那是
  // 内核数据，不随本包的 dataSchemaVersion 走），因此 0。
  dataSchemaVersion: 0,
  runtime: {
    // 面板是两张静态卡片 + 一条只读通道，无重依赖、无 watcher / worker /
    // 子进程，inline 且无 teardown。
    loading: "inline",
    heavyDependencies: [],
    teardown: [],
  },
  exposure: {
    module: "main/home-advisor/home-advisor-ipc.ts",
    register: "registerHomeAdvisorIpc",
  },
  // 两个技能目录，相对 capability-assets/home.advisor/ 的 posix 路径。
  // 从契约的唯一定义点派生，不手抄（手抄的那份少一个技能时结构断言恒绿）。
  piResources: {
    prompts: [],
    skills: HOME_ADVISOR_SKILLS.map((skill) => `skills/${skill.name}`),
    extensions: [],
  },
});

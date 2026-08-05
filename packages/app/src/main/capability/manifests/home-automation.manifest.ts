/**
 * 能力清单：智能家居自动化规则包（vertical / home.automation，家居四包之二）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * drift test 要能直接 import 它做对账。
 *
 * ## 关掉本包省掉的就是「规则引擎 tick + 1 个工具 schema」
 *
 * 家居四包按资源成本剖面切分：本包的运行期成本是每工作区一个 30s 对齐 tick
 * （unref）、状态触发规则存在时的一个实体缓存消费者（维持 WS），上下文成本
 * 是恰 1 个常驻工具 manage_rule。未启用时 activate 一次都不调用：通道不注册、
 * bridge 工具不挂、extension 不物化、引擎不存在。
 *
 * ## 为什么 dependencies 是 home.assistant + common.tasks
 *
 * 规则的两条执行路各踩一个地基：确定性动作（service call / 通知）经基座的
 * 受控出站（homeAssistantService → safeLocalFetch 三道关，每次执行前重过
 * 授权）；Agent 动作落成 tasks 域 kind:"event" 的真 task（misfire / 预算 /
 * 审计全继承）。两个依赖交给装配期不动点拒绝：任一未启用时本包拒绝启用并
 * 给出可读原因，零运行期降级代码。
 *
 * ## 为什么 permissions 为空
 *
 * 本域源码只写自己的 sqlite（node:sqlite，无 fs / 子进程 / 出站特征），
 * drift 双向对账的实际最小集就是空集。危险面全部在既有闸门后面：确定性
 * 动作的出站权限（network.local）归声明它的基座包所有、每次执行现场
 * evaluate；Agent 动作的权限判定归 tasks 的 workspace 预授权。manage_rule
 * 工具因此也零权限原子——它只管理规则数据，执行不因「规则是工具建的」
 * 而少过任何一道闸。
 */
import {
  AUTOMATION_TOOL_MANAGE_RULE,
  CHANNELS,
  HOME_AUTOMATION_CAPABILITY_ID,
  defineCapability,
} from "@pibuddy/contract";

export const homeAutomationCapability = defineCapability({
  manifestVersion: 1,
  id: HOME_AUTOMATION_CAPABILITY_ID,
  version: "1.0.0",
  tier: "vertical",
  displayName: "家居自动化",
  description:
    "轻量自动化规则：状态触发（某实体变成某状态）或每日定时，条件（实体状态比较 / 时间窗）通过后" +
    "执行动作序列。确定性动作（开关设备 / 通知）由主进程直接经受控本地出站执行，不起 Agent；" +
    "Agent 动作落成定时任务域的事件型任务，预算与审计全继承。规则经会话里的 manage_rule 工具管理。",
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 任一依赖未启用时装配期直接拒绝（reason 下发 UI），不静默降级。
  dependencies: ["home.assistant", "common.tasks"],
  permissions: [],
  channels: [
    CHANNELS.autoRulesList,
    CHANNELS.autoRuleUpsert,
    CHANNELS.autoRuleDelete,
    CHANNELS.autoRuleSetEnabled,
  ],
  pushChannels: [],
  tools: [
    {
      name: AUTOMATION_TOOL_MANAGE_RULE,
      description:
        "管理家居自动化规则（list/create/update/delete/enable/disable）。规则 = 触发器（实体状态或" +
        "每日时间）+ 可选条件（状态比较 / 时间窗）+ 动作序列（调 HA 服务 / 通知 / 交给 Agent）。" +
        "只读写规则库；动作的真实执行在命中时经受控出站与任务域闸门。",
      permissions: [],
    },
  ],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "home.automation.rules",
      title: "自动化规则",
      module: "renderer/src/components/RulesPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    // 面板是列表 + 启停 / 删除，无重依赖，随内核 bundle 内联。
    loading: "inline",
    heavyDependencies: [],
    // 挂在基座 bridge 上的工具 handler + 状态订阅 + 对齐 tick 归为 listener
    // 一类运行期驻留，随 dispose 一并收（见 disposeAutomationResources）。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/home-automation/automation-ipc.ts",
    register: "registerAutomationIpc",
    dispose: "disposeAutomationResources",
  },
  // 随包携带的 pi extension（R4 物化通道装卸）：manage_rule 的注册端。
  piResources: {
    extensions: ["extensions/automation-tools.ts"],
  },
});

/**
 * 本次构建随应用一起装的能力清单与 Profile 定义。
 *
 * ## 为什么清单聚合与注册表装配是两个文件
 *
 * 本文件是**纯数据**：只 import 各域的 `*.capability.ts`（它们同样是纯数据）。
 * 装配（把 manifest 与 `register*Ipc` 绑起来）在 `capability-catalog.ts`，那里
 * 会拖进 electron。分开的理由是 drift test：对账要 import 清单，但不该为了
 * 读一份清单去给 electron 打桩。
 */
import type { AgentProfile, CapabilityManifest } from "@pibuddy/contract";

import { artifactsCapability } from "../artifacts/artifacts.capability.js";
import { workspaceReviewCapability } from "../changeset/workspace-review.capability.js";
import { previewCapability } from "../preview/preview.capability.js";
import { workspaceFilesCapability } from "../workspace/workspace-files.capability.js";
import { childAgentCapability } from "./manifests/child-agent.manifest.js";
import { eduKidsCapability } from "./manifests/edu-kids.manifest.js";
import { connectorWebhookCapability } from "./manifests/connector-webhook.manifest.js";
import { connectorFeishuCapability } from "./manifests/connector-feishu.manifest.js";
import { connectorSlackCapability } from "./manifests/connector-slack.manifest.js";
import { connectorTelegramCapability } from "./manifests/connector-telegram.manifest.js";
import { gitCapability } from "./manifests/git.manifest.js";
import { terminalCapability } from "./manifests/terminal.manifest.js";
import { mcpCapability } from "./manifests/mcp.manifest.js";
import { memoryCapability } from "./manifests/memory.manifest.js";
import { homeAdvisorCapability } from "./manifests/home-advisor.manifest.js";
import { officeSkillsCapability } from "./manifests/office-skills.manifest.js";
import { sessionTreeCapability } from "./manifests/session-tree.manifest.js";
import { tasksCapability } from "./manifests/tasks.manifest.js";
import { workflowCapability } from "./manifests/workflow.manifest.js";
import { remoteCapability } from "./manifests/remote.manifest.js";
import { promptLibraryCapability } from "./manifests/prompt-library.manifest.js";
import { homeAssistantCapability } from "./manifests/home-assistant.manifest.js";
import { homeDashboardCapability } from "./manifests/home-dashboard.manifest.js";

/**
 * 全部内置能力，按装配顺序。
 *
 * 顺序有意义：被依赖者排在前面，`CapabilityRegistry.resolve()` 的输出因此
 * 也是一个可以直接照着调 `activate()` 的顺序。
 */
export const BUILT_IN_CAPABILITIES: readonly CapabilityManifest[] = [
  workspaceFilesCapability,
  workspaceReviewCapability,
  previewCapability,
  artifactsCapability,
  sessionTreeCapability,
  memoryCapability,
  mcpCapability,
  // 第一个垂直能力包（coding tier）。它默认只进「编码」Profile，因此排在
  // common 能力之后——被依赖的 common.workspace-review 已在前面注册。
  gitCapability,
  // 第一个原生模块能力包（coding tier，node-pty / ADR-0002 方案 B）。同属编码包，
  // 排在 coding.git 之后——它不依赖任何其它可选能力。
  terminalCapability,
  // 首个真内容垂直包（vertical / edu.kids，REQ-0001 R3）。默认只进「家庭教育」
  // Profile；它不依赖任何其它可选能力（档案在自有分区、错题本经内核收容读取），
  // 装配顺序上无前置。
  eduKidsCapability,
  // 智能家居场景/联动建议包（vertical / home.advisor，家居四包里最轻的一个：
  // 纯 skill 内容包）。dependencies: ["home.assistant"]——基座未注册/未启用时
  // 装配期不动点拒绝（"依赖未注册/未启用"，reason 下发 UI），不静默降级；
  // 不进任何内置 Profile，全经 overrides 启用。
  homeAdvisorCapability,
  tasksCapability,
  // 子 Agent 编排（common tier，可关闭）。排在末尾——它调用后台池（内核）与
  // 权限引擎（内核），不依赖任何其它可选能力，装配顺序上无前置。
  childAgentCapability,
  // 可视化工作流（common tier，可关闭）。排在末尾——它调用后台池（内核）触发
  // Agent 节点，不依赖任何其它可选能力，装配顺序上无前置。
  workflowCapability,
  // 预置办公技能包（common tier，第一个内容型能力包，REQ-0001 R2）。真正的
  // 载荷是 piResources.skills 的三个技能目录（R4 启停时物化 / 收回）；它不
  // 依赖任何其它可选能力，装配顺序上无前置。
  officeSkillsCapability,
  // 第一个 connector tier 能力包。排在最后——它不被任何 common 能力依赖，
  // 且默认进「通用办公」与「编码」两个 Profile（连接器是可组合的可选项）。
  connectorWebhookCapability,
  // 三个真实渠道适配器，各自 dependencies connector.webhook（基座）。排在基座之后：
  // 被依赖者在前，resolve() 的输出因此仍是一个可直接照着 activate 的顺序。
  connectorFeishuCapability,
  connectorSlackCapability,
  connectorTelegramCapability,
  // 远程访问（connector tier）。四层边界里唯一开对外网络监听的能力——默认对外
  // 零暴露（服务默认不监听），排在最后：它不被任何 common 能力依赖，也不依赖
  // 其它可选能力（看会话 / 发 prompt 复用的是内核设施，不是 connector.webhook）。
  remoteCapability,
  // 预置办公提示词库（common tier / REQ-0001 R1）。排在末尾——它只读写 pi 的
  // prompts 目录与自己的偏好文件，不依赖任何其它可选能力，装配顺序上无前置。
  promptLibraryCapability,
  // 智能家居基座（connector tier / 智能家居 Phase B）。不进任何内置 Profile
  // （全经 overrides 启用），排在最后——它不依赖任何其它可选能力；将来的
  // home.dashboard / home.automation / home.advisor 各自 dependencies 本包，
  // 须排在它之后。
  homeAssistantCapability,
  // 智能家居监控面板（vertical / home.dashboard）。dependencies home.assistant，
  // 因此必须排在基座之后（被依赖者在前，resolve() 的输出才是可直接照着
  // activate 的顺序）。不进任何内置 Profile（与基座同口径，全经 overrides
  // 启用）。首个 loading:"lazy" 包：面板组件独立 chunk，开面板才加载。
  homeDashboardCapability,
];

/**
 * 内置 Profile。
 *
 * ## 现阶段「编码」与「通用办公」的能力集为什么相同
 *
 * 因为垂直能力包一个都还不存在（ADR-0002 D1 第一阶段只做机制）。两条 Profile
 * 现在指向同一组通用能力，差别在第二阶段拆出编码包之后才出现。**不能因此
 * 把它们合并成一条** —— 合并之后，「切 Profile」这件事在第一阶段就没有任何
 * 可被验证的行为，而它正是这次要立起来的机制。
 *
 * 「精简」是那条让机制可证伪的 Profile：它一个可选能力都不开，因此
 * 「未启用 = 通道不注册」这句话有一个能真跑出来的对照组。
 */
export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: "general",
    displayName: "通用办公",
    description: "文件、预览、产物库、变更审阅与会话树，日常文档工作的默认组合。",
    capabilityIds: [
      "common.workspace-files",
      "common.workspace-review",
      "common.preview",
      "common.artifacts",
      "common.session-tree",
      "common.memory",
      "common.mcp",
      "common.tasks",
      "common.child-agent",
      // 可视化工作流：通用能力，默认进「通用办公」，可随时关掉。
      "common.workflow",
      // 预置办公技能包：R2 的三个办公技能默认对办公用户开箱即用（启用后
      // 首次启动对账即物化到 ~/.pi/agent/skills/），可随时关掉。
      "common.office-skills",
      // 第一个 connector tier 能力包。连接器是可组合的可选项（ADR-0002：
      // 「通用文档 + 财务分析 + 飞书连接器」），默认进「通用办公」，可随时关掉。
      "connector.webhook",
      // 三个真实渠道适配器（各自依赖 connector.webhook，故须与基座同在本组）。
      "connector.feishu",
      "connector.slack",
      "connector.telegram",
      // 远程访问：默认进「通用办公」。启用只是让管理面可用；远程服务本身默认
      // 不监听，须用户在面板里显式开启，且开启后默认只绑 loopback（对外零暴露）。
      "connector.remote",
      // 预置办公提示词库（REQ-0001 R1）：面向非程序员的开箱内容资产，
      // 默认进「通用办公」——它就是为这条 Profile 的用户准备的。
      "common.prompt-library",
    ],
  },
  {
    id: "coding",
    displayName: "编码",
    // 在通用能力之上叠加第一个垂直包 coding.git —— 这是「编码」与「通用办公」
    // 第一次有了可验证的差别（此前两者能力集相同，因为一个垂直包都不存在）。
    // 切到本 Profile = 装上 Git；切走 = 卸下。这正是 ADR-0002「可装卸」要立起来
    // 的那条机制的第一个真实用例。
    description: "在通用能力之上叠加 Git 等编码专用工具。",
    capabilityIds: [
      "common.workspace-files",
      "common.workspace-review",
      "common.preview",
      "common.artifacts",
      "common.session-tree",
      "common.memory",
      "common.mcp",
      "coding.git",
      // 第一个原生模块能力包（node-pty）。与 coding.git 同属编码 Profile：切到
      // 「编码」= 装上 Git + 终端；切走 = 卸下（PTY 进程一并清）。
      "coding.terminal",
      "common.tasks",
      "common.child-agent",
      "common.workflow",
      // 办公技能包在「编码」下也保留：写代码的人同样要整理文件、转文档；
      // 且两个 Profile 同带它，切 Profile 不会让已物化的技能来回装卸。
      "common.office-skills",
      "connector.webhook",
      "connector.feishu",
      "connector.slack",
      "connector.telegram",
      "connector.remote",
      // 提示词库同样进「编码」：办公提示词对写代码的人一样开箱可用。
      "common.prompt-library",
    ],
  },
  {
    id: "education",
    displayName: "家庭教育",
    // 在通用能力之上叠加首个真内容垂直包 edu.kids（REQ-0001 R3）——与「编码」
    // 叠加 Git/终端同构：切到本 Profile = 装上儿童教育（提示词/技能/出题器
    // 经 R4 物化到 pi），切走 = 卸下（资源经账本收回，零残留）。
    description: "在通用能力之上叠加儿童教育垂直包（辅导提示词、练习卷与错题本、数学出题器）。",
    capabilityIds: [
      "common.workspace-files",
      "common.workspace-review",
      "common.preview",
      "common.artifacts",
      "common.session-tree",
      "common.memory",
      "common.mcp",
      "common.tasks",
      "common.child-agent",
      "common.workflow",
      "connector.webhook",
      "connector.feishu",
      "connector.slack",
      "connector.telegram",
      "connector.remote",
      "edu.kids",
    ],
  },
  {
    id: "lite",
    displayName: "精简",
    description: "只保留平台内核与对话，不装任何可选能力。",
    capabilityIds: [],
  },
];

/**
 * 默认 Profile。
 *
 * 必须是「四个全开」的那一条：第一阶段不改变任何既有行为，一个老用户升级
 * 上来不该发现文件树没了。
 */
export const DEFAULT_PROFILE_ID = "general";

export function findProfile(id: string): AgentProfile | undefined {
  return AGENT_PROFILES.find((profile) => profile.id === id);
}

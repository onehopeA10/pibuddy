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
import { gitCapability } from "./manifests/git.manifest.js";
import { mcpCapability } from "./manifests/mcp.manifest.js";
import { memoryCapability } from "./manifests/memory.manifest.js";
import { sessionTreeCapability } from "./manifests/session-tree.manifest.js";

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

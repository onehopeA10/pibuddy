/**
 * 能力装配：把 manifest 与它的 `register*Ipc` / `dispose*` 绑起来，注册进
 * `CapabilityRegistry`，**注册完立即 seal**。
 *
 * seal 的位置很关键：它必须发生在 `registerAllIpc()` 之前。注册窗口关掉之后
 * 「本次构建有哪些能力」才成为一个确定的事实，之后所有基于它的判断（哪些
 * 通道该注册、界面上该显示什么）才有一个不会中途变化的前提。
 *
 * 手法与依据：CodePilot `registry.ts:13-28` 的 register→seal，以及本仓
 * `sealChannelContracts` 的合并即封口。
 */
import { app } from "electron";
import {
  CAPABILITY_HOST_CONTRACT_VERSION,
  type CapabilityDescriptor,
  type CapabilityState,
} from "@pibuddy/contract";

import { disposeArtifactResources, registerArtifactIpc } from "../artifacts/artifact-ipc.js";
import { artifactsCapability } from "../artifacts/artifacts.capability.js";
import { disposeChangesetResources, registerChangesetIpc } from "../changeset/changeset-ipc.js";
import { workspaceReviewCapability } from "../changeset/workspace-review.capability.js";
import { disposePreviewResources, registerPreviewIpc } from "../preview/preview-ipc.js";
import { previewCapability } from "../preview/preview.capability.js";
import { disposeMemoryResources, registerMemoryIpc } from "../memory/memory-ipc.js";
import { memoryCapability } from "./manifests/memory.manifest.js";
import { registerSessionTreeIpc } from "../session-tree/session-tree-ipc.js";
import { sessionTreeCapability } from "./manifests/session-tree.manifest.js";
import { disposeMcpResources, registerMcpIpc } from "../mcp/mcp-ipc.js";
import { mcpCapability } from "./manifests/mcp.manifest.js";
import { disposeGitResources, registerGitIpc } from "../git/git-ipc.js";
import { gitCapability } from "./manifests/git.manifest.js";
import { disposeTerminalResources, registerTerminalIpc } from "../terminal/terminal-ipc.js";
import { terminalCapability } from "./manifests/terminal.manifest.js";
import { disposeTasksResources, registerTasksIpc } from "../tasks/tasks-ipc.js";
import { tasksCapability } from "./manifests/tasks.manifest.js";
import {
  disposeChildAgentResources,
  registerChildAgentIpc,
} from "../child-agent/child-agent-ipc.js";
import { childAgentCapability } from "./manifests/child-agent.manifest.js";
import {
  disposeConnectorResources,
  registerConnectorIpc,
} from "../connector/connector-ipc.js";
import { registerFeishuIpc } from "../connector/feishu-ipc.js";
import { registerSlackIpc } from "../connector/slack-ipc.js";
import { registerTelegramIpc } from "../connector/telegram-ipc.js";
import { connectorWebhookCapability } from "./manifests/connector-webhook.manifest.js";
import { connectorFeishuCapability } from "./manifests/connector-feishu.manifest.js";
import { connectorSlackCapability } from "./manifests/connector-slack.manifest.js";
import { connectorTelegramCapability } from "./manifests/connector-telegram.manifest.js";
import { disposeWorkflowResources, registerWorkflowIpc } from "../workflow/workflow-ipc.js";
import { workflowCapability } from "./manifests/workflow.manifest.js";
import { disposeRemoteResources, registerRemoteIpc } from "../remote/remote-ipc.js";
import { remoteCapability } from "./manifests/remote.manifest.js";
import { workspaceFilesCapability } from "../workspace/workspace-files.capability.js";
import {
  disposeAllWorkspaceResources,
  registerWorkspaceIpc,
} from "../workspace/workspace-ipc.js";
import { AGENT_PROFILES, DEFAULT_PROFILE_ID, findProfile } from "./capability-manifests.js";
import { loadCapabilityPrefs, saveCapabilityPrefs, type CapabilityPrefs } from "./capability-prefs.js";
import {
  CapabilityRegistry,
  requestedCapabilityIds,
  type CapabilityResolution,
} from "./capability-registry.js";
import { applyCapabilityResolution } from "./capability-state.js";

/**
 * 全进程唯一的能力注册表。
 *
 * 装配在模块加载期完成：任何 import 到本模块的代码看到的都是一张已经封口的
 * 表。装配期抛错（重复 id / 通道冲突 / manifest 不合法）会让主进程直接起不来
 * —— 那正是要的：这类冲突在 pi 上的表现是 RPC 静默启动失败，排查要靠猜。
 */
export const capabilityRegistry = new CapabilityRegistry();

capabilityRegistry.register({
  manifest: workspaceFilesCapability,
  activate: registerWorkspaceIpc,
  deactivate: disposeAllWorkspaceResources,
});
capabilityRegistry.register({
  manifest: workspaceReviewCapability,
  activate: registerChangesetIpc,
  deactivate: disposeChangesetResources,
});
capabilityRegistry.register({
  manifest: previewCapability,
  activate: registerPreviewIpc,
  deactivate: disposePreviewResources,
});
capabilityRegistry.register({
  manifest: artifactsCapability,
  activate: registerArtifactIpc,
  deactivate: disposeArtifactResources,
});
// 会话树：只注册一条归一化视图通道，无 deactivate——它不持有 watcher / worker /
// 子进程等需要拆卸的运行期资源（teardown 为空，见 manifest）。
capabilityRegistry.register({
  manifest: sessionTreeCapability,
  activate: registerSessionTreeIpc,
});
capabilityRegistry.register({
  manifest: memoryCapability,
  activate: registerMemoryIpc,
  deactivate: disposeMemoryResources,
});
capabilityRegistry.register({
  manifest: mcpCapability,
  activate: registerMcpIpc,
  deactivate: disposeMcpResources,
});
// 第一个垂直能力包（coding.git）。默认只在「编码」Profile 启用，未启用时
// activate 一次都不调用 —— 它的九条通道因此不会进 ipc-guard 的注册表。
capabilityRegistry.register({
  manifest: gitCapability,
  activate: registerGitIpc,
  deactivate: disposeGitResources,
});
// 第一个原生模块能力包（coding.terminal，node-pty / ADR-0002 方案 B）。同属编码
// tier，默认只在「编码」Profile 启用；未启用时 activate 一次都不调用——它的十条
// 通道因此不会进 ipc-guard 的注册表，node-pty 也不会被 require（懒加载在 open 时）。
capabilityRegistry.register({
  manifest: terminalCapability,
  activate: registerTerminalIpc,
  deactivate: disposeTerminalResources,
});
capabilityRegistry.register({
  manifest: tasksCapability,
  activate: registerTasksIpc,
  deactivate: disposeTasksResources,
});
// 子 Agent 编排（common tier）。它 activate 时装配结构化事件汇聚 + 超时节拍，
// deactivate 时摘掉它们（编排数据留在内存不动）。
capabilityRegistry.register({
  manifest: childAgentCapability,
  activate: registerChildAgentIpc,
  deactivate: disposeChildAgentResources,
});
// 可视化工作流（common tier）。activate 时注册八条通道；deactivate 时停活跃运行、
// 摘广播、关 sqlite 句柄（工作流定义 / 历史留在磁盘不动）。
capabilityRegistry.register({
  manifest: workflowCapability,
  activate: registerWorkflowIpc,
  deactivate: disposeWorkflowResources,
});
// 第一个 connector tier 能力包（connector.webhook）。默认在「通用办公」与
// 「编码」Profile 启用，未启用时 activate 一次都不调用 —— 它的七条通道因此
// 不会进 ipc-guard 的注册表（feature gate 的主进程侧）。
capabilityRegistry.register({
  manifest: connectorWebhookCapability,
  activate: registerConnectorIpc,
  deactivate: disposeConnectorResources,
});
// 三个真实渠道适配器：只注册各自的两条平台通道（feishu/slack/telegram:send/receive）。
// 无 deactivate——它们复用基座的库与入站守卫，运行期资源由基座的
// disposeConnectorResources 一并收（且各自 dependencies connector.webhook，同启同停）。
capabilityRegistry.register({
  manifest: connectorFeishuCapability,
  activate: registerFeishuIpc,
});
capabilityRegistry.register({
  manifest: connectorSlackCapability,
  activate: registerSlackIpc,
});
capabilityRegistry.register({
  manifest: connectorTelegramCapability,
  activate: registerTelegramIpc,
});
// 远程访问（connector tier）。activate 只注册八条管理通道（不起服务）；服务本身
// 默认不监听，须用户在面板里显式开启。deactivate 停监听 + 断全部活跃连接 + 关
// sqlite 句柄（设备与配置留在磁盘不动）。
capabilityRegistry.register({
  manifest: remoteCapability,
  activate: registerRemoteIpc,
  deactivate: disposeRemoteResources,
});
capabilityRegistry.seal();

/**
 * 本次装配的解析结果；`assembleCapabilities()` 之前为 null。
 *
 * 这是 `restartRequired` 的比对基准：它记的是**这个进程实际装成了什么样**，
 * 而不是磁盘上现在写着什么。两者一旦不同，界面就该说「要重启」。
 */
let lastResolution: CapabilityResolution | null = null;

function hostInfo(): { appVersion: string; contractVersion: number } {
  return {
    // app.getVersion() 在打包后取 package.json 的 version；单测里 electron
    // 被打桩时可能没有这个方法，回落到 0.0.0 会让所有 appMin 判定失败，
    // 因此回落到一个**足够大**的版本：兼容性判定不是这里要测的东西。
    appVersion: typeof app?.getVersion === "function" ? app.getVersion() : "999.0.0",
    contractVersion: CAPABILITY_HOST_CONTRACT_VERSION,
  };
}

/**
 * 读偏好 → 解析 → 写进 `capability-state`。**只做决定，不调 activate。**
 *
 * 拆成两步（决定 / 执行）是为了让决定这一半可以被单测直接跑：`activate` 那
 * 一半会真的调用 `ipcMain.handle`，绑第二次就抛错，因此它在一个进程里只能
 * 跑一次。判据钉在跑不动的那一半上，等于没有判据。
 */
export function assembleCapabilities(): CapabilityResolution {
  const prefs = loadCapabilityPrefs(DEFAULT_PROFILE_ID);
  const wanted = requestedCapabilityIds(findProfile(prefs.profileId), prefs.overrides);
  const resolution = capabilityRegistry.resolve(wanted, hostInfo());
  lastResolution = resolution;
  applyCapabilityResolution(resolution.enabled);
  return resolution;
}

/** 装配结果的只读视图；未装配时为 null。 */
export function currentResolution(): CapabilityResolution | null {
  return lastResolution;
}

/**
 * 当前偏好折出来的启用集合与**本次进程实际装配的**集合是否已经不同。
 *
 * 主进程侧的 gate 是「`registerHandler` 有没有被调用过」，那件事不可撤销
 * （`ipcMain.handle` 在同一 channel 上绑第二次直接抛错）。所以运行期改偏好
 * 只能改文件，不能凭空补一条通道 —— 界面据此如实提示重启，而不是假装已经
 * 生效然后让用户点到一个空的面板。
 */
function computeRestartRequired(prefs: CapabilityPrefs): boolean {
  if (lastResolution === null) return false;
  const wanted = requestedCapabilityIds(findProfile(prefs.profileId), prefs.overrides);
  const resolved = capabilityRegistry.resolve(wanted, hostInfo());
  const now = [...resolved.enabled].sort().join(",");
  const assembled = [...lastResolution.enabled].sort().join(",");
  return now !== assembled;
}

function describe(prefs: CapabilityPrefs): CapabilityState {
  const wanted = requestedCapabilityIds(findProfile(prefs.profileId), prefs.overrides);
  const resolved = capabilityRegistry.resolve(wanted, hostInfo());
  const enabledNow = new Set(resolved.enabled);
  const reasons = new Map(resolved.rejected.map((r) => [r.id, r.reason] as const));

  const capabilities: CapabilityDescriptor[] = capabilityRegistry.manifests().map((manifest) => ({
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    tier: manifest.tier,
    version: manifest.version,
    enabled: enabledNow.has(manifest.id),
    reason: enabledNow.has(manifest.id)
      ? null
      : (reasons.get(manifest.id) ?? "未在当前 Profile 中启用"),
    permissions: [...manifest.permissions],
    dependencies: [...manifest.dependencies],
    uiContributions: manifest.uiContributions.map((c) => ({
      slot: c.slot,
      id: c.id,
      title: c.title,
    })),
  }));

  return {
    activeProfileId: prefs.profileId,
    profiles: AGENT_PROFILES.map((p) => ({ ...p, capabilityIds: [...p.capabilityIds] })),
    capabilities,
    restartRequired: computeRestartRequired(prefs),
  };
}

/**
 * `capabilities:describe` 的实现。
 *
 * 读的是**磁盘上当前的偏好**，不是装配时那一份。早先这里回落到装配期缓存的
 * prefs，于是 `setProfile('lite')` 之后再 describe 一次，拿回来的还是
 * 「general、四个全开」—— 界面刷新一次就把用户刚做的选择抹回去了，而且
 * `restartRequired` 恒为 false，看上去像是「切了但什么都没发生」。
 * 这条缺陷是在打包后的真机上用 CDP 走一遍 setProfile → reload 抓到的。
 */
export function describeCapabilities(): CapabilityState {
  return describe(loadCapabilityPrefs(DEFAULT_PROFILE_ID));
}

/** `capabilities:set-profile` 的实现。未知 profileId 直接抛错，不静默回落。 */
export function setActiveProfile(profileId: string): CapabilityState {
  if (findProfile(profileId) === undefined) {
    throw new Error(`CAPABILITY_PROFILE_UNKNOWN: ${profileId}`);
  }
  const prefs = loadCapabilityPrefs(DEFAULT_PROFILE_ID);
  // 换 Profile 时**清空** overrides：overrides 是「用户在这一组之上的调整」，
  // 换了一组之后那些调整所针对的组合已经不存在了。保留它们的表现是用户切到
  // 「精简」却发现文件树还在。
  const next: CapabilityPrefs = { ...prefs, profileId, overrides: {} };
  saveCapabilityPrefs(next);
  return describe(next);
}

/** `capabilities:set-enabled` 的实现。未注册的 capabilityId 直接抛错。 */
export function setCapabilityEnabled(capabilityId: string, enabled: boolean): CapabilityState {
  if (!capabilityRegistry.has(capabilityId)) {
    throw new Error(`CAPABILITY_UNKNOWN: ${capabilityId}`);
  }
  const prefs = loadCapabilityPrefs(DEFAULT_PROFILE_ID);
  const next: CapabilityPrefs = {
    ...prefs,
    overrides: { ...prefs.overrides, [capabilityId]: enabled },
  };
  saveCapabilityPrefs(next);
  return describe(next);
}

/** 仅供单测：清掉装配痕迹。 */
export function __resetCapabilityAssembly(): void {
  lastResolution = null;
}

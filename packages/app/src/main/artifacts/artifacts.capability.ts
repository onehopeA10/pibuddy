/**
 * 能力清单：产物库（common / ART-102）。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const ARTIFACTS_CAPABILITY_ID = "common.artifacts";

export const artifactsCapability = defineCapability({
  manifestVersion: 1,
  id: ARTIFACTS_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "产物库",
  description: "把 Agent 做出来的文件收进带版本链的库，可重命名、导出、回收。",
  // appMin 是 "0.0.0" 而不是当前版本号：**内置能力不可能比宿主更老**，它就是
  // 随这一份构建一起出厂的。写一个具体版本号在这里只会制造一条恒真的判据。
  // 真正对内置能力生效的那一半是 contractMin/contractMax —— 宿主契约代际一旦
  // +1，每一份没跟着改的 manifest 都会被当场拒绝。appMin/appBelow 是给第三阶段
  // 的第三方包留的，其行为由 capability-registry.spec.ts 用合成 manifest 钉住。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // external.open 是 `artifacts:show-in-folder`（shell.showItemInFolder）——
  // 这是唯一一条把控制权交给系统外壳的动作，因此它必须被单独申请，而不是
  // 混在 workspace.read 里蒙混过去。
  permissions: ["workspace.read", "workspace.write", "external.open"],
  channels: [
    CHANNELS.artifactsQuery,
    CHANNELS.artifactsRename,
    CHANNELS.artifactsDuplicate,
    CHANNELS.artifactsExport,
    CHANNELS.artifactsShowInFolder,
    CHANNELS.artifactsTrash,
    CHANNELS.artifactsRestore,
    CHANNELS.artifactsCompareVersions,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.artifacts.library",
      title: "产物",
      module: "renderer/src/components/ArtifactLibrary.vue",
      host: "renderer/src/components/AppShell.vue",
    },
    {
      slot: "message.renderer",
      id: "common.artifacts.link",
      title: "消息内产物链接",
      module: "renderer/src/components/ArtifactLink.vue",
      host: "renderer/src/components/MessageItem.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // artifact-tracker 在 tool_execution_start→end 之间持一张挂起表，
    // artifact-store 持一个 sqlite 句柄。禁用时两者都收，**库里的产物一条
    // 不动**（D4 规则 5：卸载与删数据是两个动作）。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/artifacts/artifact-ipc.ts",
    register: "registerArtifactIpc",
    dispose: "disposeArtifactResources",
  },
});

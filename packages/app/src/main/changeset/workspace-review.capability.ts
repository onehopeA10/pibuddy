/**
 * 能力清单：变更审阅（common / FS-102）。
 *
 * ADR-0002 的「已知未决」写着：行级 hunk 是否属于通用层待第二阶段定案。
 * 因此这里的 manifest 只承诺**文件级接受/拒绝**，不声明任何 hunk / stage /
 * 三方合并相关的通道或 UI —— 先把边界画在能守住的地方。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const WORKSPACE_REVIEW_CAPABILITY_ID = "common.workspace-review";

export const workspaceReviewCapability = defineCapability({
  manifestVersion: 1,
  id: WORKSPACE_REVIEW_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "变更审阅",
  description: "把 Agent 的文件写入拦成待审阅变更，逐条接受或回滚。",
  // appMin 是 "0.0.0" 而不是当前版本号：**内置能力不可能比宿主更老**，它就是
  // 随这一份构建一起出厂的。写一个具体版本号在这里只会制造一条恒真的判据。
  // 真正对内置能力生效的那一半是 contractMin/contractMax —— 宿主契约代际一旦
  // +1，每一份没跟着改的 manifest 都会被当场拒绝。appMin/appBelow 是给第三阶段
  // 的第三方包留的，其行为由 capability-registry.spec.ts 用合成 manifest 钉住。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 接受一条变更时要复用文件编辑器的错误分类与冲突预览常量
  // （apply.ts → workspace/file-editor.ts）。这是一条**真实存在**的依赖，
  // 写出来是为了让「只开审阅、不开文件」这种组合被当场拒绝，而不是等到
  // 用户点接受时炸在一句看不懂的错误上。
  dependencies: ["common.workspace-files"],
  permissions: ["workspace.read", "workspace.write"],
  channels: [
    CHANNELS.changesetQuery,
    CHANNELS.changesetAccept,
    CHANNELS.changesetReject,
    CHANNELS.changesetAcceptBatch,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.workspace-review.panel",
      title: "改动",
      module: "renderer/src/components/ChangesetPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // tool-watch 挂在 pi-supervisor 的工具事件流上，并在 start→end 之间
    // 于内存里持有整份文件的 before 字节。禁用时这两样都必须停：前者是
    // 一条还在跑的监听，后者是一块按文件大小增长的内存。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/changeset/changeset-ipc.ts",
    register: "registerChangesetIpc",
    dispose: "disposeChangesetResources",
  },
});

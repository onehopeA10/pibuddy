/**
 * 能力清单：工作区文件（common / FS-101）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * 理由是 drift test 要能直接 import 它做对账，而对账的另一端是磁盘上的
 * 源码文本 —— 一旦清单反过来依赖实现，「声明与实现是否一致」这个问题
 * 就变成了「实现与自己是否一致」，恒真。
 */
import { defineCapability, CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract";

export const WORKSPACE_FILES_CAPABILITY_ID = "common.workspace-files";

export const workspaceFilesCapability = defineCapability({
  manifestVersion: 1,
  id: WORKSPACE_FILES_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "工作区文件",
  description: "文件树、搜索、读写与附件引用。",
  // appMin 是 "0.0.0" 而不是当前版本号：**内置能力不可能比宿主更老**，它就是
  // 随这一份构建一起出厂的。写一个具体版本号在这里只会制造一条恒真的判据。
  // 真正对内置能力生效的那一半是 contractMin/contractMax —— 宿主契约代际一旦
  // +1，每一份没跟着改的 manifest 都会被当场拒绝。appMin/appBelow 是给第三阶段
  // 的第三方包留的，其行为由 capability-registry.spec.ts 用合成 manifest 钉住。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 只申请这两条：本域既不开外部程序（trashItem 是回收站，不是「用默认应用
  // 打开」），也不发出站请求，也不碰密钥。多申请一条的代价不是「没用上」，
  // 而是权限预览界面上多出一句用户无法核实的话。
  permissions: ["workspace.read", "workspace.write"],
  channels: [
    CHANNELS.workspaceTreeList,
    CHANNELS.workspaceTreeWatch,
    CHANNELS.workspaceSearch,
    CHANNELS.workspaceSearchCancel,
    CHANNELS.workspaceFileRead,
    CHANNELS.workspaceFileSave,
    CHANNELS.workspaceFileMutate,
    CHANNELS.workspaceAttachmentCreate,
    CHANNELS.workspaceRelease,
  ],
  pushChannels: [PUSH_CHANNELS.workspaceTreeEvent],
  tools: [],
  uiContributions: [
    {
      slot: "sidebar.section",
      id: "common.workspace-files.tree",
      title: "文件树",
      module: "renderer/src/components/FileTreePanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
    {
      slot: "drawer.tab",
      id: "common.workspace-files.editor",
      title: "文件编辑器",
      module: "renderer/src/components/FileEditorPane.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    // 现阶段随内核 bundle 一起装（ADR-0002 D1：第一阶段全部内置）。
    // 编辑器换成 monaco 的那天，这一段要一起改成 lazy + 预算 —— D2 的两条
    // 连带约束由 validateCapabilityManifest 强制，改不彻底会当场抛错。
    loading: "inline",
    heavyDependencies: [],
    // fs.watch（file-tree.ts）与搜索子进程（search-worker.ts）。两者都是
    // **看不见的**泄漏：前者的表现是几小时后文件树停止刷新，后者是任务
    // 管理器里越攒越多的子进程。
    teardown: ["watcher", "child-process"],
  },
  exposure: {
    module: "main/workspace/workspace-ipc.ts",
    register: "registerWorkspaceIpc",
    dispose: "disposeAllWorkspaceResources",
  },
});

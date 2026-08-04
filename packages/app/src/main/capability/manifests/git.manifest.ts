/**
 * 能力清单：Git 编码能力包（vertical / coding.git / GIT-101）。
 *
 * **第一个 coding tier 垂直能力包**，用来验证 ADR-0002 的整条链路：
 * 垂直能力声明 `process.git` → 经核心 PermissionEngine 授权 → 可随 Profile
 * 装卸。它默认只在「编码」Profile 里启用，「通用办公」不装——这正是 Profile
 * 机制第一次有了可验证的差别（在此之前 coding 与 general 的能力集相同）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。drift
 * test 要能直接 import 它做对账，一旦反过来依赖实现，「声明与实现是否一致」
 * 就退化成「实现与自己是否一致」，恒真。
 */
import { defineCapability, CHANNELS, GIT_CAPABILITY_ID } from "@pibuddy/contract";

// capabilityId 的唯一定义在契约包（GIT_CAPABILITY_ID = "coding.git"），这里只
// 引用、不再 export 同名常量——契约唯一性闸门不允许两处 export 同名符号。

export const gitCapability = defineCapability({
  manifestVersion: 1,
  id: GIT_CAPABILITY_ID,
  version: "1.0.0",
  tier: "vertical",
  displayName: "Git",
  description:
    "仓库状态、逐文件/hunk diff 与 hunk 级暂存、安全回退、提交、分支、历史、stash、" +
    "worktree，以及 fetch/pull/push；force push / reset --hard / branch -D 走额外原生二次确认。",
  // appMin 是 "0.0.0"：内置能力不可能比宿主更老，真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // diff 复用 changeset 的 review 原语（diffLines / looksBinary / ChangesetDiff，
  // 都住在 main/changeset，归 common.workspace-review 域）。写出这条依赖是为了
  // 让「只开 Git、不开变更审阅」这种组合被 resolve 当场拒绝，而不是等用户点开
  // diff 时炸在一个跨能力 import 上。
  dependencies: ["common.workspace-review"],
  // process.git：本包的核心权限，九条通道全部要它（连只读 status/diff 也要起
  // git 子进程）。workspace.read：读工作树字节算 diff 的 after 侧。workspace.write：
  // 安全 revert 前把原字节备份到磁盘（writeFileAtomic）。**不申请 process.shell**
  // ——跑 git 归 process.git；也不申请 network（push/fetch 属 deferred，见 handler）。
  permissions: ["process.git", "workspace.read", "workspace.write"],
  channels: [
    CHANNELS.gitStatus,
    CHANNELS.gitDiff,
    CHANNELS.gitStage,
    CHANNELS.gitUnstage,
    CHANNELS.gitRevert,
    CHANNELS.gitCommit,
    CHANNELS.gitBranchList,
    CHANNELS.gitBranchCreate,
    CHANNELS.gitBranchSwitch,
    // v2：网络 / 危险 / stash / history / worktree / hunk 级 stage（21 条）。
    CHANNELS.gitFetch,
    CHANNELS.gitPull,
    CHANNELS.gitPush,
    CHANNELS.gitForcePush,
    CHANNELS.gitResetHard,
    CHANNELS.gitBranchDelete,
    CHANNELS.gitStashSave,
    CHANNELS.gitStashList,
    CHANNELS.gitStashPop,
    CHANNELS.gitStashDrop,
    CHANNELS.gitLog,
    CHANNELS.gitShow,
    CHANNELS.gitWorktreeCreate,
    CHANNELS.gitWorktreeList,
    CHANNELS.gitWorktreeOpen,
    CHANNELS.gitWorktreeRename,
    CHANNELS.gitWorktreeCompare,
    CHANNELS.gitWorktreeRemove,
    CHANNELS.gitDiffHunks,
    CHANNELS.gitStageHunk,
    CHANNELS.gitUnstageHunk,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "coding.git.panel",
      title: "Git",
      module: "renderer/src/components/GitPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    // 现阶段随内核 bundle 一起装（ADR-0002 D1：第一阶段全部内置，用系统 git
    // CLI，无重依赖）。日后若引入编辑器级 git 集成再评估 lazy + 预算。
    loading: "inline",
    heavyDependencies: [],
    // git-cli 用 execFile 起 git 子进程。禁用时 disposeGitResources 会 kill 掉
    // 全部在途子进程（一个还在跑的 clone/log 会一直占着句柄），**仓库不动**。
    teardown: ["child-process"],
  },
  exposure: {
    module: "main/git/git-ipc.ts",
    register: "registerGitIpc",
    dispose: "disposeGitResources",
  },
});

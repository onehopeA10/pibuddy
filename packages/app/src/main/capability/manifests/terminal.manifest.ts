/**
 * 能力清单：终端能力包（vertical / coding.terminal / PTY-101）。
 *
 * **第一个原生模块能力包**（ADR-0002 方案 B）：它携带 node-pty 这个带预编译
 * 二进制的原生依赖，用来验证「原生模块也能在 npmRebuild:false + 白名单 +
 * asarUnpack 下随能力包装卸」。它默认只在「编码」Profile 里启用，「通用办公」
 * 不装——与 coding.git 同属编码包。
 *
 * 本文件是**纯数据**：不 import electron、node-pty，也不 import 本域的 handler。
 * drift test 要能直接 import 它做对账，一旦反过来依赖实现，「声明与实现是否
 * 一致」就退化成「实现与自己是否一致」，恒真。
 */
import { defineCapability, CHANNELS, PUSH_CHANNELS, TERMINAL_CAPABILITY_ID } from "@pibuddy/contract";

// capabilityId 的唯一定义在契约包（TERMINAL_CAPABILITY_ID = "coding.terminal"），
// 这里只引用、不再 export 同名常量——契约唯一性闸门不允许两处 export 同名符号。

export const terminalCapability = defineCapability({
  manifestVersion: 1,
  id: TERMINAL_CAPABILITY_ID,
  version: "1.0.0",
  tier: "vertical",
  displayName: "终端",
  description:
    "内置多标签页终端：workspace 目录下开 shell，输入/缩放/清屏/搜索/复制粘贴、" +
    "退出码、重启、重命名、显式关闭。基于 node-pty（原生模块，随编码 Profile 装卸），" +
    "输出走有界 ring buffer + 推送信封，reload 后可重连取快照。",
  // appMin 是 "0.0.0"：内置能力不可能比宿主更老，真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 终端不依赖任何其它可选能力：它要的只有 workspace 的 canonical root（内核
  // 设施 workspace-registry 解析），不经手别的能力域。
  dependencies: [],
  // process.shell：本包的核心权限，十条通道全部要它（开 shell 就是 process.shell，
  // 连只读的 list/snapshot 也要——它们暴露「这个 workspace 有哪些终端会话、里面
  // 输出了什么」）。**不申请 workspace.read/write**——cwd 由内核解析，终端本身
  // 不读写用户文件（要读写是用户在 shell 里自己敲的事，那是 shell 的副作用，
  // 不是 PiBuddy 主进程发起的文件操作）。
  permissions: ["process.shell"],
  channels: [
    CHANNELS.terminalList,
    CHANNELS.terminalProfiles,
    CHANNELS.terminalOpen,
    CHANNELS.terminalInput,
    CHANNELS.terminalResize,
    CHANNELS.terminalSnapshot,
    CHANNELS.terminalClear,
    CHANNELS.terminalKill,
    CHANNELS.terminalRestart,
    CHANNELS.terminalRename,
  ],
  // 输出推送信封（复用 pi 那套 PiEnvelope 的代际 + 序号丢弃规则）。
  pushChannels: [PUSH_CHANNELS.terminalEvent],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "coding.terminal.panel",
      title: "终端",
      module: "renderer/src/components/TerminalPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    // 现阶段随内核 bundle 一起装（与 coding.git 一致，AppShell 静态引入面板）。
    // node-pty 是**主进程**原生依赖，不进渲染 bundle，因此 heavyDependencies
    // （那指的是渲染侧重依赖，如 monaco）为空；xterm 体量中等，随主包内联，
    // 日后若要拆成独立 chunk 再评估 lazy + 预算。
    loading: "inline",
    heavyDependencies: [],
    // pty-manager 用 node-pty spawn shell 子进程。禁用时 disposeTerminalResources
    // 杀掉全部在册 PTY 及其进程树（不留孤儿），**磁盘不动**。
    teardown: ["child-process"],
  },
  exposure: {
    module: "main/terminal/terminal-ipc.ts",
    register: "registerTerminalIpc",
    dispose: "disposeTerminalResources",
  },
});

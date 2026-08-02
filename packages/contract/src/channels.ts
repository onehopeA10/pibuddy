/**
 * IPC 通道名常量 —— **本文件刻意不 import zod**。
 *
 * 拆出来的唯一原因是 preload：它开着 sandbox:true，产物必须是自包含的 .cjs
 * （沙箱里的 require 只认 electron 与少数内建模块，解析不到 workspace 包时
 * 整个 preload 会静默失败、window.piBuddy 变成 undefined）。preload 需要的
 * 只是这几个通道名，把它们和 schema 放在同一个模块里，就意味着要把整个
 * zod 打进 preload —— 140KB 的运行时校验库躺在一个从不做校验的安全边界上。
 *
 * schema 与通道名的对应关系仍然唯一，见 ipc-contract.ts 的 CHANNEL_CONTRACTS：
 * 那里的键类型就是本文件的 InvokeChannel，少一条或多一条都过不了编译。
 */

/**
 * 渲染进程可发起的 invoke 通道（30 个）。
 *
 * 15 个 `pi:*` 产品动作通道与 pi-sdk 的命令封装一一对应，**没有**通用的
 * 转发通道 —— 新增一种 pi 能力必须在这里显式加一行，并因此过一遍威胁模型。
 */
export const CHANNELS = {
  // ---- 运行时生命周期（非产品动作，不在 window.piBuddy.pi 命名空间下） ----
  piStart: "pi:start",
  piStop: "pi:stop",
  piUiRespond: "pi:ui-respond",

  // ---- 15 个产品动作窄通道 ----
  piPrompt: "pi:prompt",
  piSteer: "pi:steer",
  piFollowUp: "pi:follow-up",
  piAbort: "pi:abort",
  piNewSession: "pi:new-session",
  piSwitchSession: "pi:switch-session",
  piSetModel: "pi:set-model",
  piSetThinkingLevel: "pi:set-thinking-level",
  piGetState: "pi:get-state",
  piGetMessages: "pi:get-messages",
  piGetSessionStats: "pi:get-session-stats",
  piGetAvailableModels: "pi:get-available-models",
  piGetAvailableThinkingLevels: "pi:get-available-thinking-levels",
  piCompact: "pi:compact",
  piSetSessionName: "pi:set-session-name",

  // ---- 会话 / 设置 ----
  sessionsList: "sessions:list",
  settingsGet: "settings:get",
  settingsSet: "settings:set",

  // ---- workspace 与附件 capability ----
  workspaceCurrent: "workspace:current",
  dialogChooseFolder: "dialog:choose-folder",
  dialogChooseFiles: "dialog:choose-files",
  fileAttachDropped: "file:attach-dropped",
  fileReadAttachment: "file:read-attachment",
  shellOpenPath: "shell:open-path",
  shellShowInFolder: "shell:show-in-folder",
  attachmentRevokeAll: "attachment:revoke-all",

  // ---- 语音 ----
  sttTranscribe: "stt:transcribe",
} as const;

/** 主进程单向推送通道（3 个）。 */
export const PUSH_CHANNELS = {
  piEvent: "pi:event",
  piUiRequest: "pi:ui-request",
  piExit: "pi:exit",
} as const;

export type InvokeChannel = (typeof CHANNELS)[keyof typeof CHANNELS];
export type PushChannel = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS];

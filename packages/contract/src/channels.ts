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
 * 渲染进程可发起的 invoke 通道。
 *
 * `pi:*` 产品动作通道与 pi-sdk 的命令封装一一对应，**没有**通用的
 * 转发通道 —— 新增一种 pi 能力必须在这里显式加一行，并因此过一遍威胁模型。
 */
export const CHANNELS = {
  // ---- 运行时生命周期（非产品动作，不在 window.piBuddy.pi 命名空间下） ----
  piStart: "pi:start",
  piStop: "pi:stop",
  piUiRespond: "pi:ui-respond",
  /**
   * 取扩展 UI 的当前快照（挂起弹窗 / 状态 / widget / 标题）。
   *
   * 窗口 reload 之后渲染进程的内存全没了，而挂起表在主进程里还在。没有这
   * 条通道的话，reload 只能表现为「所有正在等待回答的问题凭空消失，扩展
   * 那边继续阻塞」。
   */
  piUiPending: "pi:ui-pending",

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

  // ---- 会话树 / 分叉（数据面；可视化 UI 本轮不做，见 TASK-009 risks[1]） ----
  //
  // rpc.md:694 起的 get_entries 只有 `since`（strictly after）游标，**没有**
  // before / limit，因此「向更早翻页」在协议层根本不存在 —— 那条路由
  // main/sessions/session-history.ts 按 JSONL 字节 offset 本地实现，不走这里。
  piGetEntries: "pi:get-entries",
  piGetTree: "pi:get-tree",
  piGetForkMessages: "pi:get-fork-messages",
  piFork: "pi:fork",
  piClone: "pi:clone",

  // ---- 会话中心（SES-101，恰 9 条） ----
  //
  // 取代原先那条一次性全量枚举的 `sessions:list`：列表、搜索、整理、草稿、
  // 导出、向前翻页各有各的窄通道，渲染进程一律只持有不透明 sessionId。
  sessionsQuery: "sessions:query",
  sessionsRename: "sessions:rename",
  sessionsSetPinned: "sessions:set-pinned",
  sessionsSetStatus: "sessions:set-status",
  sessionsPurge: "sessions:purge",
  sessionsGetDraft: "sessions:get-draft",
  sessionsSaveDraft: "sessions:save-draft",
  sessionsExportHtml: "sessions:export-html",
  sessionsReadHistory: "sessions:read-history",

  // ---- 设置 ----
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  /**
   * 写入一把密钥（SEC-004）。**只进不出**：渲染进程可以覆盖，但没有任何
   * 通道能把明文取回来 —— 取回的能力一旦存在，safeStorage 加密就只是
   * 给磁盘上的字节换了个编码。
   */
  settingsSetSecret: "settings:set-secret",
  /** 查询某把密钥的配置态：{configured, last4}，不含明文 */
  settingsDescribeSecret: "settings:describe-secret",

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

  // ---- Pi 资源中心与 project trust（EXT-102，恰 7 条） ----
  //
  // 全部以**不透明 id** 为入参：`piResourcesOpenDir` 收的是扫描结果里的
  // resource id 而不是路径，`piResourcesInstall` 收的是包规格字符串而不是
  // 命令行 —— 渲染进程在结构上就表达不出「执行这条命令」。真正的 execFile
  // 只发生在 main/pi-resources/package-install.ts，子命令白名单写死在那里。
  piResourcesScan: "pi-resources:scan",
  piResourcesSetEnabled: "pi-resources:set-enabled",
  piResourcesInstall: "pi-resources:install",
  piResourcesRemove: "pi-resources:remove",
  piResourcesOpenDir: "pi-resources:open-dir",
  /** 查询当前工作目录的 project trust 态（含将要加载的 project resources） */
  trustDescribe: "trust:describe",
  /** 记录用户的 allow / deny 决定；remember=true 时写 ~/.pi/agent/trust.json */
  trustDecide: "trust:decide",

  // ---- 应用自更新（UPD-001~004，恰 9 条） ----
  //
  // 渲染进程能表达的极限就是这九个意图。没有 setFeedURL、没有「装这个文件」、
  // 没有任何形式的 URL 或路径形参 —— 更新是唯一一个错了会砸掉用户数据的
  // 子系统，它的副作用必须整体收在主进程里。
  updateGetState: "update:get-state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateCancelDownload: "update:cancel-download",
  updateInstall: "update:install",
  updateSetChannel: "update:set-channel",
  updateSetAutoCheck: "update:set-auto-check",
  updateSetAutoDownload: "update:set-auto-download",
  updateDismissVersion: "update:dismiss-version",

  // ---- 诊断与健康（OBS-101，恰 3 条） ----
  //
  // 三条都**不接受路径**：诊断包的落盘位置由主进程的保存对话框决定，
  // 渲染进程既指定不了「导出到哪」，也指定不了「收集哪些文件」——
  // 否则 support bundle 会变成一条「读任意文件」的通用旁路。
  /** 先出清单供用户预览（路径、大小、是否已脱敏），**不写任何文件** */
  diagnosticsPreviewBundle: "diagnostics:preview-bundle",
  /** 用户确认后导出。主进程弹保存对话框，写盘，可选「在文件夹中显示」 */
  diagnosticsExportBundle: "diagnostics:export-bundle",
  /** 启动健康检查结果 + safe mode 态 + 上一稳定版本 */
  diagnosticsGetReport: "diagnostics:get-report",
} as const;

/** 主进程单向推送通道（6 个）。 */
export const PUSH_CHANNELS = {
  piEvent: "pi:event",
  piUiRequest: "pi:ui-request",
  piExit: "pi:exit",
  /**
   * 某一条扩展弹窗已失效（上游带 timeout 的 dialog 已自行 auto-resolve）。
   *
   * rpc.md:1145 明确「若 dialog 带 timeout，agent 侧到期会自行 auto-resolve，
   * 客户端不需要跟踪超时」—— 这句话的另一面是：**到期之后本地那个 modal
   * 上的每一个按钮都已经没人接收了**。不推这条消息的话，用户看到的是一个
   * mask-closable:false、关不掉、点了也没反应的弹窗。
   */
  piUiExpire: "pi:ui-expire",
  /** 整代作废（runtime 重启 / 换会话）：渲染侧清空全部挂起弹窗 */
  piUiExpireAll: "pi:ui-expire-all",
  /** 更新状态变更；payload 是 UpdateEnvelope（不是 PiEnvelope，语义不同） */
  updateEvent: "update:event",
} as const;

export type InvokeChannel = (typeof CHANNELS)[keyof typeof CHANNELS];
export type PushChannel = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS];

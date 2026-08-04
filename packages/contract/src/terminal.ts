/**
 * 终端能力包的契约（ADR-0002 垂直能力包 / PTY-101，coding.terminal）。
 *
 * ## 这个文件在回答什么
 *
 * `coding.terminal` 这个**垂直能力**对外声明的十一条窄通道：列出/新建/输入/
 * 缩放/取快照/清屏/杀/重启/重命名终端标签页，外加一条列出可用 shell 的
 * profiles、一条查询 WSL 发行版（R5.1，仅 Windows 有实义）。每条通道的入参只有不透明 workspaceId + 不透明 tabId + 用户键入
 * 的字节 —— **没有任何绝对路径、shell 命令行或 argv 字段**：真正 spawn PTY
 * 的地方在主进程（`main/terminal/**`，经 node-pty），渲染进程在结构上表达
 * 不出「用这个 cwd 跑这条命令」。工作目录由主进程按 workspaceId 解析成
 * canonical root，渲染进程从头到尾看不到它。
 *
 * ## 为什么所有终端动作都要 process.shell
 *
 * ADR-0002 D3：即使能力被启用，renderer 被攻陷后也不能**直接**开一个 shell。
 * 开终端就是开 shell —— 这是继 Git（process.git）之后第二个真实的危险权限
 * 消费者。十条通道全部登记在 `CHANNEL_PERMISSION_REQUIREMENTS`
 * （main/permission）里、需要 `process.shell`，未授权时被 ipc-guard 的第五道闸
 * 挡在 handler 之外——连只读的 list/profiles/snapshot 也不例外，它们同样是
 * 「这个 workspace 的终端会话」的一部分，未授权就不该被观测到。
 *
 * ## 输出为什么走推送信封 + 有界 ring buffer
 *
 * PTY 输出是持续的字节流，一次 `npm install` 可以在几秒里吐几 MB。因此主
 * 进程把输出**分块（chunk）**、编号（sequence）、装进复用现有 `PiEnvelope`
 * 的推送信封（`terminal:event`）单向下发；同时在主进程侧维护一份**有界**
 * ring buffer（按字节封顶，超了从头丢）。渲染进程 reload 之后内存全没，靠
 * `terminal:snapshot` 把 ring buffer 的当前内容 + 最后一个 sequence 取回来重
 * 建屏幕，再从推送流里按 sequence 续接（复用 `shouldAcceptEnvelope` 的代际 +
 * 序号丢弃规则，与 agent-pool / workflow 同一套）。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

// ---------------------------------------------------------------- 标签页视图

/**
 * 一个终端标签页的渲染侧视图。
 *
 * **不含绝对路径 / cwd**：终端的工作目录是 workspace 的 canonical root，只活
 * 在主进程；渲染侧只需要知道「这是哪个 tab、叫什么、用的哪个 shell、还活着
 * 没有、退出码是多少」。`generation` 每次 restart +1，用来对齐推送信封里迟到
 * 的上一代事件。
 */
export const terminalTabMetaSchema = z
  .object({
    /** 不透明标签页 id（主进程签发，渲染侧只回指、推断不出任何路径） */
    tabId: z.string().min(1),
    /** 标签标题（用户可改；默认取 shell 名） */
    title: z.string(),
    /** 这个 tab spawn 时用的 shell profile id（cmd / powershell / bash …） */
    shellId: z.string(),
    /** 代际：每次 restart +1，用于丢弃上一代 PTY 的迟到输出 */
    generation: z.number().int().nonnegative(),
    /** PTY 是否还活着（false = 已退出或被杀） */
    running: z.boolean(),
    /** 进程退出码；仍在运行 / 未知时为 null */
    exitCode: z.number().int().nullable(),
    /** 被信号杀死时的信号号；否则 null */
    exitSignal: z.number().int().nullable(),
  })
  .strict();
export type TerminalTabMeta = z.infer<typeof terminalTabMetaSchema>;

/** 一个可用的 shell profile（cmd / powershell / pwsh / bash …）。 */
export const terminalProfileSchema = z
  .object({
    /** profile id，稳定标识，open 时回指 */
    id: z.string().min(1),
    /** 展示名 */
    label: z.string().min(1),
  })
  .strict();
export type TerminalProfile = z.infer<typeof terminalProfileSchema>;

// ---------------------------------------------------------------- 通道入参

/** 只带 workspaceId 的入参（list / profiles）。 */
export const terminalWorkspaceRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type TerminalWorkspaceRequest = z.infer<typeof terminalWorkspaceRequestSchema>;

/**
 * `terminal:open` 入参。
 *
 * profileId 省略时主进程挑默认 shell；cols/rows 是初始窗口尺寸。**没有 cwd /
 * command 字段** —— cwd 是 workspace 的 canonical root（主进程解析），要跑什么
 * 由用户在终端里自己敲。
 */
export const terminalOpenRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** shell profile id；省略走主进程默认 */
    profileId: z.string().min(1).nullable().default(null),
    cols: z.number().int().positive().max(2000).default(80),
    rows: z.number().int().positive().max(2000).default(24),
  })
  .strict();
export type TerminalOpenRequest = z.infer<typeof terminalOpenRequestSchema>;

/** `terminal:input` 入参：把用户键入 / 粘贴的字节写进 PTY 的 stdin。 */
export const terminalInputRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    tabId: z.string().min(1),
    /** 键入的原始字节（含控制序列，如回车 \r、Ctrl-C \x03） */
    data: z.string(),
  })
  .strict();
export type TerminalInputRequest = z.infer<typeof terminalInputRequestSchema>;

/** `terminal:resize` 入参。 */
export const terminalResizeRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    tabId: z.string().min(1),
    cols: z.number().int().positive().max(2000),
    rows: z.number().int().positive().max(2000),
  })
  .strict();
export type TerminalResizeRequest = z.infer<typeof terminalResizeRequestSchema>;

/** 按不透明 tabId 定位的入参（snapshot / clear / kill / restart）。 */
export const terminalTabRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    tabId: z.string().min(1),
  })
  .strict();
export type TerminalTabRequest = z.infer<typeof terminalTabRequestSchema>;

/** `terminal:rename` 入参。 */
export const terminalRenameRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    tabId: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();
export type TerminalRenameRequest = z.infer<typeof terminalRenameRequestSchema>;

// ---------------------------------------------------------------- 通道返回

/**
 * 一个已安装的 WSL 发行版（R5.1）。
 *
 * 字段来自 `wsl.exe -l -v` 的解析（注意其输出是 UTF-16LE，解析住在
 * main/terminal/wsl.ts 的纯函数里）。`state`/`version` 原样透传字符串：
 * WSL 的取值集合（Running/Stopped/Installing…）不归我们定义，枚举死了
 * 反而会在 WSL 更新后校验失败。
 */
export const wslDistroSchema = z
  .object({
    /** 发行版名（如 Ubuntu-22.04、docker-desktop） */
    name: z.string().min(1),
    /** 是否默认发行版（wsl -l -v 里带 * 的那一行） */
    isDefault: z.boolean(),
    /** 运行态（Running / Stopped …），解析不出时为空串 */
    state: z.string(),
    /** WSL 版本（"1" / "2"），解析不出时为空串 */
    version: z.string(),
  })
  .strict();
export type WslDistro = z.infer<typeof wslDistroSchema>;

/**
 * `terminal:wsl-distros` 返回。
 *
 * 无 WSL / 非 Windows 机器上 `{available:false, distros:[]}`，**不抛错**：
 * 这条通道的消费者是「要不要显示 WSL 选项」的 UI 判断，缺 WSL 不是异常。
 */
export const terminalWslDistrosResultSchema = z
  .object({
    available: z.boolean(),
    distros: z.array(wslDistroSchema),
  })
  .strict();
export type TerminalWslDistrosResult = z.infer<typeof terminalWslDistrosResultSchema>;

export const terminalListResultSchema = z
  .object({ tabs: z.array(terminalTabMetaSchema) })
  .strict();
export type TerminalListResult = z.infer<typeof terminalListResultSchema>;

export const terminalProfilesResultSchema = z
  .object({
    profiles: z.array(terminalProfileSchema),
    /** 默认 profile id（open 省略 profileId 时用的那一个） */
    defaultId: z.string(),
  })
  .strict();
export type TerminalProfilesResult = z.infer<typeof terminalProfilesResultSchema>;

/**
 * 一次终端动作（input / resize / clear / kill）的结果。
 *
 * 无论成败都结构化返回、绝不向上抛：这条链路的终点是一块终端面板，抛异常
 * 只会退化成「敲了没反应」。`message` 是给人看的失败原因（已在主进程脱敏）。
 */
export const terminalActionResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().nullable(),
  })
  .strict();
export type TerminalActionResult = z.infer<typeof terminalActionResultSchema>;

/**
 * `terminal:snapshot` 返回：ring buffer 的当前内容 + 最后一个 sequence。
 *
 * 渲染进程 reload 之后据此重建屏幕：把 `text` 写进 xterm，再从推送流里接受
 * `sequence > snapshot.sequence` 的 chunk。`text` 是有界的（主进程 ring buffer
 * 按字节封顶），因此这一次 invoke 的返回不会无上界地膨胀。
 */
export const terminalSnapshotResultSchema = z
  .object({
    tabId: z.string(),
    /** 该 tab 存在与否；已被 kill / 未知 tabId 时 found=false，其余字段为空壳 */
    found: z.boolean(),
    generation: z.number().int().nonnegative(),
    /** ring buffer 的当前全部内容（有界） */
    text: z.string(),
    /** 已下发的最后一个 chunk 的 sequence（重连从它之后续接） */
    sequence: z.number().int().nonnegative(),
    running: z.boolean(),
    exitCode: z.number().int().nullable(),
    exitSignal: z.number().int().nullable(),
  })
  .strict();
export type TerminalSnapshotResult = z.infer<typeof terminalSnapshotResultSchema>;

// ---------------------------------------------------------------- 推送 payload

/**
 * `terminal:event` 推送信封的 payload 位。
 *
 * 复用 `PiEnvelope`：信封的 `sessionId` 填 tabId、`generation` 填 tab 代际、
 * `sequence` 填 chunk 序号，渲染侧因此能用现成的 `shouldAcceptEnvelope`
 * （代际优先 + 同代际序号严格递增）丢弃上一代 PTY 的迟到输出。payload 本身
 * 只区分两类事件：
 *
 *   - `data`：一段（已按帧合并的）PTY 输出字节；
 *   - `exit`：PTY 退出（带退出码 / 信号），渲染侧据此标灰该 tab。
 */
export const terminalEventPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("data"),
      tabId: z.string().min(1),
      /** 一段 PTY 输出（多个原始 chunk 已在主进程按帧合并） */
      data: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("exit"),
      tabId: z.string().min(1),
      exitCode: z.number().int().nullable(),
      exitSignal: z.number().int().nullable(),
    })
    .strict(),
]);
export type TerminalEventPayload = z.infer<typeof terminalEventPayloadSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `coding.terminal` 的全部十一条通道。
 *
 * 分片 id 是 capabilityId 的第二段（`coding.terminal` → `terminal`），drift
 * test 据此把「manifest 声明的通道」与「本分片的键集合」逐条对账。
 */
export const terminalContractShard = defineContractShard("terminal", {
  [CHANNELS.terminalList]: {
    request: terminalWorkspaceRequestSchema,
    response: terminalListResultSchema,
  },
  [CHANNELS.terminalProfiles]: {
    request: terminalWorkspaceRequestSchema,
    response: terminalProfilesResultSchema,
  },
  [CHANNELS.terminalOpen]: {
    request: terminalOpenRequestSchema,
    response: terminalTabMetaSchema,
  },
  [CHANNELS.terminalInput]: {
    request: terminalInputRequestSchema,
    response: terminalActionResultSchema,
  },
  [CHANNELS.terminalResize]: {
    request: terminalResizeRequestSchema,
    response: terminalActionResultSchema,
  },
  [CHANNELS.terminalSnapshot]: {
    request: terminalTabRequestSchema,
    response: terminalSnapshotResultSchema,
  },
  [CHANNELS.terminalClear]: {
    request: terminalTabRequestSchema,
    response: terminalActionResultSchema,
  },
  [CHANNELS.terminalKill]: {
    request: terminalTabRequestSchema,
    response: terminalActionResultSchema,
  },
  [CHANNELS.terminalRestart]: {
    request: terminalTabRequestSchema,
    response: terminalTabMetaSchema,
  },
  [CHANNELS.terminalRename]: {
    request: terminalRenameRequestSchema,
    response: terminalTabMetaSchema,
  },
  [CHANNELS.terminalWslDistros]: {
    request: terminalWorkspaceRequestSchema,
    response: terminalWslDistrosResultSchema,
  },
});

/**
 * `coding.terminal` 声明的能力 id 与它申请的危险权限。
 *
 * main/permission 的需求表把这十条通道全部指向 `coding.terminal` /
 * `process.shell`，因此未授权时任意一条终端通道都被第五道闸挡下。集中在契约
 * 层导出，避免主进程侧散落一堆字符串常量（与 git 的 GIT_* 同构）。
 */
export const TERMINAL_CAPABILITY_ID = "coding.terminal";
export const TERMINAL_PERMISSION = "process.shell";

/**
 * 需要 process.shell 授权的全部终端通道（供 main/permission 的需求表派生）。
 *
 * 连只读的 list / profiles / snapshot 也在册：它们暴露「这个 workspace 有哪些
 * 终端会话、里面输出了什么」，未授权就不该被观测到。wsl-distros 同理在册：
 * 枚举发行版本身要 spawn wsl.exe，且「这台机器装了哪些 WSL」也是环境信息。
 * permission-store 的需求表由本数组 `map(...)` 派生，故扩这个数组即自动给新
 * 通道接上第五道闸，无需改动 main/permission 的任何决策逻辑。
 */
export const TERMINAL_GATED_CHANNELS = [
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
  CHANNELS.terminalWslDistros,
] as const;

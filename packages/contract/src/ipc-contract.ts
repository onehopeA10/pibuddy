/**
 * IPC 通道契约：channel 名常量 + per-channel 运行时 schema。
 *
 * 收敛前这 13 个 channel 零运行时校验，preload 与 main 各自内联对象字面量
 * 描述参数形状，其中 `pi:command` 把渲染进程传来的任意 `{type,...}` 原样
 * 转给 pi —— 而 pi 的 rpc 协议原生提供 `{"type":"bash","command":"..."}`，
 * 于是渲染进程里的任意 JS 等价于本机任意命令执行。
 *
 * TASK-007 把它拆成 15 个**产品动作**窄通道：渲染进程只能表达
 * 「发一句话 / 停止 / 换模型」这类有限意图，无法表达「执行这条 shell」。
 * ipc-guard 直接消费本文件的 schema，不再自己写一遍。
 *
 * TypeScript 类型不能替代运行时校验：跨进程边界上收到的是 structured-clone
 * 之后的任意 JS 值，编译期约束在那里已经不存在了。
 */
import { z } from "zod";

import {
  CHANNELS,
  PUSH_CHANNELS,
  type InvokeChannel,
  type PushChannel,
} from "./channels.js";
import {
  defineContractShard,
  sealChannelContracts,
  voidRequestSchema,
  type ChannelContract,
  type ContractShard,
} from "./channel-contract.js";
import {
  bundleExportRequestSchema,
  bundleExportResultSchema,
  bundlePreviewSchema,
  diagnosticsReportSchema,
} from "./diagnostics.js";
import {
  providerCustomRequestSchema,
  providerIdRequestSchema,
  providerListResultSchema,
  providerSaveKeyRequestSchema,
  providerTestResultSchema,
  setScopeDefaultRequestSchema,
  usageExportRequestSchema,
  usageExportResultSchema,
  usageQuerySchema,
  usageRecordRequestSchema,
  usageRowSchema,
} from "./providers.js";
import { agentPoolContractShard, poolSnapshotSchema } from "./agent-pool.js";
import { childAgentContractShard, childTopologySnapshotSchema } from "./child-agent.js";
import { artifactContractShard } from "./artifacts.js";
import { capabilitiesContractShard } from "./capability.js";
import { connectorContractShard } from "./connector.js";
import {
  feishuContractShard,
  slackContractShard,
  telegramContractShard,
} from "./connector-channels.js";
import { gitContractShard } from "./git.js";
import { permissionContractShard } from "./permission.js";
import { memoryContractShard } from "./memory.js";
import { mcpContractShard } from "./mcp.js";
import { previewContractShard } from "./preview.js";
import { sessionTreeContractShard } from "./session-tree.js";
import { tasksContractShard } from "./tasks.js";
import { terminalContractShard, terminalEventPayloadSchema } from "./terminal.js";
import { workflowContractShard, workflowRunSnapshotSchema } from "./workflow.js";
import { remoteContractShard } from "./remote.js";
import { appSettingsSchema, appSettingsPatchSchema } from "./settings.js";
import {
  draftRecordSchema,
  readHistoryRequestSchema,
  sessionHistoryPageSchema,
  sessionQuerySchema,
  sessionRowSchema,
  sessionStatusSchema,
} from "./session.js";
import {
  extUiSnapshotSchema,
  extensionUiRespondResultSchema,
  piPackageCommandRequestSchema,
  piPackageCommandResultSchema,
  piResourceIdRequestSchema,
  piResourceScanResultSchema,
  piResourceSetEnabledRequestSchema,
  piUiExpireAllPayloadSchema,
  piUiExpirePayloadSchema,
  projectTrustStateSchema,
  trustDecideRequestSchema,
  workspaceScopedRequestSchema,
} from "./pi-resources.js";
import {
  updateCheckRequestSchema,
  updateDismissRequestSchema,
  updateEnvelopeSchema,
  updateInstallRequestSchema,
  updateSetChannelRequestSchema,
  updateStateSchema,
  updateToggleRequestSchema,
} from "./update.js";
import {
  changesetContractShard,
  workspaceFilesContractShard,
  workspaceTreeEventSchema,
} from "./workspace.js";

// 通道名常量住在 channels.ts（那个文件不依赖 zod，preload 可以单独引它）。

/**
 * 单条 IPC 准入规则（CT-20）。
 *
 * ipc-guard 的 CHANNEL_MAX_BYTES / RateLimiter 两张表是它的运行时投影；
 * TASK-015 的策略面板直接消费这个类型。
 */
export interface PermissionRule {
  channel: InvokeChannel;
  /** 该通道单次载荷的字节上限 */
  maxBytes: number;
  /** 限流窗口长度（ms） */
  windowMs: number;
  /** 一个窗口内允许的最大调用次数 */
  maxPerWindow: number;
}

// ---------- 具名参数 / 返回类型（替代各处内联对象字面量） ----------

/**
 * pi:start 的入参。
 *
 * **只接受不透明的 workspaceId**：绝对路径由主进程的 workspace-registry
 * 持有，渲染进程从头到尾看不到它，因此也无法把它换成别的目录。
 */
export const piStartParamsSchema = z.object({
  workspaceId: z.string().min(1),
  /** 续接的历史会话；不透明 id，由主进程经会话索引解成文件路径 */
  sessionId: z.string().optional(),
});
export type PiStartParams = z.infer<typeof piStartParamsSchema>;

/**
 * pi:start 的返回。三个槽位由消费方用 @pibuddy/pi-sdk 的具体类型实例化，
 * 契约包不反向依赖 pi-sdk。
 */
export interface StartResult<TState = unknown, TModel = unknown, TMessage = unknown> {
  state: TState;
  models: TModel[];
  messages: TMessage[];
}

/**
 * 工作目录的渲染侧视图。
 *
 * `workspaceId` 是 sha256(canonical realpath) 派生的不透明稳定 id，用于所有
 * 后续调用；`displayPath` **只用于显示**，单向下发，任何 IPC 入参都不接受它。
 */
export const workspaceRefSchema = z.object({
  workspaceId: z.string().min(1),
  displayPath: z.string(),
});
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;

/**
 * 附件 capability 的渲染侧视图（取代早先直接外发绝对路径的 PickedFile）。
 *
 * `token` 是短期能力凭证，30 分钟滑动过期，只能换取签发时那一个 canonical
 * 文件；渲染进程拿它做不了别的事，也无法据它推断出磁盘布局。
 */
export const attachmentRefSchema = z.object({
  token: z.string().min(1),
  name: z.string(),
  size: z.number().nonnegative(),
  kind: z.enum(["image", "video", "other"]),
  /**
   * 相对工作区 root 的路径（工作区内的附件才有）。
   *
   * 加它是为了让附件条显示「src/main/index.ts」而不是光秃秃一个
   * 「index.ts」—— 用户同时拖三个 index.ts 进来时，只有文件名的界面
   * 完全没法分辨。**它仍然不是绝对路径**：工作区外的单文件授权没有
   * root 可相对，这个字段就是 undefined。
   */
  relativePath: z.string().optional(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/** file:read-attachment 的返回：base64 数据 + 由 magic bytes 实测得到的 MIME。 */
export const readImageResultSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
});
export type ReadImageResult = z.infer<typeof readImageResultSchema>;

/** 内联图片附件（粘贴 / 拖拽的图片直接走 base64，不落 token）。 */
export const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

/**
 * stt:transcribe 的入参（CT-07：全计划唯一形状，恰好三个字段）。
 *
 * 收敛前这里是 `{baseUrl, apiKey, model, audio, mimeType}` —— 渲染进程在
 * 一次调用里同时决定「往哪发」和「带哪把密钥」，等价于把 Bearer token
 * 递给任意一台攻击者指定的主机（`http://169.254.169.254/...` 照发不误）。
 *
 * 现在渲染进程只能给出一个由主进程签发的不透明 `endpointId`：地址、模型、
 * 密钥三样全部由 main 侧按 id 查出来，渲染进程一样都碰不到。
 * **不得**再退化成 `{audio, mimeType}`（那样就没法支持多个端点），也不得
 * 加回任何 URL / 密钥形参。
 */
export const sttTranscribeRequestSchema = z.object({
  endpointId: z.string().min(1),
  audio: z.instanceof(ArrayBuffer),
  mimeType: z.string(),
});
export type SttTranscribeRequest = z.infer<typeof sttTranscribeRequestSchema>;

export const sttTranscribeResultSchema = z.object({ text: z.string() });
export type SttTranscribeResult = z.infer<typeof sttTranscribeResultSchema>;

/** 目前只有转写密钥一种。加一种就在这里加一个字面量，并过一遍威胁模型。 */
export const secretKindSchema = z.enum(["stt"]);
export type SecretKind = z.infer<typeof secretKindSchema>;

/** settings:set-secret 的入参。value 为空串表示「清除这把密钥」。 */
export const secretWriteRequestSchema = z.object({
  kind: secretKindSchema,
  value: z.string(),
});

/** settings:describe-secret 的入参。 */
export const secretQueryRequestSchema = z.object({ kind: secretKindSchema });

/**
 * 密钥的**不可逆**描述：只说「配没配」和「尾四位是什么」。
 *
 * 没有第三个字段，将来也不会有 —— 任何能让渲染进程还原出明文的字段
 * （哪怕是「前缀 + 长度」）都会让 safeStorage 那层加密失去意义。
 */
export const secretDescriptorSchema = z.object({
  configured: z.boolean(),
  last4: z.string(),
});
export type SecretDescriptor = z.infer<typeof secretDescriptorSchema>;

// ---------- 15 个产品动作的 request schema ----------

/**
 * pi:prompt 的入参。
 *
 * `streamingBehavior` 必须保留：PiBuddy 的「流式中插话」走
 * prompt + streamingBehavior:"steer"，**不是** pi 的原生 steer 命令
 * （rpc.md 第 65 行：流式过程中不带 streamingBehavior 的 prompt 直接返回
 * error，而原生 steer 命令不接受扩展参数）。把它当成可有可无的可选字段
 * 删掉，插话会静默失败成一条被拒绝的普通 prompt。
 *
 * `attachmentTokens` 而不是路径：非图片附件的「[附件]」提示块由主进程按
 * 结构化引用生成（工作区内一律呈现 relativePath），渲染进程与模型都拿不到
 * 本机的绝对路径。
 */
export const piPromptRequestSchema = z.object({
  message: z.string(),
  images: z.array(imageContentSchema).optional(),
  attachmentTokens: z.array(z.string()).optional(),
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});

/** pi:steer / pi:follow-up 的入参（保留 pi 原生命令的直接映射）。 */
export const piMessageRequestSchema = z.object({
  message: z.string(),
  images: z.array(imageContentSchema).optional(),
});

/**
 * pi:switch-session 的入参。
 *
 * **只接受不透明 sessionId**：JSONL 的绝对路径由主进程的会话索引持有，
 * 渲染进程从头到尾看不到它（CT-15）。handler 侧把 id 解成路径之后仍会重做
 * 一次会话目录收容校验。
 */
export const piSwitchSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
});

export const piSetModelRequestSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});

export const piSetThinkingLevelRequestSchema = z.object({
  level: z.string().min(1),
});

export const piCompactRequestSchema = z.object({
  customInstructions: z.string().optional(),
});

export const piSetSessionNameRequestSchema = z.object({
  name: z.string().min(1),
});

/** pi:get-entries 的入参。`since` 是**上一条已见 entry 的 id**（strictly after）。 */
export const piGetEntriesRequestSchema = z.object({
  since: z.string().optional(),
});

/** pi:fork 的入参：从哪条 user message 分叉。 */
export const piForkRequestSchema = z.object({
  entryId: z.string().min(1),
});

// ---------- 会话中心（SES-101） ----------

/**
 * 会话通道的公共入参：**workspaceId 与 sessionId 必须成对出现**。
 *
 * sessionId 不是全局唯一的。它由 pi 写在 JSONL 头部，复制一份会话文件、从
 * 备份里恢复、或两个工作区共用一个自定义 session-dir，都会让同一个 id 在
 * 索引里出现两行。少了 workspaceId 时主进程只能「按 id 取最近修改的那行」，
 * 于是重命名、归档、彻底删除、草稿读写都可能落到**另一个工作区**的会话上 ——
 * purge 那一条是不可逆的。
 *
 * 因此这里把它做成必填而不是可选：漏传就编译不过，而不是等到用户的会话被
 * 改到别处才发现。
 */
const workspaceScoped = {
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
};

/** sessions:rename 的入参。sessionId 是不透明标识，不是文件路径。 */
export const sessionRenameRequestSchema = z.object({
  ...workspaceScoped,
  name: z.string().min(1),
});

export const sessionSetPinnedRequestSchema = z.object({
  ...workspaceScoped,
  pinned: z.boolean(),
});

export const sessionSetStatusRequestSchema = z.object({
  ...workspaceScoped,
  status: sessionStatusSchema,
});

export const sessionIdRequestSchema = z.object({ ...workspaceScoped });

export const sessionSaveDraftRequestSchema = z.object({
  ...workspaceScoped,
  draft: draftRecordSchema,
});

export const extensionUiResponseSchema = z.object({
  type: z.literal("extension_ui_response"),
  id: z.string(),
  value: z.string().optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
});

/** 只带一个能力凭证的通道（读附件 / 打开 / 定位）。 */
export const tokenRequestSchema = z.object({ token: z.string().min(1) });

// 无参通道的入参 schema（voidRequestSchema）已移居 channel-contract.ts：
// 各契约分片文件不能反向 import 本文件（会成环），而注册期的同一性核对
// （ISS-001）要求全仓只有这一个实例。此处经 index.ts 的 `export *` 继续对外。

/** 只带工作区不透明 id 的入参（会话枚举）。 */
export const workspaceIdRequestSchema = z.object({
  workspaceId: z.string().min(1),
});

/** file:attach-dropped：拖拽进来的文件，preload 内部用 webUtils 取路径后立刻换 token。 */
export const attachDroppedRequestSchema = z.object({
  droppedPath: z.string().min(1),
});

/**
 * 渲染进程可写的设置子集。
 *
 * 显式剔除 `workspace` —— 工作目录只能经 dialog:choose-folder（一次真实的
 * 用户手势）设置。留着它等于给渲染进程留了一条「把工作目录改到 C:\ 再
 * 让智能体随便读」的旁路。
 */
export const rendererSettingsPatchSchema = appSettingsPatchSchema.omit({
  workspace: true,
  // 以下四项是**主进程单向下发**的派生字段：端点 id 由 endpoints.ts 在校验
  // 通过后签发，配置态由 secret-store 计算，schema 代际由 migrate 维护。
  // 允许渲染进程写它们，等于允许它自称「已配置」或指向一个没校验过的端点。
  schemaVersion: true,
  sttEndpointId: true,
  sttApiKeyConfigured: true,
  sttApiKeyLast4: true,
  // workspace 层默认模型只能经 providers:set-scope-default 写：那条路上
  // workspaceId 会被解成真实 root 并校验存在，允许渲染进程直接塞一整张表
  // 等于让它自己编 workspaceId。
  workspaceDefaults: true,
  // ---- SEC-005：Pi 运行时来源不再是一个「设置字段」----
  //
  // 这两项最终会走到 pi-launcher 的 spawn：`piExternalCommand` 就是那条
  // 命令行的第一个 argv。留在可写集合里，等于给渲染进程留了一条
  // 「写一次设置 → 主进程替我启动任意本机程序」的路 —— 它绕开了 TASK-007
  // 把 `pi:command` 拆成 15 条窄通道所建立的全部约束（那次收敛的整个理由
  // 就是「渲染进程不得表达任意命令执行」）。
  //
  // 改由 `settings:set-pi-runtime` 承接：入参只有 mode 枚举，路径由主进程
  // 的原生文件选择框产生，并经一次展示完整路径的确认框。
  piRuntimeMode: true,
  piExternalCommand: true,
});

/**
 * `settings:set-pi-runtime` 的入参（SEC-005）。
 *
 * **恰好一个字段**，且它是枚举而不是字符串。渲染进程能表达的极限是
 * 「我想用内置」或「我想挑一个外部命令」这两个意图，表达不出「用这个
 * 文件」—— 后者由主进程弹原生对话框向用户当面取得。
 */
export const piRuntimeChoiceRequestSchema = z.object({
  mode: z.enum(["bundled", "external"]),
});
export type PiRuntimeChoiceRequest = z.infer<typeof piRuntimeChoiceRequestSchema>;

/**
 * `settings:set-pi-runtime` 的返回。
 *
 * `applied:false` 表示用户在文件选择框或确认框里取消了 —— 此时磁盘上一个
 * 字节都没改，`settings` 是原样的当前设置。界面据此提示「已取消」，而不是
 * 谎报保存成功。
 */
export const piRuntimeApplyResultSchema = z.object({
  applied: z.boolean(),
  settings: appSettingsSchema,
});
export type PiRuntimeApplyResult = z.infer<typeof piRuntimeApplyResultSchema>;

/** RPC 响应的通用外壳；`data` 的具体形状由各命令自行约定。 */
export const rpcResponseSchema = z
  .object({ success: z.boolean(), error: z.string().optional() })
  .loose();

// ---------- per-channel schema ----------

/**
 * 运行时 schema 的**结构化**类型。
 *
 * `packages/app` 不能直接 import zod：electron-vite 的 externalizeDepsPlugin
 * 会把 app 的直接依赖统统标成 external，打包产物里于是出现一个解析不到的
 * `import "zod"`。契约包自己依赖 zod 并把「能 parse」这件能力以结构类型
 * 的形式传出去，app 侧只认这个形状即可。
 */
export interface RuntimeSchema<T = unknown> {
  parse(value: unknown): T;
}

const NO_ARGS: ChannelContract = {
  request: voidRequestSchema,
  response: rpcResponseSchema,
};

/**
 * ---------- 契约分片（ADR-0002 实施顺序第 2 条） ----------
 *
 * 改前这里是**一个** `Record<InvokeChannel, ChannelContract>` 对象字面量，
 * 类型的穷举性保证「每条通道都有 schema」。代价是所有通道必须写在同一个
 * 对象里 —— 能力包无法各自声明自己那几条再合并，而那正是能力包架构的前提。
 *
 * 现在每一组通道是一个具名分片，由 `sealChannelContracts` 合并并封口：
 * 重复 key 抛错、缺一条抛错、多一条抛错（见 channel-contract.ts）。
 *
 * 已经能独立成片的四组直接住进了各自的域文件（`workspace.ts` 的
 * workspace-files / workspace-review、`preview.ts`、`artifacts.ts`）——
 * 那是能力包拆出去之后契约该待的地方。剩下的仍留在本文件，因为它们的
 * request schema 也还定义在这里；随各自能力包拆分时一并搬走。
 */

export const piRuntimeContractShard = defineContractShard("pi-runtime", {
  // ---- 生命周期 ----
  [CHANNELS.piStart]: {
    request: piStartParamsSchema,
    response: z.object({
      state: z.unknown(),
      models: z.array(z.unknown()),
      messages: z.array(z.unknown()),
    }),
  },
  [CHANNELS.piStop]: { request: voidRequestSchema, response: z.void() },
  [CHANNELS.piUiRespond]: {
    request: extensionUiResponseSchema,
    // 返回值不是 void：respond 会因为「这条已经过期」或「runtime 没了」
    // 而失败，渲染进程必须能看见并据此给用户一句解释。
    response: extensionUiRespondResultSchema,
  },
  [CHANNELS.piUiPending]: {
    request: voidRequestSchema,
    response: extUiSnapshotSchema,
  },

  // ---- 15 个产品动作 ----
  [CHANNELS.piPrompt]: { request: piPromptRequestSchema, response: rpcResponseSchema },
  [CHANNELS.piSteer]: { request: piMessageRequestSchema, response: rpcResponseSchema },
  [CHANNELS.piFollowUp]: { request: piMessageRequestSchema, response: rpcResponseSchema },
  [CHANNELS.piAbort]: NO_ARGS,
  [CHANNELS.piNewSession]: NO_ARGS,
  [CHANNELS.piSwitchSession]: {
    request: piSwitchSessionRequestSchema,
    response: rpcResponseSchema,
  },
  [CHANNELS.piSetModel]: {
    request: piSetModelRequestSchema,
    response: rpcResponseSchema,
  },
  [CHANNELS.piSetThinkingLevel]: {
    request: piSetThinkingLevelRequestSchema,
    response: rpcResponseSchema,
  },
  [CHANNELS.piGetState]: NO_ARGS,
  [CHANNELS.piGetMessages]: NO_ARGS,
  [CHANNELS.piGetSessionStats]: NO_ARGS,
  [CHANNELS.piGetAvailableModels]: NO_ARGS,
  [CHANNELS.piGetAvailableThinkingLevels]: NO_ARGS,
  [CHANNELS.piCompact]: { request: piCompactRequestSchema, response: rpcResponseSchema },
  [CHANNELS.piSetSessionName]: {
    request: piSetSessionNameRequestSchema,
    response: rpcResponseSchema,
  },

  // ---- 会话树 / 分叉（数据面） ----
  [CHANNELS.piGetEntries]: {
    request: piGetEntriesRequestSchema,
    response: rpcResponseSchema,
  },
  [CHANNELS.piGetTree]: NO_ARGS,
  [CHANNELS.piGetForkMessages]: NO_ARGS,
  [CHANNELS.piFork]: { request: piForkRequestSchema, response: rpcResponseSchema },
  [CHANNELS.piClone]: NO_ARGS,
});

export const sessionsContractShard = defineContractShard("sessions", {
  // ---- 会话中心（9 条） ----
  [CHANNELS.sessionsQuery]: {
    request: sessionQuerySchema,
    response: z.array(sessionRowSchema),
  },
  [CHANNELS.sessionsRename]: {
    request: sessionRenameRequestSchema,
    response: z.void(),
  },
  [CHANNELS.sessionsSetPinned]: {
    request: sessionSetPinnedRequestSchema,
    response: z.void(),
  },
  [CHANNELS.sessionsSetStatus]: {
    request: sessionSetStatusRequestSchema,
    response: z.void(),
  },
  [CHANNELS.sessionsPurge]: { request: sessionIdRequestSchema, response: z.void() },
  [CHANNELS.sessionsGetDraft]: {
    request: sessionIdRequestSchema,
    response: draftRecordSchema.nullable(),
  },
  [CHANNELS.sessionsSaveDraft]: {
    request: sessionSaveDraftRequestSchema,
    response: z.boolean(),
  },
  [CHANNELS.sessionsExportHtml]: {
    request: sessionIdRequestSchema,
    response: rpcResponseSchema,
  },
  [CHANNELS.sessionsReadHistory]: {
    request: readHistoryRequestSchema,
    response: sessionHistoryPageSchema,
  },
});

export const settingsContractShard = defineContractShard("settings", {
  // ---- 设置 ----
  [CHANNELS.settingsGet]: { request: voidRequestSchema, response: appSettingsSchema },
  [CHANNELS.settingsSet]: {
    request: rendererSettingsPatchSchema,
    response: appSettingsSchema,
  },
  [CHANNELS.settingsSetSecret]: {
    request: secretWriteRequestSchema,
    response: secretDescriptorSchema,
  },
  [CHANNELS.settingsDescribeSecret]: {
    request: secretQueryRequestSchema,
    response: secretDescriptorSchema,
  },
  [CHANNELS.settingsSetPiRuntime]: {
    request: piRuntimeChoiceRequestSchema,
    response: piRuntimeApplyResultSchema,
  },
});

export const attachmentsContractShard = defineContractShard("attachments", {
  // ---- workspace 与附件 ----
  [CHANNELS.workspaceCurrent]: {
    request: voidRequestSchema,
    response: workspaceRefSchema.nullable(),
  },
  [CHANNELS.dialogChooseFolder]: {
    request: voidRequestSchema,
    response: workspaceRefSchema.nullable(),
  },
  [CHANNELS.dialogChooseFiles]: {
    request: voidRequestSchema,
    response: z.array(attachmentRefSchema),
  },
  [CHANNELS.fileAttachDropped]: {
    request: attachDroppedRequestSchema,
    response: attachmentRefSchema,
  },
  [CHANNELS.fileReadAttachment]: {
    request: tokenRequestSchema,
    response: readImageResultSchema,
  },
  [CHANNELS.shellOpenPath]: { request: tokenRequestSchema, response: z.string() },
  [CHANNELS.shellShowInFolder]: { request: tokenRequestSchema, response: z.void() },
  [CHANNELS.attachmentRevokeAll]: { request: voidRequestSchema, response: z.void() },
});

export const sttContractShard = defineContractShard("stt", {
  // ---- 语音 ----
  [CHANNELS.sttTranscribe]: {
    request: sttTranscribeRequestSchema,
    response: sttTranscribeResultSchema,
  },
});

export const piResourcesContractShard = defineContractShard("pi-resources", {
  // ---- Pi 资源中心与 project trust（7 条） ----
  //
  // 五条资源通道全部以 scan 结果作为返回：任何一次改动之后渲染进程立刻拿到
  // 权威快照，不必自己推断列表变成了什么样 —— 「开关拨了但列表没变」这类
  // 问题在结构上不成立。
  [CHANNELS.piResourcesScan]: {
    request: workspaceScopedRequestSchema,
    response: piResourceScanResultSchema,
  },
  [CHANNELS.piResourcesSetEnabled]: {
    request: piResourceSetEnabledRequestSchema,
    response: piResourceScanResultSchema,
  },
  [CHANNELS.piResourcesInstall]: {
    request: piPackageCommandRequestSchema,
    response: piPackageCommandResultSchema,
  },
  [CHANNELS.piResourcesRemove]: {
    request: piPackageCommandRequestSchema,
    response: piPackageCommandResultSchema,
  },
  [CHANNELS.piResourcesOpenDir]: {
    request: piResourceIdRequestSchema,
    response: z.void(),
  },
  [CHANNELS.trustDescribe]: {
    request: workspaceScopedRequestSchema,
    response: projectTrustStateSchema,
  },
  [CHANNELS.trustDecide]: {
    request: trustDecideRequestSchema,
    response: projectTrustStateSchema,
  },
});

export const updateContractShard = defineContractShard("update", {
  // ---- 应用自更新 ----
  //
  // 九条全部以 UpdateState 作为返回：渲染进程发起任何一个动作之后立刻拿到
  // 权威快照，不必等推送 —— 「点了没反应」这类问题在结构上就不成立。
  [CHANNELS.updateGetState]: { request: voidRequestSchema, response: updateStateSchema },
  [CHANNELS.updateCheck]: {
    request: updateCheckRequestSchema,
    response: updateStateSchema,
  },
  [CHANNELS.updateDownload]: { request: voidRequestSchema, response: updateStateSchema },
  [CHANNELS.updateCancelDownload]: {
    request: voidRequestSchema,
    response: updateStateSchema,
  },
  [CHANNELS.updateInstall]: {
    request: updateInstallRequestSchema,
    response: updateStateSchema,
  },
  [CHANNELS.updateSetChannel]: {
    request: updateSetChannelRequestSchema,
    response: updateStateSchema,
  },
  [CHANNELS.updateSetAutoCheck]: {
    request: updateToggleRequestSchema,
    response: updateStateSchema,
  },
  [CHANNELS.updateSetAutoDownload]: {
    request: updateToggleRequestSchema,
    response: updateStateSchema,
  },
  [CHANNELS.updateDismissVersion]: {
    request: updateDismissRequestSchema,
    response: updateStateSchema,
  },
});

export const providersContractShard = defineContractShard("providers", {
  // ---- Provider 与模型中心（PROV-101） ----
  //
  // 每一条的 response 都是**权威快照**（providerListResult / providerTestResult）：
  // 渲染进程做完任何一个动作立刻拿到全量状态，不必自己推断列表变成了什么样。
  [CHANNELS.providersList]: {
    request: voidRequestSchema,
    response: providerListResultSchema,
  },
  [CHANNELS.providersSaveKey]: {
    request: providerSaveKeyRequestSchema,
    response: providerListResultSchema,
  },
  [CHANNELS.providersRemove]: {
    request: providerIdRequestSchema,
    response: providerListResultSchema,
  },
  [CHANNELS.providersAddCustom]: {
    request: providerCustomRequestSchema,
    response: providerListResultSchema,
  },
  [CHANNELS.providersTest]: {
    request: providerIdRequestSchema,
    response: providerTestResultSchema,
  },
  [CHANNELS.providersDiscoverModels]: {
    request: providerIdRequestSchema,
    response: providerListResultSchema,
  },
  [CHANNELS.providersSetScopeDefault]: {
    request: setScopeDefaultRequestSchema,
    response: appSettingsSchema,
  },
  [CHANNELS.usageQuery]: {
    request: usageQuerySchema,
    response: z.array(usageRowSchema),
  },
  [CHANNELS.usageExport]: {
    request: usageExportRequestSchema,
    response: usageExportResultSchema,
  },
  [CHANNELS.usageRecord]: {
    request: usageRecordRequestSchema,
    response: z.void(),
  },
});

export const diagnosticsContractShard = defineContractShard("diagnostics", {
  // ---- 诊断与健康（OBS-101，恰 3 条） ----
  [CHANNELS.diagnosticsPreviewBundle]: {
    request: voidRequestSchema,
    response: bundlePreviewSchema,
  },
  [CHANNELS.diagnosticsExportBundle]: {
    request: bundleExportRequestSchema,
    response: bundleExportResultSchema,
  },
  [CHANNELS.diagnosticsGetReport]: {
    request: voidRequestSchema,
    response: diagnosticsReportSchema,
  },
});

/**
 * 宿主的装配清单。
 *
 * 能力包拆出去之后，这个数组就是「本次构建启用了哪些能力」的唯一声明点；
 * 现阶段全部内置，因此全部列在这里。
 */
export const CHANNEL_CONTRACT_SHARDS: readonly ContractShard[] = [
  piRuntimeContractShard,
  sessionsContractShard,
  settingsContractShard,
  attachmentsContractShard,
  workspaceFilesContractShard,
  changesetContractShard,
  previewContractShard,
  artifactContractShard,
  sttContractShard,
  piResourcesContractShard,
  updateContractShard,
  providersContractShard,
  diagnosticsContractShard,
  capabilitiesContractShard,
  permissionContractShard,
  memoryContractShard,
  mcpContractShard,
  sessionTreeContractShard,
  agentPoolContractShard,
  childAgentContractShard,
  gitContractShard,
  tasksContractShard,
  connectorContractShard,
  feishuContractShard,
  slackContractShard,
  telegramContractShard,
  workflowContractShard,
  terminalContractShard,
  remoteContractShard,
];

/**
 * 合并并封口后的全表。
 *
 * `sealChannelContracts` 在模块加载期核对 `CHANNELS` 全表：任何一条通道
 * 漏掉契约，`import "@pibuddy/contract"` 本身就会抛错 —— 那是原先
 * `Record<InvokeChannel, …>` 那条穷举性约束的等价物（见 channel-contract.ts
 * 的文件头）。
 */
export const CHANNEL_CONTRACTS = sealChannelContracts(CHANNEL_CONTRACT_SHARDS);

/**
 * pi:exit 的 payload。
 *
 * `reason` 是 RUN-002 的关键区分：用户点「停止」和进程自己崩了，界面文案与
 * 后续动作完全不同，早先两者都只有一个 `code` 可看，UI 只能一律报「意外退出」。
 */
export const piExitPayloadSchema = z.object({
  code: z.number().nullable(),
  reason: z.enum(["expected-stop", "crash"]),
  error: z.string().optional(),
});

export type PiExitPayload = z.infer<typeof piExitPayloadSchema>;

/**
 * pi RPC 事件 / UI 请求的内部结构由 @pibuddy/pi-sdk 负责，
 * 这里只在 IPC 边界上校验「是个对象且带 type」。
 */
const rpcEnvelopeLikeSchema = z.object({ type: z.string() }).loose();

/** 推送通道的 payload schema（信封的 payload 位）。 */
export const PUSH_CONTRACTS: Record<PushChannel, z.ZodType> = {
  [PUSH_CHANNELS.piEvent]: rpcEnvelopeLikeSchema,
  [PUSH_CHANNELS.piUiRequest]: rpcEnvelopeLikeSchema,
  [PUSH_CHANNELS.piExit]: piExitPayloadSchema,
  [PUSH_CHANNELS.piUiExpire]: piUiExpirePayloadSchema,
  [PUSH_CHANNELS.piUiExpireAll]: piUiExpireAllPayloadSchema,
  // update:event 推的是完整信封（不是裸 payload）：代际与序号必须送到渲染
  // 进程才能用来丢弃陈旧帧，在中途剥壳等于把丢弃判据扔了。
  [PUSH_CHANNELS.updateEvent]: updateEnvelopeSchema,
  [PUSH_CHANNELS.workspaceTreeEvent]: workspaceTreeEventSchema,
  // agent-pool:event 推的是 PiEnvelope<PoolSnapshot>；这里校验的是信封的
  // payload 位（整份快照）。
  [PUSH_CHANNELS.agentPoolEvent]: poolSnapshotSchema,
  // child-agent:event 推的是 PiEnvelope<ChildTopologySnapshot>；这里校验的是
  // 信封的 payload 位（整棵拓扑快照）。
  [PUSH_CHANNELS.childAgentEvent]: childTopologySnapshotSchema,
  // workflow:event 推的是 PiEnvelope<WorkflowRunSnapshot>；这里校验的是信封的
  // payload 位（整份运行快照）。
  [PUSH_CHANNELS.workflowEvent]: workflowRunSnapshotSchema,
  // terminal:event 推的是 PiEnvelope<TerminalEventPayload>；这里校验的是信封的
  // payload 位（一段 PTY 输出或一次退出）。
  [PUSH_CHANNELS.terminalEvent]: terminalEventPayloadSchema,
};

/** channel 名是否在白名单内。ipc-guard 的第一道闸。 */
export function isKnownChannel(channel: string): channel is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(CHANNEL_CONTRACTS, channel);
}

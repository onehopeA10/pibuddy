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
import { appSettingsSchema, appSettingsPatchSchema } from "./settings.js";
import { sessionMetaSchema } from "./session.js";

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
  /** 续接的历史会话；必须是主进程自己枚举出来的会话文件 */
  sessionPath: z.string().optional(),
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
 * stt:transcribe 的入参。
 *
 * M0 阶段仍由渲染进程携带 baseUrl / apiKey —— 这是 SEC-003 的已知缺口，
 * M2 会把凭据挪进主进程、本类型改为只带 endpointId。
 */
export const sttTranscribeRequestSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  model: z.string().min(1),
  audio: z.instanceof(ArrayBuffer),
  mimeType: z.string(),
});
export type SttTranscribeRequest = z.infer<typeof sttTranscribeRequestSchema>;

export const sttTranscribeResultSchema = z.object({ text: z.string() });
export type SttTranscribeResult = z.infer<typeof sttTranscribeResultSchema>;

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
 * `attachmentTokens` 而不是路径：非图片附件的「[用户提供的文件]」提示块
 * 由主进程用 token 换回真实路径后拼接，渲染进程全程接触不到路径。
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

export const piSwitchSessionRequestSchema = z.object({
  /** 必须是主进程自己在会话目录里枚举出来的文件，handler 侧重做收容校验 */
  sessionPath: z.string().min(1),
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

export const extensionUiResponseSchema = z.object({
  type: z.literal("extension_ui_response"),
  id: z.string(),
  value: z.string().optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
});

/** 只带一个能力凭证的通道（读附件 / 打开 / 定位）。 */
export const tokenRequestSchema = z.object({ token: z.string().min(1) });

/** 无参通道的入参 schema。 */
export const voidRequestSchema = z.void();

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
});

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

export interface ChannelContract {
  /** invoke 的入参 schema；无参通道为 z.void() */
  request: z.ZodType;
  /** invoke 的返回 schema */
  response: z.ZodType;
}

const NO_ARGS: ChannelContract = {
  request: voidRequestSchema,
  response: rpcResponseSchema,
};

export const CHANNEL_CONTRACTS: Record<InvokeChannel, ChannelContract> = {
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
    response: z.void(),
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

  // ---- 会话 / 设置 ----
  [CHANNELS.sessionsList]: {
    request: workspaceIdRequestSchema,
    response: z.array(sessionMetaSchema),
  },
  [CHANNELS.settingsGet]: { request: voidRequestSchema, response: appSettingsSchema },
  [CHANNELS.settingsSet]: {
    request: rendererSettingsPatchSchema,
    response: appSettingsSchema,
  },

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

  // ---- 语音 ----
  [CHANNELS.sttTranscribe]: {
    request: sttTranscribeRequestSchema,
    response: sttTranscribeResultSchema,
  },
};

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
};

/** channel 名是否在白名单内。ipc-guard 的第一道闸。 */
export function isKnownChannel(channel: string): channel is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(CHANNEL_CONTRACTS, channel);
}

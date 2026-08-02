/**
 * IPC 通道契约：channel 名常量 + per-channel 运行时 schema。
 *
 * 收敛前这 16 个 channel 零运行时校验，preload 与 main 各自内联对象字面量
 * 描述参数形状。TASK-007 的 ipc-guard 直接消费本文件的 schema，
 * 不再自己写一遍。
 *
 * TypeScript 类型不能替代运行时校验：跨进程边界上收到的是 structured-clone
 * 之后的任意 JS 值，编译期约束在那里已经不存在了。
 */
import { z } from "zod";

import { appSettingsSchema, appSettingsPatchSchema } from "./settings.js";
import { sessionMetaSchema } from "./session.js";

/** 渲染进程可发起的 invoke 通道（13 个）与主进程单向推送通道（3 个）。 */
export const CHANNELS = {
  piStart: "pi:start",
  piCommand: "pi:command",
  piUiRespond: "pi:ui-respond",
  piStop: "pi:stop",
  sessionsList: "sessions:list",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  dialogChooseFolder: "dialog:choose-folder",
  dialogChooseFiles: "dialog:choose-files",
  fileReadImage: "file:read-image",
  shellOpenPath: "shell:open-path",
  shellShowInFolder: "shell:show-in-folder",
  sttTranscribe: "stt:transcribe",
} as const;

export const PUSH_CHANNELS = {
  piEvent: "pi:event",
  piUiRequest: "pi:ui-request",
  piExit: "pi:exit",
} as const;

export type InvokeChannel = (typeof CHANNELS)[keyof typeof CHANNELS];
export type PushChannel = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS];

// ---------- 具名参数 / 返回类型（替代各处内联对象字面量） ----------

/**
 * pi:start 的入参。
 *
 * `workspace` 是工作目录**绝对路径**，刻意没有叫 workspaceId —— 后者在
 * PiEnvelope 中表示 M1 引入的稳定工作区标识，两者不是一回事。
 */
export const piStartParamsSchema = z.object({
  workspace: z.string().min(1),
  session: z.string().optional(),
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

/** dialog:choose-files 返回的单个文件描述。 */
export const pickedFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().nonnegative(),
  kind: z.enum(["image", "video", "other"]),
});
export type PickedFile = z.infer<typeof pickedFileSchema>;

/** file:read-image 的返回：base64 数据 + MIME。 */
export const readImageResultSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
});
export type ReadImageResult = z.infer<typeof readImageResultSchema>;

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

// ---------- per-channel schema ----------

/**
 * pi RPC 命令 / 响应 / 事件的内部结构由 @pibuddy/pi-sdk 负责，
 * 这里只在 IPC 边界上校验「是个对象且带 type」。
 */
const rpcEnvelopeLikeSchema = z.object({ type: z.string() }).loose();

export interface ChannelContract {
  /** invoke 的入参 schema；无参通道为 z.void() */
  request: z.ZodType;
  /** invoke 的返回 schema */
  response: z.ZodType;
}

export const CHANNEL_CONTRACTS: Record<InvokeChannel, ChannelContract> = {
  [CHANNELS.piStart]: {
    request: piStartParamsSchema,
    response: z.object({
      state: z.unknown(),
      models: z.array(z.unknown()),
      messages: z.array(z.unknown()),
    }),
  },
  [CHANNELS.piCommand]: {
    request: rpcEnvelopeLikeSchema,
    response: z.object({ success: z.boolean() }).loose(),
  },
  [CHANNELS.piUiRespond]: {
    request: z.object({
      type: z.literal("extension_ui_response"),
      id: z.string(),
      value: z.string().optional(),
      confirmed: z.boolean().optional(),
      cancelled: z.boolean().optional(),
    }),
    response: z.void(),
  },
  [CHANNELS.piStop]: { request: z.void(), response: z.void() },
  [CHANNELS.sessionsList]: {
    request: z.string().min(1),
    response: z.array(sessionMetaSchema),
  },
  [CHANNELS.settingsGet]: { request: z.void(), response: appSettingsSchema },
  [CHANNELS.settingsSet]: {
    request: appSettingsPatchSchema,
    response: appSettingsSchema,
  },
  [CHANNELS.dialogChooseFolder]: {
    request: z.void(),
    response: z.string().nullable(),
  },
  [CHANNELS.dialogChooseFiles]: {
    request: z.void(),
    response: z.array(pickedFileSchema),
  },
  [CHANNELS.fileReadImage]: {
    request: z.string().min(1),
    response: readImageResultSchema,
  },
  [CHANNELS.shellOpenPath]: { request: z.string().min(1), response: z.string() },
  [CHANNELS.shellShowInFolder]: { request: z.string().min(1), response: z.void() },
  [CHANNELS.sttTranscribe]: {
    request: sttTranscribeRequestSchema,
    response: sttTranscribeResultSchema,
  },
};

/** 推送通道的 payload schema（信封的 payload 位）。 */
export const PUSH_CONTRACTS: Record<PushChannel, z.ZodType> = {
  [PUSH_CHANNELS.piEvent]: rpcEnvelopeLikeSchema,
  [PUSH_CHANNELS.piUiRequest]: rpcEnvelopeLikeSchema,
  [PUSH_CHANNELS.piExit]: z.number().nullable(),
};

/** channel 名是否在白名单内。ipc-guard 的第一道闸。 */
export function isKnownChannel(channel: string): channel is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(CHANNEL_CONTRACTS, channel);
}

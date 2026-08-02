/**
 * `window.piBuddy.pi` —— pi 运行时的全部接口面。
 *
 * 顶层是**产品动作窄方法**：每一个都对应一个具体意图（发一句话 / 停止 /
 * 换模型 / 从某条消息分叉）。这里没有、也不会有一条能表达「执行任意 pi
 * 命令」的方法 —— pi 的 rpc 协议原生提供 `{"type":"bash", ...}` 直接执行
 * shell，留一条通用转发口等于把本机命令行挂在渲染进程上。
 *
 * 三个非动作的子命名空间（runtime / events / extensionUi）挂在下面而不是
 * 与 pi 平级：它们同样属于 pi 运行时，但不是用户能表达的「产品意图」，
 * 混在一层里会让「pi 上有哪些动作」这个问题失去确定答案。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { PiEnvelope, PiExitPayload, PiStartParams, StartResult } from "@pibuddy/contract";
// pi 协议自身的形状归 pi-sdk 的 types.ts 所有；契约包刻意不复制一份同名类型
// （check-contract-uniqueness 会把那算作漂移）。类型导入编译期就消失，
// 不会给 sandbox preload 的产物带进任何运行时依赖。
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ImageContent,
  Model,
  RpcResponse,
  SessionStats,
  ThinkingLevel,
} from "@pibuddy/pi-sdk";
import { invoke, subscribe } from "./bridge.js";

/** pi:start 的返回，用 pi-sdk 的具体类型实例化契约里的泛型槽位。 */
export type PiStartResult = StartResult<AgentState, Model, AgentMessage>;

export const pi = {
  /**
   * 发消息。`streamingBehavior:"steer"` 是流式插话的**唯一**正确表达方式：
   * PiBuddy 从不调用 pi 的原生 steer 命令（rpc.md 第 65 行，原生 steer 不接受
   * 扩展参数，而流式中不带 streamingBehavior 的 prompt 会直接返回 error）。
   */
  prompt: (payload: {
    message: string;
    images?: ImageContent[];
    attachmentTokens?: string[];
    streamingBehavior?: "steer" | "followUp";
  }) => invoke<RpcResponse>(CHANNELS.piPrompt, payload),
  steer: (payload: { message: string; images?: ImageContent[] }) =>
    invoke<RpcResponse>(CHANNELS.piSteer, payload),
  followUp: (payload: { message: string; images?: ImageContent[] }) =>
    invoke<RpcResponse>(CHANNELS.piFollowUp, payload),
  abort: () => invoke<RpcResponse>(CHANNELS.piAbort),
  newSession: () => invoke<RpcResponse<{ cancelled?: boolean }>>(CHANNELS.piNewSession),
  /** sessionId 必须来自 sessions.query()；主进程会把它解成路径并重做收容校验 */
  switchSession: (sessionId: string) =>
    invoke<RpcResponse<{ cancelled?: boolean }>>(CHANNELS.piSwitchSession, { sessionId }),
  setModel: (provider: string, modelId: string) =>
    invoke<RpcResponse>(CHANNELS.piSetModel, { provider, modelId }),
  setThinkingLevel: (level: ThinkingLevel) =>
    invoke<RpcResponse>(CHANNELS.piSetThinkingLevel, { level }),
  getState: () => invoke<RpcResponse<AgentState>>(CHANNELS.piGetState),
  getMessages: () => invoke<RpcResponse<{ messages: AgentMessage[] }>>(CHANNELS.piGetMessages),
  getSessionStats: () => invoke<RpcResponse<SessionStats>>(CHANNELS.piGetSessionStats),
  getAvailableModels: () =>
    invoke<RpcResponse<{ models: Model[] }>>(CHANNELS.piGetAvailableModels),
  getAvailableThinkingLevels: () =>
    invoke<RpcResponse<{ levels: ThinkingLevel[] }>>(CHANNELS.piGetAvailableThinkingLevels),
  compact: (customInstructions?: string) =>
    invoke<RpcResponse>(CHANNELS.piCompact, { customInstructions }),
  setSessionName: (name: string) => invoke<RpcResponse>(CHANNELS.piSetSessionName, { name }),

  /**
   * 会话树 / 分叉的数据面。
   *
   * `getEntries` 的 `since` 是**只能往新方向走**的游标（rpc.md:696
   * "strictly after"）。往更早翻页不在这里 —— 那条路走
   * `sessions.readHistoryBefore()`，由主进程按 JSONL 字节 offset 本地实现。
   */
  getEntries: (since?: string) =>
    invoke<RpcResponse<{ entries: unknown[]; leafId: string | null }>>(CHANNELS.piGetEntries, {
      since,
    }),
  getTree: () => invoke<RpcResponse<{ roots: unknown[] }>>(CHANNELS.piGetTree),
  getForkMessages: () => invoke<RpcResponse<{ messages: unknown[] }>>(CHANNELS.piGetForkMessages),
  /** 扩展可否决：success 仍为 true，需自行检查 data.cancelled */
  fork: (entryId: string) =>
    invoke<RpcResponse<{ text: string; cancelled?: boolean }>>(CHANNELS.piFork, { entryId }),
  clone: () => invoke<RpcResponse<{ cancelled?: boolean }>>(CHANNELS.piClone),

  /** 运行时生命周期。刻意与产品动作分层，免得「pi 有哪些动作」变成一笔糊涂账。 */
  runtime: {
    start: (opts: PiStartParams) => invoke<PiStartResult>(CHANNELS.piStart, opts),
    stop: () => invoke<void>(CHANNELS.piStop),
  },

  /** 三个通道传的都是完整的 PiEnvelope，由渲染进程 parseEnvelope 后解包。 */
  events: {
    onEvent: (cb: (e: PiEnvelope<AgentEvent>) => void) =>
      subscribe("pi:event", cb as (p: unknown) => void),
    onUiRequest: (cb: (r: PiEnvelope<ExtensionUiRequest>) => void) =>
      subscribe("pi:ui-request", cb as (p: unknown) => void),
    onExit: (cb: (e: PiEnvelope<PiExitPayload>) => void) =>
      subscribe("pi:exit", cb as (p: unknown) => void),
  },

  extensionUi: {
    respond: (response: ExtensionUiResponse) => invoke<void>(CHANNELS.piUiRespond, response),
  },
};

import { contextBridge, ipcRenderer, webUtils } from "electron";
// channel 名与形状一律取自契约包，preload 不再内联对象字面量描述跨进程参数。
//
// 值导入走 `@pibuddy/contract/channels` 这个**不含 zod** 的子入口：sandbox
// preload 的产物必须自包含，从主入口引会把整个 zod（140KB 的运行时校验库）
// 打进一个从不做校验的安全边界。类型导入没有这个顾虑，编译期就消失了。
import { CHANNELS, type InvokeChannel } from "@pibuddy/contract/channels";
import type {
  AttachmentRef,
  PiStartParams,
  ReadImageResult,
  SecretDescriptor,
  SecretKind,
  SttTranscribeRequest,
  SttTranscribeResult,
} from "@pibuddy/contract";

/**
 * 唯一的 invoke 出口，**私有**（不经 contextBridge 暴露）。
 *
 * 形参类型是 `InvokeChannel` 而不是 `string`：渲染进程既拿不到这个函数，
 * 也无法凭空造出一个不在 CHANNELS 表里的通道名。收敛前这里是
 * `invoke(channel: string, ...)`，且 api 对象上还挂着一个把任意
 * `Record<string, unknown>` 原样转发给 pi 的通用方法 —— 而 pi 的 rpc 协议
 * 原生提供 `{"type":"bash", ...}` 直接执行 shell，于是渲染进程里的任意一行
 * JS（包括模型输出诱导出的 XSS）都等价于本机任意命令执行。
 */
function invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

/**
 * 订阅主进程推送。
 *
 * payload 一律是完整的 `PiEnvelope`，preload **不再剥壳**：代际与序号只有
 * 送到渲染进程才能用来丢弃上一代的迟到事件，在这里剥掉就等于把 RUN-002
 * 的判据扔了。
 *
 * 所有监听器登记在 `active` 里，pagehide（窗口刷新 / 关闭）时统一摘除，
 * 避免热重载后同一 channel 上挂着几代回调。
 */
const active = new Set<() => void>();

// preload 的 tsconfig 只带 node 类型（没有 DOM lib），但它实际运行在渲染进程
// 上下文里，window 是存在的。为一处 API 引入整个 DOM lib 不划算，这里最小声明。
declare const window: {
  addEventListener(type: string, listener: () => void): void;
};

function subscribe(channel: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  const off = (): void => {
    ipcRenderer.removeListener(channel, listener);
    active.delete(off);
  };
  active.add(off);
  return off;
}

window.addEventListener("pagehide", () => {
  for (const off of [...active]) off();
});

/**
 * 15 个产品动作。
 *
 * `window.piBuddy.pi` 上**只有**这 15 个键 —— 没有 start/stop 这类生命周期
 * 方法（它们在 `runtime` 下），更没有任何形式的通用命令转发。渲染进程能表达
 * 的意图就是这张表，多一条都要显式加在这里并过一遍威胁模型。
 */
const pi = {
  /**
   * 发消息。`streamingBehavior:"steer"` 是流式插话的**唯一**正确表达方式：
   * PiBuddy 从不调用 pi 的原生 steer 命令（rpc.md 第 65 行，原生 steer 不接受
   * 扩展参数，而流式中不带 streamingBehavior 的 prompt 会直接返回 error）。
   */
  prompt: (payload: {
    message: string;
    images?: { type: "image"; data: string; mimeType: string }[];
    attachmentTokens?: string[];
    streamingBehavior?: "steer" | "followUp";
  }) => invoke(CHANNELS.piPrompt, payload),
  steer: (payload: {
    message: string;
    images?: { type: "image"; data: string; mimeType: string }[];
  }) => invoke(CHANNELS.piSteer, payload),
  followUp: (payload: {
    message: string;
    images?: { type: "image"; data: string; mimeType: string }[];
  }) => invoke(CHANNELS.piFollowUp, payload),
  abort: () => invoke(CHANNELS.piAbort),
  newSession: () => invoke(CHANNELS.piNewSession),
  switchSession: (sessionPath: string) =>
    invoke(CHANNELS.piSwitchSession, { sessionPath }),
  setModel: (provider: string, modelId: string) =>
    invoke(CHANNELS.piSetModel, { provider, modelId }),
  setThinkingLevel: (level: string) => invoke(CHANNELS.piSetThinkingLevel, { level }),
  getState: () => invoke(CHANNELS.piGetState),
  getMessages: () => invoke(CHANNELS.piGetMessages),
  getSessionStats: () => invoke(CHANNELS.piGetSessionStats),
  getAvailableModels: () => invoke(CHANNELS.piGetAvailableModels),
  getAvailableThinkingLevels: () => invoke(CHANNELS.piGetAvailableThinkingLevels),
  compact: (customInstructions?: string) =>
    invoke(CHANNELS.piCompact, { customInstructions }),
  setSessionName: (name: string) => invoke(CHANNELS.piSetSessionName, { name }),
};

const api = {
  pi,
  /** 运行时生命周期。刻意与产品动作分开，`piBuddy.pi` 上只留纯粹的动作。 */
  runtime: {
    start: (opts: PiStartParams) => invoke(CHANNELS.piStart, opts),
    stop: () => invoke<void>(CHANNELS.piStop),
  },
  /** 三个通道传的都是 PiEnvelope<...>，由渲染进程 parseEnvelope 后解包 */
  events: {
    onEvent: (cb: (e: unknown) => void) => subscribe("pi:event", cb),
    onUiRequest: (cb: (r: unknown) => void) => subscribe("pi:ui-request", cb),
    onExit: (cb: (e: unknown) => void) => subscribe("pi:exit", cb),
  },
  extensionUi: {
    respond: (response: {
      type: "extension_ui_response";
      id: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    }) => invoke<void>(CHANNELS.piUiRespond, response),
  },
  sessions: {
    list: (workspaceId: string) => invoke(CHANNELS.sessionsList, { workspaceId }),
  },
  settings: {
    get: () => invoke(CHANNELS.settingsGet),
    // patch 里的 workspace 会被契约的 schema 直接拒掉：工作目录只能经
    // workspace.choose()（一次真实的用户手势）设置。
    set: (patch: Record<string, unknown>) => invoke(CHANNELS.settingsSet, patch),
    /**
     * 写一把密钥。**没有对应的 get** —— 明文进了主进程就再也出不来，
     * 渲染进程能问到的极限是下面这个 {configured, last4}。
     */
    setSecret: (kind: SecretKind, value: string) =>
      invoke<SecretDescriptor>(CHANNELS.settingsSetSecret, { kind, value }),
    describeSecret: (kind: SecretKind) =>
      invoke<SecretDescriptor>(CHANNELS.settingsDescribeSecret, { kind }),
  },
  workspace: {
    current: () => invoke(CHANNELS.workspaceCurrent),
    choose: () => invoke(CHANNELS.dialogChooseFolder),
  },
  attachments: {
    /** 系统文件对话框；返回的是能力凭证，不是路径。 */
    pick: () => invoke<AttachmentRef[]>(CHANNELS.dialogChooseFiles),
    /**
     * 拖拽进来的文件 → 能力凭证。
     *
     * `webUtils.getPathForFile` 在**这里**调用并把结果直接送进主进程换凭证，
     * 绝对路径因此从不进入渲染进程的 JS 作用域 —— 收敛前它是
     * `file.pathFor(file)` 直接返回给渲染进程的。
     */
    fromDrop: (file: File) =>
      invoke<AttachmentRef>(CHANNELS.fileAttachDropped, {
        droppedPath: webUtils.getPathForFile(file),
      }),
    readImage: (token: string) =>
      invoke<ReadImageResult>(CHANNELS.fileReadAttachment, { token }),
    open: (token: string) => invoke<string>(CHANNELS.shellOpenPath, { token }),
    showInFolder: (token: string) => invoke<void>(CHANNELS.shellShowInFolder, { token }),
    revokeAll: () => invoke<void>(CHANNELS.attachmentRevokeAll),
  },
  stt: {
    transcribe: (request: SttTranscribeRequest) =>
      invoke<SttTranscribeResult>(CHANNELS.sttTranscribe, request),
  },
};

contextBridge.exposeInMainWorld("piBuddy", api);

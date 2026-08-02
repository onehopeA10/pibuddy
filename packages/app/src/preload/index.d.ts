// 渲染进程可见的 window.piBuddy 类型（与 preload/index.ts 中实现保持一致）。
//
// 本文件不再自己声明任何跨进程数据形状 —— 全部 re-export 自
// @pibuddy/contract，避免与 main / renderer 侧漂移。
//
// **接口面的有限性由类型层兜底**：这里不出现任何裸的通道名、绝对路径、
// 任意 URL 或环境变量形参。工作目录一律以不透明的
// `workspaceId: string` 表达，文件一律以短期能力凭证 `token: string` 表达，
// 其余形参全部是契约包导出的具名类型。任何想绕过 capability 的改动，
// 都会先在这个文件里表现为「多了一个裸字符串路径形参」。
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
} from "@sdk";
import type {
  AppSettings,
  AppSettingsPatch,
  AttachmentRef,
  PiStartParams,
  ReadImageResult,
  SessionMeta,
  SttTranscribeRequest,
  SttTranscribeResult,
  StartResult as ContractStartResult,
  PiEnvelope,
  PiExitPayload,
  WorkspaceRef,
} from "@contract";

export type {
  AppSettings,
  AttachmentRef,
  PiStartParams,
  ReadImageResult,
  SessionMeta,
  SttTranscribeRequest,
  SttTranscribeResult,
  WorkspaceRef,
};

/** pi:start 的返回，用 pi-sdk 的具体类型实例化契约里的泛型槽位。 */
export type PiStartResult = ContractStartResult<AgentState, Model, AgentMessage>;

/** 渲染进程可写的设置子集：workspace 被契约层剔除，只能经 workspace.choose()。 */
export type RendererSettingsPatch = Omit<AppSettingsPatch, "workspace">;

/**
 * 15 个产品动作 —— `window.piBuddy.pi` 上有且只有这些键。
 *
 * 没有通用的 `command(...)`：pi 的 rpc 协议原生提供
 * `{"type":"bash", ...}` 直接执行 shell，留一条通用转发口等于把本机命令行
 * 挂在渲染进程上。新增能力必须在这里显式加一个具名方法。
 */
export interface PiActions {
  /**
   * 发消息。流式插话走 `streamingBehavior: "steer"`，**不是** pi 的原生
   * steer 命令（rpc.md 第 65 行）。
   */
  prompt: (payload: {
    message: string;
    images?: ImageContent[];
    attachmentTokens?: string[];
    streamingBehavior?: "steer" | "followUp";
  }) => Promise<RpcResponse>;
  steer: (payload: { message: string; images?: ImageContent[] }) => Promise<RpcResponse>;
  followUp: (payload: { message: string; images?: ImageContent[] }) => Promise<RpcResponse>;
  abort: () => Promise<RpcResponse>;
  newSession: () => Promise<RpcResponse<{ cancelled?: boolean }>>;
  /** sessionPath 必须来自 sessions.list()；主进程会重做会话目录收容校验 */
  switchSession: (sessionPath: string) => Promise<RpcResponse<{ cancelled?: boolean }>>;
  setModel: (provider: string, modelId: string) => Promise<RpcResponse>;
  setThinkingLevel: (level: ThinkingLevel) => Promise<RpcResponse>;
  getState: () => Promise<RpcResponse<AgentState>>;
  getMessages: () => Promise<RpcResponse<{ messages: AgentMessage[] }>>;
  getSessionStats: () => Promise<RpcResponse<SessionStats>>;
  getAvailableModels: () => Promise<RpcResponse<{ models: Model[] }>>;
  getAvailableThinkingLevels: () => Promise<RpcResponse<{ levels: ThinkingLevel[] }>>;
  compact: (customInstructions?: string) => Promise<RpcResponse>;
  setSessionName: (name: string) => Promise<RpcResponse>;
}

export interface PiBuddyApi {
  pi: PiActions;
  runtime: {
    start: (opts: PiStartParams) => Promise<PiStartResult>;
    stop: () => Promise<void>;
  };
  /** 三条 push 通道传的都是完整信封，代际与序号在渲染进程侧判定 */
  events: {
    onEvent: (cb: (e: PiEnvelope<AgentEvent>) => void) => () => void;
    onUiRequest: (cb: (r: PiEnvelope<ExtensionUiRequest>) => void) => () => void;
    onExit: (cb: (e: PiEnvelope<PiExitPayload>) => void) => () => void;
  };
  extensionUi: {
    respond: (response: ExtensionUiResponse) => Promise<void>;
  };
  sessions: {
    list: (workspaceId: string) => Promise<SessionMeta[]>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    set: (patch: RendererSettingsPatch) => Promise<AppSettings>;
  };
  workspace: {
    /** 当前工作目录；未选择返回 null。displayPath 只用于显示，不得回传 */
    current: () => Promise<WorkspaceRef | null>;
    choose: () => Promise<WorkspaceRef | null>;
  };
  attachments: {
    pick: () => Promise<AttachmentRef[]>;
    /** 拖拽文件 → 能力凭证；绝对路径在 preload 内部就被换掉，不进渲染进程 */
    fromDrop: (file: File) => Promise<AttachmentRef>;
    readImage: (token: string) => Promise<ReadImageResult>;
    open: (token: string) => Promise<string>;
    showInFolder: (token: string) => Promise<void>;
    revokeAll: () => Promise<void>;
  };
  stt: {
    transcribe: (request: SttTranscribeRequest) => Promise<SttTranscribeResult>;
  };
}

declare global {
  interface Window {
    piBuddy: PiBuddyApi;
  }
}

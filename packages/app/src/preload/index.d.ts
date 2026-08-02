// 渲染进程可见的 window.piBuddy 类型（与 preload/index.ts 中实现保持一致）。
//
// 本文件不再自己声明任何跨进程数据形状 —— 全部 re-export 自
// @pibuddy/contract，避免与 main / renderer 侧漂移。
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  ExtensionUiRequest,
  ExtensionUiResponse,
  Model,
  RpcCommandBase,
  RpcResponse,
} from "@sdk";
import type {
  AppSettings,
  PickedFile,
  PiStartParams,
  ReadImageResult,
  SessionMeta,
  SttTranscribeRequest,
  SttTranscribeResult,
  StartResult as ContractStartResult,
  PiEnvelope,
  PiExitPayload,
} from "@contract";

export type {
  AppSettings,
  PickedFile,
  PiStartParams,
  ReadImageResult,
  SessionMeta,
  SttTranscribeRequest,
  SttTranscribeResult,
};

/** pi:start 的返回，用 pi-sdk 的具体类型实例化契约里的泛型槽位。 */
export type PiStartResult = ContractStartResult<AgentState, Model, AgentMessage>;

export interface PiBuddyApi {
  pi: {
    start: (opts: PiStartParams) => Promise<PiStartResult>;
    command: <T = unknown>(command: RpcCommandBase) => Promise<RpcResponse<T>>;
    uiRespond: (response: ExtensionUiResponse) => Promise<void>;
    stop: () => Promise<void>;
    // 三条 push 通道传的都是完整信封，代际与序号在渲染进程侧判定
    onEvent: (cb: (e: PiEnvelope<AgentEvent>) => void) => () => void;
    onUiRequest: (cb: (r: PiEnvelope<ExtensionUiRequest>) => void) => () => void;
    onExit: (cb: (e: PiEnvelope<PiExitPayload>) => void) => () => void;
  };
  sessions: {
    list: (workspace: string) => Promise<SessionMeta[]>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
  dialog: {
    chooseFolder: () => Promise<string | null>;
    chooseFiles: () => Promise<PickedFile[]>;
  };
  file: {
    readImage: (path: string) => Promise<ReadImageResult>;
    pathFor: (file: File) => string;
  };
  shell: {
    openPath: (target: string) => Promise<string>;
    showInFolder: (target: string) => Promise<void>;
  };
  stt: {
    transcribe: (req: SttTranscribeRequest) => Promise<SttTranscribeResult>;
  };
}

declare global {
  interface Window {
    piBuddy: PiBuddyApi;
  }
}

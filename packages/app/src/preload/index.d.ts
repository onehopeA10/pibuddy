// 渲染进程可见的 window.piBuddy 类型（与 preload/index.ts 中实现保持一致）
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

export interface StartResult {
  state: AgentState;
  models: Model[];
  messages: AgentMessage[];
}

export interface SessionMeta {
  path: string;
  id: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: number;
}

export interface AppSettings {
  workspace?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  sttBaseUrl?: string;
  sttApiKey?: string;
  sttModel?: string;
}

export interface PickedFile {
  path: string;
  name: string;
  size: number;
  kind: "image" | "video" | "other";
}

export interface PiBuddyApi {
  pi: {
    start: (opts: { workspace: string; session?: string }) => Promise<StartResult>;
    command: <T = unknown>(command: RpcCommandBase) => Promise<RpcResponse<T>>;
    uiRespond: (response: ExtensionUiResponse) => Promise<void>;
    stop: () => Promise<void>;
    onEvent: (cb: (e: AgentEvent) => void) => () => void;
    onUiRequest: (cb: (r: ExtensionUiRequest) => void) => () => void;
    onExit: (cb: (code: number | null) => void) => () => void;
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
    readImage: (path: string) => Promise<{ data: string; mimeType: string }>;
    pathFor: (file: File) => string;
  };
  shell: {
    openPath: (target: string) => Promise<string>;
    showInFolder: (target: string) => Promise<void>;
  };
  stt: {
    transcribe: (req: {
      baseUrl: string;
      apiKey: string;
      model: string;
      audio: ArrayBuffer;
      mimeType: string;
    }) => Promise<{ text: string }>;
  };
}

declare global {
  interface Window {
    piBuddy: PiBuddyApi;
  }
}

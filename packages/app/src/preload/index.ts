import { contextBridge, ipcRenderer, webUtils } from "electron";
// 形状一律取自契约包，preload 不再内联对象字面量描述跨进程参数
import type {
  PiStartParams,
  ReadImageResult,
  SttTranscribeRequest,
  SttTranscribeResult,
} from "@pibuddy/contract";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
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

const api = {
  pi: {
    start: (opts: PiStartParams) => invoke("pi:start", opts),
    command: (command: Record<string, unknown>) => invoke("pi:command", command),
    uiRespond: (response: Record<string, unknown>) => invoke("pi:ui-respond", response),
    stop: () => invoke("pi:stop"),
    // 三个通道传的都是 PiEnvelope<...>，由渲染进程 parseEnvelope 后解包
    onEvent: (cb: (e: unknown) => void) => subscribe("pi:event", cb),
    onUiRequest: (cb: (r: unknown) => void) => subscribe("pi:ui-request", cb),
    onExit: (cb: (e: unknown) => void) => subscribe("pi:exit", cb),
  },
  sessions: {
    list: (workspace: string) => invoke("sessions:list", workspace),
  },
  settings: {
    get: () => invoke("settings:get"),
    set: (patch: Record<string, unknown>) => invoke("settings:set", patch),
  },
  dialog: {
    chooseFolder: () => invoke<string | null>("dialog:choose-folder"),
    chooseFiles: () => invoke("dialog:choose-files"),
  },
  file: {
    readImage: (path: string) => invoke<ReadImageResult>("file:read-image", path),
    /** 拖拽的 File 对象 → 本地绝对路径 */
    pathFor: (file: File) => webUtils.getPathForFile(file),
  },
  shell: {
    openPath: (target: string) => invoke("shell:open-path", target),
    showInFolder: (target: string) => invoke("shell:show-in-folder", target),
  },
  stt: {
    transcribe: (req: SttTranscribeRequest) =>
      invoke<SttTranscribeResult>("stt:transcribe", req),
  },
};

contextBridge.exposeInMainWorld("piBuddy", api);

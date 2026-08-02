import { contextBridge, ipcRenderer, webUtils } from "electron";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function subscribe(channel: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  pi: {
    start: (opts: { workspace: string; session?: string }) => invoke("pi:start", opts),
    command: (command: Record<string, unknown>) => invoke("pi:command", command),
    uiRespond: (response: Record<string, unknown>) => invoke("pi:ui-respond", response),
    stop: () => invoke("pi:stop"),
    onEvent: (cb: (e: unknown) => void) => subscribe("pi:event", cb),
    onUiRequest: (cb: (r: unknown) => void) => subscribe("pi:ui-request", cb),
    onExit: (cb: (code: unknown) => void) => subscribe("pi:exit", cb),
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
    readImage: (path: string) => invoke<{ data: string; mimeType: string }>("file:read-image", path),
    /** 拖拽的 File 对象 → 本地绝对路径 */
    pathFor: (file: File) => webUtils.getPathForFile(file),
  },
  shell: {
    openPath: (target: string) => invoke("shell:open-path", target),
    showInFolder: (target: string) => invoke("shell:show-in-folder", target),
  },
  stt: {
    transcribe: (req: {
      baseUrl: string;
      apiKey: string;
      model: string;
      audio: ArrayBuffer;
      mimeType: string;
    }) => invoke<{ text: string }>("stt:transcribe", req),
  },
};

contextBridge.exposeInMainWorld("piBuddy", api);

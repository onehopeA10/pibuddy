import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  PiRpcClient,
  type AgentEvent,
  type ExtensionUiResponse,
  type RpcCommandBase,
} from "@pibuddy/pi-sdk";
import type {
  PickedFile,
  PiStartParams,
  ReadImageResult,
  SttTranscribeRequest,
  SttTranscribeResult,
} from "@pibuddy/contract";
import { buildPiSpawn } from "./pi-launcher.js";
import { listSessions } from "./sessions-store.js";
import { loadSettings, saveSettings, type AppSettings } from "./settings.js";

const clients = new Map<number, PiRpcClient>();

export function disposeClientFor(webContentsId: number): void {
  const client = clients.get(webContentsId);
  if (client) {
    clients.delete(webContentsId);
    client.stop();
  }
}

function clientFor(webContentsId: number): PiRpcClient {
  const client = clients.get(webContentsId);
  if (!client || !client.running) throw new Error("智能体尚未启动");
  return client;
}

/**
 * 事件合并转发：pi 流式输出时每个 token 都会产生 message_update（携带全量部分消息），
 * 逐条走 IPC 会把渲染进程主线程打满。这里按 33ms 节拍批量转发，
 * 并折叠「连续的累积型事件」（message_update / 同一工具的 tool_execution_update
 * 都包含到目前为止的完整内容，只保留最后一条即可，不丢信息）。
 */
function makeEventForwarder(wc: WebContents): (e: AgentEvent) => void {
  let queue: AgentEvent[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    timer = null;
    if (wc.isDestroyed() || queue.length === 0) {
      queue = [];
      return;
    }
    const collapsed: AgentEvent[] = [];
    for (const e of queue) {
      const prev = collapsed[collapsed.length - 1];
      if (
        prev &&
        e.type === "message_update" &&
        prev.type === "message_update"
      ) {
        collapsed[collapsed.length - 1] = e;
        continue;
      }
      if (
        prev &&
        e.type === "tool_execution_update" &&
        prev.type === "tool_execution_update" &&
        (prev as { toolCallId?: string }).toolCallId ===
          (e as { toolCallId?: string }).toolCallId
      ) {
        collapsed[collapsed.length - 1] = e;
        continue;
      }
      collapsed.push(e);
    }
    queue = [];
    for (const e of collapsed) wc.send("pi:event", e);
  };

  return (e: AgentEvent) => {
    queue.push(e);
    if (!timer) timer = setTimeout(flush, 33);
  };
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function registerIpc(): void {
  ipcMain.handle(
    "pi:start",
    async (event, opts: PiStartParams) => {
      const wc = event.sender;
      disposeClientFor(wc.id);

      const client = new PiRpcClient({
        spawn: buildPiSpawn(),
        cwd: opts.workspace,
        session: opts.session,
      });
      client.on("event", makeEventForwarder(wc));
      client.on("ui_request", (r) => !wc.isDestroyed() && wc.send("pi:ui-request", r));
      client.on("exit", (code) => !wc.isDestroyed() && wc.send("pi:exit", code));
      client.start();
      clients.set(wc.id, client);

      const state = await client.getState();
      const [models, messages] = await Promise.all([
        client.getAvailableModels().catch(() => ({ models: [] })),
        client.getMessages().catch(() => ({ messages: [] })),
      ]);
      return { state, models: models.models, messages: messages.messages };
    }
  );

  ipcMain.handle("pi:command", (event, command: RpcCommandBase) => {
    return clientFor(event.sender.id).send(command);
  });

  ipcMain.handle("pi:ui-respond", (event, response: ExtensionUiResponse) => {
    clientFor(event.sender.id).respondUi(response);
  });

  ipcMain.handle("pi:stop", (event) => {
    disposeClientFor(event.sender.id);
  });

  ipcMain.handle("sessions:list", (_event, workspace: string) => {
    return listSessions(workspace);
  });

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:set", (_event, patch: Partial<AppSettings>) =>
    saveSettings(patch)
  );

  ipcMain.handle("dialog:choose-folder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: "选择工作文件夹",
      message: "PiBuddy 将在这个文件夹里帮你处理文件",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:choose-files", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: "选择文件",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    return result.filePaths.map((p) => describeFile(p));
  });

  // 读取本地图片为 base64（供图片附件内联发送给模型）
  ipcMain.handle("file:read-image", (_event, filePath: string): ReadImageResult => {
    const mimeType = IMAGE_MIME[path.extname(filePath).toLowerCase()];
    if (!mimeType) throw new Error("不支持的图片格式");
    const data = fs.readFileSync(filePath).toString("base64");
    return { data, mimeType };
  });

  ipcMain.handle("shell:open-path", (_event, target: string) => {
    return shell.openPath(target);
  });

  ipcMain.handle("shell:show-in-folder", (_event, target: string) => {
    shell.showItemInFolder(target);
  });

  // 语音转写：转发到 OpenAI 兼容 /audio/transcriptions 端点（主进程发请求，避免 CORS）
  ipcMain.handle(
    "stt:transcribe",
    async (_event, req: SttTranscribeRequest): Promise<SttTranscribeResult> => {
      const form = new FormData();
      const ext = req.mimeType.includes("ogg")
        ? "ogg"
        : req.mimeType.includes("wav")
          ? "wav"
          : req.mimeType.includes("mp4")
            ? "mp4"
            : "webm";
      form.append(
        "file",
        new Blob([req.audio], { type: req.mimeType }),
        `voice.${ext}`
      );
      form.append("model", req.model);
      const base = req.baseUrl.replace(/\/+$/, "");
      const resp = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${req.apiKey}` },
        body: form,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`语音转写失败 (${resp.status}): ${detail.slice(0, 200)}`);
      }
      const json = (await resp.json()) as { text?: string };
      return { text: json.text ?? "" };
    }
  );
}

function describeFile(filePath: string): PickedFile {
  const ext = path.extname(filePath).toLowerCase();
  const kind = IMAGE_MIME[ext]
    ? "image"
    : [".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv"].includes(ext)
      ? "video"
      : "other";
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    /* ignore */
  }
  return { path: filePath, name: path.basename(filePath), size, kind };
}

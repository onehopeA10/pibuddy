import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  PiRpcClient,
  ExtensionUiResponse,
  RpcCommandBase,
} from "@pibuddy/pi-sdk";
import type {
  PickedFile,
  PiStartParams,
  ReadImageResult,
  SttTranscribeRequest,
  SttTranscribeResult,
} from "@pibuddy/contract";
import { buildPiSpawn, assertRuntimeHandshake } from "./pi-launcher.js";
import { PROTOCOL_VERSION } from "@pibuddy/contract";
import { createLogger, type Logger } from "./logger.js";
import { listSessionsForWorkspace } from "./sessions/session-repository.js";
import { resolveSessionDir } from "./sessions/session-dir.js";
import { loadSettings, saveSettings, type AppSettings } from "./settings.js";
import { PiSupervisor } from "./pi-supervisor.js";

/**
 * webContents id → 当前 runtime 的 client。
 *
 * 这份索引的唯一职责是让 `clientFor` 能同步查到 client；代际、序号、信封与
 * 转发全部由 supervisor 负责。**登记必须发生在任何 await 之前** —— 早先
 * 这里的 clients.set 排在 client.start() 之后但也在 await 之前，而 spawn 失败
 * 时 exit 事件根本不触发（ENOENT 实测序列是 error → close），死 client 就此
 * 滞留在 map 里，后续所有请求都被它接走。
 */
const clients = new Map<number, PiRpcClient>();

/** ipc 层的 logger（与 main/index.ts 写同一个目录下的同一份 JSONL）。 */
let ipcLogger: Logger | null = null;
function log(): Logger {
  if (!ipcLogger) {
    ipcLogger = createLogger({ dir: path.join(app.getPath("userData"), "logs") });
  }
  return ipcLogger;
}

/** 全应用唯一的运行时监管者（代际、序号、信封、33ms 转发都归它管）。 */
let supervisorInstance: PiSupervisor | null = null;
function supervisor(): PiSupervisor {
  if (!supervisorInstance) {
    supervisorInstance = new PiSupervisor({
      info: (event, fields) => log().info(event, fields),
      warn: (event, fields) => log().warn(event, fields),
    });
  }
  return supervisorInstance;
}

export function disposeClientFor(webContentsId: number): void {
  clients.delete(webContentsId);
  supervisor().disposeTarget(webContentsId);
}

/**
 * 取当前可用的 client。
 *
 * 不可用时抛出的错误必须携带**真实原因**：ENOENT / 权限 / 版本不符各有各的
 * 处置方式，一律报一句泛化的「运行时没起来」等于把诊断信息扔掉。真因由
 * client.assertUsable() 从 lastSpawnError 与 stderr 尾巴里取。
 */
function clientFor(webContentsId: number): PiRpcClient {
  const client = clients.get(webContentsId);
  if (!client) throw new Error("智能体运行时不可用：尚未启动，请先选择工作文件夹");
  client.assertUsable();
  return client;
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

      const settings = loadSettings();
      const spawn = buildPiSpawn({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        settings,
        logger: log(),
      });
      verifyRuntime(spawn.runtime);

      const { client, handle } = supervisor().launch(wc, {
        spawn,
        workspaceId: opts.workspace,
        cwd: opts.workspace,
        sessionPath: opts.session,
        // 主进程列目录与 pi 写目录必须同源，否则历史会话恒为空（SES-001）
        sessionDir: resolveSessionDir(opts.workspace, settings),
      });
      // 必须先登记再 await：spawn 失败（ENOENT 只走 error → close，没有 exit）
      // 时下面的握手会抛，catch 里才有东西可清。
      clients.set(wc.id, client);

      try {
        const state = await client.getState();
        supervisor().adoptSession(handle.runtimeId, state.sessionId);
        const [models, messages] = await Promise.all([
          client.getAvailableModels().catch(() => ({ models: [] })),
          client.getMessages().catch(() => ({ messages: [] })),
        ]);
        return { state, models: models.models, messages: messages.messages };
      } catch (err) {
        // 初始化任一 RPC 失败：立刻停子进程、删索引、摘监听，并把真因
        // （含最近的脱敏 stderr）结构化地抛回 UI。
        const cause = client.lastSpawnError?.message ?? (err as Error).message;
        const tail = client.stderrSnapshot;
        log().error("pi_runtime_start_failed", {
          runtimeId: handle.runtimeId,
          generation: handle.generation,
          phase: client.phase,
          cause,
        });
        disposeClientFor(wc.id);
        throw new Error(`启动智能体失败：${cause}${tail ? `\n${tail}` : ""}`);
      }
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

  ipcMain.handle("sessions:list", async (_event, workspace: string) => {
    return listSessionsForWorkspace(workspace, loadSettings());
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

/**
 * 启动握手：内置运行时必须与清单声明的版本/协议一致。
 * 开发形态没有清单（直接跑 node_modules 里的 pi），只记一条日志不做断言。
 */
function verifyRuntime(runtime: ReturnType<typeof buildPiSpawn>["runtime"]): void {
  if (runtime.source !== "bundled" || !runtime.runtimeRoot) {
    log().info("pi_runtime_handshake_skipped", {
      selectedRuntime: runtime.source,
      protocolVersion: PROTOCOL_VERSION,
    });
    return;
  }
  const pkgPath = path.join(runtime.runtimeRoot, "package.json");
  const actualVersion = (
    JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string }
  ).version;
  assertRuntimeHandshake(
    {
      runtimeVersion: runtime.bundledVersion ?? "",
      protocolVersion: runtime.protocolVersion ?? PROTOCOL_VERSION,
    },
    { version: actualVersion ?? "", protocolVersion: PROTOCOL_VERSION }
  );
  log().info("pi_runtime_handshake_ok", {
    selectedRuntime: runtime.source,
    bundledVersion: runtime.bundledVersion,
    protocolVersion: runtime.protocolVersion,
  });
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

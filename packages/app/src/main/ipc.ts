import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import type { PiRpcClient } from "@pibuddy/pi-sdk";
import {
  CHANNELS,
  attachDroppedRequestSchema,
  extensionUiResponseSchema,
  piCompactRequestSchema,
  piMessageRequestSchema,
  piPromptRequestSchema,
  piSetModelRequestSchema,
  piSetSessionNameRequestSchema,
  piSetThinkingLevelRequestSchema,
  piStartParamsSchema,
  piSwitchSessionRequestSchema,
  rendererSettingsPatchSchema,
  secretQueryRequestSchema,
  secretWriteRequestSchema,
  sttTranscribeRequestSchema,
  tokenRequestSchema,
  voidRequestSchema,
  workspaceIdRequestSchema,
  APP_SETTINGS_PUBLIC_KEYS,
  type AppSettings,
  type AttachmentRef,
  type SttTranscribeResult,
} from "@pibuddy/contract";
import { buildPiSpawn, verifyRuntimeHandshake } from "./pi-launcher.js";
import { createLogger, type Logger } from "./logger.js";
import { listSessionsForWorkspace } from "./sessions/session-repository.js";
import { resolveSessionDir } from "./sessions/session-dir.js";
import { loadSettings, saveSettings } from "./settings.js";
import { PiSupervisor } from "./pi-supervisor.js";
import { forgetSender, registerHandler, setGuardLogger } from "./ipc-guard.js";
import {
  describeWorkspace,
  registerWorkspace,
  requireWorkspaceRoot,
  assertContained,
} from "./workspace-registry.js";
import * as attachments from "./attachment-registry.js";
import { registerEndpoint, requireEndpoint } from "./endpoints.js";
import { safeFetch } from "./net/outbound-guard.js";
import { SECRET_KEYS, describeSecret, loadSecret, saveSecret } from "./secret-store.js";

/**
 * 单次语音载荷上限（25MB，与 CHANNEL_MAX_BYTES 里 stt:transcribe 的放宽值一致）。
 * guard 那层按 structured-clone 估算整体载荷，这里再按 audio 自身的
 * byteLength 卡一次 —— 两处都要有，否则「整体没超但音频超了」会溜过去。
 */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * 挑出允许下发给渲染进程的设置字段（CT-09）。
 *
 * 不是 `return loadSettings()` —— 那样将来任何一个新加的敏感字段都会自动
 * 跟着流出去。白名单在契约包里，加字段必须显式过一遍。
 */
function publicSettings(settings: AppSettings): Partial<AppSettings> {
  const out: Record<string, unknown> = {};
  for (const key of APP_SETTINGS_PUBLIC_KEYS) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<AppSettings>;
}

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
  forgetSender(webContentsId);
  // 窗口没了，之前签发的附件凭证一律作废：留着它们等于给下一个窗口
  // 继承上一个窗口的文件读取能力。
  attachments.revokeAll();
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

export function registerIpc(): void {
  setGuardLogger({ warn: (event, fields) => log().warn(event, fields) });

  // ------------------------------------------------------------ 运行时生命周期

  registerHandler(CHANNELS.piStart, piStartParamsSchema, async (opts, event) => {
    const wc = event.sender;
    disposeClientFor(wc.id);

    // 渲染进程只给得出不透明 id，真实路径在这里才被解出来
    const root = requireWorkspaceRoot(opts.workspaceId);
    const settings = loadSettings();
    const sessionDir = resolveSessionDir(root, settings);

    // 续接历史会话时，会话文件必须是主进程自己那个会话目录里的东西
    let sessionPath: string | undefined;
    if (opts.sessionPath) {
      sessionPath = await assertContained(sessionDir, opts.sessionPath);
    }

    const spawn = buildPiSpawn({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      settings,
      logger: log(),
    });
    verifyRuntimeHandshake(spawn.runtime, log());

    const { client, handle } = supervisor().launch(wc, {
      spawn,
      workspaceId: opts.workspaceId,
      cwd: root,
      sessionPath,
      // 主进程列目录与 pi 写目录必须同源，否则历史会话恒为空（SES-001）
      sessionDir,
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
  });

  registerHandler(CHANNELS.piStop, voidRequestSchema, (_payload, event) => {
    disposeClientFor(event.sender.id);
  });

  registerHandler(CHANNELS.piUiRespond, extensionUiResponseSchema, (response, event) => {
    clientFor(event.sender.id).respondUi(response);
  });

  // ------------------------------------------------------- 15 个产品动作窄通道
  //
  // 每一条都是一个**具体的产品意图**。这里没有、也不会有一条能表达
  // 「执行任意 pi 命令」的通道 —— pi 的协议原生提供 {"type":"bash",...}，
  // 留一条通用转发口等于把本机 shell 直接挂在渲染进程上。

  registerHandler(CHANNELS.piPrompt, piPromptRequestSchema, async (payload, event) => {
    const client = clientFor(event.sender.id);
    // 非图片附件的路径由主进程用凭证换回来后拼进提示词，渲染进程全程不接触路径
    let message = payload.message;
    const tokens = payload.attachmentTokens ?? [];
    if (tokens.length > 0) {
      const paths: string[] = [];
      for (const token of tokens) {
        paths.push(await attachments.resolvePath(token, { capability: "read" }));
      }
      const block = paths.map((p) => `- ${p}`).join("\n");
      message = `${message}\n\n[用户提供的文件]\n${block}`.trim();
    }
    return client.send({
      type: "prompt",
      message,
      ...(payload.images?.length ? { images: payload.images } : {}),
      // 插话走 prompt + streamingBehavior:"steer"，不是 pi 的原生 steer 命令：
      // rpc.md 第 65 行明确流式过程中不带 streamingBehavior 的 prompt 直接返回
      // error，而原生 steer 命令不接受扩展参数。这个分支删不得。
      ...(payload.streamingBehavior
        ? { streamingBehavior: payload.streamingBehavior }
        : {}),
    });
  });

  registerHandler(CHANNELS.piSteer, piMessageRequestSchema, (payload, event) =>
    clientFor(event.sender.id).steer(payload.message, payload.images)
  );

  registerHandler(CHANNELS.piFollowUp, piMessageRequestSchema, (payload, event) =>
    clientFor(event.sender.id).followUp(payload.message, payload.images)
  );

  registerHandler(CHANNELS.piAbort, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).abort()
  );

  registerHandler(CHANNELS.piNewSession, voidRequestSchema, async (_p, event) => {
    const resp = await clientFor(event.sender.id).newSession();
    // 换会话 = 上一段对话里签发的附件凭证全部作废
    if (resp.success) attachments.revokeAll();
    return resp;
  });

  registerHandler(
    CHANNELS.piSwitchSession,
    piSwitchSessionRequestSchema,
    async (payload, event) => {
      const settings = loadSettings();
      const root = settings.workspace;
      if (!root) throw new Error("尚未选择工作文件夹");
      // 只允许切到主进程自己枚举出来的那个目录里的会话文件
      const sessionDir = resolveSessionDir(root, settings);
      const real = await assertContained(sessionDir, payload.sessionPath);
      const resp = await clientFor(event.sender.id).switchSession(real);
      if (resp.success) attachments.revokeAll();
      return resp;
    }
  );

  registerHandler(CHANNELS.piSetModel, piSetModelRequestSchema, (payload, event) =>
    clientFor(event.sender.id).send({
      type: "set_model",
      provider: payload.provider,
      modelId: payload.modelId,
    })
  );

  registerHandler(
    CHANNELS.piSetThinkingLevel,
    piSetThinkingLevelRequestSchema,
    (payload, event) =>
      clientFor(event.sender.id).send({
        type: "set_thinking_level",
        level: payload.level,
      })
  );

  registerHandler(CHANNELS.piGetState, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_state" })
  );

  registerHandler(CHANNELS.piGetMessages, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_messages" })
  );

  registerHandler(CHANNELS.piGetSessionStats, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_session_stats" })
  );

  registerHandler(
    CHANNELS.piGetAvailableModels,
    voidRequestSchema,
    (_p, event) => clientFor(event.sender.id).send({ type: "get_available_models" })
  );

  registerHandler(
    CHANNELS.piGetAvailableThinkingLevels,
    voidRequestSchema,
    (_p, event) =>
      clientFor(event.sender.id).send({ type: "get_available_thinking_levels" })
  );

  registerHandler(CHANNELS.piCompact, piCompactRequestSchema, (payload, event) =>
    clientFor(event.sender.id).compact(payload.customInstructions)
  );

  registerHandler(CHANNELS.piSetSessionName, piSetSessionNameRequestSchema, (payload, event) =>
    clientFor(event.sender.id).setSessionName(payload.name)
  );

  // ------------------------------------------------------------ 会话 / 设置

  registerHandler(CHANNELS.sessionsList, workspaceIdRequestSchema, async (payload) => {
    const root = requireWorkspaceRoot(payload.workspaceId);
    return listSessionsForWorkspace(root, loadSettings());
  });

  registerHandler(CHANNELS.settingsGet, voidRequestSchema, () =>
    publicSettings(loadSettings())
  );

  // patch 的 schema 已在契约里剔除 workspace：工作目录只能经真实的用户手势
  // （dialog:choose-folder）设置，不接受渲染进程直接写入一个路径。
  //
  // 端点地址是这里唯一还接受渲染进程输入的「网络」字段：它在**落盘之前**
  // 先过 registerEndpoint（normalizeEndpointUrl + assertPublicAddress），
  // 被拒时整个 patch 一个字节都不写。
  registerHandler(CHANNELS.settingsSet, rendererSettingsPatchSchema, async (patch) => {
    const next: Record<string, unknown> = { ...patch };
    const raw = typeof patch.sttBaseUrl === "string" ? patch.sttBaseUrl.trim() : "";
    if (raw !== "") {
      const endpoint = await registerEndpoint({
        kind: "stt",
        baseUrl: raw,
        model: patch.sttModel,
      });
      next.sttBaseUrl = endpoint.baseUrl;
      next.sttEndpointId = endpoint.endpointId;
    } else if (patch.sttBaseUrl !== undefined) {
      next.sttEndpointId = undefined;
    }
    return publicSettings(saveSettings(next as Partial<AppSettings>));
  });

  // 密钥**只进不出**：这条通道能写、能清，但仓库里没有任何一条能把明文
  // 送回渲染进程的通道。返回值只有 {configured, last4}。
  registerHandler(CHANNELS.settingsSetSecret, secretWriteRequestSchema, (payload) => {
    const description = saveSecret(SECRET_KEYS.sttApiKey, payload.value.trim());
    saveSettings({
      sttApiKeyConfigured: description.configured,
      sttApiKeyLast4: description.last4,
    });
    return description;
  });

  registerHandler(CHANNELS.settingsDescribeSecret, secretQueryRequestSchema, () =>
    describeSecret(SECRET_KEYS.sttApiKey)
  );

  // ------------------------------------------------- workspace 与附件 capability

  registerHandler(CHANNELS.workspaceCurrent, voidRequestSchema, () => {
    const saved = loadSettings().workspace;
    if (!saved) return null;
    try {
      // 目录可能已被用户删掉 / 移走：注册失败就当作「还没选工作文件夹」
      return { ...describeWorkspace(registerWorkspace(saved).workspaceId) };
    } catch {
      return null;
    }
  });

  registerHandler(
    CHANNELS.dialogChooseFolder,
    voidRequestSchema,
    async (_p, event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win!, {
        title: "选择工作文件夹",
        message: "PiBuddy 将在这个文件夹里帮你处理文件",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const record = registerWorkspace(result.filePaths[0]);
      // 绝对路径只写进主进程的设置文件，不经由渲染进程中转
      saveSettings({ workspace: record.root });
      return describeWorkspace(record.workspaceId);
    }
  );

  registerHandler(
    CHANNELS.dialogChooseFiles,
    voidRequestSchema,
    async (_p, event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win!, {
        title: "选择文件",
        properties: ["openFile", "multiSelections"],
      });
      if (result.canceled) return [];
      const refs: AttachmentRef[] = [];
      for (const picked of result.filePaths) {
        try {
          refs.push(attachments.toAttachmentRef(await attachments.issue(picked)));
        } catch (err) {
          log().warn("attachment_issue_failed", { reason: (err as Error).message });
        }
      }
      return refs;
    }
  );

  // 拖拽进窗口的文件：preload 内部用 webUtils 取到路径后立刻换成凭证，
  // 路径本身从不进入渲染进程的 JS 作用域。
  registerHandler(CHANNELS.fileAttachDropped, attachDroppedRequestSchema, async (payload) =>
    attachments.toAttachmentRef(await attachments.issue(payload.droppedPath))
  );

  registerHandler(CHANNELS.fileReadAttachment, tokenRequestSchema, (payload) =>
    attachments.readImage(payload.token)
  );

  registerHandler(CHANNELS.shellOpenPath, tokenRequestSchema, (payload) =>
    attachments.openAttachment(payload.token)
  );

  registerHandler(CHANNELS.shellShowInFolder, tokenRequestSchema, (payload) =>
    attachments.revealAttachment(payload.token)
  );

  registerHandler(CHANNELS.attachmentRevokeAll, voidRequestSchema, () => {
    attachments.revokeAll();
  });

  // ------------------------------------------------------------------ 语音转写
  //
  // 渲染进程只交出 {endpointId, audio, mimeType}：地址、模型、密钥三样全部
  // 由主进程按 id 查出来。收敛前它同时交出 baseUrl 与密钥，等于可以把
  // Bearer token 定向送到任意主机（含 169.254.169.254）。

  registerHandler(
    CHANNELS.sttTranscribe,
    sttTranscribeRequestSchema,
    async (request): Promise<SttTranscribeResult> => {
      if (request.audio.byteLength > MAX_AUDIO_BYTES) {
        throw new Error(`录音过长（超过 ${MAX_AUDIO_BYTES / 1024 / 1024}MB），请分段录制`);
      }
      const endpoint = requireEndpoint(request.endpointId);
      const secret = loadSecret(SECRET_KEYS.sttApiKey);
      if (!secret) throw new Error("尚未配置语音识别密钥，请到「设置」里填写");

      const form = new FormData();
      const ext = request.mimeType.includes("ogg")
        ? "ogg"
        : request.mimeType.includes("wav")
          ? "wav"
          : request.mimeType.includes("mp4")
            ? "mp4"
            : "webm";
      form.append(
        "file",
        new Blob([request.audio], { type: request.mimeType }),
        `voice.${ext}`
      );
      form.append("model", endpoint.model);

      const base = endpoint.baseUrl.replace(/\/+$/, "");
      const resp = await safeFetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        body: form,
      });
      if (!resp.ok) {
        // 只报状态码：上游的错误正文里常常回显请求头
        throw new Error(`语音转写失败（HTTP ${resp.status}）`);
      }
      const json = JSON.parse(resp.bodyText) as { text?: string };
      return { text: json.text ?? "" };
    }
  );
}


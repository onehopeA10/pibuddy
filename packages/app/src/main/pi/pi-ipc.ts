/**
 * pi 运行时相关的 IPC handler（从 ipc.ts 迁出）。
 *
 * 迁出的原因是结构性的：所有 handler 挤在一个文件里时，「新增一个通道」
 * 必然要改那个文件，于是 M3-M5 的七八个任务全部串行卡在同一处冲突上。
 * 每域一个 `*-ipc.ts` 之后，新增能力只动自己那一份。
 *
 * **本文件不出现 ipcMain.handle**：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * 这里同时是 webContents → PiRpcClient 索引的持有者：sessions-ipc 需要
 * 「当前会话的 client」来发 set_session_name / export_html，那份索引只能有
 * 一处，否则两边各持一个 map，停一个进程只会清掉其中一份。
 */
import { app, type WebContents } from "electron";
import { stat } from "node:fs/promises";
import type { ImageContent, PiRpcClient } from "@pibuddy/pi-sdk";
import { attachSwitchTrace } from "./switch-session-trace.js";
import {
  CHANNELS,
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_TOTAL_ATTACHMENT_BYTES,
  MAX_PROMPT_TOTAL_IMAGE_BYTES,
  SUPPORTED_PROMPT_IMAGE_MIME_TYPES,
  decodedBase64ByteLength,

  extensionUiResponseSchema,
  piCompactRequestSchema,
  piForkRequestSchema,
  piGetEntriesRequestSchema,
  piMessageRequestSchema,
  piPromptRequestSchema,
  piSetApprovalModeRequestSchema,
  piSetModelRequestSchema,
  piSetSessionNameRequestSchema,
  piSetThinkingLevelRequestSchema,
  piStartParamsSchema,
  piSwitchSessionRequestSchema,
  voidRequestSchema,
} from "@pibuddy/contract";

import * as attachments from "../attachment-registry.js";
import { agentPool, agentPoolObserver, poolRuntimeHost } from "../agent-pool/pool.js";
import { isCapabilityEnabled } from "../capability/capability-state.js";
import { MEMORY_CAPABILITY_ID } from "../capability/manifests/memory.manifest.js";
import { applyConversationActions } from "../conversation/apply-actions.js";
import { applyWorkMode } from "../../lib/work-mode.js";
import { injectMemory } from "../memory/memory-inject.js";
import { ExtensionUiService, type ExtUiHost } from "../extension-ui/ext-ui-service.js";
import { registerHandler, forgetSender } from "../ipc-guard.js";
import { log } from "../log.js";
import { buildPiSpawn, verifyRuntimeHandshake } from "../pi-launcher.js";
import { kernelExtensionArgs } from "./kernel-extensions.js";
import {
  APPROVAL_RELOAD_COMMAND,
  approvalModeFromStatuses,
  writeApprovalMode,
} from "./approval-mode.js";
import { sessionTrustFor } from "../pi-resources/project-trust.js";
import { describeTrust, trustArgsFor } from "../pi-resources/trust-store.js";
import { PiSupervisor } from "../pi-supervisor.js";
import {
  pickResumeSessionPath,
  resolveSessionDir,
  sessionFilePath,
} from "../sessions/session-dir.js";
import { sessionIndex } from "../sessions/session-index.js";
import { loadSettings } from "../settings.js";
import { assertContained, requireWorkspaceRoot, workspaceIdFor } from "../workspace-registry.js";

/**
 * webContents id → 当前 runtime 的 client。
 *
 * 登记必须发生在任何 await 之前 —— spawn 失败（ENOENT 实测序列是
 * error → close，没有 exit）时死 client 会滞留在 map 里接走后续所有请求。
 */
const clients = new Map<number, PiRpcClient>();
/** webContents → 该 runtime 启动时绑定的 workspaceId（记忆注入 / 切会话不得回退 settings）。 */
const clientWorkspaces = new Map<number, string>();
/** 切换 / 新建 / 中止推进代际，作废仍在预处理的旧 prompt。 */
const promptEpochBySender = new Map<number, number>();

function currentPromptEpoch(senderId: number): number {
  return promptEpochBySender.get(senderId) ?? 0;
}

function bumpPromptEpoch(senderId: number): number {
  const next = currentPromptEpoch(senderId) + 1;
  promptEpochBySender.set(senderId, next);
  return next;
}

let supervisorInstance: PiSupervisor | null = null;
/** 全应用唯一的运行时监管者（代际、序号、信封、33ms 转发都归它管）。 */
export function supervisor(): PiSupervisor {
  if (!supervisorInstance) {
    supervisorInstance = new PiSupervisor({
      info: (event, fields) => log().info(event, fields),
      warn: (event, fields) => log().warn(event, fields),
    });
  }
  return supervisorInstance;
}

/**
 * 全应用唯一的扩展 UI 挂起表。
 *
 * host 适配层刻意在这里而不是在 service 里：service 不该知道 supervisor 与
 * PiRpcClient 的存在，否则它就没法在没有 Electron 的环境里被驱动，而
 * timeout / 代际清理 / 定时器泄漏这三件事恰恰只有单测能查。
 */
let extUiInstance: ExtensionUiService | null = null;

export function extUi(): ExtensionUiService {
  if (!extUiInstance) {
    const host: ExtUiHost = {
      push: (targetId, channel, payload) => supervisor().push(targetId, channel, payload),
      responderFor: (targetId) => clients.get(targetId) ?? null,
    };
    extUiInstance = new ExtensionUiService(host);
    supervisor().setUiHook((targetId, generation, request) =>
      extUiInstance!.track(targetId, generation, request)
    );
  }
  return extUiInstance;
}

/** 仅供单测：丢弃挂起表与 supervisor 单例之间的绑定。 */
export function __resetExtUi(): void {
  extUiInstance = null;
}

export function disposeClientFor(webContentsId: number): void {
  clients.delete(webContentsId);
  clientWorkspaces.delete(webContentsId);
  promptEpochBySender.delete(webContentsId);
  // 先作废挂起弹窗再停进程：反过来的话，广播 expire 时 supervisor 里已经
  // 没有这个 target 的记录，信封发不出去，渲染进程会留着一排永远等不到
  // 回答的框。
  const generation = supervisor().currentGeneration();
  extUi().clearGeneration(webContentsId, generation, "runtime-gone");
  // 窗口关了：前台和挂起的后台一起停。休眠 / 换当前会话走 disposeTarget。
  supervisor().disposeAllForTarget(webContentsId);
  forgetSender(webContentsId);
  // 窗口没了，之前签发的附件凭证全部作废。
  attachments.revokeAll();
}

function bindForegroundClient(
  webContentsId: number,
  client: PiRpcClient,
  workspaceId: string
): void {
  clients.set(webContentsId, client);
  clientWorkspaces.set(webContentsId, workspaceId);
}

function switchResponse(
  command: "switch_session" | "new_session",
  extra?: { sessionId?: string }
): { type: "response"; command: typeof command; success: true; data: { cancelled: false; sessionId?: string } } {
  return {
    type: "response",
    command,
    success: true,
    data: { cancelled: false, ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}) },
  };
}

/**
 * 取当前可用的 client。
 *
 * 不可用时抛出的错误必须携带**真实原因**：ENOENT / 权限 / 版本不符各有各的
 * 处置方式，一律报「运行时没起来」等于把诊断信息扔掉。
 */
export function clientFor(webContentsId: number): PiRpcClient {
  const client = clients.get(webContentsId);
  if (!client) throw new Error("智能体运行时不可用：尚未启动，请先选择工作文件夹");
  client.assertUsable();
  return client;
}

/** 拿不到就返回 null 的版本，供「有就用、没有就降级」的路径使用。 */
export function tryClientFor(webContentsId: number): PiRpcClient | null {
  return clients.get(webContentsId) ?? null;
}

const supportedInlineImageMimes = new Set<string>(SUPPORTED_PROMPT_IMAGE_MIME_TYPES);

/**
 * 解码并复核渲染进程传来的内联图片。声明 MIME 只有与 magic bytes 一致才可转发。
 */
export function validateInlineImages(
  images: readonly ImageContent[] | undefined
): ImageContent[] | undefined {
  if (!images?.length) return undefined;
  if (images.length > MAX_PROMPT_IMAGES) {
    throw new Error(`PI_IMAGE_COUNT_EXCEEDED: ${images.length} > ${MAX_PROMPT_IMAGES}`);
  }

  let totalBytes = 0;
  const decodedSizes: number[] = [];
  for (const image of images) {
    if (!supportedInlineImageMimes.has(image.mimeType)) {
      throw new Error(`PI_IMAGE_UNSUPPORTED_MIME: ${image.mimeType}`);
    }
    const decodedBytes = decodedBase64ByteLength(image.data);
    if (!Number.isFinite(decodedBytes)) throw new Error("PI_IMAGE_BASE64_INVALID");
    if (decodedBytes > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error(`PI_IMAGE_TOO_LARGE: ${decodedBytes} > ${MAX_PROMPT_IMAGE_BYTES}`);
    }
    totalBytes += decodedBytes;
    if (totalBytes > MAX_PROMPT_TOTAL_IMAGE_BYTES) {
      throw new Error(
        `PI_IMAGE_TOTAL_TOO_LARGE: ${totalBytes} > ${MAX_PROMPT_TOTAL_IMAGE_BYTES}`
      );
    }
    decodedSizes.push(decodedBytes);
  }

  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    const decoded = Buffer.from(image.data, "base64");
    // 规范化校验不必整段重编码：decodedBase64ByteLength 已验过字符集、
    // 长度整除与 padding 只在末尾，剩下唯一的非规范形态是最后一个 4 字符块
    // 的尾随位非零（同一字节序列存在多个 base64 写法）。只重编码末尾
    // 1-3 个字节与原文最后一块比较即可，省掉多 MB 图片的整段二次编码。
    const tailByteCount = decoded.byteLength % 3 || 3;
    const canonicalTail = decoded.subarray(decoded.byteLength - tailByteCount).toString("base64");
    if (
      decoded.byteLength !== decodedSizes[index] ||
      canonicalTail !== image.data.slice(-canonicalTail.length)
    ) {
      throw new Error("PI_IMAGE_BASE64_INVALID");
    }
    const actualMime = attachments.sniffImageMime(decoded.subarray(0, 16));
    if (!actualMime) throw new Error("PI_IMAGE_MAGIC_INVALID");
    if (actualMime !== image.mimeType) {
      throw new Error(`PI_IMAGE_MIME_MISMATCH: ${image.mimeType} != ${actualMime}`);
    }
  }

  return [...images];
}

type PromptAttachmentResolver = (
  token: string
) => Promise<attachments.PromptAttachmentSnapshot>;

/** 先完整生成稳定快照，再按快照字节执行单文件与总上限，失败时绝不进入 client.send。 */
export async function resolvePromptAttachments(
  tokens: readonly string[],
  resolve: PromptAttachmentResolver = (token) => attachments.snapshotPromptAttachment(token)
): Promise<attachments.PromptAttachmentSnapshot[]> {
  const settled = await Promise.allSettled(tokens.map((token) => resolve(token)));
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (rejected) throw rejected.reason;

  const snapshots = settled.map(
    (result) =>
      (result as PromiseFulfilledResult<attachments.PromptAttachmentSnapshot>).value
  );
  let totalBytes = 0;
  for (const snapshot of snapshots) {
    if (
      !Number.isSafeInteger(snapshot.size) ||
      snapshot.size < 0 ||
      snapshot.size > MAX_PROMPT_ATTACHMENT_BYTES
    ) {
      throw new Error(
        `PI_ATTACHMENT_TOO_LARGE: ${snapshot.size} > ${MAX_PROMPT_ATTACHMENT_BYTES}`
      );
    }
    totalBytes += snapshot.size;
    if (totalBytes > MAX_PROMPT_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `PI_ATTACHMENT_TOTAL_TOO_LARGE: ${totalBytes} > ${MAX_PROMPT_TOTAL_ATTACHMENT_BYTES}`
      );
    }
  }
  return snapshots;
}

/** 模型只看到来源标签与 app-owned snapshot；original canonical path 永不拼入 prompt。 */
export function appendPromptAttachmentManifest(
  message: string,
  snapshots: readonly attachments.PromptAttachmentSnapshot[]
): string {
  if (snapshots.length === 0) return message;
  const lines = snapshots.map(
    (snapshot) =>
      `- ${snapshot.sourceLabel}（${snapshot.mimeType}，${snapshot.size} 字节）：${snapshot.snapshotPath}`
  );
  return `${message}\n\n[附件]\n${lines.join("\n")}`.trim();
}

export function shouldRevokeAttachmentsAfterSessionChange(response: {
  success: boolean;
  data?: unknown;
}): boolean {
  if (!response.success) return false;
  if (response.data === null || typeof response.data !== "object") return true;
  return (response.data as { cancelled?: unknown }).cancelled !== true;
}

/**
 * 不透明 sessionId → JSONL 绝对路径。
 *
 * 索引里查不到就先同步一次再查。同步后仍没有：约定文件名若已在磁盘上
 * 就用它。文件还不存在（pi 惰性落盘、或放太久被清掉）时返回 null ——
 * 调用方应开新会话，不能把这条路径丢给 realpath（ENOENT）。
 */
async function resolveSessionPath(sessionId: string, workspaceRoot: string): Promise<string | null> {
  const settings = loadSettings();
  const sessionDir = resolveSessionDir(workspaceRoot, settings);
  const index = sessionIndex();
  // 按 (workspaceId, sessionId) 联合定位：sessionId 只在一个工作区之内唯一，
  // 全局取「最近修改的那行」会在同 id 撞车时打开另一个工作区的会话文件。
  const workspaceId = workspaceIdFor(workspaceRoot);
  let row = index.bySessionId(sessionId, workspaceId);
  if (!row) {
    await index.syncWorkspace(workspaceRoot, settings);
    row = index.bySessionId(sessionId, workspaceId);
  }
  const fallback = sessionFilePath(sessionDir, sessionId);
  let fallbackExists = false;
  try {
    await stat(fallback);
    fallbackExists = true;
  } catch {
    fallbackExists = false;
  }
  return pickResumeSessionPath(row?.sourcePath ?? null, fallback, fallbackExists);
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

async function containedIfExists(sessionDir: string, absTarget: string): Promise<string | null> {
  try {
    return await assertContained(sessionDir, absTarget);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function sessionFileBytes(sessionPath: string): Promise<number> {
  try {
    return (await stat(sessionPath)).size;
  } catch {
    return 0;
  }
}

/**
 * 为窗口再起一个前台 runtime。
 *
 * `replace`：只拆当前前台（休眠 / 续接同一会话）。
 * `park`：前台挂起继续跑，再起一个新进程（运行中切到另一个会话）。
 */
async function spawnForeground(
  wc: WebContents,
  opts: { workspaceId: string; sessionId?: string },
  mode: "replace" | "park"
): Promise<{
  state: Awaited<ReturnType<PiRpcClient["getState"]>>;
  models: Awaited<ReturnType<PiRpcClient["getAvailableModels"]>>["models"];
  messages: Awaited<ReturnType<PiRpcClient["getMessages"]>>["messages"];
  modelsError?: string;
}> {
  const root = requireWorkspaceRoot(opts.workspaceId);
  const settings = loadSettings();
  const sessionDir = resolveSessionDir(root, settings);
  let sessionPath: string | undefined;
  if (opts.sessionId) {
    const resolved = await resolveSessionPath(opts.sessionId, root);
    if (resolved) {
      const contained = await containedIfExists(sessionDir, resolved);
      if (contained) sessionPath = contained;
      else {
        log().warn("pi_start_session_missing", {
          sessionId: opts.sessionId,
          path: resolved,
        });
      }
    }
  }

  const trust = await describeTrust({
    workspaceId: opts.workspaceId,
    workspaceRoot: root,
    defaultProjectTrust: "ask",
  });
  const trustArgs = trustArgsFor({
    hasProjectResources: trust.hasProjectResources,
    saved: trust.saved,
    decision: sessionTrustFor(opts.workspaceId),
  });
  const spawn = buildPiSpawn({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    settings,
    logger: log(),
    trustArgs,
  });
  verifyRuntimeHandshake(spawn.runtime, log());

  const { client, handle } = supervisor().launch(
    wc,
    {
      spawn,
      workspaceId: opts.workspaceId,
      cwd: root,
      sessionPath,
      sessionDir,
      extraArgs: kernelExtensionArgs(log()),
    },
    mode
  );
  bindForegroundClient(wc.id, client, opts.workspaceId);

  try {
    const state = await client.getState();
    supervisor().adoptSession(handle.runtimeId, state.sessionId);
    if (state.sessionId) agentPool().setFocused(state.sessionId);
    const [models, messages] = await Promise.all([
      client.getAvailableModels().catch((err: unknown) => {
        const modelsError = err instanceof Error ? err.message : String(err);
        log().warn("pi_start_models_failed", { cause: modelsError });
        return { models: [], modelsError };
      }),
      client.getMessages().catch((err: unknown) => {
        log().warn("pi_start_messages_failed", {
          cause: err instanceof Error ? err.message : String(err),
        });
        throw new Error(
          `启动智能体成功，但未能读取会话消息：${err instanceof Error ? err.message : String(err)}`
        );
      }),
    ]);
    return {
      state,
      models: models.models,
      messages: messages.messages,
      ...("modelsError" in models && models.modelsError ? { modelsError: models.modelsError } : {}),
    };
  } catch (err) {
    const cause = client.lastSpawnError?.message ?? (err as Error).message;
    const tail = client.stderrSnapshot;
    log().error("pi_runtime_start_failed", {
      runtimeId: handle.runtimeId,
      generation: handle.generation,
      phase: client.phase,
      cause,
    });
    supervisor().disposeTarget(wc.id);
    if (clients.get(wc.id) === client) clients.delete(wc.id);
    throw new Error(`启动智能体失败：${cause}${tail ? `\n${tail}` : ""}`);
  }
}

export function registerPiIpc(): void {
  // 把后台会话池挂到 supervisor 上（AGT-101）。依赖方向 pi → kernel：池的实现
  // 与观测者形状都在内核侧，pi 域只负责把观测者装上去。放在最前面，保证从第一
  // 次会话握手（adoptSession）起，池就在观测当前会话。
  supervisor().setPoolObserver(agentPoolObserver());

  // 前台回退网关（AGT-103 / ISS-004）：池的 deliver / stop 目标若命中前台
  // supervisor 当前活跃会话，就路由到 supervisor 的 client——remote 的
  // 「发 prompt / 停止」因此够得着前台会话，而 remote 域一行不改。网关形状
  // 定义在内核侧（pool-runtime-host.ts），真实实现在**这里**（pi 域），依赖
  // 方向仍是 pi → kernel，kernel-boundary 的 allowlist 一条不加。
  poolRuntimeHost().setForegroundGateway({
    activeSessionId: () => supervisor().currentActive()?.sessionId ?? null,
    deliver: (text) => {
      const active = supervisor().currentActive();
      if (!active) return;
      void active.client.send({ type: "prompt", message: text }).catch((err: unknown) => {
        log().warn("pi_foreground_deliver_failed", {
          sessionId: active.sessionId,
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    },
    stop: () => {
      const active = supervisor().currentActive();
      if (!active) return;
      supervisor().disposeTarget(active.targetId);
      clients.delete(active.targetId);
    },
  });

  // ------------------------------------------------------------ 生命周期

  registerHandler(CHANNELS.piStart, piStartParamsSchema, async (opts, event) => {
    const wc = event.sender;
    if (opts.sessionId) {
      const live = supervisor().recordForSession(opts.sessionId);
      if (live) {
        const attached = supervisor().attachToTarget(wc, opts.sessionId);
        if (attached) {
          bindForegroundClient(wc.id, attached, opts.workspaceId);
          agentPool().setFocused(opts.sessionId);
          const state = await attached.getState();
          const [models, messages] = await Promise.all([
            attached.getAvailableModels().catch(() => ({ models: [] })),
            attached.getMessages().catch(() => ({ messages: [] })),
          ]);
          return { state, models: models.models, messages: messages.messages };
        }
      }
    }
    return spawnForeground(wc, opts, "replace");
  });

  registerHandler(CHANNELS.piStop, voidRequestSchema, (_payload, event) => {
    // 只停当前前台：后台挂起的会话继续跑。窗口关闭才 disposeClientFor。
    supervisor().disposeTarget(event.sender.id);
    clients.delete(event.sender.id);
  });

  /**
   * 回答一条扩展弹窗。
   *
   * 改造前这里是一行直写：取到 client 就把响应塞进 stdin。两个后果：
   *   - 没有 id 校验 —— 上游带 timeout 的 dialog 到期自行 auto-resolve 之后，
   *     用户点的那个按钮发出的是一个**失效 id**，client.ts 直写 stdin，
   *     pi 那边找不到对应 pending，静默丢弃；
   *   - 没有 try/catch —— runtime 已经没了时 clientFor 抛错，而渲染侧的
   *     调用方只是把那个 promise `void` 掉，于是它变成一条无人认领的
   *     unhandled rejection。
   *
   * 现在两件事都由 ExtensionUiService 兜住，并把结论作为返回值送回渲染
   * 进程：`ok:false` 时界面要给用户一句解释，而不是假装回答已经送到。
   */
  registerHandler(CHANNELS.piUiRespond, extensionUiResponseSchema, (response, event) => {
    const result = extUi().respond(event.sender.id, response);
    if (!result.ok) {
      log().warn("ext_ui_respond_rejected", { reason: result.reason, id: response.id });
    }
    return result;
  });

  /** 窗口 reload 后的恢复快照。挂起表在主进程，reload 不该让它们凭空消失。 */
  registerHandler(CHANNELS.piUiPending, voidRequestSchema, (_p, event) =>
    extUi().snapshot(event.sender.id)
  );

  // ------------------------------------------------------- 产品动作窄通道
  //
  // 每一条都是一个**具体的产品意图**。这里没有、也不会有一条能表达
  // 「执行任意 pi 命令」的通道 —— pi 的协议原生提供 {"type":"bash",...}，
  // 留一条通用转发口等于把本机 shell 直接挂在渲染进程上。

  registerHandler(CHANNELS.piPrompt, piPromptRequestSchema, async (payload, event) => {
    const preprocessStartedAt = Date.now();
    const senderId = event.sender.id;
    const promptEpoch = currentPromptEpoch(senderId);
    const sessionAtStart = supervisor().currentActive()?.sessionId;
    const inlineImages = validateInlineImages(payload.images);
    const tokens = payload.attachmentTokens ?? [];
    const attachmentSnapshots = await resolvePromptAttachments(tokens);
    const client = clientFor(senderId);
    const promptWorkspaceId = clientWorkspaces.get(senderId);
    // 对话即动作：在拼附件 / 注入记忆之前认「记住 / 定时 / 办公技能」。
    // 关掉对应能力时 applyConversationActions 原样返回，这段等价于不存在。
    const acted = applyConversationActions(payload.message, {
      workspaceId: promptWorkspaceId,
      sessionId: supervisor().currentActive()?.sessionId,
      workMode: payload.workMode ?? "act",
    });
    // 非图片附件先在 main 内完成稳定读取与 immutable snapshot，再把 snapshot 路径
    // 交给 pi。原 workspace / 系统文件路径不会进入 prompt，也不会返回 renderer。
    let message = appendPromptAttachmentManifest(acted.message, attachmentSnapshots);
    message = applyWorkMode(message, payload.workMode ?? "act");
    // 长期记忆注入（MEM-101，本能力唯一的内核接触点）。
    //
    // 零成本门：`common.memory` 未启用时 isCapabilityEnabled 是一次内存 Set 命中、
    // 立即为假，连 loadSettings 都不会跑 —— 「关掉记忆」因此真的等于「这段不存在」，
    // 而不是「每发一句话还白读一次设置」。启用时才解出 workspaceId 交给 injectMemory，
    // 后者内部再判一次注入总开关、抽词检索、落下命中记录（供隐私视图查看）。
    const memoryEnabled = isCapabilityEnabled(MEMORY_CAPABILITY_ID) && Boolean(promptWorkspaceId);
    if (memoryEnabled && promptWorkspaceId) {
      message = await injectMemory(
        message,
        promptWorkspaceId,
        supervisor().currentActive()?.sessionId
      );
    }
    const preprocessMs = Date.now() - preprocessStartedAt;
    const sessionNow = supervisor().currentActive()?.sessionId;
    if (
      promptEpoch !== currentPromptEpoch(senderId) ||
      (sessionAtStart && sessionNow && sessionAtStart !== sessionNow)
    ) {
      return { success: false, error: "会话已切换，未发送" };
    }
    const rpcStartedAt = Date.now();
    const resp = await client.send({
      type: "prompt",
      message,
      ...(inlineImages ? { images: inlineImages } : {}),
      // 插话走 prompt + streamingBehavior:"steer"，不是 pi 的原生 steer 命令：
      // rpc.md 第 65 行明确流式过程中不带 streamingBehavior 的 prompt 直接返回
      // error，而原生 steer 命令不接受扩展参数。这个分支删不得。
      ...(payload.streamingBehavior ? { streamingBehavior: payload.streamingBehavior } : {}),
    });
    log().info("pi_prompt_accepted", {
      preprocessMs,
      rpcMs: Date.now() - rpcStartedAt,
      attachments: tokens.length,
      memoryEnabled,
      success: resp.success,
    });
    return resp;
  });

  registerHandler(CHANNELS.piSteer, piMessageRequestSchema, (payload, event) => {
    const inlineImages = validateInlineImages(payload.images);
    return clientFor(event.sender.id).steer(payload.message, inlineImages);
  });

  registerHandler(CHANNELS.piFollowUp, piMessageRequestSchema, (payload, event) => {
    const inlineImages = validateInlineImages(payload.images);
    return clientFor(event.sender.id).followUp(payload.message, inlineImages);
  });

  registerHandler(CHANNELS.piAbort, voidRequestSchema, async (_p, event) => {
    bumpPromptEpoch(event.sender.id);
    // 不能走 clientFor()：phase=stopping 时 assertUsable 会抛「运行时不可用」，
    // 用户点「停止」反而被拒，界面的 streaming 也就永远收不掉。
    const client = tryClientFor(event.sender.id);
    if (
      !client ||
      !client.running ||
      client.phase === "stopping" ||
      client.phase === "stopped"
    ) {
      return { type: "response", command: "abort", success: true };
    }
    try {
      return await client.abort();
    } catch {
      return { type: "response", command: "abort", success: true };
    }
  });

  registerHandler(CHANNELS.piNewSession, voidRequestSchema, async (_p, event) => {
    bumpPromptEpoch(event.sender.id);
    // 不能走 clientFor()：phase≠running 时 assertUsable 会抛到渲染进程，
    // newTask 以前又没有 catch，按钮就像没点一样。
    const client = tryClientFor(event.sender.id);
    if (!client || !client.running) {
      return {
        type: "response" as const,
        command: "new_session",
        success: false,
        error: "智能体运行时不可用，请先唤醒会话",
      };
    }
    try {
      client.assertUsable();
    } catch (err) {
      return {
        type: "response" as const,
        command: "new_session",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    log().info("pi_new_session", { runtimeId: client.runtimeId, phase: client.phase });
    const workspaceId = clientWorkspaces.get(event.sender.id);
    if (supervisor().isForegroundBusy(event.sender.id) && workspaceId) {
      const launched = await spawnForeground(
        event.sender,
        { workspaceId },
        "park"
      );
      return switchResponse("new_session", { sessionId: launched.state.sessionId });
    }
    try {
      await client.abort();
    } catch {
      // 没有在跑的回合，或 abort 已超时：下面仍尝试换会话。
    }
    const resp = await client.newSession();
    if (resp.success && (resp.data as { cancelled?: boolean } | undefined)?.cancelled !== true) {
      const nextId =
        resp.data && typeof resp.data === "object" && "sessionId" in resp.data
          ? String((resp.data as { sessionId?: unknown }).sessionId ?? "")
          : "";
      if (nextId) supervisor().adoptSession(client.runtimeId, nextId);
    }
    // 换会话 = 上一段对话里签发的附件凭证全部作废
    if (shouldRevokeAttachmentsAfterSessionChange(resp)) attachments.revokeAll();
    return resp;
  });

  registerHandler(CHANNELS.piSwitchSession, piSwitchSessionRequestSchema, async (payload, event) => {
    bumpPromptEpoch(event.sender.id);
    const wc = event.sender;
    const live = supervisor().recordForSession(payload.sessionId);
    const foreground = supervisor().currentActive();
    if (live && foreground?.sessionId !== payload.sessionId) {
      const attached = supervisor().attachToTarget(wc, payload.sessionId);
      if (attached) {
        bindForegroundClient(wc.id, attached, payload.workspaceId);
        agentPool().setFocused(payload.sessionId);
        log().info("pi_switch_session_attached", { sessionId: payload.sessionId });
        return switchResponse("switch_session", { sessionId: payload.sessionId });
      }
    }
    if (
      supervisor().isForegroundBusy(wc.id) &&
      foreground?.sessionId &&
      foreground.sessionId !== payload.sessionId
    ) {
      await spawnForeground(
        wc,
        { workspaceId: payload.workspaceId, sessionId: payload.sessionId },
        "park"
      );
      log().info("pi_switch_session_spawned", { sessionId: payload.sessionId });
      return switchResponse("switch_session", { sessionId: payload.sessionId });
    }

    const root = requireWorkspaceRoot(payload.workspaceId);
    const settings = loadSettings();
    // 只允许切到该 workspace 会话目录里的文件，禁止回退 settings.workspace
    const sessionDir = resolveSessionDir(root, settings);
    const resolveStartedAt = Date.now();
    const resolved = await resolveSessionPath(payload.sessionId, root);
    const real = resolved ? await containedIfExists(sessionDir, resolved) : null;
    if (!real) {
      throw new Error("这条会话的文件已经不在了，请再开一条新对话");
    }
    const resolveMs = Date.now() - resolveStartedAt;
    const fileBytes = await sessionFileBytes(real);
    const client = clientFor(event.sender.id);
    const trace = attachSwitchTrace(client);
    const rpcStartedAt = Date.now();
    log().info("pi_switch_session_start", {
      sessionId: payload.sessionId,
      fileBytes,
    });
    let resp: Awaited<ReturnType<PiRpcClient["switchSession"]>> | undefined;
    try {
      resp = await client.switchSession(real);
    } finally {
      const observed = trace.stop();
      log().info("pi_switch_session_done", {
        sessionId: payload.sessionId,
        resolveMs,
        rpcMs: Date.now() - rpcStartedAt,
        fileBytes,
        success: resp?.success ?? false,
        ...observed,
      });
    }
    if (!resp) throw new Error("switch_session 没有返回");
    if (resp.success && (resp.data as { cancelled?: boolean } | undefined)?.cancelled !== true) {
      clientWorkspaces.set(event.sender.id, payload.workspaceId);
      supervisor().adoptSession(client.runtimeId, payload.sessionId);
      agentPool().setFocused(payload.sessionId);
    }
    if (shouldRevokeAttachmentsAfterSessionChange(resp)) attachments.revokeAll();
    return resp;
  });

  registerHandler(CHANNELS.piSetModel, piSetModelRequestSchema, (payload, event) =>
    clientFor(event.sender.id).send({
      type: "set_model",
      provider: payload.provider,
      modelId: payload.modelId,
    })
  );

  registerHandler(CHANNELS.piSetThinkingLevel, piSetThinkingLevelRequestSchema, (payload, event) =>
    clientFor(event.sender.id).send({ type: "set_thinking_level", level: payload.level })
  );

  /**
   * 切审批模式：写工作目录 `.pi/settings.local.json` → 让权限扩展 reload。
   * 两步的理由与「为什么不走 pi:prompt」见 ./approval-mode.ts 文件头。
   */
  registerHandler(CHANNELS.piSetApprovalMode, piSetApprovalModeRequestSchema, async (payload, event) => {
    const senderId = event.sender.id;
    // 扩展不在场时 reload 命令会当成普通提示词进模型，还白改一个文件 —— 先拒绝。
    if (approvalModeFromStatuses(extUi().snapshot(senderId).statuses) === null) {
      return { success: false, error: "当前运行时没有加载权限扩展，改不了审批模式" };
    }
    const workspaceId = clientWorkspaces.get(senderId);
    if (!workspaceId) return { success: false, error: "当前会话还没绑定工作目录" };
    const root = requireWorkspaceRoot(workspaceId);
    const filePath = writeApprovalMode(root, payload.mode);
    const resp = await clientFor(senderId).send({ type: "prompt", message: APPROVAL_RELOAD_COMMAND });
    log().info("pi_approval_mode_set", { mode: payload.mode, filePath, success: resp.success });
    return resp;
  });

  registerHandler(CHANNELS.piGetState, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_state" })
  );

  registerHandler(CHANNELS.piGetMessages, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_messages" })
  );

  registerHandler(CHANNELS.piGetSessionStats, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_session_stats" })
  );

  registerHandler(CHANNELS.piGetAvailableModels, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_available_models" })
  );

  registerHandler(CHANNELS.piGetAvailableThinkingLevels, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_available_thinking_levels" })
  );

  registerHandler(CHANNELS.piCompact, piCompactRequestSchema, (payload, event) =>
    clientFor(event.sender.id).compact(payload.customInstructions)
  );

  registerHandler(CHANNELS.piSetSessionName, piSetSessionNameRequestSchema, (payload, event) =>
    clientFor(event.sender.id).setSessionName(payload.name)
  );

  // ------------------------------------------------------- 会话树 / 分叉
  //
  // 数据面本轮就接完整（rpc.md:615 fork / 643 clone / 671 get_fork_messages /
  // 694 get_entries / 724 get_tree）；**可视化分支图不在本轮交付范围内**，
  // 因此不得声称 M3 出口门禁的「分叉」能力已完整达成。
  //
  // fork / clone 的 `data.cancelled === true` 与 new_session 同语义：扩展
  // 可以否决，此时 success 仍是 true。调用方必须自己看 cancelled。

  registerHandler(CHANNELS.piGetEntries, piGetEntriesRequestSchema, (payload, event) =>
    clientFor(event.sender.id).send({
      type: "get_entries",
      ...(payload.since ? { since: payload.since } : {}),
    })
  );

  registerHandler(CHANNELS.piGetTree, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_tree" })
  );

  registerHandler(CHANNELS.piGetForkMessages, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "get_fork_messages" })
  );

  registerHandler(CHANNELS.piFork, piForkRequestSchema, (payload, event) =>
    clientFor(event.sender.id).send({ type: "fork", entryId: payload.entryId })
  );

  registerHandler(CHANNELS.piClone, voidRequestSchema, (_p, event) =>
    clientFor(event.sender.id).send({ type: "clone" })
  );
}

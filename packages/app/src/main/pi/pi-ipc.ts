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
import { app } from "electron";
import path from "node:path";
import type { PiRpcClient } from "@pibuddy/pi-sdk";
import {
  CHANNELS,
  extensionUiResponseSchema,
  piCompactRequestSchema,
  piForkRequestSchema,
  piGetEntriesRequestSchema,
  piMessageRequestSchema,
  piPromptRequestSchema,
  piSetModelRequestSchema,
  piSetSessionNameRequestSchema,
  piSetThinkingLevelRequestSchema,
  piStartParamsSchema,
  piSwitchSessionRequestSchema,
  voidRequestSchema,
} from "@pibuddy/contract";

import * as attachments from "../attachment-registry.js";
import { registerHandler, forgetSender } from "../ipc-guard.js";
import { createLogger, type Logger } from "../logger.js";
import { buildPiSpawn, verifyRuntimeHandshake } from "../pi-launcher.js";
import { PiSupervisor } from "../pi-supervisor.js";
import { resolveSessionDir } from "../sessions/session-dir.js";
import { sessionIndex } from "../sessions/session-index.js";
import { loadSettings } from "../settings.js";
import { assertContained, requireWorkspaceRoot } from "../workspace-registry.js";

/**
 * webContents id → 当前 runtime 的 client。
 *
 * 登记必须发生在任何 await 之前 —— spawn 失败（ENOENT 实测序列是
 * error → close，没有 exit）时死 client 会滞留在 map 里接走后续所有请求。
 */
const clients = new Map<number, PiRpcClient>();

let ipcLogger: Logger | null = null;
export function log(): Logger {
  if (!ipcLogger) {
    ipcLogger = createLogger({ dir: path.join(app.getPath("userData"), "logs") });
  }
  return ipcLogger;
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

export function disposeClientFor(webContentsId: number): void {
  clients.delete(webContentsId);
  supervisor().disposeTarget(webContentsId);
  forgetSender(webContentsId);
  // 窗口没了，之前签发的附件凭证一律作废。
  attachments.revokeAll();
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

/**
 * 不透明 sessionId → JSONL 绝对路径。
 *
 * 索引里查不到就先同步一次再查（首次启动、或索引刚被删掉时会走到）。
 * 仍查不到才抛 —— 静默降级成「开一个新会话」会让用户以为历史丢了。
 */
async function resolveSessionPath(sessionId: string, workspaceRoot: string): Promise<string> {
  const index = sessionIndex();
  let row = index.bySessionId(sessionId);
  if (!row) {
    await index.syncWorkspace(workspaceRoot, loadSettings());
    row = index.bySessionId(sessionId);
  }
  if (!row) throw new Error(`SESSION_UNKNOWN: ${sessionId}`);
  return row.sourcePath;
}

export function registerPiIpc(): void {
  // ------------------------------------------------------------ 生命周期

  registerHandler(CHANNELS.piStart, piStartParamsSchema, async (opts, event) => {
    const wc = event.sender;
    disposeClientFor(wc.id);

    // 渲染进程只给得出不透明 id，真实路径在这里才被解出来
    const root = requireWorkspaceRoot(opts.workspaceId);
    const settings = loadSettings();
    const sessionDir = resolveSessionDir(root, settings);

    // 续接历史会话：渲染进程只给得出不透明 sessionId，路径在这里经索引解出来，
    // 解完仍要过一次会话目录收容校验。
    let sessionPath: string | undefined;
    if (opts.sessionId) {
      sessionPath = await assertContained(sessionDir, await resolveSessionPath(opts.sessionId, root));
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

  // ------------------------------------------------------- 产品动作窄通道
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
      ...(payload.streamingBehavior ? { streamingBehavior: payload.streamingBehavior } : {}),
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

  registerHandler(CHANNELS.piSwitchSession, piSwitchSessionRequestSchema, async (payload, event) => {
    const settings = loadSettings();
    const root = settings.workspace;
    if (!root) throw new Error("尚未选择工作文件夹");
    // 只允许切到主进程自己枚举出来的那个目录里的会话文件
    const sessionDir = resolveSessionDir(root, settings);
    const real = await assertContained(
      sessionDir,
      await resolveSessionPath(payload.sessionId, root)
    );
    const resp = await clientFor(event.sender.id).switchSession(real);
    if (resp.success) attachments.revokeAll();
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

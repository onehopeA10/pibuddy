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
import { ExtensionUiService, type ExtUiHost } from "../extension-ui/ext-ui-service.js";
import { registerHandler, forgetSender } from "../ipc-guard.js";
import { log } from "../log.js";
import { buildPiSpawn, verifyRuntimeHandshake } from "../pi-launcher.js";
import { sessionTrustFor } from "../pi-resources/pi-resources-ipc.js";
import { describeTrust, trustArgsFor } from "../pi-resources/trust-store.js";
import { PiSupervisor } from "../pi-supervisor.js";
import { resolveSessionDir } from "../sessions/session-dir.js";
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
  // 先作废挂起弹窗再停进程：反过来的话，广播 expire 时 supervisor 里已经
  // 没有这个 target 的记录，信封发不出去，渲染进程会留着一排永远等不到
  // 回答的框。
  const generation = supervisor().currentGeneration();
  extUi().clearGeneration(webContentsId, generation, "runtime-gone");
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
  // 按 (workspaceId, sessionId) 联合定位：sessionId 只在一个工作区之内唯一，
  // 全局取「最近修改的那行」会在同 id 撞车时打开另一个工作区的会话文件。
  const workspaceId = workspaceIdFor(workspaceRoot);
  let row = index.bySessionId(sessionId, workspaceId);
  if (!row) {
    await index.syncWorkspace(workspaceRoot, loadSettings());
    row = index.bySessionId(sessionId, workspaceId);
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

    // project trust：RPC 模式下 pi 不弹提示（security.md:30），所以决定必须
    // 由 PiBuddy 问完之后作为一次性参数带下来。已经写进 trust.json 的决定
    // **不重复表达** —— 让 pi 自己读文件，两处表达同一件事必然有对不上的时候。
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
    const client = clientFor(event.sender.id);
    // 非图片附件的路径由主进程用凭证换回来后拼进提示词，渲染进程全程不接触路径
    let message = payload.message;
    const tokens = payload.attachmentTokens ?? [];
    if (tokens.length > 0) {
      // 结构化附件清单（FS-101）：工作区内的附件按 **relativePath** 呈现 ——
      // pi 的工作目录就是工作区 root，相对路径它解得开，而绝对路径一旦进了
      // 提示词，就等于把本机磁盘布局连同用户名一起送给了模型。
      // 工作区外的单文件授权（用户经系统对话框亲手选的）没有 root 可相对，
      // 只能给绝对路径 —— 那是一次显式手势的结果，不是渲染进程能构造的。
      const lines: string[] = [];
      for (const token of tokens) {
        const record = await attachments.resolveAttachment(token, { capability: "read" });
        const shown = record.workspaceId ? record.relativePath : record.canonicalPath;
        lines.push(`- ${shown}（${record.mimeType}，${record.size} 字节）`);
      }
      message = `${message}\n\n[附件]\n${lines.join("\n")}`.trim();
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

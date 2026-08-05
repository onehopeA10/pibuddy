/**
 * pi 子进程生命周期监管者（RUN-002）。
 *
 * 它解决的是一个具体的、可复现的故障：旧 runtime 延迟退出时仍会 emit
 * `exit`，主进程把它原样转给渲染进程，而渲染进程无从辨别代际，于是
 * **刚启动成功的新会话被置 started=false 并弹「智能体进程意外退出」**。
 *
 * 治理手段是「代际 + 序号」而不是时间窗口：
 *  - 每次 launch 分配一个不可复用的 runtimeId 与自增的 generation；
 *  - 每条外发消息都由 wrapEnvelope 包成 PiEnvelope，填满 7 个字段；
 *  - 只有 `generation === 当前代际` 的消息才会被转发（第一层防御，
 *    渲染进程侧还有第二层）。
 *
 * 33ms 合批与折叠**不在本文件**：它们唯一地住在 ./pi/event-forwarder.ts，
 * 避免两个转发器并存（CT-03 / CT-04）。
 */
import {
  PiRpcClient,
  type AgentEvent,
  type ExtensionUiRequest,
  type PiExitMeta,
  type PiSpawn,
} from "@pibuddy/pi-sdk";
import {
  PROTOCOL_VERSION,
  PUSH_CHANNELS,
  wrapEnvelope,
  type EnvelopeContext,
  type PiEnvelope,
  type PiRuntimeHandle,
  type PiRuntimeStartOptions,
  type PiRuntimeSupervisor,
  type PushChannel,
} from "@pibuddy/contract";
import {
  createForwarder,
  sendPush,
  type Forwarder,
  type ForwarderTarget,
} from "./pi/event-forwarder.js";
import { agentActivity } from "./lifecycle/graceful-shutdown.js";
import { observeToolEvent } from "./changeset/tool-watch.js";
import { modelErrorFromAgentEvent, modelErrorFromExit } from "./model-errors/index.js";
import type { PoolObserver } from "./agent-pool/pool-core.js";

/** 转发目标同时要能被按 id 索引（生产即 Electron 的 WebContents.id）。 */
export interface SupervisorTarget extends ForwarderTarget {
  id: number;
}

export interface LaunchOptions extends PiRuntimeStartOptions {
  spawn: PiSpawn;
}

interface RuntimeRecord {
  client: PiRpcClient;
  /** ctx 可变：sessionId 在握手拿到 get_state 之前是未知的 */
  ctx: EnvelopeContext;
  /** 单调序号，per runtime，从 0 开始 */
  sequence: number;
  forwarder: Forwarder;
  target: SupervisorTarget;
}

export interface SupervisorLogger {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * 后台会话池的观测挂钩（AGT-101）。
 *
 * 与 `uiHook` 同一手法：supervisor 不持有池、也不主动 import 它的实现，只
 * `import type` 一个观测者形状（依赖方向 pi → kernel），在三个生命周期点回调
 * 一个可注入的观测者。默认为 null——**不装时行为与从前一字不差**，这是单会话
 * 零回归的落点。装上后，池才据此把当前会话纳入监督面。
 *
 * 观测者的形状定义在内核侧（`agent-pool/pool-core.ts`），此处只 `import type`
 * 并原样再导出——依赖方向 pi → kernel，两边永不漂移。
 */
export type { PoolObserver } from "./agent-pool/pool-core.js";

const NOOP_LOGGER: SupervisorLogger = { info: () => {}, warn: () => {} };

export class PiSupervisor implements PiRuntimeSupervisor {
  /** 按 webContents id 索引：一个窗口同时只允许一个活跃 runtime。 */
  private byTarget = new Map<number, RuntimeRecord>();
  private byRuntimeId = new Map<string, RuntimeRecord>();
  /** 代际计数器：只增不减，进程生命周期内永不复用。 */
  private generationCounter = 0;
  private latest: PiRuntimeHandle | null = null;
  private boundTarget: SupervisorTarget | null = null;

  /**
   * 每收到一条 extension_ui_request 时的登记回调（ExtensionUiService 注册）。
   *
   * 用回调而不是让 supervisor 直接持有 service：supervisor 已经是本进程里
   * 最重的那个对象，再给它加一份挂起表的所有权，「谁负责清定时器」就会变成
   * 两个地方都能改的事。
   */
  private uiHook: ((targetId: number, generation: number, request: ExtensionUiRequest) => void) | null =
    null;

  /** 后台会话池观测者（AGT-101）。默认 null：不装时行为一字不变。 */
  private poolObserver: PoolObserver | null = null;

  constructor(private readonly logger: SupervisorLogger = NOOP_LOGGER) {}

  setUiHook(
    hook: (targetId: number, generation: number, request: ExtensionUiRequest) => void
  ): void {
    this.uiHook = hook;
  }

  setPoolObserver(observer: PoolObserver | null): void {
    this.poolObserver = observer;
  }

  /**
   * 以当前 runtime 的信封向某个窗口推一条消息。
   *
   * ExtensionUiService 的 expire / expire-all 走这里，因此它们同样带上代际
   * 与本通道的单调序号，渲染侧的闸门对它们一视同仁。没有活跃 runtime 时
   * 静默丢弃 —— 那种情况下渲染进程本来就要整体重来。
   */
  push(targetId: number, channel: PushChannel, payload: unknown): void {
    const record = this.byTarget.get(targetId);
    if (!record) return;
    sendPush(record.target, channel, this.nextEnvelope(record, payload));
  }

  /** 供 `start()`（端口签名不带 target）使用的默认目标。 */
  bindTarget(target: SupervisorTarget): void {
    this.boundTarget = target;
  }

  currentGeneration(): number {
    return this.generationCounter;
  }

  currentHandle(): PiRuntimeHandle | null {
    return this.latest;
  }

  clientFor(targetId: number): PiRpcClient | null {
    return this.byTarget.get(targetId)?.client ?? null;
  }

  /**
   * 当前活跃 runtime 的前台视图（AGT-103：池 deliver/stop 的前台回退网关用）。
   *
   * 只认**仍在索引里**的当前代际记录：`latest` 句柄在 runtime 退出后是陈旧的，
   * 必须经 byRuntimeId 再验一次，否则回退网关会把投递发给一个已死的 client。
   * 注意 sessionId 在握手 adoptSession 之前是占位值（sessionPath / runtimeId），
   * 那段窗口里它不会与任何真实会话 id 匹配——回退因此天然只在握手完成后生效。
   */
  currentActive(): { sessionId: string; targetId: number; client: PiRpcClient } | null {
    if (!this.latest) return null;
    const record = this.byRuntimeId.get(this.latest.runtimeId);
    if (!record) return null;
    return {
      sessionId: record.ctx.sessionId,
      targetId: record.target.id,
      client: record.client,
    };
  }

  /**
   * 同步启动一个新 runtime。
   *
   * 之所以必须同步返回 client：调用方要在**任何 await 之前**把它登记进自己的
   * 索引，否则 spawn 失败时会留下一个永远查不到、也永远清不掉的死 client。
   */
  launch(target: SupervisorTarget, options: LaunchOptions): {
    client: PiRpcClient;
    handle: PiRuntimeHandle;
  } {
    this.disposeTarget(target.id);

    const generation = ++this.generationCounter;
    const client = new PiRpcClient({
      spawn: options.spawn,
      cwd: options.cwd,
      session: options.sessionPath,
      sessionDir: options.sessionDir,
      generation,
    });
    const ctx: EnvelopeContext = {
      workspaceId: options.workspaceId || options.cwd,
      // 真实 sessionId 要等 get_state 才知道；先用 runtimeId 占位（schema 要求非空）
      sessionId: options.sessionPath || client.runtimeId,
      runtimeId: client.runtimeId,
      generation,
    };
    const forwarder = createForwarder(target, client);
    const record: RuntimeRecord = { client, ctx, sequence: 0, forwarder, target };

    client.on("event", (e: AgentEvent) => {
      if (!this.isCurrent(record)) return;
      // 「现在能不能安全地重启」的判据只认 pi 的这两个协议事件（UPD-004）。
      // 放在 isCurrent 之后：上一代 runtime 的迟到 agent_start 不该把
      // 更新安装拦在门外。
      if (e.type === "agent_start") agentActivity.markBusy(client.runtimeId);
      else if (e.type === "agent_settled") agentActivity.markSettled(client.runtimeId);
      // 文件类工具的执行登记成待审阅变更（FS-102）。放在转发**之前**：
      // before 快照必须在工具动手之前抓到，而 tool_execution_start 到达这里
      // 与到达渲染进程之间没有别的同步点。observeToolEvent 自己吞掉全部异常，
      // 一次记账失败不会让对话停下来。
      void observeToolEvent(e, {
        workspaceId: record.ctx.workspaceId,
        sessionId: record.ctx.sessionId,
        turnId: `${record.ctx.runtimeId}#${record.ctx.generation}`,
      });
      // 信封只生成一次：先喂给池观测者派生列表态，再原样转发。序号仍由
      // nextEnvelope 单调自增一次，转发行为与从前逐字节一致（AGT-101）。
      const env = this.nextEnvelope(record, e);
      this.poolObserver?.onEvent(env);
      forwarder.push(env);
      // provider 错误的归一化结论（MDL-101）。走**自己的通道**而不是改写
      // 上面那条事件：AgentEvent 的形状归 pi-sdk 所有，往里塞一个我们算出来
      // 的 kind，等于让契约对上游协议撒谎。归一失败不该让对话停下来 ——
      // 这一层只是加解释，原文那条路径一个字节都没改。
      const report = modelErrorFromAgentEvent(e);
      if (report) sendPush(target, PUSH_CHANNELS.piModelError, this.nextEnvelope(record, report));
    });
    client.on("ui_request", (r: ExtensionUiRequest) => {
      if (!this.isCurrent(record) || target.isDestroyed()) return;
      // 先登记再转发：渲染进程收到弹窗的下一刻就可能作答，此时挂起表里
      // 必须已经有这一条，否则合法回答会被判成 expired。
      this.uiHook?.(target.id, record.ctx.generation, r);
      sendPush(target, PUSH_CHANNELS.piUiRequest, this.nextEnvelope(record, r));
    });
    client.on("stderr", (text: string) => {
      // stderr 不单开 IPC 通道，但同样带上代际上下文进日志（OBS-001）。
      this.logger.warn("pi_stderr", {
        runtimeId: ctx.runtimeId,
        generation: ctx.generation,
        text: String(text).slice(0, 500),
      });
    });
    client.on("exit", (code: number | null, meta: PiExitMeta) => {
      // 上一代的 exit 绝不能打断新一代会话 —— RUN-002 的核心症状就在这一行。
      if (!this.isCurrent(record)) {
        this.logger.info("pi_stale_exit_dropped", {
          runtimeId: meta.runtimeId,
          generation: meta.generation,
          currentGeneration: this.generationCounter,
        });
        return;
      }
      forwarder.flush();
      // 崩溃退出携带的正文同样过一遍归一化：ENOENT / 鉴权 / provider 5xx
      // 三种崩法的下一步动作完全不同。主动停止（expected-stop）不产出报告。
      const exitReport = modelErrorFromExit({ reason: meta.reason, error: meta.error });
      if (exitReport) {
        sendPush(target, PUSH_CHANNELS.piModelError, this.nextEnvelope(record, exitReport));
      }
      sendPush(
        target,
        PUSH_CHANNELS.piExit,
        this.nextEnvelope(record, {
          code,
          reason: meta.reason,
          ...(meta.error ? { error: meta.error } : {}),
        })
      );
      // 池观测：当前代际退出。reason 区分主动停止与崩溃，由池自行判定
      // 是否计入崩溃预算。放在 forget 之前——forget 会摘索引，之后 ctx 还在。
      this.poolObserver?.onExit({ sessionId: record.ctx.sessionId, reason: meta.reason });
      this.forget(record);
    });

    client.start();
    this.byTarget.set(target.id, record);
    this.byRuntimeId.set(client.runtimeId, record);
    this.latest = {
      runtimeId: client.runtimeId,
      generation,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
    };
    this.logger.info("pi_runtime_launched", {
      runtimeId: client.runtimeId,
      generation,
      protocolVersion: PROTOCOL_VERSION,
    });
    return { client, handle: this.latest };
  }

  /** 握手拿到真实 sessionId 后回填，之后的信封才带得上正确的会话标识。 */
  adoptSession(runtimeId: string, sessionId: string | undefined): void {
    if (!sessionId) return;
    const record = this.byRuntimeId.get(runtimeId);
    if (!record) return;
    record.ctx.sessionId = sessionId;
    if (this.latest?.runtimeId === runtimeId) this.latest.sessionId = sessionId;
    // 真实 sessionId 到手才登记进池：此前 ctx.sessionId 还是占位（runtimeId /
    // sessionPath），用它做池的键会与后续事件的键对不上。
    this.poolObserver?.onAdopt({
      sessionId,
      workspaceId: record.ctx.workspaceId,
      runtimeId: record.ctx.runtimeId,
      generation: record.ctx.generation,
    });
  }

  async start(options: PiRuntimeStartOptions & { spawn?: PiSpawn }): Promise<PiRuntimeHandle> {
    if (!this.boundTarget) throw new Error("PiSupervisor 尚未 bindTarget");
    if (!options.spawn) throw new Error("PiSupervisor.start 需要 spawn 配置");
    return this.launch(this.boundTarget, { ...options, spawn: options.spawn }).handle;
  }

  async stop(runtimeId: string): Promise<void> {
    const record = this.byRuntimeId.get(runtimeId);
    if (!record) return;
    this.forget(record);
    await record.client.stop();
  }

  /** 按 webContents 停掉当前 runtime（窗口关闭 / 重启 runtime 时调用）。 */
  disposeTarget(targetId: number): void {
    const record = this.byTarget.get(targetId);
    if (!record) return;
    this.forget(record);
    void record.client.stop();
  }

  async dispose(): Promise<void> {
    const records = [...this.byRuntimeId.values()];
    this.byRuntimeId.clear();
    this.byTarget.clear();
    for (const record of records) record.forwarder.dispose();
    await Promise.all(records.map((r) => r.client.stop().catch(() => undefined)));
  }

  // ---------- 内部 ----------

  /** 只有当前代际的记录才有资格向渲染进程推送。 */
  private isCurrent(record: RuntimeRecord): boolean {
    return this.byRuntimeId.get(record.ctx.runtimeId) === record;
  }

  private nextEnvelope<T>(record: RuntimeRecord, payload: T): PiEnvelope<T> {
    return wrapEnvelope(record.ctx, record.sequence++, payload);
  }

  private forget(record: RuntimeRecord): void {
    // 先摘索引再 dispose：dispose 会触发 removeAllListeners，此时 exit 回调
    // 可能还在栈上，isCurrent 必须已经返回 false。
    if (this.byTarget.get(record.target.id) === record) {
      this.byTarget.delete(record.target.id);
    }
    this.byRuntimeId.delete(record.ctx.runtimeId);
    // runtime 没了就一定不忙了。漏掉这一行的话，一次崩溃会把 busy 永久钉住，
    // 用户从此再也装不上更新，而界面上没有任何线索。
    agentActivity.forget(record.ctx.runtimeId);
    record.forwarder.dispose();
  }
}

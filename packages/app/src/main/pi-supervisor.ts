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

  constructor(private readonly logger: SupervisorLogger = NOOP_LOGGER) {}

  setUiHook(
    hook: (targetId: number, generation: number, request: ExtensionUiRequest) => void
  ): void {
    this.uiHook = hook;
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
      forwarder.push(this.nextEnvelope(record, e));
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
      sendPush(
        target,
        PUSH_CHANNELS.piExit,
        this.nextEnvelope(record, {
          code,
          reason: meta.reason,
          ...(meta.error ? { error: meta.error } : {}),
        })
      );
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

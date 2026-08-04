/**
 * 后台会话池的**真实进程派生** host（AGT-102，落地 AGT-101 §7 的第一个接线点）。
 *
 * AGT-101 里 `PoolRuntimeHost.launch/stop` 是记账占位（后台派生留空）。本文件把
 * 它落地成真实的后台 pi 子进程派生：**每个后台/子会话一个独立 runtime**，复用
 * `pi-launcher` 的 `buildPiSpawn` spawn 机制与 `@pibuddy/pi-sdk` 的 `PiRpcClient`。
 *
 * ## 与前台 supervisor 的分工
 *
 * 前台活跃会话仍走既有 `pi:start` → `PiSupervisor.launch(webContents,…)` 那条零
 * 回归的老路（推流到窗口、33ms 合批、扩展 UI 挂起表）。本 host 只管**后台**会话：
 * 它们没有对应窗口，事件不推给任何 webContents，而是直接喂进池内核（列表态 /
 * 未读 / 成本 / 崩溃预算）与——对 origin:"child" 的会话——child 编排的结构化消息
 * 汇聚点。两条路各起各的进程、各喂各的观测者，互不串台。
 *
 * ## 为什么 client 工厂可注入
 *
 * 真实 spawn 需要 electron 的 `app.isPackaged` 与内置 pi 运行时；而「launch 真的
 * 起了一个进程并把会话喂进了池」这件事必须能在单测里证伪。因此 client 工厂可注入：
 * 生产用 `PiRpcClient` + `buildPiSpawn`，单测注入一个受控假 client，投喂事件 / 退出
 * 来断言池状态随之变化——这是本接线点的可证伪落点。
 *
 * ## 边界
 *
 * 本文件在 `main/agent-pool/**`（池域，非 pi 域）。它 import `pi-launcher.js`
 * （PI_DOMAIN_MEMBER，但相对说明符不含 `pi/`，不触 kernel-boundary 的
 * 「内核模块不得 import pi 域」判据），**不** import `main/pi/**` 的任何模块。
 */
import { app } from "electron";
import { PiRpcClient, type AgentEvent, type PiExitMeta } from "@pibuddy/pi-sdk";
import {
  wrapEnvelope,
  type EnvelopeContext,
  type PiEnvelope,
} from "@pibuddy/contract";

import { log } from "../log.js";
import { buildPiSpawn, verifyRuntimeHandshake } from "../pi-launcher.js";
import { resolveSessionDir } from "../sessions/session-dir.js";
import { loadSettings } from "../settings.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import type { PoolLaunchRequest, PoolRuntimeHost } from "./pool-core.js";

/**
 * 一个真实后台 runtime 需要的最小 client 面（`PiRpcClient` 的子集）。
 *
 * 抽成接口是为了让单测注入受控假 client——不必给 electron / pi spawn 打桩。
 */
export interface PoolRuntimeClient {
  readonly runtimeId: string;
  start(): void;
  stop(): Promise<void> | void;
  getState(): Promise<{ sessionId?: string }>;
  send(message: unknown): Promise<unknown> | unknown;
  on(event: "event", cb: (e: AgentEvent) => void): void;
  on(event: "exit", cb: (code: number | null, meta: PiExitMeta) => void): void;
  on(event: "stderr", cb: (text: string) => void): void;
}

/** 派生一个后台 runtime 的参数（已解出真实 cwd）。 */
export interface PoolRuntimeSpawnSpec {
  sessionId: string;
  workspaceId: string | null;
  cwd: string;
  sessionDir: string;
  generation: number;
}

export type PoolRuntimeClientFactory = (spec: PoolRuntimeSpawnSpec) => PoolRuntimeClient;

/**
 * 生产用工厂：`buildPiSpawn` + `PiRpcClient`，与前台 supervisor 同一 spawn 机制。
 *
 * 后台会话的 trust 走空覆盖（`trustArgs:[]`）：让 pi 自己读 trust.json——后台子
 * 会话所在工作区在前台会话启动时已决定过信任，不重复表达（两处表达同一件事
 * 必然有对不上的时候，与前台同口径）。
 */
const realClientFactory: PoolRuntimeClientFactory = (spec) => {
  const settings = loadSettings();
  const spawn = buildPiSpawn({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    settings,
    logger: log(),
    trustArgs: [],
  });
  verifyRuntimeHandshake(spawn.runtime, log());
  return new PiRpcClient({
    spawn,
    cwd: spec.cwd,
    sessionDir: spec.sessionDir,
    generation: spec.generation,
  }) as unknown as PoolRuntimeClient;
};

interface RuntimeRecord {
  client: PoolRuntimeClient;
  ctx: EnvelopeContext;
  sequence: number;
  origin: "user" | "child";
}

/** 池内核侧的回调（由 pool.ts 装配时接上，避免 host ↔ pool 的构造期循环）。 */
export interface PoolHostSink {
  /** runtime 就绪：回填 runtimeId / generation（不改前台聚焦）。 */
  onReady(sessionId: string, info: { runtimeId: string; generation: number }): void;
  /** 一条已包信封的事件流过（派生列表态 / 成本 / 未读）。 */
  onEvent(envelope: PiEnvelope<AgentEvent>): void;
  /** 当前 runtime 退出（reason 区分主动停止与崩溃）。 */
  onExit(sessionId: string, reason: string): void;
}

/** 子 Agent 结构化事件汇聚（仅 origin:"child" 的会话；由 child 编排注册）。 */
export type ChildEventSink = (sessionId: string, event: AgentEvent) => void;

/** 子 runtime 就绪通知（仅 origin:"child"；child 编排据此下发目标提示词）。 */
export type ChildReadySink = (sessionId: string) => void;

/**
 * 前台 supervisor 的回退网关（由 **pi 域**在装配期注入，本文件不 import pi 域）。
 *
 * deliver / stop 的目标会话若不是池派生的后台 runtime，而恰好是前台 supervisor
 * 当前的活跃会话（单窗口单活跃 runtime 那条老路），就经此网关路由过去——
 * remote 的「发 prompt / 停止」因此也够得着前台会话，而 remote 域一行不改。
 *
 * 恒以 `activeSessionId()` 精确匹配为门：网关只对**此刻**前台活跃的那个会话
 * 生效，绝不把别的会话的投递误路由到前台进程上。
 */
export interface ForegroundGateway {
  /** 前台 supervisor 当前活跃会话的 sessionId；无活跃 runtime 时 null。 */
  activeSessionId(): string | null;
  /** 向前台活跃会话发一条提示词。 */
  deliver(text: string): void;
  /** 停止前台活跃会话（等价于用户在窗口里点「停止」）。 */
  stop(): void;
}

/**
 * 单个后台 runtime 的观察者（tasks 触发这类一次性驱动方用）。
 *
 * 与 childEventSink 的差别：child 汇聚是**全局**的、按 origin 过滤；tap 按
 * sessionId 挂，谁派生谁观察，互不相扰。每会话至多一个 tap。
 */
export interface RuntimeTap {
  /** 握手完成。`realSessionId` 是 pi 侧真实会话 id（会话历史用它定位）。 */
  onReady?(realSessionId: string | null): void;
  onEvent?(event: AgentEvent): void;
  onExit?(reason: string): void;
}

/** 把不透明 workspaceId 解成真实工作目录（可注入，便于单测）。 */
export type WorkspaceResolver = (workspaceId: string | null) => { cwd: string; sessionDir: string };

const realWorkspaceResolver: WorkspaceResolver = (workspaceId) => {
  // workspaceId 为空时无从解出工作目录——后台会话必须绑定一个工作区。
  const root = requireWorkspaceRoot(workspaceId ?? "");
  return { cwd: root, sessionDir: resolveSessionDir(root, loadSettings()) };
};

export interface PoolRuntimeHostOptions {
  clientFactory?: PoolRuntimeClientFactory;
  resolveWorkspace?: WorkspaceResolver;
}

/**
 * 真实后台派生 host。单例，持有全部后台 runtime 的索引。
 */
export class PoolRuntimeHostImpl implements PoolRuntimeHost {
  private runtimes = new Map<string, RuntimeRecord>();
  private generationCounter = 0;
  private sink: PoolHostSink | null = null;
  private childEventSink: ChildEventSink | null = null;
  private childReadySink: ChildReadySink | null = null;
  private foreground: ForegroundGateway | null = null;
  private taps = new Map<string, RuntimeTap>();
  private readonly clientFactory: PoolRuntimeClientFactory;
  private readonly resolveWorkspace: WorkspaceResolver;

  constructor(options: PoolRuntimeHostOptions = {}) {
    this.clientFactory = options.clientFactory ?? realClientFactory;
    this.resolveWorkspace = options.resolveWorkspace ?? realWorkspaceResolver;
  }

  /** 装配期接上池内核回调。 */
  bind(sink: PoolHostSink): void {
    this.sink = sink;
  }

  /** child 编排注册结构化事件汇聚（只收 origin:"child" 的会话事件）。 */
  setChildEventSink(sink: ChildEventSink | null): void {
    this.childEventSink = sink;
  }

  /** child 编排注册子 runtime 就绪通知（据此下发目标提示词）。 */
  setChildReadySink(sink: ChildReadySink | null): void {
    this.childReadySink = sink;
  }

  /** pi 域装配期注入前台回退网关（不装时行为与从前一字不差）。 */
  setForegroundGateway(gateway: ForegroundGateway | null): void {
    this.foreground = gateway;
  }

  /**
   * 观察某会话的后台 runtime（就绪 / 事件 / 退出）。返回解除函数。
   *
   * 允许在 launch 之前挂（tasks 触发先挂 tap 再 requestSession，会话可能先
   * 排队后派生，不能有「挂晚了漏掉 ready」的窗口）。每会话至多一个 tap。
   */
  observeRuntime(sessionId: string, tap: RuntimeTap): () => void {
    this.taps.set(sessionId, tap);
    return () => {
      if (this.taps.get(sessionId) === tap) this.taps.delete(sessionId);
    };
  }

  /**
   * 派生一个后台 runtime。**同步返回**（与 host 契约一致）：spawn 之后的握手
   * 走一个不阻塞的异步尾巴，握手拿到状态才回填 onReady。
   */
  launch(req: PoolLaunchRequest): void {
    // 已有则先停掉旧的（避免同 sessionId 双 runtime）。**只停池内 runtime**：
    // 这里绝不能走带前台回退的 stop()——重新派生一个恰与前台同名的会话时，
    // 回退会把用户正在看的 supervisor runtime 误杀掉。
    this.stopPoolRuntime(req.sessionId);

    let cwd: string;
    let sessionDir: string;
    try {
      ({ cwd, sessionDir } = this.resolveWorkspace(req.workspaceId));
    } catch (err) {
      log().warn("agent_pool_launch_resolve_failed", {
        sessionId: req.sessionId,
        workspaceId: req.workspaceId,
        detail: err instanceof Error ? err.message : String(err),
      });
      // 起不来当成一次崩溃反馈给池：池的崩溃预算据此处置，不留一个卡在
      // background 却没有进程的幽灵会话。
      this.sink?.onExit(req.sessionId, "crash");
      this.taps.get(req.sessionId)?.onExit?.("crash");
      return;
    }

    const generation = ++this.generationCounter;
    let client: PoolRuntimeClient;
    try {
      client = this.clientFactory({
        sessionId: req.sessionId,
        workspaceId: req.workspaceId,
        cwd,
        sessionDir,
        generation,
      });
    } catch (err) {
      log().warn("agent_pool_launch_spawn_failed", {
        sessionId: req.sessionId,
        detail: err instanceof Error ? err.message : String(err),
      });
      this.sink?.onExit(req.sessionId, "crash");
      this.taps.get(req.sessionId)?.onExit?.("crash");
      return;
    }

    const ctx: EnvelopeContext = {
      workspaceId: req.workspaceId ?? cwd,
      sessionId: req.sessionId,
      runtimeId: client.runtimeId,
      generation,
    };
    const record: RuntimeRecord = { client, ctx, sequence: 0, origin: req.origin };
    this.runtimes.set(req.sessionId, record);

    client.on("event", (e: AgentEvent) => {
      if (this.runtimes.get(req.sessionId) !== record) return; // 陈旧代际
      const env = wrapEnvelope(record.ctx, record.sequence++, e);
      this.sink?.onEvent(env);
      if (record.origin === "child") this.childEventSink?.(req.sessionId, e);
      this.taps.get(req.sessionId)?.onEvent?.(e);
    });
    client.on("stderr", (text: string) => {
      log().warn("agent_pool_child_stderr", {
        sessionId: req.sessionId,
        runtimeId: record.ctx.runtimeId,
        text: String(text).slice(0, 500),
      });
    });
    client.on("exit", (_code: number | null, meta: PiExitMeta) => {
      if (this.runtimes.get(req.sessionId) !== record) return;
      this.runtimes.delete(req.sessionId);
      this.sink?.onExit(req.sessionId, meta.reason);
      this.taps.get(req.sessionId)?.onExit?.(meta.reason);
    });

    client.start();
    log().info("agent_pool_runtime_launched", {
      sessionId: req.sessionId,
      runtimeId: client.runtimeId,
      generation,
      origin: req.origin,
    });

    // 握手：拿到真实 sessionId 只用于回填 runtime 索引与就绪回调；池的键仍是
    // 不透明的 pool sessionId（req.sessionId），事件信封也一律用它，保证与
    // requestSession 时登记的键一致。
    void (async () => {
      try {
        const state = await client.getState();
        if (this.runtimes.get(req.sessionId) !== record) return;
        this.sink?.onReady(req.sessionId, { runtimeId: client.runtimeId, generation });
        if (record.origin === "child") this.childReadySink?.(req.sessionId);
        this.taps.get(req.sessionId)?.onReady?.(state.sessionId ?? null);
      } catch (err) {
        log().warn("agent_pool_runtime_handshake_failed", {
          sessionId: req.sessionId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  /** 停掉某会话的**池内** runtime（有则停并返回 true；没有不碰任何回退）。 */
  private stopPoolRuntime(sessionId: string): boolean {
    const record = this.runtimes.get(sessionId);
    if (!record) return false;
    this.runtimes.delete(sessionId);
    void Promise.resolve(record.client.stop()).catch(() => undefined);
    log().info("agent_pool_runtime_stopped", { sessionId, runtimeId: record.ctx.runtimeId });
    return true;
  }

  /**
   * 停一个 runtime 的进程。
   *
   * 三分支路由：池派生的后台 runtime → 真停子进程；不在池里但命中前台
   * supervisor 当前活跃会话 → 经注入的前台网关停（remote 停前台会话走到这）；
   * 都不中 → 无事可做（会话本就没有进程），记一条日志便于诊断。
   */
  stop(sessionId: string): void {
    if (!this.stopPoolRuntime(sessionId)) {
      if (this.foreground?.activeSessionId() === sessionId) {
        this.foreground.stop();
        log().info("agent_pool_stop_foreground_fallback", { sessionId });
      } else {
        log().info("agent_pool_stop_no_runtime", { sessionId });
      }
    }
    this.taps.get(sessionId)?.onExit?.("expected-stop");
  }

  /**
   * 向一个会话发一条提示词（子 Agent 的目标下发 / 父回答续发 / remote 发话）。
   *
   * 三分支路由：池派生的后台 runtime → 走池 client；不在池里但命中前台
   * supervisor 当前活跃会话 → 经注入的前台网关投递；都不中 → 丢弃并返回
   * false（会话已停，投不出去不能装作投出去了）。
   */
  deliver(sessionId: string, text: string): boolean {
    const record = this.runtimes.get(sessionId);
    if (!record) {
      if (this.foreground?.activeSessionId() === sessionId) {
        this.foreground.deliver(text);
        return true;
      }
      log().warn("agent_pool_deliver_no_runtime", { sessionId });
      return false;
    }
    void Promise.resolve(record.client.send({ type: "prompt", message: text })).catch((err) => {
      log().warn("agent_pool_deliver_failed", {
        sessionId,
        detail: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

  /**
   * 向某个**池派生**的后台会话发一条任意 RPC 命令并等响应（tasks 触发用它
   * 下发冻结的 set_model / 收尾拉 get_session_stats）。无活跃 runtime 时 reject。
   */
  send(sessionId: string, message: unknown): Promise<unknown> {
    const record = this.runtimes.get(sessionId);
    if (!record) return Promise.reject(new Error(`会话无活跃后台 runtime：${sessionId}`));
    return Promise.resolve(record.client.send(message));
  }

  /** 是否存在某会话的活跃后台 runtime。 */
  has(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /** 停掉全部后台 runtime（应用退出）。 */
  stopAll(): void {
    for (const id of [...this.runtimes.keys()]) this.stop(id);
  }
}

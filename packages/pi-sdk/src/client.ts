import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { attachJsonlReader, type JsonlReaderHandle } from "./jsonl.js";
import { JsonlOverflowError, RpcAbortedError, RpcTimeoutError } from "./errors.js";
import { toAgentEvent } from "./types.js";
import type {
  AgentEvent,
  AgentState,
  AgentMessage,
  CommandInfo,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ImageContent,
  Model,
  RpcCommandBase,
  RpcResponse,
  SessionStats,
  StreamingBehavior,
  ThinkingLevel,
} from "./types.js";

export interface PiSpawn {
  /** 可执行文件（如 node / electron / pi.cmd） */
  command: string;
  /** 置于 pi 参数之前的参数（如 cli.js 路径） */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** 通过 shell 启动（Windows 上运行 .cmd 时需要） */
  shell?: boolean;
  /**
   * 追加在 `--mode rpc` 之后的启动参数。
   *
   * 目前唯一的用途是 project trust 的一次性覆盖（`-a` / `-na`，见
   * pi docs/security.md:30）：RPC 模式不弹 trust 提示，PiBuddy 自己问完
   * 用户之后，把结论作为本次运行的参数传下去。**不是**通用的命令行入口：
   * 值只由主进程的 buildPiSpawn 组装，渲染进程无法影响它。
   */
  args?: string[];
}

export interface PiClientOptions {
  spawn: PiSpawn;
  cwd: string;
  /** 恢复指定会话文件 */
  session?: string;
  /**
   * 会话 jsonl 的存放目录（pi 的 --session-dir）。
   *
   * 必须由调用方显式给出：不传的话 pi 按自己那套 env + cwd 编码去推断，
   * 主进程枚举列表时又按另一套推断，两条独立路径必然漂移（SES-001）。
   */
  sessionDir?: string;
  sessionName?: string;
  noSession?: boolean;
  provider?: string;
  model?: string;
  extraArgs?: string[];
  /** 代际：由 supervisor 分配，每次 start 单调 +1，永不复用 */
  generation?: number;
}

/** 默认 RPC 超时。pi 的长任务由事件流推进，单条命令不该等这么久还没回。 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** 写队列上限：对端 stdin 长时间不排空时止损，而不是无界堆积。 */
const MAX_WRITE_QUEUE = 1000;

/** 有界诊断环的容量。 */
const MAX_DIAGNOSTICS = 200;

/** stop() 四级阶梯各级的等待上限。 */
const STOP_ABORT_MS = 1500;
const STOP_STDIN_MS = 1000;
const STOP_SIGTERM_MS = 3000;

/**
 * 运行时相位。
 *
 * 与 `running`（看 proc.exitCode 的瞬时事实）不同，phase 是**意图**：
 * 它区分「用户主动停」与「进程自己死了」，这正是 RUN-002 里
 * 「刚启动成功的新会话被旧进程的 exit 打成 started=false」的根因。
 */
export type RuntimePhase =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "recovering";

/** 合法相位转换表。表外的转换都是状态机 bug，不是可容忍的边界情况。 */
export const ALLOWED_TRANSITIONS: Record<RuntimePhase, readonly RuntimePhase[]> = {
  idle: ["starting"],
  starting: ["running", "stopping", "stopped", "crashed"],
  running: ["stopping", "stopped", "crashed"],
  stopping: ["stopped", "crashed"],
  stopped: ["recovering"],
  crashed: ["recovering"],
  recovering: ["starting", "stopped"],
};

export type ExitReason = "expected-stop" | "crash";

export interface PiExitMeta {
  reason: ExitReason;
  runtimeId: string;
  generation: number;
  /** 崩溃时的原始错误文本（ENOENT 等），供 UI 显示真因 */
  error?: string;
}

export interface PiDiagnostic {
  at: number;
  kind:
    | "illegal-transition"
    | "malformed-line"
    | "orphan-response"
    | "duplicate-response"
    | "jsonl-overflow"
    | "stdin-error"
    | "write-overflow";
  detail: string;
}

interface Pending {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  /** 清掉 timeout timer 与 abort 监听，任何结束路径都必须调用 */
  dispose: () => void;
}

export declare interface PiRpcClient {
  on(event: "event", listener: (e: AgentEvent) => void): this;
  on(event: "ui_request", listener: (r: ExtensionUiRequest) => void): this;
  on(event: "stderr", listener: (text: string) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, meta: PiExitMeta) => void
  ): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * pi RPC 客户端：spawn `pi --mode rpc`，stdin 写命令，stdout 读响应与事件。
 * 集成方式与 @openai/codex-sdk 对 codex CLI 的封装一致。
 */
export class PiRpcClient extends EventEmitter {
  /** 一次子进程实例的唯一标识，构造即固定，永不复用。 */
  readonly runtimeId = randomUUID();
  /** 代际：supervisor 分配，用于下游丢弃上一代的迟到事件。 */
  readonly generation: number;
  readonly options: PiClientOptions;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: JsonlReaderHandle | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderrTail: string[] = [];
  private phaseValue: RuntimePhase = "idle";
  private terminated = false;
  private stoppedByUser = false;
  private writeQueue: string[] = [];
  private writing = false;
  private diagnostics: PiDiagnostic[] = [];
  /** spawn 失败（ENOENT 等）的原始错误。clientFor 靠它把真因透出到 UI。 */
  private spawnError: Error | null = null;

  constructor(options: PiClientOptions) {
    super();
    this.options = options;
    this.generation = options.generation ?? 0;
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  get phase(): RuntimePhase {
    return this.phaseValue;
  }

  get lastSpawnError(): Error | null {
    return this.spawnError;
  }

  /** 最近的 stderr 尾巴（已按行截断），供错误提示与日志使用。 */
  get stderrSnapshot(): string {
    return this.stderrTail.join("").slice(-500);
  }

  recentDiagnostics(): readonly PiDiagnostic[] {
    return this.diagnostics;
  }

  /**
   * 相位迁移。非法转换在非生产环境直接抛错 —— 状态机被写错时越早炸越好，
   * 生产环境降级为一条诊断记录，不影响用户正在进行的对话。
   *
   * 公开是为了让 supervisor 与状态机单测能驱动它，业务代码不应直接调用。
   */
  transition(next: RuntimePhase): void {
    const from = this.phaseValue;
    if (from === next) return;
    if (!ALLOWED_TRANSITIONS[from].includes(next)) {
      const detail = `非法状态转换：${from} → ${next}`;
      this.recordDiagnostic("illegal-transition", detail);
      if (process.env.NODE_ENV !== "production") throw new Error(detail);
      return;
    }
    this.phaseValue = next;
  }

  private recordDiagnostic(kind: PiDiagnostic["kind"], detail: string): void {
    this.diagnostics.push({ at: Date.now(), kind, detail });
    if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift();
  }

  /**
   * 供上层（ipc 的 clientFor）使用：不可用时抛出**带真因**的错误。
   * 早先这里只抛「智能体尚未启动」，把 ENOENT 之类的真实原因整个吞掉。
   */
  assertUsable(): void {
    if (this.running && this.phaseValue === "running") return;
    const cause =
      this.spawnError?.message ??
      (this.stderrSnapshot || `运行时不可用（phase=${this.phaseValue}）`);
    throw new Error(`智能体运行时不可用：${cause}`);
  }

  start(): void {
    if (this.proc) throw new Error("PiRpcClient already started");
    this.transition("starting");
    const o = this.options;
    // spawn.args 在 --mode rpc 之后、会话参数之前展开：trust 覆盖参数
    // （-a / -na）是整次运行的属性，与具体会话无关。
    const args = [...(o.spawn.prefixArgs ?? []), "--mode", "rpc", ...(o.spawn.args ?? [])];
    if (o.session) args.push("--session", o.session);
    if (o.sessionDir) args.push("--session-dir", o.sessionDir);
    if (o.sessionName) args.push("--name", o.sessionName);
    if (o.noSession) args.push("--no-session");
    if (o.provider) args.push("--provider", o.provider);
    if (o.model) args.push("--model", o.model);
    if (o.extraArgs) args.push(...o.extraArgs);

    const proc = spawn(o.spawn.command, args, {
      cwd: o.cwd,
      env: o.spawn.env ?? process.env,
      shell: o.spawn.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // 非 Windows 下建独立进程组，stop() 末级才能整棵树 kill。
      detached: process.platform !== "win32",
    });
    this.proc = proc;
    this.transition("running");

    this.reader = attachJsonlReader(
      proc.stdout,
      (line) => this.handleLine(line),
      (err: JsonlOverflowError) => {
        this.recordDiagnostic("jsonl-overflow", err.message);
        this.emit("stderr", `${err.message}\n`);
      }
    );

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail.push(text);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit("stderr", text);
    });

    // stdin 在对端已死时写入会触发 EPIPE。不挂监听 = 进程级 uncaught error。
    proc.stdin.on("error", (err: Error) => {
      this.recordDiagnostic("stdin-error", err.message);
    });

    proc.on("error", (err) => {
      // ENOENT 实测只走 error → close，exit 事件从不触发。
      this.spawnError = err;
      this.settleTermination(null, err);
    });
    proc.on("exit", (code) => this.settleTermination(code, null));
    proc.on("close", (code) => this.settleTermination(code, null));
  }

  /**
   * 终局收敛：error / exit / close 三条路径都汇到这里，靠 terminated 保证
   * `exit` 事件**恰好** emit 一次（ENOENT 场景没有 exit，crash 场景 exit 与
   * close 都会来）。
   */
  private settleTermination(code: number | null, err: Error | null): void {
    if (this.terminated) return;
    this.terminated = true;

    const reason: ExitReason =
      this.stoppedByUser || this.phaseValue === "stopping"
        ? "expected-stop"
        : "crash";
    this.transition(reason === "expected-stop" ? "stopped" : "crashed");

    this.reader?.detach();
    this.reader = null;
    this.writeQueue = [];
    this.proc = null;

    const detail = err?.message ?? "";
    this.failAll(
      new Error(
        `pi 进程已退出 (code=${code})` +
          (detail ? `: ${detail}` : "") +
          (this.stderrTail.length ? `: ${this.stderrSnapshot}` : "")
      )
    );

    this.emit("exit", code, {
      reason,
      runtimeId: this.runtimeId,
      generation: this.generation,
      ...(detail ? { error: detail } : {}),
    } satisfies PiExitMeta);
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      this.recordDiagnostic("malformed-line", line.slice(0, 200));
      return;
    }
    if (obj.type === "response") {
      const resp = obj as unknown as RpcResponse;
      if (resp.id && this.pending.has(resp.id)) {
        const p = this.pending.get(resp.id)!;
        this.pending.delete(resp.id);
        p.dispose();
        p.resolve(resp);
        return;
      }
      if (resp.id) {
        this.recordDiagnostic("orphan-response", `id=${resp.id}`);
      }
      // 无 id 的响应也作为事件透出，便于调试
      this.emit("event", toAgentEvent(obj));
      return;
    }
    if (obj.type === "extension_ui_request") {
      this.emit("ui_request", obj as unknown as ExtensionUiRequest);
      return;
    }
    this.emit("event", toAgentEvent(obj));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      p.dispose();
      p.reject(err);
    }
    this.pending.clear();
  }

  private assertWritable(force: boolean): void {
    if (!this.proc || this.proc.exitCode !== null) {
      throw new Error(
        this.spawnError ? `pi 进程未运行：${this.spawnError.message}` : "pi 进程未运行"
      );
    }
    if (!force && (this.phaseValue === "stopping" || this.terminated)) {
      throw new Error("运行时正在停止，已拒绝新命令");
    }
  }

  private write(obj: unknown, force = false): void {
    this.assertWritable(force);
    if (this.writeQueue.length >= MAX_WRITE_QUEUE) {
      this.recordDiagnostic("write-overflow", `queue=${this.writeQueue.length}`);
      throw new Error("stdin 写队列已满，pi 进程可能已无响应");
    }
    this.writeQueue.push(JSON.stringify(obj) + "\n");
    void this.pumpWrites();
  }

  /**
   * 串行泵出写队列并处理背压：stdin.write 返回 false 说明内核缓冲已满，
   * 必须等 drain 再继续，否则 Node 会在用户态无界缓冲。
   */
  private async pumpWrites(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.writeQueue.length > 0) {
        const proc = this.proc;
        if (!proc || proc.stdin.destroyed || proc.exitCode !== null) break;
        const chunk = this.writeQueue.shift()!;
        if (!proc.stdin.write(chunk)) await once(proc.stdin, "drain");
      }
    } catch (err) {
      this.recordDiagnostic("stdin-error", (err as Error).message);
    } finally {
      this.writing = false;
    }
  }

  /**
   * 发送任意 RPC 命令并等待对应响应。
   *
   * id 以 runtimeId 为前缀：跨代际重启后序号从 1 重来，若不带前缀，上一代
   * 的迟到 response 会被新一代的 pending 认领。
   */
  send<T = unknown>(
    command: RpcCommandBase,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RpcResponse<T>> {
    return this.sendInternal<T>(command, opts, false);
  }

  private sendInternal<T>(
    command: RpcCommandBase,
    opts: { timeoutMs?: number; signal?: AbortSignal } | undefined,
    force: boolean
  ): Promise<RpcResponse<T>> {
    const id = command.id ?? `${this.runtimeId}:${++this.seq}`;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    return new Promise<RpcResponse<T>>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const signal = opts?.signal;
      const onAbort = (): void => {
        this.pending.delete(id);
        dispose();
        reject(new RpcAbortedError(id, command.type));
      };
      const dispose = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal?.aborted) {
        reject(new RpcAbortedError(id, command.type));
        return;
      }

      timer = setTimeout(() => {
        // 超时后必须把 pending 删掉，否则迟到的 response 会走 orphan 分支
        // 同时这条记录会永久占住 map（RUN-003 的「请求永久悬挂」）。
        this.pending.delete(id);
        dispose();
        reject(new RpcTimeoutError(id, timeoutMs, command.type));
      }, timeoutMs);
      // 别让一个在途 RPC 吊住 Node 进程退出。
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: resolve as (r: RpcResponse) => void,
        reject,
        dispose,
      });
      try {
        this.write({ ...command, id }, force);
      } catch (err) {
        this.pending.delete(id);
        dispose();
        reject(err as Error);
      }
    });
  }

  /** 发送命令，失败（success:false）时抛错 */
  async invoke<T = unknown>(
    command: RpcCommandBase,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T> {
    const resp = await this.send<T>(command, opts);
    if (!resp.success) {
      throw new Error(resp.error ?? `命令 ${command.type} 执行失败`);
    }
    return resp.data as T;
  }

  /**
   * 回答一条扩展弹窗。**返回 false 表示这次回答没有送出去**。
   *
   * 早先这里是 `void` 并直接 `this.write(response)`：进程已经退出时
   * assertWritable 抛错，而唯一的调用点没有 try/catch，于是它变成一条
   * 未处理的 promise rejection —— 用户看到的是「点了确定，弹窗关了，
   * 助手那边什么都没发生」，日志里也只有一条无人认领的 rejection。
   *
   * 改成返回布尔而不是继续抛错，是因为「对端已经不在了」在这条路径上是
   * **正常情况**：上游带 timeout 的 dialog 到期会自行 auto-resolve，此后
   * 任何回答都注定无人接收。调用方据返回值给用户一句解释即可。
   */
  respondUi(response: ExtensionUiResponse): boolean {
    if (!this.running || this.terminated) return false;
    try {
      this.write(response);
      return true;
    } catch (err) {
      this.recordDiagnostic("stdin-error", (err as Error).message);
      return false;
    }
  }

  // ---------- 常用命令封装 ----------

  prompt(
    message: string,
    opts?: { images?: ImageContent[]; streamingBehavior?: StreamingBehavior }
  ): Promise<RpcResponse> {
    return this.send({
      type: "prompt",
      message,
      ...(opts?.images?.length ? { images: opts.images } : {}),
      ...(opts?.streamingBehavior ? { streamingBehavior: opts.streamingBehavior } : {}),
    });
  }

  steer(message: string, images?: ImageContent[]): Promise<RpcResponse> {
    return this.send({ type: "steer", message, ...(images?.length ? { images } : {}) });
  }

  followUp(message: string, images?: ImageContent[]): Promise<RpcResponse> {
    return this.send({ type: "follow_up", message, ...(images?.length ? { images } : {}) });
  }

  abort(): Promise<RpcResponse> {
    return this.send({ type: "abort" });
  }

  newSession(): Promise<RpcResponse> {
    return this.send({ type: "new_session" });
  }

  switchSession(sessionPath: string): Promise<RpcResponse> {
    return this.send({ type: "switch_session", sessionPath });
  }

  getState(): Promise<AgentState> {
    return this.invoke<AgentState>({ type: "get_state" });
  }

  getMessages(): Promise<{ messages: AgentMessage[] }> {
    return this.invoke<{ messages: AgentMessage[] }>({ type: "get_messages" });
  }

  getAvailableModels(): Promise<{ models: Model[] }> {
    return this.invoke<{ models: Model[] }>({ type: "get_available_models" });
  }

  setModel(provider: string, modelId: string): Promise<Model> {
    return this.invoke<Model>({ type: "set_model", provider, modelId });
  }

  getAvailableThinkingLevels(): Promise<{ levels: ThinkingLevel[] }> {
    return this.invoke<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" });
  }

  setThinkingLevel(level: ThinkingLevel): Promise<RpcResponse> {
    return this.send({ type: "set_thinking_level", level });
  }

  getSessionStats(): Promise<SessionStats> {
    return this.invoke<SessionStats>({ type: "get_session_stats" });
  }

  setSessionName(name: string): Promise<RpcResponse> {
    return this.send({ type: "set_session_name", name });
  }

  getCommands(): Promise<{ commands: CommandInfo[] }> {
    return this.invoke<{ commands: CommandInfo[] }>({ type: "get_commands" });
  }

  compact(customInstructions?: string): Promise<RpcResponse> {
    return this.send({
      type: "compact",
      ...(customInstructions ? { customInstructions } : {}),
    });
  }

  /** 等待进程真正终止，最多 ms 毫秒。已终止立即返回 true。 */
  private waitExit(ms: number): Promise<boolean> {
    if (this.terminated || !this.proc) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.off("exit", onExit);
        resolve(this.terminated);
      }, ms);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("exit", onExit);
    });
  }

  /**
   * 四级停止阶梯。每级都有独立超时，进程在任何一级正常退出都会提前收敛。
   *
   *   1. abort RPC（1500ms）  —— 让 pi 自己收尾，会话 jsonl 才能写完整
   *   2. stdin.end()（1000ms）—— 关闭输入即「收工」信号
   *   3. SIGTERM（3000ms）    —— 留足时间落盘
   *   4. 进程树强杀           —— Windows taskkill /T /F；其它平台杀进程组
   *
   * 永不 reject：调用方（ipc / afterEach）大多不会 await。
   */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.terminated) {
      this.stoppedByUser = true;
      return;
    }
    this.stoppedByUser = true;
    this.transition("stopping");

    // 1) graceful abort：让 pi 中断当前 turn。force=true 绕过「停止中拒收」。
    try {
      await Promise.race([
        this.sendInternal({ type: "abort" }, { timeoutMs: STOP_ABORT_MS }, true),
        new Promise((r) => setTimeout(r, STOP_ABORT_MS)),
      ]);
    } catch {
      /* abort 失败不影响后续阶梯 */
    }
    this.failAll(new Error("客户端已停止"));
    if (await this.waitExit(0)) return;

    // 2) 关 stdin
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    if (await this.waitExit(STOP_STDIN_MS)) return;

    // 3) SIGTERM
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (await this.waitExit(STOP_SIGTERM_MS)) return;

    // 4) 整棵进程树强杀
    killTree(proc.pid);
    await this.waitExit(1000);
  }
}

/**
 * 强杀进程树。
 *
 * Windows 没有进程组信号，SIGKILL 只会杀掉 pi 自己，它 spawn 出来的
 * shell / node 子进程会变孤儿继续占着工作目录，因此必须 taskkill /T。
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

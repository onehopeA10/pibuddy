import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { attachJsonlReader } from "./jsonl.js";
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
}

export interface PiClientOptions {
  spawn: PiSpawn;
  cwd: string;
  /** 恢复指定会话文件 */
  session?: string;
  sessionName?: string;
  noSession?: boolean;
  provider?: string;
  model?: string;
  extraArgs?: string[];
}

interface Pending {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
}

export declare interface PiRpcClient {
  on(event: "event", listener: (e: AgentEvent) => void): this;
  on(event: "ui_request", listener: (r: ExtensionUiRequest) => void): this;
  on(event: "stderr", listener: (text: string) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * pi RPC 客户端：spawn `pi --mode rpc`，stdin 写命令，stdout 读响应与事件。
 * 集成方式与 @openai/codex-sdk 对 codex CLI 的封装一致。
 */
export class PiRpcClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderrTail: string[] = [];
  readonly options: PiClientOptions;

  constructor(options: PiClientOptions) {
    super();
    this.options = options;
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  start(): void {
    if (this.proc) throw new Error("PiRpcClient already started");
    const o = this.options;
    const args = [...(o.spawn.prefixArgs ?? []), "--mode", "rpc"];
    if (o.session) args.push("--session", o.session);
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
    });
    this.proc = proc;

    attachJsonlReader(proc.stdout, (line) => this.handleLine(line));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail.push(text);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit("stderr", text);
    });

    proc.on("error", (err) => this.failAll(err));
    proc.on("exit", (code) => {
      this.failAll(
        new Error(
          `pi 进程已退出 (code=${code})${this.stderrTail.length ? `: ${this.stderrTail.join("").slice(-500)}` : ""}`
        )
      );
      this.proc = null;
      this.emit("exit", code);
    });
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // 忽略无法解析的输出
    }
    if (obj.type === "response") {
      const resp = obj as unknown as RpcResponse;
      if (resp.id && this.pending.has(resp.id)) {
        const p = this.pending.get(resp.id)!;
        this.pending.delete(resp.id);
        p.resolve(resp);
        return;
      }
      // 无 id 的响应也作为事件透出，便于调试
      this.emit("event", obj as AgentEvent);
      return;
    }
    if (obj.type === "extension_ui_request") {
      this.emit("ui_request", obj as unknown as ExtensionUiRequest);
      return;
    }
    this.emit("event", obj as AgentEvent);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private write(obj: unknown): void {
    if (!this.proc || this.proc.exitCode !== null) {
      throw new Error("pi 进程未运行");
    }
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** 发送任意 RPC 命令并等待对应响应 */
  send<T = unknown>(command: RpcCommandBase): Promise<RpcResponse<T>> {
    const id = command.id ?? `c${++this.seq}`;
    return new Promise<RpcResponse<T>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: RpcResponse) => void, reject });
      try {
        this.write({ ...command, id });
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** 发送命令，失败（success:false）时抛错 */
  async invoke<T = unknown>(command: RpcCommandBase): Promise<T> {
    const resp = await this.send<T>(command);
    if (!resp.success) {
      throw new Error(resp.error ?? `命令 ${command.type} 执行失败`);
    }
    return resp.data as T;
  }

  respondUi(response: ExtensionUiResponse): void {
    this.write(response);
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

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.failAll(new Error("客户端已停止"));
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3000);
    proc.once("exit", () => clearTimeout(killTimer));
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}

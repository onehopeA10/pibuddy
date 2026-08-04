/**
 * PTY 会话管理器（coding.terminal / PTY-101）——**不 import electron**。
 *
 * 整个终端能力包里，只有这一处真的会 spawn 一个 shell 子进程，因此所有关于
 * 「怎么安全地开终端」的纪律都收在这里：
 *
 *  1. **cwd 只接受主进程解析出的 canonical root**。渲染进程给的永远只是不透明
 *     workspaceId，真实工作目录由 terminal-ipc 用 requireWorkspaceRoot 解析后
 *     传进来——本类拿到的 `cwd` 已经是一个可信的绝对路径，绝不接受渲染进程
 *     给的路径字段（契约里压根没有这个字段）。
 *  2. **node-pty 懒加载**。用 createRequire 在 `open()` 首次被调到时才 require
 *     `node-pty`，而不是在模块加载期——这样仅仅 import 本模块（例如 drift test
 *     经装配点连带 import 到）不会去加载原生 .node，也不会 spawn 任何进程。
 *     打包后 `require("node-pty")` 从 app.asar/node_modules 解析，其预编译
 *     `.node` 由 electron-builder 的 asarUnpack 外置到 app.asar.unpacked，
 *     Electron 的 asar 层自动重定向（与 convert-worker 同一套机制）。
 *  3. **输出有界 + 分帧下发 + 可拆卸**。每个 tab 一份有界 ring buffer；node-pty
 *     的 onData 频繁触发，这里按帧（FLUSH_INTERVAL_MS）合并成一段一段的 chunk
 *     再经 emitter 下发，避免一次 `npm install` 把几万条 IPC 消息灌进渲染进程
 *     （这就是这里的「背压」：合并 + 有界，而不是无限缓冲）。禁用能力 / 关窗时
 *     `disposeAll()` 杀掉全部在册 PTY（ADR-0002 D4 规则 4：teardown child-process），
 *     不留孤儿终端进程。
 *
 * 本类不广播、不碰 BrowserWindow：它只把「某 tab 产生了一段输出 / 退出了」经
 * 注入的 `emitter` 抛出去，由 terminal-ipc 包成 PiEnvelope 广播。这条接缝让
 * 管理器可以在单测里被直接驱动（真 spawn 一个 shell、断言 ring buffer 有界、
 * 断言退出码、断言 kill 后无进程），不必给 electron 打桩。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import type { IPty } from "node-pty";
import type { TerminalEventPayload, TerminalProfile, TerminalTabMeta } from "@pibuddy/contract";

import { TerminalRingBuffer } from "./ring-buffer.js";

// createRequire 让本 ESM 模块能在运行期按需 require 原生 CJS 模块 node-pty，
// 而不经 vite 的静态打包（原生 .node 不能被 bundle）。
const requireNative = createRequire(import.meta.url);

/** node-pty 的最小结构类型（只用到 spawn）。 */
interface PtyLib {
  spawn(file: string, args: string[] | string, options: PtySpawnOptions): IPty;
}
interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  useConpty?: boolean;
}

let ptyLib: PtyLib | null = null;
function loadPty(): PtyLib {
  if (!ptyLib) ptyLib = requireNative("node-pty") as PtyLib;
  return ptyLib;
}

/** 输出分帧合并的节拍：一帧内的多次 onData 合成一段 chunk。 */
const FLUSH_INTERVAL_MS = 16;
/** 单帧内 pending 超过这个字符数就立刻 flush，避免一次巨量输出把 pending 撑大。 */
const FLUSH_THRESHOLD = 64 * 1024;

/** 一条下发消息（terminal-ipc 据它包 PiEnvelope 广播）。 */
export interface TerminalEmit {
  workspaceId: string;
  tabId: string;
  generation: number;
  sequence: number;
  payload: TerminalEventPayload;
}
export type TerminalEmitter = (msg: TerminalEmit) => void;

/** 一个内部 shell profile（含 spawn 所需的 file/args）。 */
interface ShellProfile {
  id: string;
  label: string;
  file: string;
  args: string[];
}

interface Session {
  tabId: string;
  workspaceId: string;
  cwd: string;
  shellId: string;
  title: string;
  generation: number;
  pty: IPty | null;
  ring: TerminalRingBuffer;
  running: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  cols: number;
  rows: number;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export interface OpenParams {
  workspaceId: string;
  /** 主进程解析出的 canonical root（绝不来自渲染进程） */
  cwd: string;
  profileId: string | null;
  cols: number;
  rows: number;
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private emitter: TerminalEmitter | null = null;
  private counter = 0;

  /** 注入下发通道（terminal-ipc 装配时给）。传 null 摘除（拆卸 / 单测）。 */
  setEmitter(emitter: TerminalEmitter | null): void {
    this.emitter = emitter;
  }

  // ------------------------------------------------------------ shell profiles

  /**
   * 本机可用的 shell profiles。
   *
   * 只用 `existsSync`（不是 readFile/readdir，不触碰 workspace.read 语义）探测
   * 备选 shell 是否安装，用 env 取默认 shell —— 不申请也不需要 workspace.read。
   */
  private buildProfiles(): ShellProfile[] {
    const list: ShellProfile[] = [];
    if (process.platform === "win32") {
      const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
      list.push({ id: "cmd", label: "命令提示符 (cmd)", file: comspec, args: [] });
      list.push({
        id: "powershell",
        label: "Windows PowerShell",
        file: "powershell.exe",
        args: ["-NoLogo"],
      });
      const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
      if (fs.existsSync(gitBash)) {
        list.push({ id: "git-bash", label: "Git Bash", file: gitBash, args: ["--login", "-i"] });
      }
    } else {
      const login = process.env.SHELL || "/bin/bash";
      list.push({ id: "default", label: `默认 Shell (${path.basename(login)})`, file: login, args: [] });
      for (const candidate of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
        if (candidate !== login && fs.existsSync(candidate)) {
          list.push({ id: candidate, label: path.basename(candidate), file: candidate, args: [] });
        }
      }
    }
    return list;
  }

  /** 对外的 profile 列表（去掉 file/args 实现细节）+ 默认 id。 */
  listProfiles(): { profiles: TerminalProfile[]; defaultId: string } {
    const built = this.buildProfiles();
    return {
      profiles: built.map((p) => ({ id: p.id, label: p.label })),
      defaultId: built[0]?.id ?? "",
    };
  }

  private resolveShell(profileId: string | null): ShellProfile {
    const built = this.buildProfiles();
    if (profileId !== null) {
      const found = built.find((p) => p.id === profileId);
      if (found) return found;
    }
    return built[0];
  }

  // ------------------------------------------------------------ 生命周期

  private metaOf(s: Session): TerminalTabMeta {
    return {
      tabId: s.tabId,
      title: s.title,
      shellId: s.shellId,
      generation: s.generation,
      running: s.running,
      exitCode: s.exitCode,
      exitSignal: s.exitSignal,
    };
  }

  private controlledEnv(): NodeJS.ProcessEnv {
    return { ...process.env, TERM: "xterm-256color" };
  }

  private spawnInto(s: Session, shell: ShellProfile): void {
    const child = loadPty().spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd,
      env: this.controlledEnv(),
    });
    s.pty = child;
    s.running = true;
    s.exitCode = null;
    s.exitSignal = null;

    child.onData((chunk: string) => {
      s.pending += chunk;
      if (s.pending.length >= FLUSH_THRESHOLD) this.flush(s);
      else this.schedule(s);
    });

    child.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.flush(s); // 把退出前最后一段输出先送出去
      s.running = false;
      s.exitCode = exitCode ?? null;
      s.exitSignal = signal ?? null;
      s.pty = null;
      const seq = s.ring.advance();
      this.emit(s, seq, {
        kind: "exit",
        tabId: s.tabId,
        exitCode: s.exitCode,
        exitSignal: s.exitSignal,
      });
    });
  }

  /** 新开一个终端 tab，spawn PTY，返回其视图。 */
  open(params: OpenParams): TerminalTabMeta {
    const shell = this.resolveShell(params.profileId);
    this.counter += 1;
    const tabId = `t-${Date.now().toString(36)}-${this.counter.toString(36)}`;
    const session: Session = {
      tabId,
      workspaceId: params.workspaceId,
      cwd: params.cwd,
      shellId: shell.id,
      title: shell.label,
      generation: 0,
      pty: null,
      ring: new TerminalRingBuffer(),
      running: false,
      exitCode: null,
      exitSignal: null,
      cols: params.cols,
      rows: params.rows,
      pending: "",
      flushTimer: null,
    };
    this.sessions.set(tabId, session);
    this.spawnInto(session, shell);
    return this.metaOf(session);
  }

  /** 写用户键入 / 粘贴的字节进 PTY 的 stdin。 */
  input(tabId: string, data: string): boolean {
    const s = this.sessions.get(tabId);
    if (!s || !s.pty || !s.running) return false;
    s.pty.write(data);
    return true;
  }

  /** 调整 PTY 窗口尺寸。 */
  resize(tabId: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(tabId);
    if (!s) return false;
    s.cols = cols;
    s.rows = rows;
    if (s.pty && s.running) {
      try {
        s.pty.resize(cols, rows);
      } catch {
        return false; // PTY 刚退出的竞态：忽略
      }
    }
    return true;
  }

  /** 清屏（清 ring buffer，序号不重置）。 */
  clear(tabId: string): boolean {
    const s = this.sessions.get(tabId);
    if (!s) return false;
    s.ring.clear();
    return true;
  }

  /** 重命名 tab。 */
  rename(tabId: string, title: string): TerminalTabMeta | null {
    const s = this.sessions.get(tabId);
    if (!s) return null;
    s.title = title;
    return this.metaOf(s);
  }

  /**
   * 显式杀掉一个 tab：kill PTY 并从册中移除（= 关闭标签页）。
   *
   * kill 会终止 PTY 及其下的整棵进程树（node-pty 关闭 ConPTY / 发信号给进程组），
   * 不留孤儿。
   */
  kill(tabId: string): boolean {
    const s = this.sessions.get(tabId);
    if (!s) return false;
    this.killPty(s);
    this.clearTimer(s);
    this.sessions.delete(tabId);
    return true;
  }

  /** 重启：杀掉旧 PTY、代际 +1、换一份新 ring buffer、用同样的 shell 重新 spawn。 */
  restart(tabId: string): TerminalTabMeta | null {
    const s = this.sessions.get(tabId);
    if (!s) return null;
    this.killPty(s);
    this.clearTimer(s);
    s.pending = "";
    s.generation += 1;
    s.ring = new TerminalRingBuffer();
    this.spawnInto(s, this.resolveShell(s.shellId));
    return this.metaOf(s);
  }

  /** 取一个 tab 的 ring buffer 快照，供 reload 后重连重建屏幕。 */
  snapshot(tabId: string): {
    found: boolean;
    generation: number;
    text: string;
    sequence: number;
    running: boolean;
    exitCode: number | null;
    exitSignal: number | null;
  } {
    const s = this.sessions.get(tabId);
    if (!s) {
      return { found: false, generation: 0, text: "", sequence: 0, running: false, exitCode: null, exitSignal: null };
    }
    return {
      found: true,
      generation: s.generation,
      text: s.ring.text(),
      sequence: s.ring.sequence,
      running: s.running,
      exitCode: s.exitCode,
      exitSignal: s.exitSignal,
    };
  }

  /** 某工作区的全部 tab 视图。 */
  list(workspaceId: string): TerminalTabMeta[] {
    const out: TerminalTabMeta[] = [];
    for (const s of this.sessions.values()) {
      if (s.workspaceId === workspaceId) out.push(this.metaOf(s));
    }
    return out;
  }

  /**
   * 拆卸：杀掉全部在册 PTY，清掉全部 flush 定时器与会话（ADR-0002 D4 规则 4）。
   *
   * 不留任何孤儿终端进程（node-pty spawn 的 shell 及其子进程一并清）。
   */
  disposeAll(): void {
    for (const s of [...this.sessions.values()]) {
      this.killPty(s);
      this.clearTimer(s);
    }
    this.sessions.clear();
  }

  // ------------------------------------------------------------ 内部

  private killPty(s: Session): void {
    if (!s.pty) return;
    try {
      s.pty.kill();
    } catch {
      /* 已退出 */
    }
    s.pty = null;
    s.running = false;
  }

  private clearTimer(s: Session): void {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
  }

  private schedule(s: Session): void {
    if (s.flushTimer) return;
    s.flushTimer = setTimeout(() => this.flush(s), FLUSH_INTERVAL_MS);
  }

  private flush(s: Session): void {
    this.clearTimer(s);
    if (s.pending.length === 0) return;
    const data = s.pending;
    s.pending = "";
    const seq = s.ring.append(data);
    this.emit(s, seq, { kind: "data", tabId: s.tabId, data });
  }

  private emit(s: Session, sequence: number, payload: TerminalEventPayload): void {
    this.emitter?.({
      workspaceId: s.workspaceId,
      tabId: s.tabId,
      generation: s.generation,
      sequence,
      payload,
    });
  }
}

/** 全进程唯一的 PTY 管理器。 */
export const ptyManager = new PtyManager();

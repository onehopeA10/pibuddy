/**
 * MCP stdio 传输的最小客户端：spawn 一个 MCP 服务器进程，走 JSON-RPC 2.0 的
 * `initialize` → `notifications/initialized` → `tools/list` 握手，拿到服务器
 * 自述与工具列表。这是「连接测试要真的连一次」的落点（FEAT-mcp.md 铁律 2）。
 *
 * ## 为什么只做 stdio
 *
 * MCP stdio 传输就是**换行分隔的 JSON-RPC 消息**跑在子进程的 stdin/stdout 上，
 * 不涉及任何网络请求——因此它天然满足「main 侧无出站 HTTP 调用」的硬约束，
 * 也不需要 safeFetch。http / 远程传输本轮不测（见契约文件与 FEAT-mcp.md risks）。
 *
 * ## 安全
 *
 *  - `spawn(..., { shell: false })`：command 直接作为 argv[0]，**不经 shell 解析**，
 *    因此 args 里的 `;` `|` `$()` 都只是普通字符串，不会被当成 shell 语法。
 *    这挡住的是 shell 注入；「运行用户配置里的某个可执行文件」是 MCP stdio
 *    的固有语义（与 pi-resources 的 npm/git 执行同类）。调用方的 start / test
 *    已接入 PermissionEngine 的 process.shell 第五道闸，授权绑定工作区、服务器
 *    与完整执行配置指纹；配置或工作区变化后旧授权不再覆盖新的 spawn。
 *  - 进程一定被回收：无论握手成败，非 keepAlive 路径在 finally 里 kill。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { McpServerInput } from "@pibuddy/contract";

/** 客户端声明的协议版本。服务器会在 initialize 结果里回它协商到的版本。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** 握手默认超时（ms）。够一个本地进程启动 + 报出 initialize 结果。 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
const terminatedChildren = new WeakSet<ChildProcess>();

/** service 与 client 共用的幂等终止原语，避免 teardown/exit 路径重复 kill。 */
export function terminateStdioChild(child: ChildProcess): void {
  if (terminatedChildren.has(child)) return;
  terminatedChildren.add(child);
  const pid = child.pid;
  if (process.platform === "win32" && typeof pid === "number" && pid > 0) {
    // .cmd/.bat 经 cmd.exe 启动时，child 只是包装进程；必须带 /T 收整棵树。
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
}

export interface StdioProbe {
  ok: boolean;
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  tools: { name: string; description: string }[];
  diagnostics: string[];
}

export interface StdioConnection {
  /** keepAlive 且握手成功时的活进程；否则 null（已回收 / 从未起来） */
  child: ChildProcess | null;
  probe: StdioProbe;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
}

/** 一次 spawn 的具体形态：可执行文件 + 参数（+ Windows 逐字参数标记）。 */
export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** cmd.exe 的元字符集合——这些字符在命令行里会被 cmd 解释，需逐个加 `^` 保字面量。 */
const CMD_META = /[()%!^"<>&|]/g;

/**
 * MCP 子进程可继承的宿主环境键。
 *
 * 只放「npx / node 不给就起不来」的路径与临时目录，绝不展开 process.env。
 * 用户在 mcp.json 里显式写的 config.env 随后覆盖同名键。
 */
export const MCP_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "windir",
  "ComSpec",
  "LANG",
  "LC_ALL",
] as const;

const MCP_ENV_DENY = /^(NODE_OPTIONS|NODE_INSPECT|LD_PRELOAD|DYLD_|ELECTRON_|PIBUDDY_)/i;

/** 构造 MCP stdio 子进程环境：白名单继承 + 用户显式 env。 */
export function buildMcpChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  overlay: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    const value = base[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (!key || MCP_ENV_DENY.test(key)) continue;
    env[key] = value;
  }
  env.NODE_OPTIONS = "";
  return env;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows PATH + PATHEXT 解析：把一个命令名解析成一个具体存在的文件。
 *
 * `npx` → `npx.cmd`、`node` → `node.exe`。带路径分隔符的命令只在其所在目录里
 * 找；裸命令名遍历 PATH。命令自带扩展名（`foo.cmd`）时优先按原名查。
 * 解析不到返回 null —— 调用方按原样 spawn，让它像以前一样 ENOENT 失败。
 */
export function resolveWindowsExecutable(command: string): string | null {
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const hasDirSep = command.includes("/") || command.includes("\\");
  const base = hasDirSep ? path.basename(command) : command;
  const dirs = hasDirSep
    ? [path.dirname(path.resolve(command))]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const existingExt = path.extname(base);
  for (const dir of dirs) {
    if (existingExt) {
      const p = path.join(dir, base);
      if (isFile(p)) return p;
    }
    for (const ext of pathext) {
      const p = path.join(dir, base + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/**
 * 供 `cmd.exe /c` 使用的参数转义（cross-spawn 多年验证的做法）：
 *
 *  1. 先按 CreateProcess 的引号规则把参数整体括进 `"…"`（引号前的反斜杠翻倍、
 *     内部引号转义）；
 *  2. 再对 cmd 元字符逐个加 `^`。批处理经 `cmd /c "…"` 外层还有一次 cmd 解析，
 *     因此对 `.cmd` / `.bat` **双重**加 `^`（`&` → `^^&`）。
 *
 * 结果：参数里的 `;` `|` `&` `$()` `%VAR%` 全部保持字面量，不重新获得 shell
 * 注入能力——`spawn(shell:false)` 的安全边界一分不放宽。
 */
export function escapeCmdArg(arg: string): string {
  let s = arg.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  // 元字符加 `^`，再加一次：`cmd /c "…"` 对批处理外层还有一次解析，需双重转义。
  s = s.replace(CMD_META, "^$&").replace(CMD_META, "^$&");
  return s;
}

function escapeCmdCommand(cmd: string): string {
  return cmd.replace(CMD_META, "^$&");
}

/**
 * 算出一次 spawn 的具体形态。
 *
 * ## 为什么需要它：Windows 上 `spawn(shell:false)` 跑不了 `.cmd`
 *
 * `spawn(shell:false)` 底层是 CreateProcess，它只能执行 PE 可执行文件，**不能**
 * 直接跑 `.cmd` / `.bat`（那是 cmd.exe 的批处理脚本）。而 MCP 生态最常见的启动
 * 命令 `npx`（`pnpm dlx` 同理）在 Windows 上正是 `npx.cmd` 这类批处理 shim ——
 * 于是 `spawn("npx", …, {shell:false})` 直接 ENOENT（FEAT-mcp.md §5 risks 3）。
 *
 * 解决而**不放宽** shell:false 安全边界：
 *   - 命令解析到 PE（`.exe` / `.com`）：spawn 该绝对路径，shell 仍 false；
 *   - 命令解析到 `.cmd` / `.bat`：经 `cmd.exe /d /s /c` 执行，但用 `escapeCmdArg`
 *     把每个用户参数括死 + `windowsVerbatimArguments` —— Node 不再二次加引号，
 *     参数里的 shell 元字符全部字面量。
 * 非 Windows、或解析不到的命令：按原样返回（行为不变）。
 */
export function planSpawn(command: string, args: readonly string[]): SpawnPlan {
  const argv = [...args];
  if (process.platform !== "win32") {
    return { file: command, args: argv, windowsVerbatimArguments: false };
  }
  const resolved = resolveWindowsExecutable(command);
  if (!resolved) {
    return { file: command, args: argv, windowsVerbatimArguments: false };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const comSpec = process.env.ComSpec || "cmd.exe";
    const line = `"${[escapeCmdCommand(resolved), ...argv.map(escapeCmdArg)].join(" ")}"`;
    return { file: comSpec, args: ["/d", "/s", "/c", line], windowsVerbatimArguments: true };
  }
  return { file: resolved, args: argv, windowsVerbatimArguments: false };
}

/**
 * 连接一台 stdio MCP 服务器并完成握手。
 *
 * `keepAlive=false`（连接测试）：握手完就 kill，`child` 恒为 null。
 * `keepAlive=true`（启动）：握手成功后保留活进程，交给调用方登记与后续 stop。
 */
export function connectStdio(
  config: McpServerInput,
  opts: {
    timeoutMs?: number;
    keepAlive?: boolean;
    onSpawn?: (child: ChildProcess) => void;
  } = {}
): Promise<StdioConnection> {
  const timeoutMs = opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const keepAlive = opts.keepAlive ?? false;
  const diagnostics: string[] = [];

  return new Promise<StdioConnection>((resolve) => {
    if (!config.command || config.command.trim() === "") {
      resolve({ child: null, probe: fail(["stdio 服务器缺少 command"]) });
      return;
    }

    let child: ChildProcess;
    try {
      // Windows 上把 `npx`（实为 npx.cmd）等批处理 shim 解析成可 spawn 的形态，
      // 但不放宽 shell:false（planSpawn 用逐字转义 + verbatim 挡住注入）。
      const plan = planSpawn(config.command, config.args);
      child = spawn(plan.file, plan.args, {
        // 白名单继承 PATH 等启动必需变量，再叠用户显式 config.env。
        // 绝不 `{ ...process.env }`：那会把 API Key / NODE_OPTIONS 交给第三方 MCP。
        env: buildMcpChildEnv(process.env, config.env),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
      // 生命周期拥有者必须在握手前就拿到句柄：退出 / stop 可能发生在
      // initialize 尚未返回时，等握手完成再登记会留下无法及时回收的进程。
      opts.onSpawn?.(child);
    } catch (err) {
      resolve({ child: null, probe: fail([`无法启动进程：${describe(err)}`]) });
      return;
    }

    let settled = false;
    let stderrTail = "";
    const serverInfo = { value: null as { name: string; version: string } | null };
    const protocolVersion = { value: null as string | null };
    let tools: { name: string; description: string }[] = [];

    const finish = (ok: boolean, extra: string[] = []): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();

      const allDiagnostics = [...diagnostics, ...extra];
      if (!ok && stderrTail.trim() !== "") {
        allDiagnostics.push(`服务器 stderr：${stderrTail.trim().slice(-500)}`);
      }
      const probe: StdioProbe = {
        ok,
        serverInfo: serverInfo.value,
        protocolVersion: protocolVersion.value,
        tools,
        diagnostics: allDiagnostics,
      };

      if (ok && keepAlive) {
        // 保留活进程：解绑握手期的监听，但不 kill。输出继续吞进 void，
        // 避免管道写满把子进程卡死。
        child.stdout?.on("data", () => undefined);
        child.stderr?.on("data", () => undefined);
        child.on("error", () => undefined);
        resolve({ child, probe });
        return;
      }
      terminateStdioChild(child);
      resolve({ child: null, probe });
    };

    const timer = setTimeout(() => {
      finish(false, [`握手超时（${timeoutMs}ms）：服务器未在时限内完成 initialize / tools/list`]);
    }, timeoutMs);

    child.on("error", (err) => {
      finish(false, [`进程错误：${describe(err)}`]);
    });
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(false, [`进程在握手完成前退出（code=${code ?? "null"} signal=${signal ?? "null"}）`]);
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    // ---- 行缓冲：stdio 传输是换行分隔的 JSON-RPC 消息 ----
    //
    // 缓冲必须有上界：恶意/异常服务器可以在握手超时窗口内持续输出不带换行
    // 的字节，无上限累积等于把主进程内存交给对端。正常握手只有 initialize
    // 结果 + tools/list 两条消息，远小于此数；超限按握手失败收场并回收进程。
    const HANDSHAKE_BUFFER_LIMIT = 4 * 1024 * 1024;
    let buffer = "";
    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        return; // 非 JSON 的行（有些服务器往 stdout 打日志）：忽略
      }
      if (msg.id === 1) {
        if (msg.error) {
          finish(false, [`initialize 被拒：${msg.error.message ?? "未知错误"}`]);
          return;
        }
        const result = (msg.result ?? {}) as Record<string, unknown>;
        const info = (result.serverInfo ?? {}) as Record<string, unknown>;
        serverInfo.value = {
          name: typeof info.name === "string" ? info.name : "(未提供)",
          version: typeof info.version === "string" ? info.version : "",
        };
        protocolVersion.value =
          typeof result.protocolVersion === "string" ? result.protocolVersion : null;
        // 握手第二步：告知服务器初始化完成，然后列工具。
        send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        return;
      }
      if (msg.id === 2) {
        if (msg.error) {
          // 有的服务器不支持 tools/list：握手本身算成功，工具列表为空。
          finish(true, [`tools/list 不可用：${msg.error.message ?? "未知错误"}`]);
          return;
        }
        const result = (msg.result ?? {}) as Record<string, unknown>;
        const rawTools = Array.isArray(result.tools) ? result.tools : [];
        tools = rawTools.map((t) => {
          const tool = (t ?? {}) as Record<string, unknown>;
          return {
            name: typeof tool.name === "string" ? tool.name : "(未命名)",
            description: typeof tool.description === "string" ? tool.description : "",
          };
        });
        finish(true);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      // 在整行消耗之后再判：正常的大消息只要带换行就不受影响，
      // 只有「迟迟凑不出一行」的输出才会触顶。
      if (buffer.length > HANDSHAKE_BUFFER_LIMIT) {
        finish(false, [`握手输出累积超过 ${HANDSHAKE_BUFFER_LIMIT} 字节仍无完整消息，已中止`]);
      }
    });

    // 发起握手第一步。
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "PiBuddy", version: "0.1.0" },
      },
    });
  });
}

/** 写一条 JSON-RPC 消息（换行分隔）。stdin 已关时静默失败，由超时兜底。 */
function send(child: ChildProcess, message: unknown): void {
  try {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  } catch {
    /* 管道已关：超时会兜住 */
  }
}

function fail(diagnostics: string[]): StdioProbe {
  return { ok: false, serverInfo: null, protocolVersion: null, tools: [], diagnostics };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
 *    的固有语义（与 pi-resources 的 npm/git 执行同类），残余风险记在
 *    FEAT-mcp.md：彻底收口要靠 PermissionEngine 的 process.shell 门（ADR D3，
 *    本轮未做）。
 *  - 进程一定被回收：无论握手成败，非 keepAlive 路径在 finally 里 kill。
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { McpServerInput } from "@pibuddy/contract";

/** 客户端声明的协议版本。服务器会在 initialize 结果里回它协商到的版本。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** 握手默认超时（ms）。够一个本地进程启动 + 报出 initialize 结果。 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

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

/**
 * 连接一台 stdio MCP 服务器并完成握手。
 *
 * `keepAlive=false`（连接测试）：握手完就 kill，`child` 恒为 null。
 * `keepAlive=true`（启动）：握手成功后保留活进程，交给调用方登记与后续 stop。
 */
export function connectStdio(
  config: McpServerInput,
  opts: { timeoutMs?: number; keepAlive?: boolean } = {}
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
      child = spawn(config.command, config.args, {
        // config.env 叠加在 process.env 之上：npx / node 需要 PATH 等继承变量，
        // 用户的 env 覆盖同名键。shell:false 是安全边界，不能动。
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
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
        // 保留活进程：解绑握手期的监听，但不 kill。stderr 继续吞进 void，
        // 避免管道写满把子进程卡死。
        child.stderr?.on("data", () => undefined);
        child.on("error", () => undefined);
        resolve({ child, probe });
        return;
      }
      try {
        child.kill();
      } catch {
        /* 已经退出就算了 */
      }
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

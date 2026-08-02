/**
 * 会话仓储：全仓**唯一**的会话枚举入口（裁定 5）。
 *
 * 两条路径，优先级固定：
 *
 *   1. pi 自己导出的 `SessionManager.list(cwd, sessionDir)` —— 与命令行看到的
 *      列表逐字一致，不会因为我们复制了一份解析算法而二次漂移；
 *   2. 回退：本文件自实现的**异步**扫描。只有在运行时不可 import（打包形态、
 *      版本不匹配）时才会走到，语义尽量对齐但不保证逐字相同。
 *
 * 硬约束：
 *   - 全部 I/O 走 node:fs/promises。被本文件取代的 sessions-store.ts 用的是
 *     同步目录枚举 + 每文件同步 stat + 同步整文件读入再 split，会话一多就把
 *     Electron 主线程钉死，而 agent_settled 每次都会触发它。
 *   - 扫描条数与单文件读取字节数都有上限，坏文件只标记 parseError 不 throw。
 */
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AppSettings, SessionSummary } from "@pibuddy/contract";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { resolveSessionDir } from "./session-dir.js";

/** 最多枚举多少个会话文件（按修改时间倒序取前 N 个）。 */
const MAX_SESSIONS_SCANNED = 200;

/** 回退路径下单个 jsonl 最多读取的字节数，防止超大会话把内存吃光。 */
const MAX_SESSION_HEAD_BYTES = 1_048_576;

/** 首条消息预览的截断长度。 */
const FIRST_MESSAGE_MAX_CHARS = 120;

/**
 * pi 运行时以**变量**形式动态 import：写成字面量会被 electron-vite 静态解析、
 * 把整个 pi 打进主进程包里（它是 devDependency，且带一堆动态 require）。
 */
const PI_MODULE_ID = "@earendil-works/pi-coding-agent";

interface PiSessionModule {
  SessionManager: {
    list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
  };
}

let piModule: PiSessionModule | null = null;
let piModuleFailed = false;

async function loadPiSessionModule(): Promise<PiSessionModule | null> {
  if (piModule) return piModule;
  if (piModuleFailed) return null;
  try {
    piModule = (await import(/* @vite-ignore */ PI_MODULE_ID)) as PiSessionModule;
    return piModule;
  } catch {
    // 运行时不可用（打包形态没随包、版本不匹配）时永久降级到回退扫描，
    // 不要每次列表都重试一遍 import。
    piModuleFailed = true;
    return null;
  }
}

/**
 * 枚举某个工作目录下的全部历史会话。
 *
 * **本函数是全仓唯一的枚举入口**：TASK-009 用 SQLite 索引替换实现时也在这里
 * 原地替换，任何时刻都不允许存在第二套枚举器。
 */
export async function listSessionsForWorkspace(
  workspace: string,
  settings: AppSettings
): Promise<SessionSummary[]> {
  if (!workspace) return [];
  const sessionDir = resolveSessionDir(workspace, settings);

  const mod = await loadPiSessionModule();
  if (mod) {
    try {
      const infos = await mod.SessionManager.list(workspace, sessionDir);
      return infos
        .map(fromSessionInfo)
        .sort((a, b) => b.modified - a.modified)
        .slice(0, MAX_SESSIONS_SCANNED);
    } catch {
      // pi 侧解析整体失败（目录不存在是正常情况）时落回自实现扫描，
      // 它对单文件损坏更宽容。
    }
  }
  return scanSessionDir(sessionDir);
}

/** pi 的 SessionInfo → 契约里的 SessionSummary。 */
function fromSessionInfo(info: SessionInfo): SessionSummary {
  return {
    path: info.path,
    id: info.id,
    ...(info.name ? { name: info.name } : {}),
    firstMessage: (info.firstMessage ?? "").slice(0, FIRST_MESSAGE_MAX_CHARS),
    messageCount: info.messageCount ?? 0,
    modified: info.modified instanceof Date ? info.modified.getTime() : Number(info.modified ?? 0),
    ...(info.cwd ? { cwd: info.cwd } : {}),
  };
}

// ---------------------------------------------------------------- 回退扫描

async function scanSessionDir(dir: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
  } catch {
    // 目录不存在 = 这个工作目录还没有历史会话，不是错误。
    return [];
  }

  const stamped: { file: string; modified: number }[] = [];
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      try {
        const st = await stat(file);
        stamped.push({ file, modified: st.mtimeMs });
      } catch {
        /* 文件在扫描期间被删掉：跳过 */
      }
    })
  );
  stamped.sort((a, b) => b.modified - a.modified);
  const targets = stamped.slice(0, MAX_SESSIONS_SCANNED);

  const parsed = await Promise.all(
    targets.map(({ file, modified }) => parseSessionHead(file, modified))
  );
  return parsed;
}

/**
 * 解析单个会话文件的头部。
 *
 * 任何失败都只落在**这一条**上（parseError 非空），既不 throw 也不把条目
 * 藏起来 —— 用户至少要能看见「有这么一个会话，但读不出来」。
 */
async function parseSessionHead(file: string, modified: number): Promise<SessionSummary> {
  try {
    const text = await readHead(file);
    return { ...parseJsonl(text, file), modified };
  } catch (err) {
    return {
      path: file,
      id: path.basename(file, ".jsonl"),
      firstMessage: "",
      messageCount: 0,
      modified,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readHead(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(MAX_SESSION_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_SESSION_HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseJsonl(text: string, file: string): Omit<SessionSummary, "modified"> {
  const lines = text.split("\n");
  // 读到上限时最后一行多半是半条 JSON，丢掉它而不是记一条假的解析失败。
  const complete = text.length >= MAX_SESSION_HEAD_BYTES ? lines.slice(0, -1) : lines;

  let id = "";
  let cwd: string | undefined;
  let runtimeVersion: string | undefined;
  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;
  let brokenLines = 0;

  for (const line of complete) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      brokenLines++;
      continue;
    }
    switch (entry.type) {
      case "session":
        id = typeof entry.id === "string" ? entry.id : id;
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (entry.version !== undefined) runtimeVersion = String(entry.version);
        break;
      case "session_info":
        if (typeof entry.name === "string") name = entry.name;
        break;
      case "message": {
        const message = entry.message as { role?: string; content?: unknown } | undefined;
        if (!message) break;
        if (message.role === "user" || message.role === "assistant") messageCount++;
        if (!firstMessage && message.role === "user") {
          firstMessage = extractText(message.content).slice(0, FIRST_MESSAGE_MAX_CHARS);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    path: file,
    id: id || path.basename(file, ".jsonl"),
    ...(name ? { name } : {}),
    firstMessage,
    messageCount,
    ...(cwd ? { cwd } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
    ...(brokenLines > 0 ? { parseError: `${brokenLines} 行无法解析` } : {}),
    ...(id ? {} : { parseError: "缺少 session 头部记录" }),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return (block as { text?: string }).text ?? "";
      }
    }
  }
  return "";
}

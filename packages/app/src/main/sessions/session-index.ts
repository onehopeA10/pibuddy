/**
 * 会话索引（SES-101）——**全仓唯一的会话枚举实现**（裁定 5）。
 *
 * ## JSONL 是真相源，SQLite 只是索引
 *
 * 本文件从头到尾**只读** .jsonl：它不含任何写入或删除文件的调用 —— 无论是
 * 同步写、追加写、写入流，还是任何形式的就地删除。索引丢了可以重建，会话
 * 文件被我们改坏了就再也回不去 —— 那些文件同时属于 pi 命令行。
 * 「彻底删除」也只把文件交给系统回收站（见 purge），不做不可逆的删除。
 *
 * ## 为什么不再整文件读入
 *
 * 被取代的实现是「同步列目录 + 每文件同步 stat + 把整个文件同步读进内存 +
 * split 逐行 JSON.parse」，而 `agent_settled` 每次都触发它。几百个会话时
 * 主线程一次能钉住好几百毫秒，表现为流式输出卡顿。这里的增量规则是：
 *
 *   1. `row.mtime_ms === stat.mtimeMs && row.size_bytes === stat.size`
 *      → 整个文件跳过，一个字节都不读；
 *   2. 未命中时用 `createReadStream(file, { start: row.scan_offset })`
 *      **只读新增的那一段**，把 scan_offset 推到最后一个完整行的行尾；
 *   3. content_hash（文件前 64KB 的 sha256 前 32 位）与索引不符 = 文件被
 *      外部截断/重写，此时 scan_offset 归零做一次全量重扫。
 *
 * 只靠 mtime+size 会漏掉「大小恰好不变的原地重写」，只靠 hash 又要每次都
 * 读 64KB，两者叠起来才既快又不会读到错位的字节。
 *
 * ## 为什么 workspace_id 必须由路径派生
 *
 * 见 workspace-registry.ts 的注释：进程级随机 id 会让重启后的历史会话
 * 「全部消失且不报错」。这里的 workspace_id 一律取 registerWorkspace()
 * 落盘的那个 sha256(canonical realpath)。
 */
import { app, shell } from "electron";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppSettings,
  DraftRecord,
  SessionQuery,
  SessionRow,
  SessionStatus,
} from "@pibuddy/contract";

import { resolveSessionDir } from "./session-dir.js";
import { isBrokenPiSessionFile } from "./pi-session-header.js";
import { workspaceIdFor } from "../workspace-registry.js";

/** 索引表结构的代际。改动 DDL 必须 +1，并在 migrate() 里补一条分支。 */
export const SESSION_INDEX_SCHEMA_VERSION = 1;

/** content_hash 取样长度：文件前 64KB。 */
const HASH_HEAD_BYTES = 64 * 1024;

/** 全文检索 blob 的上限，避免把整个会话塞进一列。 */
const SEARCH_BLOB_MAX_CHARS = 4000;

/** 首条用户消息预览的截断长度。 */
const PREVIEW_MAX_CHARS = 160;

/** 会话目录的最大递归深度（fork 会在子目录里再开一层）。 */
const MAX_SCAN_DEPTH = 4;

/** 单次 query 的默认返回条数。 */
const DEFAULT_QUERY_LIMIT = 500;

/**
 * 索引内部的一行。**带 sourcePath**，因此绝不外发给渲染进程 ——
 * 对外一律经 toSessionRow() 换成不透明的 sessionId（CT-15）。
 */
export interface IndexedSession {
  sourcePath: string;
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  scanOffset: number;
  mtimeMs: number;
  sizeBytes: number;
  contentHash: string;
  name: string | null;
  preview: string;
  /** 供 LIKE 搜索的正文拼接，上限 SEARCH_BLOB_MAX_CHARS */
  searchBlob: string;
  messageCount: number;
  tokenTotal: number;
  costTotal: number;
  modelId: string | null;
  status: SessionStatus;
  pinned: boolean;
  unread: boolean;
  running: boolean;
  deletedAt: number | null;
}

export interface SyncResult {
  /** 本次看到的会话文件数 */
  scanned: number;
  /** 其中真正读了字节、重新解析过的文件数 */
  reparsed: number;
}

// ---------------------------------------------------------------- 落盘位置

/** 测试注入用；生产环境恒为 null，走 app.getPath("userData")。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把索引 DB 指向临时目录。 */
export function __setSessionIndexDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

/**
 * 索引 DB 的绝对路径。
 *
 * **必须落在 userData**：打包后 asar 内目录只读，把 DB 写在应用安装目录
 * （即模块自身所在的那个目录）旁边会在 packaged 构建里静默失败，而 dev 下
 * 一切正常 —— 这类缺陷只有装完才暴露。
 */
function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "session-index.db");
}

const DDL = `CREATE TABLE IF NOT EXISTS sessions (
  source_path TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scan_offset INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  name TEXT,
  preview TEXT,
  search_blob TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  token_total INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  draft_text TEXT,
  draft_json TEXT,
  deleted_at INTEGER,
  last_indexed_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL
)`;

// ---------------------------------------------------------------- 解析

interface ParseAccum {
  sessionId: string;
  name: string | null;
  preview: string;
  searchBlob: string;
  messageCount: number;
  tokenTotal: number;
  costTotal: number;
  modelId: string | null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      parts.push((block as { text?: string }).text ?? "");
    }
  }
  return parts.join("\n");
}

/**
 * 消化一行 JSONL。
 *
 * **未知 type 一律原样跳过**：pi 的 entry 类型是开放集合（fork / compaction /
 * 各种扩展记录都会往里写），我们不理解的东西不去解释它，更不会因为看不懂
 * 就把整个会话判为损坏。
 */
function consume(acc: ParseAccum, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (entry.type) {
    case "session":
      if (typeof entry.id === "string") acc.sessionId = entry.id;
      break;
    case "session_info":
      if (typeof entry.name === "string") acc.name = entry.name;
      break;
    case "model_change":
      if (typeof entry.modelId === "string") acc.modelId = entry.modelId;
      break;
    case "message": {
      const msg = entry.message as
        | {
            role?: string;
            content?: unknown;
            model?: string;
            usage?: { totalTokens?: number; cost?: { total?: number } };
          }
        | undefined;
      if (!msg) return;
      if (msg.role !== "user" && msg.role !== "assistant") return;
      acc.messageCount++;
      const text = textOf(msg.content);
      if (!acc.preview && msg.role === "user") {
        acc.preview = text.slice(0, PREVIEW_MAX_CHARS);
      }
      if (text && acc.searchBlob.length < SEARCH_BLOB_MAX_CHARS) {
        acc.searchBlob = `${acc.searchBlob}\n${text}`.slice(0, SEARCH_BLOB_MAX_CHARS);
      }
      if (typeof msg.model === "string") acc.modelId = msg.model;
      if (msg.usage) {
        acc.tokenTotal += Number(msg.usage.totalTokens ?? 0) || 0;
        acc.costTotal += Number(msg.usage.cost?.total ?? 0) || 0;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 会话文件头部记录的 cwd —— **归属判据的唯一来源**。
 *
 * pi 写下的第一行恒是 `{"type":"session","version":3,"id":...,"cwd":...}`
 * （source/pi packages/coding-agent/src/core/session-manager.ts 的
 * SessionHeader）。默认布局下会话目录名由 cwd 编码而来，这一行只是复述；
 * 但 `settings.sessionDir` 允许多个工作区共用同一个目录，此时目录名什么都
 * 证明不了 —— 头部的 cwd 是唯一能说清「这份会话属于谁」的东西。
 *
 * 返回 null 表示头部没写 cwd（v1 会话就没有 version 字段，更早的也可能缺
 * cwd）。此时**按当前工作区收下**：拿不准归属就沿用旧行为，绝不因为一个
 * 读不出来的字段把用户的历史会话整批藏起来。
 */
function headerCwd(head: Buffer): string | null {
  const nl = head.indexOf(0x0a);
  const line = (nl >= 0 ? head.subarray(0, nl) : head).toString("utf8").trim();
  if (!line) return null;
  try {
    const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    if (entry.type !== "session") return null;
    return typeof entry.cwd === "string" && entry.cwd ? entry.cwd : null;
  } catch {
    return null;
  }
}

/**
 * 路径规范化的结果缓存。
 *
 * samePath 会在「遍历目录里每一个会话文件」的循环里被调用，而
 * realpathSync.native 是一次真实的系统调用。同一个 workspaceRoot 在一轮同步
 * 里会被问上几十次，缓存掉。
 */
const canonicalCache = new Map<string, string>();

/**
 * 把绝对路径收敛成可比较的形态。
 *
 * **必须走 `realpathSync.native`**：Windows 上 `C:\Users\RUNNER~1\proj` 与
 * `C:\Users\runneradmin\proj` 是同一个目录的两种写法（8.3 短名），而
 * `path.resolve` 只做词法处理，认不出这件事 —— 只有操作系统能。
 * `workspace-registry.ts` 算 workspaceId 时用的正是 native 版；这里若用词法
 * 版，两边对「同一个目录」的判断就会不一致，表现是**历史会话一条都列不出
 * 来**（CI 的 Windows runner 上恰好是短名路径，因此只在 CI 红）。
 *
 * 路径不存在时（会话头部记的 cwd 指向已被删掉的目录）退回词法归一化 ——
 * 那种情况下没有操作系统答案可问，词法比较是唯一能做的事。
 */
function canonicalize(p: string): string {
  const cached = canonicalCache.get(p);
  if (cached !== undefined) return cached;
  let out: string;
  try {
    out = realpathSync.native(p);
  } catch {
    out = path.resolve(p);
  }
  if (process.platform === "win32") out = out.toLowerCase();
  canonicalCache.set(p, out);
  return out;
}

/**
 * 两个绝对路径是否指同一个目录。
 *
 * Windows 路径大小写不敏感，而 pi 记下的 cwd 是用户敲进命令行的那个形态
 * （`d:\proj`、甚至 8.3 短名），我们的 workspaceRoot 是 realpath 归一化过的。
 * 逐字比较会把它们判成两个目录。
 */
function samePath(a: string, b: string): boolean {
  return canonicalize(a) === canonicalize(b);
}

/** 按字节区间读取，返回 Buffer。全部 I/O 走流，不整文件读入。 */
function readRange(file: string, start: number, end: number): Promise<Buffer> {
  if (end < start) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(file, { start, end });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** 递归枚举会话目录下的 .jsonl（fork 会话住在子目录里）。 */
async function listJsonl(dir: string, depth = 0, acc: string[] = []): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return acc;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 目录不存在 = 这个工作区还没有历史会话，不是错误。
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listJsonl(full, depth + 1, acc);
    } else if (entry.name.endsWith(".jsonl")) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------- 索引本体

export class SessionIndex {
  private readonly db: DatabaseSync;
  /**
   * 串行化闸门。
   *
   * syncWorkspace 内部有 await（读文件），而事务不可重入 —— 两次并发调用
   * 若各自 BEGIN，第二次会直接抛「cannot start a transaction within a
   * transaction」。这里让后来者排队，顺带保证同一 source_path 不会出现两行。
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL);
    this.migrate();
  }

  /** 用 `PRAGMA user_version` 记代际；升级时在这里补分支，绝不静默重建。 */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current === SESSION_INDEX_SCHEMA_VERSION) return;
    if (current > SESSION_INDEX_SCHEMA_VERSION) {
      // 用旧版应用打开新版索引：不动它，让本次运行退化为「每次都重扫」，
      // 也不要把用户在新版里整理好的置顶/归档删掉。
      return;
    }
    this.db.exec(`PRAGMA user_version = ${SESSION_INDEX_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ 增量同步

  /**
   * 扫描一个工作目录的会话目录，把新增内容并进索引。
   *
   * 整个过程包在一个事务里：解析到第 N 个文件时抛错，本次已写的行全部回滚，
   * 索引不会停在「一半新一半旧」的状态上。
   */
  syncWorkspace(workspaceRoot: string, settings?: AppSettings): Promise<SyncResult> {
    const run = this.queue.then(() => this.syncLocked(workspaceRoot, settings));
    // 失败也要让队列继续往下走，否则一次异常会把后续所有 sync 永久挂住。
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async syncLocked(
    workspaceRoot: string,
    settings?: AppSettings
  ): Promise<SyncResult> {
    const sessionDir = resolveSessionDir(
      workspaceRoot,
      settings ?? ({ schemaVersion: 1, piRuntimeMode: "bundled" } as AppSettings)
    );
    const workspaceId = workspaceIdFor(workspaceRoot);
    const files = await listJsonl(sessionDir);

    // 先把要写的东西全算出来，再一次性入库：事务里不夹 await，
    // 回滚语义因此与「解析到第 N 个文件抛错」严格一致。
    const pending: IndexedSession[] = [];
    const forgotten: string[] = [];
    let reparsed = 0;
    for (const file of files) {
      const next = await this.planFile(file, workspaceRoot, workspaceId, forgotten);
      if (!next) continue;
      pending.push(next);
      reparsed++;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of pending) this.upsert(row);
      for (const file of forgotten) {
        this.db.prepare("DELETE FROM sessions WHERE source_path = ?").run(file);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { scanned: files.length, reparsed };
  }

  /**
   * 判断单个文件要不要重新解析；要的话把新一行算出来（不入库）。
   * 返回 null = 文件未变，一个字节都没读。
   */
  private async planFile(
    file: string,
    workspaceRoot: string,
    workspaceId: string,
    forgotten: string[]
  ): Promise<IndexedSession | null> {
    let st;
    try {
      st = await stat(file);
    } catch {
      // 扫描期间被删掉：跳过，下次 sync 时索引行会因为查不到文件而保持原样。
      return null;
    }

    const existing = this.bySourcePath(file);
    // 闸 1：mtime + size 双命中即整文件跳过。
    // 零消息的坏文件（只有 loop-state、没有 session 头）也走这里：必须补一次
    // 头部校验，否则会永远留在「未命名任务」里，一点就让 pi 退出。
    if (existing && existing.mtimeMs === st.mtimeMs && existing.sizeBytes === st.size) {
      if (existing.messageCount === 0 && st.size > 0) {
        const peek = await readRange(file, 0, Math.min(HASH_HEAD_BYTES, st.size) - 1);
        if (isBrokenPiSessionFile(st.size, peek)) forgotten.push(file);
      }
      return null;
    }

    const head = await readRange(file, 0, Math.min(HASH_HEAD_BYTES, st.size) - 1);
    if (isBrokenPiSessionFile(st.size, head)) {
      if (existing) forgotten.push(file);
      return null;
    }
    const contentHash = createHash("sha256").update(head).digest("hex").slice(0, 32);

    // 归属判定（SES-2）。**必须在算出任何一行之前**：settings.sessionDir 允许
    // 多个工作区共用一个会话目录，而下面这一整段是无条件把 workspaceId 写成
    // 「本次同步的那个工作区」——于是 A 工作区每同步一次，就把 B 的会话全部
    // 重标成自己的，B 那边再同步一次又抢回去。用户看到的是「历史会话时有时无」。
    //
    // 头部的 cwd 不属于本工作区就整份跳过：既不重标，也不改它的任何统计。
    const cwd = headerCwd(head);
    if (cwd && !samePath(cwd, workspaceRoot)) return null;

    // 闸 2：头部哈希变了 = 文件被外部截断或重写，之前算出来的偏移与统计
    // 全部作废，只能从头再来。
    const rewritten = !existing || existing.contentHash !== contentHash;
    const from = rewritten ? 0 : Math.min(existing.scanOffset, st.size);

    const acc: ParseAccum = rewritten
      ? {
          sessionId: "",
          name: null,
          preview: "",
          searchBlob: "",
          messageCount: 0,
          tokenTotal: 0,
          costTotal: 0,
          modelId: null,
        }
      : {
          sessionId: existing.sessionId,
          name: existing.name,
          preview: existing.preview,
          searchBlob: existing.searchBlob,
          messageCount: existing.messageCount,
          tokenTotal: existing.tokenTotal,
          costTotal: existing.costTotal,
          modelId: existing.modelId,
        };

    // 闸 3：只读 [from, size) 这一段新增字节。
    const buf = await readRange(file, from, st.size - 1);
    const lastNl = buf.lastIndexOf(0x0a);
    // 尾部半行（pi 正在写）不解析，也不把 scan_offset 推过去 —— 下次从行首续。
    const consumable = lastNl >= 0 ? buf.subarray(0, lastNl + 1) : Buffer.alloc(0);
    for (const line of consumable.toString("utf8").split("\n")) consume(acc, line);
    const scanOffset = from + consumable.length;

    return {
      sourcePath: file,
      workspaceRoot,
      workspaceId,
      sessionId: acc.sessionId || path.basename(file, ".jsonl"),
      scanOffset,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      contentHash,
      name: acc.name,
      preview: acc.preview,
      searchBlob: acc.searchBlob,
      messageCount: acc.messageCount,
      tokenTotal: acc.tokenTotal,
      costTotal: acc.costTotal,
      modelId: acc.modelId,
      // 用户整理过的状态（置顶/归档/回收站/未读）跟着 source_path 走，
      // 重新解析文件内容绝不能把它们抹掉。
      status: existing?.status ?? "active",
      pinned: existing?.pinned ?? false,
      unread: existing ? existing.unread : false,
      running: existing?.running ?? false,
      deletedAt: existing?.deletedAt ?? null,
    };
  }

  /**
   * ON CONFLICT 保证同一 source_path 恒只有一行 —— 并发调用不会插出重复。
   * search_blob 用累加后的值覆盖，其余整理态由 planFile 带过来。
   */
  private upsert(row: IndexedSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
           source_path, workspace_root, workspace_id, session_id, scan_offset,
           mtime_ms, size_bytes, content_hash, name, preview, search_blob,
           message_count, token_total, cost_total, model_id, status,
           pinned, unread, running, deleted_at, last_indexed_at, schema_version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_path) DO UPDATE SET
           workspace_root = excluded.workspace_root,
           workspace_id   = excluded.workspace_id,
           session_id     = excluded.session_id,
           scan_offset    = excluded.scan_offset,
           mtime_ms       = excluded.mtime_ms,
           size_bytes     = excluded.size_bytes,
           content_hash   = excluded.content_hash,
           name           = excluded.name,
           preview        = excluded.preview,
           search_blob    = excluded.search_blob,
           message_count  = excluded.message_count,
           token_total    = excluded.token_total,
           cost_total     = excluded.cost_total,
           model_id       = excluded.model_id,
           last_indexed_at = excluded.last_indexed_at,
           schema_version  = excluded.schema_version`
      )
      .run(
        row.sourcePath,
        row.workspaceRoot,
        row.workspaceId,
        row.sessionId,
        row.scanOffset,
        row.mtimeMs,
        row.sizeBytes,
        row.contentHash,
        row.name,
        row.preview,
        row.searchBlob,
        row.messageCount,
        row.tokenTotal,
        row.costTotal,
        row.modelId,
        row.status,
        row.pinned ? 1 : 0,
        row.unread ? 1 : 0,
        row.running ? 1 : 0,
        row.deletedAt,
        Date.now(),
        SESSION_INDEX_SCHEMA_VERSION
      );
  }

  // ------------------------------------------------------------ 查询

  /**
   * 按条件查索引。
   *
   * `ORDER BY pinned DESC, mtime_ms DESC` —— 置顶恒在最前，是唯一口径。
   */
  query(filter: SessionQuery): IndexedSession[] {
    const where: string[] = ["workspace_id = ?"];
    const args: (string | number)[] = [filter.workspaceId];

    // 不指定 status 时默认只看活动会话：回收站里的东西不该混在主列表里。
    where.push("status = ?");
    args.push(filter.status ?? "active");

    const search = filter.search?.trim();
    if (search) {
      where.push(
        "(IFNULL(name,'') LIKE ? OR IFNULL(preview,'') LIKE ? OR IFNULL(search_blob,'') LIKE ?)"
      );
      const like = `%${search}%`;
      args.push(like, like, like);
    }
    if (filter.modelId) {
      where.push("model_id = ?");
      args.push(filter.modelId);
    }
    if (typeof filter.from === "number") {
      where.push("mtime_ms >= ?");
      args.push(filter.from);
    }
    if (typeof filter.to === "number") {
      where.push("mtime_ms <= ?");
      args.push(filter.to);
    }

    args.push(filter.limit ?? DEFAULT_QUERY_LIMIT, filter.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE ${where.join(" AND ")}
         ORDER BY pinned DESC, mtime_ms DESC LIMIT ? OFFSET ?`
      )
      .all(...args) as Record<string, unknown>[];
    return rows.map(fromDbRow);
  }

  bySourcePath(sourcePath: string): IndexedSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE source_path = ?")
      .get(sourcePath) as Record<string, unknown> | undefined;
    return row ? fromDbRow(row) : null;
  }

  /**
   * 只摘索引行，不动磁盘上的 jsonl。
   * 坏文件不能交给 pi，但也不能悄悄删用户的文件。
   */
  forgetSource(sourcePath: string): void {
    this.db.prepare("DELETE FROM sessions WHERE source_path = ?").run(sourcePath);
  }

  /**
   * (workspaceId, sessionId) → 索引行。跨进程边界只有这两个不透明标识，
   * 真实路径在这里才被解出来。
   *
   * **workspaceId 必填**。sessionId 只在一个工作区之内唯一：复制一份 .jsonl、
   * 从备份里恢复、或两个工作区共用一个自定义 session-dir，都会让同一个 id
   * 在表里出现两行。早先这里是全局「取最近修改的那行」，于是重命名 / 归档 /
   * purge / 草稿读写都可能落到另一个工作区的会话上 —— purge 那一条不可逆。
   *
   * 同一工作区内仍可能撞 id（同一份文件被复制到子目录）；那种情况下取最近
   * 修改的那个，与用户「刚才在用的那个」一致。
   */
  bySessionId(sessionId: string, workspaceId: string): IndexedSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE session_id = ? AND workspace_id = ?
         ORDER BY mtime_ms DESC LIMIT 1`
      )
      .get(sessionId, workspaceId) as Record<string, unknown> | undefined;
    return row ? fromDbRow(row) : null;
  }

  // ------------------------------------------------------------ 整理动作

  /** 只改索引里的展示名。落到会话文件由 session-rename.ts 经 RPC 完成。 */
  rename(sourcePath: string, name: string): void {
    this.db.prepare("UPDATE sessions SET name = ? WHERE source_path = ?").run(name, sourcePath);
  }

  setPinned(sourcePath: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE sessions SET pinned = ? WHERE source_path = ?")
      .run(pinned ? 1 : 0, sourcePath);
  }

  /**
   * 归档 / 移入回收站 / 恢复。
   *
   * **只改状态列，绝不碰 .jsonl**：回收站是索引里的一个字段，不是删文件。
   * 真正把文件交出去只发生在 purge()。
   */
  setStatus(sourcePath: string, status: SessionStatus): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, deleted_at = ? WHERE source_path = ?")
      .run(status, status === "trashed" ? Date.now() : null, sourcePath);
  }

  setUnread(sourcePath: string, unread: boolean): void {
    this.db
      .prepare("UPDATE sessions SET unread = ? WHERE source_path = ?")
      .run(unread ? 1 : 0, sourcePath);
  }

  setRunning(sourcePath: string, running: boolean): void {
    this.db
      .prepare("UPDATE sessions SET running = ? WHERE source_path = ?")
      .run(running ? 1 : 0, sourcePath);
  }

  /**
   * 彻底删除：把会话文件交给**系统回收站**（不是 unlink），再删索引行。
   * 用 shell.trashItem 而不是 fs 删除，是为了让误操作还有一次挽回机会。
   */
  async purge(sourcePath: string): Promise<void> {
    try {
      await shell.trashItem(sourcePath);
    } catch {
      // 文件已经不在了（用户在文件管理器里先删了）：索引行照样要清掉，
      // 否则列表里留着一条永远打不开的幽灵会话。
    }
    this.db.prepare("DELETE FROM sessions WHERE source_path = ?").run(sourcePath);
  }

  // ------------------------------------------------------------ 草稿

  /** 无草稿返回 null（不是 `{}`）—— 空对象会让调用方误以为有一份空草稿。 */
  getDraft(sourcePath: string): DraftRecord | null {
    const row = this.db
      .prepare("SELECT draft_json FROM sessions WHERE source_path = ?")
      .get(sourcePath) as { draft_json?: string | null } | undefined;
    if (!row || typeof row.draft_json !== "string" || !row.draft_json) return null;
    try {
      return JSON.parse(row.draft_json) as DraftRecord;
    } catch {
      return null;
    }
  }

  /**
   * 写草稿。**目标会话不存在时返回 false 且不插新行** —— 静默 upsert
   * 出一条没有会话文件的孤儿记录，比丢草稿更难查。
   */
  saveDraft(sourcePath: string, draft: DraftRecord): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET draft_text = ?, draft_json = ? WHERE source_path = ?")
      .run(draft.text, JSON.stringify(draft), sourcePath);
    return Number(result.changes) > 0;
  }
}

function fromDbRow(row: Record<string, unknown>): IndexedSession {
  return {
    sourcePath: String(row.source_path),
    workspaceRoot: String(row.workspace_root),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    scanOffset: Number(row.scan_offset ?? 0),
    mtimeMs: Number(row.mtime_ms ?? 0),
    sizeBytes: Number(row.size_bytes ?? 0),
    contentHash: String(row.content_hash ?? ""),
    name: row.name == null ? null : String(row.name),
    preview: row.preview == null ? "" : String(row.preview),
    searchBlob: row.search_blob == null ? "" : String(row.search_blob),
    messageCount: Number(row.message_count ?? 0),
    tokenTotal: Number(row.token_total ?? 0),
    costTotal: Number(row.cost_total ?? 0),
    modelId: row.model_id == null ? null : String(row.model_id),
    status: String(row.status ?? "active") as SessionStatus,
    pinned: Number(row.pinned ?? 0) === 1,
    unread: Number(row.unread ?? 0) === 1,
    running: Number(row.running ?? 0) === 1,
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  };
}

/** 索引行 → 渲染侧视图。sourcePath / workspaceRoot 在这一步被丢掉。 */
export function toSessionRow(row: IndexedSession): SessionRow {
  return {
    sessionId: row.sessionId,
    ...(row.name ? { name: row.name } : {}),
    preview: row.preview,
    messageCount: row.messageCount,
    tokenTotal: row.tokenTotal,
    costTotal: row.costTotal,
    ...(row.modelId ? { modelId: row.modelId } : {}),
    status: row.status,
    pinned: row.pinned,
    unread: row.unread,
    running: row.running,
    modified: row.mtimeMs,
    sizeBytes: row.sizeBytes,
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
  };
}

// ---------------------------------------------------------------- 单例

let shared: SessionIndex | null = null;

/** 全进程唯一的索引实例（惰性打开，测试可经 __setSessionIndexDataDir 重置）。 */
export function sessionIndex(): SessionIndex {
  if (!shared) shared = new SessionIndex();
  return shared;
}

/**
 * 枚举某个工作目录下的会话。**全仓唯一的枚举入口**（裁定 5）。
 *
 * 先增量同步再查索引：目录没变化时 syncWorkspace 一个字节都不读，
 * 因此这条路径在稳态下的开销就是一次 SQLite 查询。
 */
export async function listSessionsForWorkspace(
  workspaceRoot: string,
  settings: AppSettings,
  filter: Omit<SessionQuery, "workspaceId"> = {}
): Promise<SessionRow[]> {
  if (!workspaceRoot) return [];
  const index = sessionIndex();
  await index.syncWorkspace(workspaceRoot, settings);
  return index
    .query({ ...filter, workspaceId: workspaceIdFor(workspaceRoot) })
    .map(toSessionRow);
}

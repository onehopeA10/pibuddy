/**
 * 长期记忆库（MEM-101 第一版）——**全仓唯一的记忆持久化实现**。
 *
 * ## 存储形态：主表 + FTS5 影子表 + meta
 *
 *   memories       记忆本体（正文、类别、作用域、来源、置信度、敏感度、过期…）
 *   memories_fts   FTS5 影子表（trigram 分词），只为检索存在
 *   memory_meta    键值对，存注入开关（全局 / 逐工作区）
 *
 * FTS 用 `trigram` 而不是默认的 unicode61：本项目以中文为主，unicode61 会把
 * 一整段连续中文当成**一个** token，于是搜「数据库」命不中「用的是数据库」——
 * 那种「搜了一个字都搜不到」的检索比没有还糟。trigram 做子串匹配，中英文一致，
 * 代价是 <3 字的查询走不了 MATCH，那种情况回落到 LIKE。
 *
 * ## 删除必须覆盖正文 + FTS + cache
 *
 * 「保存 → 命中注入 → 删除 → 再查零命中」是这套记忆的核心安全承诺。因此
 * `delete` / `merge` 一律**同时**清主表与 FTS 影子表；注入命中的内存 cache 不在
 * 本文件（在 memory-inject.ts），它在删除时由 IPC 层一并清掉。少清任何一处，
 * 一条被用户删掉的记忆都可能在之后某一轮里又被检索到、又被注入 —— 这正是
 * memory-inject.spec 用完整时序钉死的那条。
 *
 * ## secret 默认不进 memory
 *
 * `classifyContent` 在保存 / 编辑入口把疑似密钥的内容直接挡下（不落库），把
 * 疑似敏感路径的内容标 `sensitive`（落库但默认不注入）。这不是靠调用方自觉：
 * save / update 两条路都必过它。
 *
 * ## 本文件不 import electron 的可测部分
 *
 * DB 路径经 `app.getPath` 取，但落盘目录可被 `__setMemoryDataDir` 覆盖，单测
 * 因此在纯 node 下就能跑一整套 CRUD / FTS / 删除时序，不必给 electron 打桩。
 */
import { app } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MEMORY_DATA_SCHEMA_VERSION,
  type MemoryRecord,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryType,
} from "@pibuddy/contract";

import { classifyContent } from "./memory-secret.js";

/** 单条注入命中候选，带匹配分（命中的词数）。 */
export interface InjectionCandidate extends MemoryRecord {
  score: number;
}

export interface SaveInput {
  workspaceId: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  sourceSessionId?: string | null;
  sourceTurnId?: string | null;
  confidence?: number;
  expiry?: number | null;
  sensitivity?: MemorySensitivity;
}

export interface SaveOutcome {
  ok: boolean;
  record: MemoryRecord | null;
  message?: string;
  /** 记录归属的工作区（供 IPC 层解证据用）；失败时为 null */
  workspaceId: string | null;
  sourceSessionId?: string | null;
  sourceTurnId?: string | null;
}

export interface QueryInput {
  workspaceId: string;
  query?: string;
  scope?: MemoryScope;
  includeExcluded?: boolean;
}

const DDL_MEMORIES = `CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user',
  confidence REAL NOT NULL DEFAULT 1,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  excluded INTEGER NOT NULL DEFAULT 0,
  source_session_id TEXT,
  source_turn_id TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  expiry INTEGER,
  schema_version INTEGER NOT NULL
)`;

/** trigram：中英文一致的子串匹配。删除主表行时必须同步删这里（见文件头）。 */
const DDL_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(id UNINDEXED, content, tokenize = 'trigram')`;

const DDL_META = `CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** meta 键：全局注入总开关。 */
const META_GLOBAL_INJECTION = "global_injection_enabled";
/** meta 键前缀：逐工作区注入开关。 */
const META_WS_INJECTION_PREFIX = "workspace_injection:";

// ---------------------------------------------------------------- 落盘位置

let dataDirOverride: string | null = null;
let shared: MemoryStore | null = null;

/** 仅供单测：把记忆库指向临时目录，并丢弃单例。 */
export function __setMemoryDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "memory.db");
}

/**
 * FTS5 字符串字面量：双引号包裹，内部的 `"` 翻倍。
 *
 * 没有它的话，用户搜一句带引号的内容会让 MATCH 的查询语法当场解析失败，
 * 表现为「一搜就报错」。
 */
function ftsLiteral(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** 从一段文本里抽出可用于检索的词。中文按 2~4 字滑窗补几个子串，英文按单词。 */
export function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  // 英文 / 数字单词（长度 >= 2）
  for (const m of text.matchAll(/[a-z0-9_]{2,}/gi)) terms.add(m[0].toLowerCase());
  // 连续中文串按 2 / 3 字滑窗（trigram 需要 >=3 字才走 MATCH，2 字回落 LIKE）
  for (const run of text.matchAll(/[一-龥]{2,}/g)) {
    const s = run[0];
    for (let i = 0; i < s.length - 1; i++) {
      terms.add(s.slice(i, i + 2));
      if (i < s.length - 2) terms.add(s.slice(i, i + 3));
    }
  }
  return [...terms];
}

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL_MEMORIES);
    this.db.exec(DDL_FTS);
    this.db.exec(DDL_META);
    this.migrate();
  }

  /** 用 `PRAGMA user_version` 记代际；升级在这里补分支，绝不静默重建。 */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current === MEMORY_DATA_SCHEMA_VERSION) return;
    // 用旧版打开新版库：不动它，别把用户在新版里整理好的记忆搞坏。
    if (current > MEMORY_DATA_SCHEMA_VERSION) return;
    this.db.exec(`PRAGMA user_version = ${MEMORY_DATA_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ 写入

  /**
   * 保存一条记忆。secret 命中即拒绝（不落库）；敏感路径标 sensitive 后落库。
   */
  save(input: SaveInput): SaveOutcome {
    const verdict = classifyContent(input.content);
    if (verdict.rejected) {
      return { ok: false, record: null, message: verdict.reason, workspaceId: null };
    }
    const now = Date.now();
    const id = randomUUID();
    const sensitivity: MemorySensitivity =
      input.sensitivity ?? (verdict.sensitive ? "sensitive" : "normal");
    const record: MemoryRecord = {
      id,
      content: input.content,
      type: input.type,
      scope: input.scope,
      origin: "user",
      confidence: input.confidence ?? 1,
      sensitivity,
      excluded: false,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
      created: now,
      updated: now,
      expiry: input.expiry ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO memories (id, workspace_id, content, type, scope, origin, confidence,
           sensitivity, excluded, source_session_id, source_turn_id, created, updated, expiry, schema_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.workspaceId,
        record.content,
        record.type,
        record.scope,
        record.origin,
        record.confidence,
        record.sensitivity,
        0,
        record.sourceSessionId,
        record.sourceTurnId,
        now,
        now,
        record.expiry,
        MEMORY_DATA_SCHEMA_VERSION
      );
    this.db
      .prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)")
      .run(id, record.content);
    return {
      ok: true,
      record,
      workspaceId: input.workspaceId,
      sourceSessionId: record.sourceSessionId,
      sourceTurnId: record.sourceTurnId,
    };
  }

  /** 编辑。改正文会重跑一次 secret 检测（否则 secret 从编辑旁路进来）。 */
  update(
    id: string,
    patch: Partial<Pick<MemoryRecord, "content" | "type" | "scope" | "confidence" | "expiry" | "sensitivity" | "excluded">>
  ): SaveOutcome {
    const existing = this.rowById(id);
    if (!existing) return { ok: false, record: null, message: "记忆不存在", workspaceId: null };

    let sensitivity = existing.sensitivity;
    if (patch.content !== undefined && patch.content !== existing.content) {
      const verdict = classifyContent(patch.content);
      if (verdict.rejected) {
        return { ok: false, record: null, message: verdict.reason, workspaceId: existing.workspaceId };
      }
      if (patch.sensitivity === undefined && verdict.sensitive) sensitivity = "sensitive";
    }
    if (patch.sensitivity !== undefined) sensitivity = patch.sensitivity;

    const next: MemoryRecord = {
      ...existing.record,
      content: patch.content ?? existing.content,
      type: patch.type ?? existing.record.type,
      scope: patch.scope ?? existing.record.scope,
      confidence: patch.confidence ?? existing.record.confidence,
      expiry: patch.expiry !== undefined ? patch.expiry : existing.record.expiry,
      sensitivity,
      excluded: patch.excluded ?? existing.record.excluded,
      updated: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE memories SET content=?, type=?, scope=?, confidence=?, expiry=?, sensitivity=?, excluded=?, updated=?
         WHERE id=?`
      )
      .run(
        next.content,
        next.type,
        next.scope,
        next.confidence,
        next.expiry,
        next.sensitivity,
        next.excluded ? 1 : 0,
        next.updated,
        id
      );
    // FTS 影子表跟着正文走：正文变了不同步，检索命中的是旧字。
    this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(id, next.content);
    return { ok: true, record: next, workspaceId: existing.workspaceId };
  }

  /**
   * 合并：删掉给定的若干条，插入一条新的。
   *
   * 被删的那几条同样要清 FTS —— 否则它们的旧正文还留在检索里，合并等于
   * 「看着少了几条，搜起来还在」。
   */
  merge(workspaceId: string, ids: string[], content: string): SaveOutcome {
    const verdict = classifyContent(content);
    if (verdict.rejected) {
      return { ok: false, record: null, message: verdict.reason, workspaceId };
    }
    // 取第一条的类别 / 作用域作为合并结果的默认，取不到就用最保守的默认。
    const first = ids.map((id) => this.rowById(id)).find((r) => r !== null);
    const type: MemoryType = first?.record.type ?? "fact";
    const scope: MemoryScope = first?.record.scope ?? "workspace";
    for (const id of ids) this.deleteInternal(id);
    return this.save({ workspaceId, content, type, scope });
  }

  /** 删除一条：主表 + FTS 一起清。返回删掉的归属工作区（供 IPC 清命中 cache）。 */
  delete(id: string): { ok: boolean; workspaceId: string | null } {
    const existing = this.rowById(id);
    if (!existing) return { ok: false, workspaceId: null };
    this.deleteInternal(id);
    return { ok: true, workspaceId: existing.workspaceId };
  }

  private deleteInternal(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
  }

  // ------------------------------------------------------------ 读取

  get(id: string): MemoryRecord | null {
    return this.rowById(id)?.record ?? null;
  }

  /**
   * 一条记忆的来源坐标（供 memory-evidence 把它解回会话原文）。
   *
   * workspaceId 是它被保存时的 origin 工作区（无论作用域是 workspace 还是
   * global 都记着），会话索引正是靠它把不透明 sessionId 解成 JSONL 路径。
   */
  originOf(id: string): { workspaceId: string; sessionId: string | null; turnId: string | null } | null {
    const row = this.rowById(id);
    if (!row) return null;
    return {
      workspaceId: row.workspaceId,
      sessionId: row.record.sourceSessionId,
      turnId: row.record.sourceTurnId,
    };
  }

  /** 内部行（含 workspace_id）；对外一律经 record 视图，不外发分区键。 */
  private rowById(id: string): { record: MemoryRecord; workspaceId: string; content: string; sensitivity: MemorySensitivity } | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      record: toRecord(row),
      workspaceId: String(row.workspace_id),
      content: String(row.content),
      sensitivity: String(row.sensitivity) as MemorySensitivity,
    };
  }

  /**
   * 管理视图查询（memory:query）。
   *
   * 有检索词且长度 >= 3 走 FTS 子串匹配；1~2 字回落 LIKE（trigram 索引不到）。
   */
  query(input: QueryInput): MemoryRecord[] {
    const where: string[] = ["(scope = 'global' OR workspace_id = ?)"];
    const args: (string | number)[] = [input.workspaceId];
    if (input.scope) {
      where.push("scope = ?");
      args.push(input.scope);
    }
    if (!input.includeExcluded) where.push("excluded = 0");

    const q = input.query?.trim();
    if (q) {
      const ids = this.searchIds(q);
      if (ids.length === 0) return [];
      where.push(`id IN (${ids.map(() => "?").join(",")})`);
      args.push(...ids);
    }
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY updated DESC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /** 一个检索词 → 命中的 id 集合。>=3 字走 FTS，否则 LIKE。 */
  private searchIds(term: string): string[] {
    if (term.length >= 3) {
      try {
        const rows = this.db
          .prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH ?")
          .all(ftsLiteral(term)) as { id: string }[];
        return rows.map((r) => r.id);
      } catch {
        // MATCH 语法异常时回落 LIKE，绝不让「搜一下就报错」。
      }
    }
    const rows = this.db
      .prepare("SELECT id FROM memories WHERE content LIKE ?")
      .all(`%${term}%`) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * 注入候选（memory-inject 用）。
   *
   * 只返回**有资格注入**的记录：未排除、非 sensitive、未过期、作用域匹配。
   * 按提示词里抽出的词命中，命中词数即分。sensitive 在这里就被 SQL 挡掉 ——
   * 它绝不进注入，也因此绝不进命中记录。
   */
  injectionCandidates(workspaceId: string, terms: string[], limit: number): InjectionCandidate[] {
    if (terms.length === 0) return [];
    const now = Date.now();
    const hitCount = new Map<string, number>();
    for (const term of terms) {
      for (const id of this.searchIds(term)) {
        hitCount.set(id, (hitCount.get(id) ?? 0) + 1);
      }
    }
    if (hitCount.size === 0) return [];
    const ids = [...hitCount.keys()];
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE id IN (${ids.map(() => "?").join(",")})
           AND (scope = 'global' OR workspace_id = ?)
           AND excluded = 0
           AND sensitivity = 'normal'
           AND (expiry IS NULL OR expiry > ?)`
      )
      .all(...ids, workspaceId, now) as Record<string, unknown>[];
    return rows
      .map((row) => ({ ...toRecord(row), score: hitCount.get(String(row.id)) ?? 0 }))
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || b.updated - a.updated)
      .slice(0, limit);
  }

  /** 导出：某工作区可见的全部记录（含被排除的，导出是带走全部）。 */
  exportAll(workspaceId: string, scope?: MemoryScope): MemoryRecord[] {
    const where: string[] = ["(scope = 'global' OR workspace_id = ?)"];
    const args: (string | number)[] = [workspaceId];
    if (scope) {
      where.push("scope = ?");
      args.push(scope);
    }
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY created ASC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  // ------------------------------------------------------------ 注入开关

  /** 缺省即启用：一条 meta 都没有时注入是开的（用户存了记忆本就是要用它）。 */
  private metaBool(key: string, fallback: boolean): boolean {
    const row = this.db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    if (!row || row.value === undefined) return fallback;
    return row.value === "1";
  }

  private setMeta(key: string, value: boolean): void {
    this.db
      .prepare(
        "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value ? "1" : "0");
  }

  globalInjectionEnabled(): boolean {
    return this.metaBool(META_GLOBAL_INJECTION, true);
  }

  workspaceInjectionEnabled(workspaceId: string): boolean {
    return this.metaBool(`${META_WS_INJECTION_PREFIX}${workspaceId}`, true);
  }

  /** 某工作区当下是否会注入 = 全局开 且 该工作区开。 */
  injectionActive(workspaceId: string): boolean {
    return this.globalInjectionEnabled() && this.workspaceInjectionEnabled(workspaceId);
  }

  setInjection(workspaceId: string, target: "workspace" | "global", enabled: boolean): void {
    if (target === "global") this.setMeta(META_GLOBAL_INJECTION, enabled);
    else this.setMeta(`${META_WS_INJECTION_PREFIX}${workspaceId}`, enabled);
  }
}

/** DB 行 → 渲染侧视图。workspace_id 在这一步被丢掉（分区键不外发）。 */
function toRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    content: String(row.content ?? ""),
    type: String(row.type ?? "fact") as MemoryType,
    scope: String(row.scope ?? "workspace") as MemoryScope,
    origin: (String(row.origin ?? "user") === "inferred" ? "inferred" : "user"),
    confidence: Number(row.confidence ?? 1),
    sensitivity: String(row.sensitivity ?? "normal") as MemorySensitivity,
    excluded: Number(row.excluded ?? 0) === 1,
    sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
    sourceTurnId: row.source_turn_id == null ? null : String(row.source_turn_id),
    created: Number(row.created ?? 0),
    updated: Number(row.updated ?? 0),
    expiry: row.expiry == null ? null : Number(row.expiry),
  };
}

// ---------------------------------------------------------------- 单例

/** 全进程唯一的记忆库（惰性打开：未启用能力时永不创建 memory.db）。 */
export function memoryStore(): MemoryStore {
  if (!shared) shared = new MemoryStore();
  return shared;
}

/** 拆卸：关掉 sqlite 句柄。**不删 memory.db**（禁用 ≠ 删数据）。 */
export function closeMemoryStore(): void {
  if (shared) {
    shared.close();
    shared = null;
  }
}

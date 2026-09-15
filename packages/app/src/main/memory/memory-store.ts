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
  type KnowledgeRecord,
  type KnowledgeSourceKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryType,
  type WorkingExpiry,
  type WorkingItem,
} from "@pibuddy/contract";

import { classifyContent } from "./memory-secret.js";
import { deserializeVector, serializeVector } from "./memory-vector.js";

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
  /**
   * 来源。缺省 `user`（用户显式保存）。v2 的有限抽取传 `inferred` —— 连同
   * confidence<1 一起，明确「这是推断的、可能是错的」，绝不伪装成用户亲手记下的事实。
   */
  origin?: "user" | "inferred";
  /** 缺省 false。抽取出来的候选默认 true（不自动注入，等用户确认）。 */
  excluded?: boolean;
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

/**
 * 向量表（v2）——语义检索的存储面。
 *
 * `(kind, ref_id)` 主键：kind 区分 memory / knowledge，ref_id 指向对应主表的 id。
 * `model` 记产出这条向量的 embedder 标识 —— 检索只比同 model 的向量（本地哈希与
 * Provider 向量落在不同空间，混算无意义）。`vec` 是 Float32Array 的 BLOB，纯 JS
 * 余弦，不引任何原生向量库（check-pure-js-deps 闸门）。
 */
const DDL_EMBEDDINGS = `CREATE TABLE IF NOT EXISTS embeddings (
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'workspace',
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (kind, ref_id)
)`;

/** 知识库主表（v2）：文档 / 片段 + 来源坐标。删除时连 FTS 与向量一并清。 */
const DDL_KNOWLEDGE = `CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  source_turn_id TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
)`;

/** 知识库 FTS 影子表（trigram，中英一致）。 */
const DDL_KNOWLEDGE_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
  USING fts5(id UNINDEXED, content, tokenize = 'trigram')`;

/** v3：当前任务缓存（Working）。不改 memories 行。 */
const DDL_WORKING_ITEMS = `CREATE TABLE IF NOT EXISTS working_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source_memory_id TEXT,
  source_hash TEXT,
  created_turn INTEGER NOT NULL,
  expires TEXT NOT NULL,
  refresh_on_source_change INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const DDL_WORKING_SESSION_IDX = `CREATE INDEX IF NOT EXISTS idx_working_workspace_session
  ON working_items(workspace_id, session_id, expires)`;

const DDL_WORKING_SOURCE_IDX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_working_workspace_session_source
  ON working_items(workspace_id, session_id, source_memory_id) WHERE source_memory_id IS NOT NULL`;

const DDL_MEMORY_CANDIDATES = `CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  workspace_id TEXT,
  logical_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
)`;

const DDL_MEMORY_CONFLICTS = `CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT PRIMARY KEY,
  claim_key TEXT NOT NULL,
  memory_ids_json TEXT NOT NULL,
  resolution TEXT,
  requires_validation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  resolved_at TEXT
)`;

const DDL_MEMORY_ROUTE_EVENTS = `CREATE TABLE IF NOT EXISTS memory_route_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  retrieved INTEGER NOT NULL DEFAULT 0,
  admitted INTEGER NOT NULL DEFAULT 0,
  injected INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  live_validations INTEGER NOT NULL DEFAULT 0,
  token_cost INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  task_success INTEGER,
  memory_helpful INTEGER,
  created_at TEXT NOT NULL
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
  private transactionDepth = 0;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL_MEMORIES);
    this.db.exec(DDL_FTS);
    this.db.exec(DDL_META);
    // v2 表：CREATE IF NOT EXISTS 幂等 —— 用 v2 代码打开 v1 库时，这几条把新表
    // 补上而**不动** v1 已有的 memories / FTS / meta 一个字节（迁移不丢数据）。
    this.db.exec(DDL_EMBEDDINGS);
    this.db.exec(DDL_KNOWLEDGE);
    this.db.exec(DDL_KNOWLEDGE_FTS);
    // v3 治理表：同样 IF NOT EXISTS，不动 memories / FTS / embeddings 一个字节。
    this.db.exec(DDL_WORKING_ITEMS);
    this.db.exec(DDL_MEMORY_CANDIDATES);
    this.db.exec(DDL_MEMORY_CONFLICTS);
    this.db.exec(DDL_MEMORY_ROUTE_EVENTS);
    // v4 索引依赖 working_items.workspace_id。v3 库的表没有这一列，
    // CREATE TABLE IF NOT EXISTS 不会改已有表；若先建索引会抛 no such column，
    // migrate() 永远跑不到。必须先补列再建模。
    this.migrate();
  }

  /**
   * 用 `PRAGMA user_version` 记代际；升级在这里补分支，绝不静默重建。
   *
   * v1(1) → v2(2)：新表已在构造里以 IF NOT EXISTS 建好（非破坏性），这里只把
   * 代际推到当前版本。老库里已有的 memories 一条不动，语义检索所需的向量按需
   * 补算（memory:reembed / 保存时嵌入），因此「迁移不丢数据」是真的——v1 的
   * 记录迁移后仍能被 FTS 查到、能被注入，只是尚无向量直到被重嵌。
   *
   * v2(2) → v3(3)：只加 working / candidates / conflicts / route_events，
   * 不改 v1/v2 行字节。
   *
   * v3(3) → v4(4)：working_items 补 workspace_id，重建按工作区隔离的索引。
   */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current > MEMORY_DATA_SCHEMA_VERSION) return;
    // 代际已是 4 也要看列：构造中途抛错过的库可能列还没有、代际却已被推高。
    if (current < 4 || this.workingItemsMissingWorkspace()) this.migrateWorkingWorkspace();
    if (current < MEMORY_DATA_SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${MEMORY_DATA_SCHEMA_VERSION}`);
    }
  }

  private workingItemsMissingWorkspace(): boolean {
    const cols = this.db.prepare("PRAGMA table_info(working_items)").all() as { name: string }[];
    return !cols.some((col) => col.name === "workspace_id");
  }

  private migrateWorkingWorkspace(): void {
    if (this.workingItemsMissingWorkspace()) {
      this.db.exec(`ALTER TABLE working_items ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec("DROP INDEX IF EXISTS idx_working_session");
    this.db.exec("DROP INDEX IF EXISTS idx_working_session_source");
    this.db.exec(DDL_WORKING_SESSION_IDX);
    this.db.exec(DDL_WORKING_SOURCE_IDX);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 保留触发回滚的原始错误。
      }
      throw error;
    } finally {
      this.transactionDepth--;
    }
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
      origin: input.origin ?? "user",
      confidence: input.confidence ?? 1,
      sensitivity,
      excluded: input.excluded ?? false,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
      created: now,
      updated: now,
      expiry: input.expiry ?? null,
    };
    this.transaction(() => {
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
        record.excluded ? 1 : 0,
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
    });
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
    this.transaction(() => {
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
    });
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
    return this.transaction(() => {
      for (const id of ids) this.deleteInternal(id);
      return this.save({ workspaceId, content, type, scope });
    });
  }

  /** 删除一条：主表 + FTS 一起清。返回删掉的归属工作区（供 IPC 清命中 cache）。 */
  delete(id: string): { ok: boolean; workspaceId: string | null } {
    const existing = this.rowById(id);
    if (!existing) return { ok: false, workspaceId: null };
    this.transaction(() => this.deleteInternal(id));
    return { ok: true, workspaceId: existing.workspaceId };
  }

  private deleteInternal(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    // v2：向量也要清 —— 否则「删除后语义检索仍命中」，与「删除后 FTS 零命中」
    // 是同一条安全承诺的另一半。少清这一处，一条被删的记忆还能被向量余弦捞回来。
    this.db.prepare("DELETE FROM embeddings WHERE kind = 'memory' AND ref_id = ?").run(id);
    // v3：Working 指针也要清，否则删除后下一轮仍会注入已死来源。
    this.db.prepare("DELETE FROM working_items WHERE source_memory_id = ?").run(id);
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

  // ============================================================ v2：向量存储

  /** 写入 / 覆盖一条向量。同 (kind, ref_id) 覆盖，换 model 就换了向量空间。 */
  upsertEmbedding(
    kind: "memory" | "knowledge",
    refId: string,
    workspaceId: string,
    scope: MemoryScope,
    model: string,
    vec: Float32Array
  ): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (kind, ref_id, workspace_id, scope, model, dim, vec)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(kind, ref_id) DO UPDATE SET
           workspace_id = excluded.workspace_id, scope = excluded.scope,
           model = excluded.model, dim = excluded.dim, vec = excluded.vec`
      )
      .run(kind, refId, workspaceId, scope, model, vec.length, serializeVector(vec));
  }

  deleteEmbedding(kind: "memory" | "knowledge", refId: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE kind = ? AND ref_id = ?").run(kind, refId);
  }

  /**
   * 可注入 / 可检索的记忆 + 它们的向量（同 model）。
   *
   * 资格与 injectionCandidates 一致（未排除、非 sensitive、未过期、作用域匹配），
   * 再内连 embeddings 只取同 model 的向量。跨 model 的旧向量在这里被自然排除 ——
   * 换了 embedder 但没重嵌时语义部分为空，而不是拿错空间的向量乱算。
   */
  eligibleMemoryVectors(workspaceId: string, model: string): { record: MemoryRecord; vec: Float32Array }[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT m.*, e.vec AS __vec FROM memories m
         JOIN embeddings e ON e.kind = 'memory' AND e.ref_id = m.id AND e.model = ?
         WHERE (m.scope = 'global' OR m.workspace_id = ?)
           AND m.excluded = 0 AND m.sensitivity = 'normal'
           AND (m.expiry IS NULL OR m.expiry > ?)`
      )
      .all(model, workspaceId, now) as Record<string, unknown>[];
    return rows.map((row) => ({
      record: toRecord(row),
      vec: deserializeVector(row.__vec as Uint8Array),
    }));
  }

  /** 某工作区可见（scope global 或本区）的全部记忆（正文 + 作用域），供重嵌。 */
  visibleMemoriesForEmbedding(workspaceId: string): { id: string; content: string; scope: MemoryScope }[] {
    const rows = this.db
      .prepare(
        "SELECT id, content, scope FROM memories WHERE scope = 'global' OR workspace_id = ?"
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      content: String(r.content),
      scope: String(r.scope) as MemoryScope,
    }));
  }

  /** 可见记忆总数 与 已按 model 嵌入的数（供 embed-status）。 */
  memoryEmbedCounts(workspaceId: string, model: string): { total: number; embedded: number } {
    const total = (
      this.db
        .prepare("SELECT count(*) c FROM memories WHERE scope = 'global' OR workspace_id = ?")
        .get(workspaceId) as { c: number }
    ).c;
    const embedded = (
      this.db
        .prepare(
          `SELECT count(*) c FROM memories m
           JOIN embeddings e ON e.kind = 'memory' AND e.ref_id = m.id AND e.model = ?
           WHERE m.scope = 'global' OR m.workspace_id = ?`
        )
        .get(model, workspaceId) as { c: number }
    ).c;
    return { total, embedded };
  }

  // ============================================================ v2：知识库

  /** 加入一条知识片段。secret 命中即拒（不落库）——知识库同样不该收密钥。 */
  addKnowledge(input: {
    workspaceId: string;
    title: string;
    content: string;
    sourceKind: KnowledgeSourceKind;
    sourceRef?: string | null;
    sourceTurnId?: string | null;
  }): { ok: boolean; record: KnowledgeRecord | null; message?: string } {
    const verdict = classifyContent(input.content);
    if (verdict.rejected) return { ok: false, record: null, message: verdict.reason };
    const now = Date.now();
    const id = randomUUID();
    const record: KnowledgeRecord = {
      id,
      title: input.title,
      content: input.content,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
      created: now,
      updated: now,
    };
    this.transaction(() => {
      this.db
        .prepare(
        `INSERT INTO knowledge (id, workspace_id, title, content, source_kind, source_ref, source_turn_id, created, updated)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
        .run(
          id,
          input.workspaceId,
          record.title,
          record.content,
          record.sourceKind,
          record.sourceRef,
          record.sourceTurnId,
          now,
          now
        );
      this.db.prepare("INSERT INTO knowledge_fts (id, content) VALUES (?, ?)").run(id, record.content);
    });
    return { ok: true, record };
  }

  getKnowledge(id: string): KnowledgeRecord | null {
    const row = this.db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toKnowledgeRecord(row) : null;
  }

  /** 一条知识的归属工作区（删除时清向量用）。 */
  knowledgeWorkspace(id: string): string | null {
    const row = this.db.prepare("SELECT workspace_id FROM knowledge WHERE id = ?").get(id) as
      | { workspace_id?: string }
      | undefined;
    return row?.workspace_id ? String(row.workspace_id) : null;
  }

  listKnowledge(workspaceId: string): KnowledgeRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM knowledge WHERE workspace_id = ? ORDER BY updated DESC")
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map(toKnowledgeRecord);
  }

  /** 删除一条知识：主表 + FTS + 向量一起清（与记忆删除同一套覆盖承诺）。 */
  deleteKnowledge(id: string): { ok: boolean } {
    const exists = this.db.prepare("SELECT 1 FROM knowledge WHERE id = ?").get(id);
    if (!exists) return { ok: false };
    this.transaction(() => {
      this.db.prepare("DELETE FROM knowledge WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM knowledge_fts WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM embeddings WHERE kind = 'knowledge' AND ref_id = ?").run(id);
    });
    return { ok: true };
  }

  /** 知识 FTS 命中：term → id 集合（>=3 字走 FTS，否则 LIKE）。 */
  knowledgeSearchIds(term: string): string[] {
    if (term.length >= 3) {
      try {
        const rows = this.db
          .prepare("SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH ?")
          .all(ftsLiteral(term)) as { id: string }[];
        return rows.map((r) => r.id);
      } catch {
        /* 回落 LIKE */
      }
    }
    const rows = this.db
      .prepare("SELECT id FROM knowledge WHERE content LIKE ?")
      .all(`%${term}%`) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** 一组 term 在知识库里的命中计数：id → 命中词数（FTS 分）。 */
  knowledgeFtsHits(workspaceId: string, terms: string[]): Map<string, { record: KnowledgeRecord; hits: number }> {
    const out = new Map<string, { record: KnowledgeRecord; hits: number }>();
    if (terms.length === 0) return out;
    const count = new Map<string, number>();
    for (const term of terms) {
      for (const id of this.knowledgeSearchIds(term)) count.set(id, (count.get(id) ?? 0) + 1);
    }
    for (const [id, hits] of count) {
      const row = this.db
        .prepare("SELECT * FROM knowledge WHERE id = ? AND workspace_id = ?")
        .get(id, workspaceId) as Record<string, unknown> | undefined;
      if (row) out.set(id, { record: toKnowledgeRecord(row), hits });
    }
    return out;
  }

  /** 知识片段 + 向量（同 model），供语义检索。 */
  knowledgeVectors(workspaceId: string, model: string): { record: KnowledgeRecord; vec: Float32Array }[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, e.vec AS __vec FROM knowledge k
         JOIN embeddings e ON e.kind = 'knowledge' AND e.ref_id = k.id AND e.model = ?
         WHERE k.workspace_id = ?`
      )
      .all(model, workspaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      record: toKnowledgeRecord(row),
      vec: deserializeVector(row.__vec as Uint8Array),
    }));
  }

  /** 某工作区的全部知识片段（正文），供重嵌。 */
  knowledgeForEmbedding(workspaceId: string): { id: string; content: string }[] {
    const rows = this.db
      .prepare("SELECT id, content FROM knowledge WHERE workspace_id = ?")
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), content: String(r.content) }));
  }

  knowledgeEmbedCounts(workspaceId: string, model: string): { total: number; embedded: number } {
    const total = (
      this.db.prepare("SELECT count(*) c FROM knowledge WHERE workspace_id = ?").get(workspaceId) as {
        c: number;
      }
    ).c;
    const embedded = (
      this.db
        .prepare(
          `SELECT count(*) c FROM knowledge k
           JOIN embeddings e ON e.kind = 'knowledge' AND e.ref_id = k.id AND e.model = ?
           WHERE k.workspace_id = ?`
        )
        .get(model, workspaceId) as { c: number }
    ).c;
    return { total, embedded };
  }

  // ============================================================ v2：嵌入配置（meta）

  /** 读嵌入后端配置（存 memory_meta，全局一份）。缺省 local。 */
  embeddingConfig(): { backend: "local" | "provider"; provider: string | null; model: string | null } {
    const backend = this.metaString("embedding_backend") === "provider" ? "provider" : "local";
    return {
      backend,
      provider: this.metaString("embedding_provider"),
      model: this.metaString("embedding_model"),
    };
  }

  setEmbeddingConfig(config: { backend: "local" | "provider"; provider?: string; model?: string }): void {
    this.setMetaString("embedding_backend", config.backend);
    this.setMetaString("embedding_provider", config.backend === "provider" ? config.provider ?? "" : "");
    this.setMetaString("embedding_model", config.model ?? "");
  }

  private metaString(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    const value = row?.value ?? "";
    return value === "" ? null : value;
  }

  private setMetaString(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  // ------------------------------------------------------------ Working（v3）

  upsertWorkingItem(input: {
    workspaceId: string;
    sessionId: string;
    kind: string;
    content: string;
    sourceMemoryId?: string | null;
    sourceHash?: string | null;
    createdTurn?: number;
    expires?: WorkingExpiry;
    refreshOnSourceChange?: boolean;
  }): WorkingItem {
    const now = new Date().toISOString();
    const sourceId = input.sourceMemoryId ?? null;
    const workspaceId = input.workspaceId.trim();
    if (sourceId) {
      const existing = this.db
        .prepare(
          "SELECT id FROM working_items WHERE workspace_id = ? AND session_id = ? AND source_memory_id = ?"
        )
        .get(workspaceId, input.sessionId, sourceId) as { id?: string } | undefined;
      if (existing?.id) {
        this.db
          .prepare(
            `UPDATE working_items SET kind=?, content=?, source_hash=?, expires=?,
             refresh_on_source_change=?, updated_at=? WHERE id=?`
          )
          .run(
            input.kind,
            input.content,
            input.sourceHash ?? null,
            input.expires ?? "task_end",
            (input.refreshOnSourceChange ?? true) ? 1 : 0,
            now,
            existing.id
          );
        return this.getWorkingItem(existing.id)!;
      }
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO working_items (id, workspace_id, session_id, kind, content, source_memory_id, source_hash,
           created_turn, expires, refresh_on_source_change, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        workspaceId,
        input.sessionId,
        input.kind,
        input.content,
        sourceId,
        input.sourceHash ?? null,
        input.createdTurn ?? 0,
        input.expires ?? "task_end",
        (input.refreshOnSourceChange ?? true) ? 1 : 0,
        now,
        now
      );
    return this.getWorkingItem(id)!;
  }

  getWorkingItem(id: string): WorkingItem | null {
    const row = this.db.prepare("SELECT * FROM working_items WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toWorkingItem(row) : null;
  }

  listWorkingItems(workspaceId: string, sessionId: string): WorkingItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM working_items WHERE workspace_id = ? AND session_id = ? ORDER BY updated_at DESC"
      )
      .all(workspaceId, sessionId) as Record<string, unknown>[];
    return rows.map(toWorkingItem);
  }

  listWorkingSourceIds(workspaceId: string, sessionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT source_memory_id FROM working_items WHERE workspace_id = ? AND session_id = ? AND source_memory_id IS NOT NULL"
      )
      .all(workspaceId, sessionId) as { source_memory_id: string }[];
    return rows.map((r) => r.source_memory_id);
  }

  deleteWorkingItem(id: string): void {
    this.db.prepare("DELETE FROM working_items WHERE id = ?").run(id);
  }

  /**
   * source_hash 变了且 refresh_on_source_change=1 时删掉该 Working 项。
   * @returns true = 该项已失效并被删除
   */
  invalidateWorkingIfHashChanged(
    workspaceId: string,
    sessionId: string,
    sourceMemoryId: string,
    currentHash: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT id, source_hash, refresh_on_source_change FROM working_items
         WHERE workspace_id = ? AND session_id = ? AND source_memory_id = ?`
      )
      .get(workspaceId, sessionId, sourceMemoryId) as
      | { id: string; source_hash: string | null; refresh_on_source_change: number }
      | undefined;
    if (!row) return false;
    if (!row.refresh_on_source_change) return false;
    if (!row.source_hash || row.source_hash === currentHash) return false;
    this.db.prepare("DELETE FROM working_items WHERE id = ?").run(row.id);
    return true;
  }

  insertCandidate(input: {
    workspaceId: string;
    scope: string;
    logicalKind: string;
    payload: unknown;
    evidence: unknown;
  }): string | null {
    const scanned = `${JSON.stringify(input.payload)}\n${JSON.stringify(input.evidence)}`;
    if (classifyContent(scanned).rejected) return null;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_candidates (id, scope, workspace_id, logical_kind, payload_json, evidence_json, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.scope,
        input.workspaceId,
        input.logicalKind,
        JSON.stringify(input.payload),
        JSON.stringify(input.evidence),
        "pending",
        new Date().toISOString()
      );
    return id;
  }

  listCandidates(workspaceId: string): Array<{ id: string; logicalKind: string; status: string }> {
    const rows = this.db
      .prepare("SELECT id, logical_kind, status FROM memory_candidates WHERE workspace_id = ?")
      .all(workspaceId) as { id: string; logical_kind: string; status: string }[];
    return rows.map((r) => ({ id: r.id, logicalKind: r.logical_kind, status: r.status }));
  }

  recordRouteEvent(input: {
    requestId: string;
    sessionId?: string | null;
    mode: string;
    scopes: string[];
    retrieved: number;
    admitted: number;
    injected: number;
    conflicts: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_route_events (id, request_id, session_id, mode, scopes_json,
           retrieved, admitted, injected, conflicts, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        randomUUID(),
        input.requestId,
        input.sessionId ?? null,
        input.mode,
        JSON.stringify(input.scopes),
        input.retrieved,
        input.admitted,
        input.injected,
        input.conflicts,
        new Date().toISOString()
      );
  }
}

function toWorkingItem(row: Record<string, unknown>): WorkingItem {
  const expires = String(row.expires ?? "task_end");
  const expiry: WorkingExpiry =
    expires === "session_end" || expires === "manual" ? expires : "task_end";
  return {
    id: String(row.id),
    kind: String(row.kind ?? "fact"),
    content: String(row.content ?? ""),
    sourceMemoryId: row.source_memory_id == null ? null : String(row.source_memory_id),
    sourceHash: row.source_hash == null ? null : String(row.source_hash),
    createdTurn: Number(row.created_turn ?? 0),
    expires: expiry,
    refreshOnSourceChange: Number(row.refresh_on_source_change ?? 1) === 1,
  };
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

/** DB 行 → 知识片段视图（workspace_id 在这一步被丢掉）。 */
function toKnowledgeRecord(row: Record<string, unknown>): KnowledgeRecord {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    sourceKind: String(row.source_kind ?? "manual") as KnowledgeSourceKind,
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
    sourceTurnId: row.source_turn_id == null ? null : String(row.source_turn_id),
    created: Number(row.created ?? 0),
    updated: Number(row.updated ?? 0),
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

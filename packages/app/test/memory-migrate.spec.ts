import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1 → v2 迁移：**不丢用户已存的记忆**（MEM-101 第二版）。
 *
 * 这不是「断言 migrate 被调用过」这种恒真判据，而是造一个**真正的 v1 格式库**
 * （只有 v1 的三张表、user_version=1、里面躺着一条 v1 记录），用 v2 代码打开它，
 * 再逐项验证：
 *   1. 代际被推到 2；
 *   2. v1 那条记录**还在**、字段原样、FTS 仍能查到、仍能被注入候选选中；
 *   3. v2 的新表（embeddings / knowledge）已建好，老记录能被重嵌拿到语义检索能力。
 *
 * 少了迁移的非破坏性（比如 migrate 里 DROP/重建），第 2 步就会红。
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mem-migrate-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { MemoryStore, extractTerms } = await import("../src/main/memory/memory-store.js");
const { __setEmbedder, disposeEmbedder } = await import("../src/main/memory/memory-embed.js");
const { reembedWorkspace, searchMemories } = await import("../src/main/memory/memory-search.js");
const { DatabaseSync } = await import("node:sqlite");

const WS = "ws-v1";

/** 手工搭一个 v1 格式的库：只有 v1 三张表、user_version=1、一条 v1 记录。 */
function buildV1Db(file: string, id: string): void {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL,
    scope TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'user', confidence REAL NOT NULL DEFAULT 1,
    sensitivity TEXT NOT NULL DEFAULT 'normal', excluded INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT, source_turn_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    expiry INTEGER, schema_version INTEGER NOT NULL)`);
  db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, tokenize = 'trigram')");
  db.exec("CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("PRAGMA user_version = 1");
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, workspace_id, content, type, scope, origin, confidence, sensitivity,
       excluded, source_session_id, source_turn_id, created, updated, expiry, schema_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, WS, "后端用 PostgreSQL", "fact", "workspace", "user", 1, "normal", 0, null, null, now, now, null, 1);
  db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(id, "后端用 PostgreSQL");
  db.close();
}

let dbFile: string;
const V1_ID = "v1-record-0001";

beforeEach(() => {
  dbFile = path.join(userData, `v1-${Math.random().toString(36).slice(2)}.db`);
  buildV1Db(dbFile, V1_ID);
  __setEmbedder({ id: "fake-mig", dim: 2, embed: (t) => Promise.resolve(t.map(() => Float32Array.from([1, 0]))) });
});
afterEach(() => disposeEmbedder());

describe("用 v2 代码打开 v1 库", () => {
  it("代际被推到 2，且 v1 记录一条不丢", () => {
    const store = new MemoryStore(dbFile);
    try {
      // 代际到 2
      const raw = new DatabaseSync(dbFile);
      const ver = raw.prepare("PRAGMA user_version").get() as { user_version: number };
      raw.close();
      expect(ver.user_version).toBe(2);

      // v1 那条记录还在、字段原样
      const got = store.get(V1_ID);
      expect([got?.content, got?.type, got?.scope, got?.origin]).toEqual([
        "后端用 PostgreSQL",
        "fact",
        "workspace",
        "user",
      ]);
      // FTS 仍能查到
      expect(store.query({ workspaceId: WS, query: "postgres" }).map((r) => r.id)).toContain(V1_ID);
      // 仍能被注入候选选中
      expect(
        store.injectionCandidates(WS, extractTerms("PostgreSQL 数据库"), 8).map((c) => c.id)
      ).toContain(V1_ID);
    } finally {
      store.close();
    }
  });

  it("新表已建好，老记录能被重嵌拿到语义检索能力", async () => {
    const store = new MemoryStore(dbFile);
    try {
      // 迁移刚打开时老记录没有向量
      const counts = await reembedWorkspace(store, WS);
      expect(counts.embeddedMemories).toBe(1);
      // 重嵌后向量检索能捞到它（fake 恒定向量，任何查询都命中）
      const result = await searchMemories(WS, "任意查询", undefined, 8, store);
      expect(result.items.map((h) => h.record.id)).toContain(V1_ID);
    } finally {
      store.close();
    }
  });
});

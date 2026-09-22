import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 知识库的行为判据（MEM-101 第二版）。
 *
 * 钉三件事：
 *   1. **来源引用可追溯**：检索命中带 citation（来源三元组），不是一段无从核对的文本；
 *   2. **语义命中**：用 fake embedder 复现「向量命中、FTS 不命中」；
 *   3. **删除覆盖 FTS + 向量**：删完后 FTS 与向量都零命中（同记忆一套覆盖承诺）。
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mem-kb-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { MemoryStore } = await import("../src/main/memory/memory-store.js");
const { __setEmbedder, disposeEmbedder, localEmbedder } = await import(
  "../src/main/memory/memory-embed.js"
);
const { searchKnowledge, embedKnowledge } = await import("../src/main/memory/memory-search.js");
const { cosine, hashEmbed } = await import("../src/main/memory/memory-vector.js");
const { meaningfulLexicalOverlap } = await import("../src/main/memory/query-compiler.js");
const { DatabaseSync } = await import("node:sqlite");

const WS = "ws-kb";

const CONCEPTS: string[][] = [["postgres", "postgresql", "数据库", "database"], ["部署", "deploy", "上线"]];
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(CONCEPTS.length);
  const t = text.toLowerCase();
  CONCEPTS.forEach((words, i) => {
    if (words.some((w) => t.includes(w))) v[i] = 1;
  });
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}
const fake = { id: "fake-kb", dim: CONCEPTS.length, embed: (t: string[]) => Promise.resolve(t.map(fakeVec)) };

let store: InstanceType<typeof MemoryStore>;
let dbFile: string;

beforeEach(() => {
  dbFile = path.join(userData, `k-${Math.random().toString(36).slice(2)}.db`);
  store = new MemoryStore(dbFile);
  __setEmbedder(fake);
});
afterEach(() => {
  store.close();
  disposeEmbedder();
});

describe("加入 / 读取 / 列出", () => {
  it("加入后能取回，来源坐标原样", () => {
    const out = store.addKnowledge({
      workspaceId: WS,
      title: "部署手册",
      content: "生产环境用 PostgreSQL，迁移前先备份",
      sourceKind: "session",
      sourceRef: "sess-1",
      sourceTurnId: "turn-9",
    });
    expect(out.ok).toBe(true);
    const got = store.getKnowledge(out.record!.id)!;
    expect([got.title, got.sourceKind, got.sourceRef, got.sourceTurnId]).toEqual([
      "部署手册",
      "session",
      "sess-1",
      "turn-9",
    ]);
    expect(store.listKnowledge(WS).length).toBe(1);
  });

  it("secret 命中的知识被拒（不落库）", () => {
    const out = store.addKnowledge({
      workspaceId: WS,
      title: "配置",
      content: "线上 key 是 sk-abcdef0123456789abcdef0123",
      sourceKind: "manual",
    });
    expect(out.ok).toBe(false);
    expect(store.listKnowledge(WS).length).toBe(0);
  });
});

describe("语义检索带引用", () => {
  it("向量命中而 FTS 不命中：查「数据库」捞到含 PostgreSQL 的片段，且带来源引用", async () => {
    const out = store.addKnowledge({
      workspaceId: WS,
      title: "选型",
      content: "后端选了 PostgreSQL",
      sourceKind: "file",
      sourceRef: "docs/db.md",
    });
    await embedKnowledge(store, out.record!.id, WS, out.record!.content);

    const result = await searchKnowledge(WS, "数据库怎么选", 8, store);
    const hit = result.items.find((h) => h.record.id === out.record!.id)!;
    expect(hit).toBeTruthy();
    expect(hit.vectorScore).toBeGreaterThan(0);
    // 命中带引用：出自哪个文件可追溯
    expect([hit.citation.sourceKind, hit.citation.sourceRef]).toEqual(["file", "docs/db.md"]);
  });

  it("local hash 高余弦也不能靠通用 project 词绕过词法准入", async () => {
    __setEmbedder(localEmbedder());
    const query = "project build";
    const content = "project finance";
    const raw = cosine(hashEmbed(query), hashEmbed(content));
    expect(raw).toBeGreaterThan(0.25);
    expect(meaningfulLexicalOverlap(query, content)).toBe(0);

    const out = store.addKnowledge({
      workspaceId: WS,
      title: "Finance",
      content,
      sourceKind: "manual",
    });
    await embedKnowledge(store, out.record!.id, WS, content);

    const result = await searchKnowledge(WS, query, 8, store);
    expect(result.items).toEqual([]);
  });
});

describe("删除覆盖 FTS + 向量", () => {
  it("删除后 FTS 与向量都零命中", async () => {
    const out = store.addKnowledge({
      workspaceId: WS,
      title: "部署",
      content: "部署流程：先跑 migration 再切流量",
      sourceKind: "manual",
    });
    const id = out.record!.id;
    await embedKnowledge(store, id, WS, out.record!.content);
    // 命中在
    expect((await searchKnowledge(WS, "部署", 8, store)).items.map((h) => h.record.id)).toContain(id);

    expect(store.deleteKnowledge(id).ok).toBe(true);

    // FTS 语义都零命中
    const after = await searchKnowledge(WS, "部署上线", 8, store);
    expect(after.items.map((h) => h.record.id)).not.toContain(id);

    // 直接查底表：knowledge / knowledge_fts / embeddings 三处都不剩
    store.close();
    const raw = new DatabaseSync(dbFile);
    const k = raw.prepare("SELECT count(*) c FROM knowledge WHERE id=?").get(id) as { c: number };
    const kf = raw.prepare("SELECT count(*) c FROM knowledge_fts WHERE id=?").get(id) as { c: number };
    const e = raw.prepare("SELECT count(*) c FROM embeddings WHERE ref_id=?").get(id) as { c: number };
    raw.close();
    store = new MemoryStore(dbFile);
    expect([k.c, kf.c, e.c]).toEqual([0, 0, 0]);
  });
});

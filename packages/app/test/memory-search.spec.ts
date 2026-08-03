import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 语义检索 / 混合排序的行为判据（MEM-101 第二版）。
 *
 * ## 用可注入的 fake embedder 验证「近义不同词也能查到」
 *
 * 本地哈希嵌入只捕捉形近 / 子串，真正的近义（「数据库」查到「PostgreSQL」这类
 * 无共享字符的近义）需要 Provider 嵌入，而 CI / 本机未必有凭据。因此这里注入一个
 * **概念 fake embedder**：把同一概念的不同词映射到同一维，从而可控地复现「向量
 * 命中、FTS 不命中」的场景 —— 检索**逻辑本身**（混合排序、向量命中、删除覆盖向量）
 * 因此可证伪，不依赖任何外部凭据。
 *
 * ## 核心是一条完整时序，不是「delete 被调用过」
 *
 * 「删除后语义检索也零命中」这条承诺，用一条真实时序钉死：
 *   保存 → 嵌入 → 语义命中（FTS 不命中，纯向量捞到）→ 删除 → 再检索向量零命中。
 * 少清向量（deleteInternal 不删 embeddings）时，第 4 步仍会命中 —— 这条会变红。
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mem-search-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { MemoryStore } = await import("../src/main/memory/memory-store.js");
const { __setEmbedder, disposeEmbedder } = await import("../src/main/memory/memory-embed.js");
const { searchMemories, embedMemory, reembedWorkspace, embedStatus } = await import(
  "../src/main/memory/memory-search.js"
);
const { DatabaseSync } = await import("node:sqlite");

const WS = "ws-search";

/**
 * 概念 fake embedder：同一概念的不同词落在同一维 → 余弦为 1。
 * 「PostgreSQL / 数据库 / database」是一个概念，「中文 / chinese」是另一个。
 */
const CONCEPTS: string[][] = [
  ["postgres", "postgresql", "数据库", "database", " db "],
  ["中文", "chinese", "简体"],
  ["测试", "test", "vitest"],
];
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(CONCEPTS.length);
  const t = ` ${text.toLowerCase()} `;
  CONCEPTS.forEach((words, i) => {
    if (words.some((w) => t.includes(w.toLowerCase()))) v[i] = 1;
  });
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}
const fakeEmbedder = {
  id: "fake-concepts",
  dim: CONCEPTS.length,
  embed: (texts: string[]) => Promise.resolve(texts.map(fakeVec)),
};

let store: InstanceType<typeof MemoryStore>;
let dbFile: string;

beforeEach(() => {
  dbFile = path.join(userData, `s-${Math.random().toString(36).slice(2)}.db`);
  store = new MemoryStore(dbFile);
  __setEmbedder(fakeEmbedder);
});

afterEach(() => {
  store.close();
  disposeEmbedder();
});

describe("混合语义检索：近义不同词也能查到", () => {
  it("向量命中而 FTS 不命中：查「数据库」捞到「后端用 PostgreSQL」", async () => {
    const saved = store.save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    await embedMemory(store, saved.record!.id, WS, "workspace", saved.record!.content);

    // FTS 单独查不到（「数据库」与「PostgreSQL」无 trigram 交集）
    expect(store.query({ workspaceId: WS, query: "数据库" }).length).toBe(0);

    // 混合检索：向量把它捞回来
    const result = await searchMemories(WS, "换个数据库方案", undefined, 8, store);
    expect(result.items.map((h) => h.record.id)).toContain(saved.record!.id);
    const hit = result.items.find((h) => h.record.id === saved.record!.id)!;
    expect(hit.vectorScore).toBeGreaterThan(0);
    expect(hit.ftsScore).toBe(0);
    expect(result.backend).toBe("fake-concepts");
  });

  it("FTS 命中的记录同样进结果（混合，不是二选一）", async () => {
    const a = store.save({ workspaceId: WS, content: "回复统一用中文", type: "preference", scope: "workspace" });
    await embedMemory(store, a.record!.id, WS, "workspace", a.record!.content);
    const result = await searchMemories(WS, "中文", undefined, 8, store);
    expect(result.items.map((h) => h.record.id)).toContain(a.record!.id);
  });
});

describe("删除覆盖向量：保存 → 嵌入 → 语义命中 → 删除 → 向量零命中", () => {
  it("走完一整轮，删除后语义检索也捞不回来", async () => {
    const saved = store.save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    const id = saved.record!.id;
    await embedMemory(store, id, WS, "workspace", saved.record!.content);

    // 1) 语义命中（纯向量）
    const before = await searchMemories(WS, "选型数据库", undefined, 8, store);
    expect(before.items.map((h) => h.record.id)).toContain(id);

    // 2) 删除：主表 + FTS + 向量一起清
    expect(store.delete(id).ok).toBe(true);

    // 3) 语义检索零命中（少清 embeddings 时这一步会红）
    const after = await searchMemories(WS, "选型数据库", undefined, 8, store);
    expect(after.items.map((h) => h.record.id)).not.toContain(id);

    // 4) 直接查向量表：这条一行不剩（不是「delete 被调用过」这种恒真断言）
    store.close();
    const raw = new DatabaseSync(dbFile);
    const cnt = raw.prepare("SELECT count(*) c FROM embeddings WHERE ref_id = ?").get(id) as { c: number };
    raw.close();
    store = new MemoryStore(dbFile); // afterEach 会关掉
    expect(cnt.c).toBe(0);
  });
});

describe("重嵌：为缺向量的记录（含 v1 迁移上来的）补算", () => {
  it("先只保存不嵌入 → 语义查不到 → reembed 后语义查得到", async () => {
    const saved = store.save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    const id = saved.record!.id;

    // 未嵌入：eligibleMemoryVectors 为空，纯向量捞不到
    const before = await searchMemories(WS, "数据库选型", undefined, 8, store);
    expect(before.items.map((h) => h.record.id)).not.toContain(id);

    // 补算
    const counts = await reembedWorkspace(store, WS);
    expect(counts.embeddedMemories).toBe(1);

    const after = await searchMemories(WS, "数据库选型", undefined, 8, store);
    expect(after.items.map((h) => h.record.id)).toContain(id);
  });

  it("embed-status 如实报「已嵌入 / 总数」", async () => {
    store.save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    store.save({ workspaceId: WS, content: "回复统一用中文", type: "preference", scope: "workspace" });
    const s0 = embedStatus(WS, store);
    expect([s0.totalMemories, s0.embeddedMemories]).toEqual([2, 0]);
    await reembedWorkspace(store, WS);
    const s1 = embedStatus(WS, store);
    expect([s1.totalMemories, s1.embeddedMemories, s1.model]).toEqual([2, 2, "fake-concepts"]);
  });
});

describe("敏感 / 排除的记录不进语义候选", () => {
  it("被排除的记录即便有向量也不进检索结果", async () => {
    const saved = store.save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    await embedMemory(store, saved.record!.id, WS, "workspace", saved.record!.content);
    store.update(saved.record!.id, { excluded: true });
    const result = await searchMemories(WS, "数据库", undefined, 8, store);
    expect(result.items.map((h) => h.record.id)).not.toContain(saved.record!.id);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 记忆库的行为判据（MEM-101 第一版）。
 *
 * 重点钉三件容易变成恒真断言的事：
 *   1. **删除必须覆盖 FTS**：删完之后不仅主表查不到，FTS 影子表里也一条不剩 ——
 *      少清 FTS 的表现是「列表里没了，一搜又出来」，而那正是记忆删除的安全承诺
 *      要防的。用「删除后再检索恰好零命中」而不是「delete 被调用过」来断言。
 *   2. **secret 不落库**：不是「标记了敏感」，是**根本查不到**（total 恒 0）。
 *   3. **敏感 / 排除 / 过期不进注入候选**：三者都由 SQL 挡在候选之外，逐条验证。
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mem-store-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { MemoryStore, extractTerms } = await import("../src/main/memory/memory-store.js");
const { MEMORY_DATA_SCHEMA_VERSION } = await import("@pibuddy/contract");

const WS_A = "workspace-a";
const WS_B = "workspace-b";

let store: InstanceType<typeof MemoryStore>;
let dbFile: string;

beforeEach(() => {
  dbFile = path.join(userData, `mem-${Math.random().toString(36).slice(2)}.db`);
  store = new MemoryStore(dbFile);
});

afterEach(() => {
  store.close();
});

describe("保存与读取", () => {
  it("保存后能按 id 取回，字段原样", () => {
    const out = store.save({ workspaceId: WS_A, content: "回复统一用中文", type: "preference", scope: "workspace" });
    expect(out.ok).toBe(true);
    const got = store.get(out.record!.id);
    expect([got?.content, got?.type, got?.scope, got?.origin, got?.excluded]).toEqual([
      "回复统一用中文",
      "preference",
      "workspace",
      "user",
      false,
    ]);
  });

  it("schema 版本写进了 user_version", () => {
    // 打开同一个文件再读一次 PRAGMA：迁移把代际钉上了，不是每次重建。
    store.save({ workspaceId: WS_A, content: "x 是 y", type: "fact", scope: "workspace" });
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(dbFile);
    const row = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    raw.close();
    expect(row.user_version).toBe(MEMORY_DATA_SCHEMA_VERSION);
  });
});

describe("FTS 检索", () => {
  it("按英文子串命中", () => {
    store.save({ workspaceId: WS_A, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    expect(store.query({ workspaceId: WS_A, query: "postgres" }).length).toBe(1);
    expect(store.query({ workspaceId: WS_A, query: "mysql" }).length).toBe(0);
  });

  it("按中文子串命中（trigram，unicode61 做不到）", () => {
    store.save({ workspaceId: WS_A, content: "这个项目是给财务团队做的", type: "context", scope: "workspace" });
    expect(store.query({ workspaceId: WS_A, query: "财务" }).length).toBe(1);
  });
});

describe("删除必须覆盖正文 + FTS", () => {
  it("删除后主表与 FTS 都零命中", () => {
    const out = store.save({ workspaceId: WS_A, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    expect(store.query({ workspaceId: WS_A, query: "postgres" }).length).toBe(1);

    const del = store.delete(out.record!.id);
    expect(del.ok).toBe(true);

    // 主表：查不到
    expect(store.get(out.record!.id)).toBeNull();
    // FTS：再检索恰好零命中（不是「delete 被调用过」这种恒真断言）
    expect(store.query({ workspaceId: WS_A, query: "postgres" }).length).toBe(0);
    // 直接查 FTS 影子表：一行都不剩
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(dbFile);
    const cnt = raw.prepare("SELECT count(*) c FROM memories_fts").get() as { c: number };
    raw.close();
    expect(cnt.c).toBe(0);
  });

  it("合并会删掉被并入的几条（含它们的 FTS）", () => {
    const a = store.save({ workspaceId: WS_A, content: "偏好 A alpha", type: "preference", scope: "workspace" });
    const b = store.save({ workspaceId: WS_A, content: "偏好 B beta", type: "preference", scope: "workspace" });
    const merged = store.merge(WS_A, [a.record!.id, b.record!.id], "偏好 合并后 gamma");
    expect(merged.ok).toBe(true);
    // 旧的两条连 FTS 一起没了
    expect(store.query({ workspaceId: WS_A, query: "alpha" }).length).toBe(0);
    expect(store.query({ workspaceId: WS_A, query: "beta" }).length).toBe(0);
    // 新的一条在
    expect(store.query({ workspaceId: WS_A, query: "gamma" }).length).toBe(1);
  });
});

describe("secret 默认不进 memory（拒绝，不是标记）", () => {
  it("API key 前缀被拒，且根本查不到", () => {
    const out = store.save({
      workspaceId: WS_A,
      content: "我的 key 是 sk-abcdef0123456789abcdef0123",
      type: "fact",
      scope: "workspace",
    });
    expect(out.ok).toBe(false);
    expect(store.query({ workspaceId: WS_A }).length).toBe(0);
  });

  it("私钥 PEM 头被拒", () => {
    const out = store.save({
      workspaceId: WS_A,
      content: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
      type: "fact",
      scope: "workspace",
    });
    expect(out.ok).toBe(false);
  });

  it("password=xxx 赋值被拒", () => {
    const out = store.save({ workspaceId: WS_A, content: "password=hunter2xyz", type: "fact", scope: "workspace" });
    expect(out.ok).toBe(false);
  });

  it("编辑成 secret 同样被拒（不从编辑旁路进来）", () => {
    const out = store.save({ workspaceId: WS_A, content: "一句正常的话", type: "fact", scope: "workspace" });
    const upd = store.update(out.record!.id, { content: "token: ghp_abcdefghijklmnopqrstuvwxyz0123" });
    expect(upd.ok).toBe(false);
    // 原内容没被改坏
    expect(store.get(out.record!.id)?.content).toBe("一句正常的话");
  });
});

describe("注入候选：敏感 / 排除 / 过期都不进", () => {
  it("敏感路径落库但标 sensitive，且不进注入候选", () => {
    const out = store.save({
      workspaceId: WS_A,
      content: "我的私钥在 ~/.ssh/id_rsa 里",
      type: "fact",
      scope: "workspace",
    });
    expect(out.ok).toBe(true);
    expect(out.record!.sensitivity).toBe("sensitive");
    const terms = extractTerms("私钥 ssh");
    expect(store.injectionCandidates(WS_A, terms, 8).length).toBe(0);
  });

  it("被排除的不进注入候选，但 includeExcluded 查得到", () => {
    const out = store.save({ workspaceId: WS_A, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    store.update(out.record!.id, { excluded: true });
    expect(store.injectionCandidates(WS_A, extractTerms("postgresql"), 8).length).toBe(0);
    expect(store.query({ workspaceId: WS_A, includeExcluded: true }).length).toBe(1);
    expect(store.query({ workspaceId: WS_A, includeExcluded: false }).length).toBe(0);
  });

  it("已过期的不进注入候选", () => {
    store.save({
      workspaceId: WS_A,
      content: "临时事项 tempitem",
      type: "context",
      scope: "workspace",
      expiry: Date.now() - 1000,
    });
    expect(store.injectionCandidates(WS_A, extractTerms("tempitem"), 8).length).toBe(0);
  });

  it("global 作用域从别的工作区也命中", () => {
    store.save({ workspaceId: WS_A, content: "全局偏好 globalpref", type: "preference", scope: "global" });
    store.save({ workspaceId: WS_A, content: "本地偏好 localpref", type: "preference", scope: "workspace" });
    // 从 WS_B 看：global 那条进候选，workspace 那条不进
    const global = store.injectionCandidates(WS_B, extractTerms("globalpref"), 8);
    const local = store.injectionCandidates(WS_B, extractTerms("localpref"), 8);
    expect([global.length, local.length]).toEqual([1, 0]);
  });
});

describe("注入开关", () => {
  it("默认开；关工作区或关全局都会让 injectionActive 变假", () => {
    expect(store.injectionActive(WS_A)).toBe(true);
    store.setInjection(WS_A, "workspace", false);
    expect(store.injectionActive(WS_A)).toBe(false);
    store.setInjection(WS_A, "workspace", true);
    store.setInjection(WS_A, "global", false);
    // 全局关掉 = 任何工作区都不注入
    expect(store.injectionActive(WS_A)).toBe(false);
    expect(store.injectionActive(WS_B)).toBe(false);
  });
});

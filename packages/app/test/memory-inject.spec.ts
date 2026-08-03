import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 注入钩子的行为判据（MEM-101 第一版）。
 *
 * ## 核心是一条完整时序，不是「删除函数被调用过」
 *
 * 本项目多次抓到恒真断言。「删除后不再注入」这条尤其容易退化成「断言 delete
 * 被调了一次」——那种断言即便注入根本没清 cache 也照样绿。因此这里造一条真实
 * 时序：**保存 → 命中注入（message 真的被改写、命中记录真的落下）→ 删除 →
 * 再注入零命中（message 原样返回）→ 命中记录里也没有它**。少清任何一环，这条
 * 时序里就有一步对不上。
 *
 * ## 零成本门也在这里钉
 *
 * 能力未启用时 injectMemory 必须原样返回、且不落任何命中——即便库里明明有一条
 * 会命中的记忆。这条与「启用时会注入」合起来才是一条可证伪的判据。
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mem-inject-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { __setMemoryDataDir, memoryStore } = await import("../src/main/memory/memory-store.js");
const { injectMemory, memoryHitsFor, clearHitsForMemory, disposeMemoryInject } = await import(
  "../src/main/memory/memory-inject.js"
);
const { applyCapabilityResolution, __resetCapabilityState } = await import(
  "../src/main/capability/capability-state.js"
);
const { MEMORY_CAPABILITY_ID } = await import("../src/main/capability/manifests/memory.manifest.js");

const WS = "ws-inject";
const PROMPT = "我用的是 PostgreSQL 数据库，帮我写个查询";

beforeEach(() => {
  const dir = path.join(userData, `d-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  __setMemoryDataDir(dir);
  disposeMemoryInject();
  // 默认把记忆能力设为启用（真实装配路径会这么做）。
  applyCapabilityResolution([MEMORY_CAPABILITY_ID]);
});

afterEach(() => {
  disposeMemoryInject();
  __resetCapabilityState();
  __setMemoryDataDir(null);
});

describe("完整时序：保存 → 命中注入 → 删除 → 零命中", () => {
  it("走完一整轮，每一步都对得上", async () => {
    const saved = memoryStore().save({
      workspaceId: WS,
      content: "后端用 PostgreSQL",
      type: "fact",
      scope: "workspace",
    });
    expect(saved.ok).toBe(true);
    const id = saved.record!.id;

    // 1) 命中注入：message 被改写、包含记忆正文、命中记录落下
    const injected = await injectMemory(PROMPT, WS);
    expect(injected).not.toBe(PROMPT);
    expect(injected).toContain("后端用 PostgreSQL");
    expect(injected).toContain(PROMPT);
    const hitsAfterInject = memoryHitsFor(WS);
    expect(hitsAfterInject.map((h) => h.id)).toContain(id);

    // 2) 删除：主表 + FTS + 向量（store）+ 命中 cache（inject）一起清
    memoryStore().delete(id);
    clearHitsForMemory(id);

    // 3) 再注入：原样返回，什么都不加
    const afterDelete = await injectMemory(PROMPT, WS);
    expect(afterDelete).toBe(PROMPT);

    // 4) 命中记录里也没有它了
    expect(memoryHitsFor(WS).map((h) => h.id)).not.toContain(id);

    // 5) 检索也零命中
    expect(memoryStore().query({ workspaceId: WS, query: "postgres" }).length).toBe(0);
  });
});

describe("零成本门：能力未启用时原样返回、不落命中", () => {
  it("库里有会命中的记忆，但能力关着 → 注入不发生", async () => {
    memoryStore().save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    // 关掉记忆能力
    applyCapabilityResolution([]);
    const out = await injectMemory(PROMPT, WS);
    expect(out).toBe(PROMPT);
    expect(memoryHitsFor(WS)).toEqual([]);
  });
});

describe("注入总开关", () => {
  it("关掉工作区注入 → 即便有命中也不注入", async () => {
    memoryStore().save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    memoryStore().setInjection(WS, "workspace", false);
    expect(await injectMemory(PROMPT, WS)).toBe(PROMPT);
    expect(memoryHitsFor(WS)).toEqual([]);
  });

  it("关掉全局注入 → 任何工作区都不注入", async () => {
    memoryStore().save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    memoryStore().setInjection(WS, "global", false);
    expect(await injectMemory(PROMPT, WS)).toBe(PROMPT);
  });
});

describe("敏感记忆不注入、不进命中", () => {
  it("sensitive 记忆既不改写 message，也不出现在命中记录里", async () => {
    memoryStore().save({
      workspaceId: WS,
      content: "我的私钥在 ~/.ssh/id_rsa 数据库凭证",
      type: "fact",
      scope: "workspace",
    });
    const out = await injectMemory("数据库 私钥在哪", WS);
    expect(out).toBe("数据库 私钥在哪");
    expect(memoryHitsFor(WS)).toEqual([]);
  });
});

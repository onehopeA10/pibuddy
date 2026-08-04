import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 有限自动抽取的边界 case（FEAT-memory-v2.md §6 deferred 之外、§2「有限抽取」
 * 的红线）。两层：
 *
 *   1. **默认启发式抽取器**的边界（纯函数，直接喂 turns 断言）：只看用户消息、
 *      去重、最短长度、线索词分类、句子切分、不命中不抽。
 *   2. **落库不变量**（ADR 红线：总结不是不可更正真相）：无论抽取器换成什么，
 *      落库的每条恒为 origin=inferred / confidence=0.5 / excluded=true，且 secret
 *      候选被 save 拒。用可注入抽取器 + 真实 MemoryStore 钉死这四道结构约束。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mem-extract-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { defaultExtractor, extractFromSession, __setFactExtractor } = await import(
  "../src/main/memory/memory-extract.js"
);
const { MemoryStore } = await import("../src/main/memory/memory-store.js");
import type { SessionTurn, FactCandidate } from "../src/main/memory/memory-extract.js";

function userTurn(text: string, turnId: string | null = "t1"): SessionTurn {
  return { turnId, role: "user", text };
}

describe("默认启发式抽取器：边界", () => {
  it("只看用户消息：assistant / system 的话一律不抽", () => {
    const out = defaultExtractor([
      { turnId: "a", role: "assistant", text: "我喜欢用 TypeScript" },
      { turnId: "s", role: "system", text: "请始终用中文" },
    ]);
    expect(out).toEqual([]);
  });

  it("命中偏好 / 指令 / 事实线索词才抽，并带回正确 type 与 turnId", () => {
    const out = defaultExtractor([
      userTurn("我喜欢用深色主题", "turn-9"),
      userTurn("以后回复都用中文", "turn-9"),
      userTurn("这个项目后端用 Rust", "turn-9"),
    ]);
    const byType = Object.fromEntries(out.map((c) => [c.type, c.content]));
    expect(byType.preference).toContain("喜欢");
    expect(byType.instruction).toContain("以后");
    expect(byType.fact).toContain("后端用");
    expect(out.every((c) => c.turnId === "turn-9")).toBe(true);
  });

  it("无任何线索词的句子不抽（宁可少抽，不把随口一句当长期事实）", () => {
    expect(defaultExtractor([userTurn("今天天气不错啊")])).toEqual([]);
  });

  it("按标点切句，逐句判定", () => {
    const out = defaultExtractor([userTurn("你好。我喜欢简洁的代码！随便说说")]);
    // 只有「我喜欢简洁的代码」这句命中
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("我喜欢简洁的代码");
  });

  it("去重：同一句话出现两次只抽一条", () => {
    const out = defaultExtractor([userTurn("我喜欢用 Vim"), userTurn("我喜欢用 Vim")]);
    expect(out).toHaveLength(1);
  });

  it("太短的句子（< 4 字）跳过", () => {
    expect(defaultExtractor([userTurn("喜欢")])).toEqual([]);
  });
});

describe("落库不变量：抽取的候选绝不冒充真相（ADR 红线）", () => {
  let store: InstanceType<typeof MemoryStore>;
  let dbFile: string;

  beforeEach(() => {
    dbFile = path.join(userData, `ex-${Math.random().toString(36).slice(2)}.db`);
    store = new MemoryStore(dbFile);
  });
  afterEach(() => {
    store.close();
    __setFactExtractor(null);
  });

  it("每条落库恒为 inferred / confidence=0.5 / excluded=true（默认不注入）", async () => {
    __setFactExtractor((): FactCandidate[] => [
      { content: "偏好深色主题", type: "preference", turnId: "u1" },
      { content: "项目叫 PiBuddy", type: "fact", turnId: "u2" },
    ]);
    const { candidates, scannedTurns } = await extractFromSession("ws-x", "sess-1", 10, store);

    expect(candidates).toHaveLength(2);
    for (const rec of candidates) {
      expect(rec.origin).toBe("inferred");
      expect(rec.confidence).toBe(0.5);
      expect(rec.excluded).toBe(true);
      expect(rec.sourceSessionId).toBe("sess-1");
    }
    // 无真实工作区 → readSessionTurns 返回空，scannedTurns=0（如实计数）。
    expect(scannedTurns).toBe(0);

    // excluded=true 的直接后果：即便 terms 命中正文，注入候选里也一条都没有。
    const injectable = store.injectionCandidates("ws-x", ["偏好", "项目", "深色"], 10);
    expect(injectable).toHaveLength(0);
  });

  it("secret 候选被 save 拒：不落库（抽取同样不把密钥收进记忆）", async () => {
    __setFactExtractor((): FactCandidate[] => [
      { content: "正常偏好：喜欢简洁", type: "preference", turnId: "u1" },
      { content: "我的 key 是 sk-abcdef0123456789ghij", type: "fact", turnId: "u2" },
    ]);
    const { candidates } = await extractFromSession("ws-y", "sess-2", 10, store);
    // secret 那条被拒，只剩正常那条
    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toContain("喜欢简洁");
    expect(candidates.some((c) => c.content.includes("sk-"))).toBe(false);
  });

  it("limit 截断：抽取器给再多，只落 limit 条", async () => {
    __setFactExtractor((): FactCandidate[] =>
      Array.from({ length: 5 }, (_, i) => ({
        content: `偏好条目 ${i}`,
        type: "preference" as const,
        turnId: `u${i}`,
      }))
    );
    const { candidates } = await extractFromSession("ws-z", "sess-3", 2, store);
    expect(candidates).toHaveLength(2);
  });
});

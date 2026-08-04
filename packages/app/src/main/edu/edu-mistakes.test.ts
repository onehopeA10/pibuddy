/**
 * 错题本解析与档案落盘的判据（edu.kids / REQ-0001 R3）。
 *
 * 解析的核心取舍是**宽进**：写入方是模型（经 SKILL.md 约定），坏一行只跳
 * 一行并计数，绝不让一行坏数据把整个错题本从面板上抹掉。档案落盘的核心
 * 取舍是**按 workspaceId 分区 + 坏文件当空档案重建**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseMistakeJsonl } from "./edu-mistakes.js";

vi.mock("electron", () => ({ app: { getPath: () => userDataDir } }));

let userDataDir = "";

const LINE = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    date: "2026-08-01",
    subject: "math",
    topic: "三位数退位减法",
    question: "502 - 178 =",
    wrong: "336",
    right: "324",
    note: "忘了借位",
    ...over,
  });

describe("parseMistakeJsonl：宽进严出", () => {
  it("合法行全部归一化；缺可选字段补 null", () => {
    const text = [LINE(), LINE({ wrong: undefined, right: undefined, note: undefined })].join("\n");
    const parsed = parseMistakeJsonl(text, 200);
    expect(parsed.total).toBe(2);
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries[1]).toEqual({
      date: "2026-08-01",
      subject: "math",
      topic: "三位数退位减法",
      question: "502 - 178 =",
      wrong: null,
      right: null,
      note: null,
    });
  });

  it("坏行只跳该行并计数：整行非 JSON、缺必填字段、JSON 数组都算坏行", () => {
    const text = [
      LINE(),
      "这不是 JSON",
      LINE({ topic: "" }),
      LINE({ question: undefined }),
      "[1,2,3]",
      LINE({ topic: "表内乘法" }),
    ].join("\n");
    const parsed = parseMistakeJsonl(text, 200);
    expect(parsed.total).toBe(2);
    expect(parsed.skipped).toBe(4);
  });

  it("空行不算坏行；未知字段不让整行失效", () => {
    const text = `\n${LINE({ extra: "模型多写的字段" })}\n\n`;
    const parsed = parseMistakeJsonl(text, 200);
    expect(parsed.total).toBe(1);
    expect(parsed.skipped).toBe(0);
  });

  it("按日期倒序、同日保持写入顺序；limit 截断但 total 报全量", () => {
    const text = [
      LINE({ date: "2026-08-01", topic: "A" }),
      LINE({ date: "2026-08-03", topic: "B1" }),
      LINE({ date: "2026-08-03", topic: "B2" }),
      LINE({ date: "not-a-date", topic: "C" }),
    ].join("\n");
    const parsed = parseMistakeJsonl(text, 3);
    expect(parsed.entries.map((e) => e.topic)).toEqual(["B1", "B2", "A"]);
    expect(parsed.total).toBe(4);
    // 非法日期归空串（最旧），被 limit 截掉的是它
    expect(parsed.entries.some((e) => e.topic === "C")).toBe(false);
  });

  it("非法日期与未知科目：不丢行，归一化为空串 / 原样保留", () => {
    const parsed = parseMistakeJsonl(LINE({ date: "08/01", subject: "奥数" }), 10);
    expect(parsed.entries[0].date).toBe("");
    expect(parsed.entries[0].subject).toBe("奥数");
  });
});

describe("edu-profile-store：按 workspaceId 分区落盘", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-edu-"));
  });
  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  async function freshStore(): Promise<typeof import("./edu-profile-store.js")> {
    vi.resetModules();
    const mod = await import("./edu-profile-store.js");
    mod.__setEduDataDir(userDataDir);
    return mod;
  }

  it("读写往返：两个 workspace 各自一份，互不串", async () => {
    const store = await freshStore();
    expect(store.loadEduProfile("ws-a")).toBeNull();
    store.saveEduProfile({ workspaceId: "ws-a", childName: "小明", grade: 3, subjects: ["math"] });
    store.saveEduProfile({
      workspaceId: "ws-b",
      childName: "小红",
      grade: 1,
      subjects: ["english", "chinese"],
    });
    const a = store.loadEduProfile("ws-a");
    const b = store.loadEduProfile("ws-b");
    expect([a?.childName, a?.grade, a?.subjects]).toEqual(["小明", 3, ["math"]]);
    expect([b?.childName, b?.grade, b?.subjects]).toEqual(["小红", 1, ["english", "chinese"]]);
    expect(a!.updatedAt).toBeGreaterThan(0);
  });

  it("重复科目在写入时去重", async () => {
    const store = await freshStore();
    store.saveEduProfile({
      workspaceId: "ws",
      childName: "",
      grade: 2,
      subjects: ["math", "math", "english"],
    });
    expect(store.loadEduProfile("ws")?.subjects).toEqual(["math", "english"]);
  });

  it("文件被手改坏：当空档案，写入路径原子重建", async () => {
    const store = await freshStore();
    const file = path.join(userDataDir, "edu-kids", "profiles.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ 坏掉的 JSON");
    expect(store.loadEduProfile("ws")).toBeNull();
    store.saveEduProfile({ workspaceId: "ws", childName: "小明", grade: 4, subjects: [] });
    expect(store.loadEduProfile("ws")?.grade).toBe(4);
  });

  it("坏条目（年级越界 / 非对象）读盘时被丢弃，好条目保留", async () => {
    const store = await freshStore();
    const file = path.join(userDataDir, "edu-kids", "profiles.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        workspaces: {
          bad1: { childName: "x", grade: 9, subjects: [], updatedAt: 1 },
          bad2: "不是对象",
          good: { childName: "小明", grade: 5, subjects: ["science", "不存在的科目"], updatedAt: 1 },
        },
      })
    );
    expect(store.loadEduProfile("bad1")).toBeNull();
    expect(store.loadEduProfile("bad2")).toBeNull();
    const good = store.loadEduProfile("good");
    expect([good?.grade, good?.subjects]).toEqual([5, ["science"]]);
  });
});

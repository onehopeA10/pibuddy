import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-conv-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { parseConversationIntents } = await import("../src/main/conversation/intent.js");
const { applyConversationActions } = await import("../src/main/conversation/apply-actions.js");
const { __setMemoryDataDir, memoryStore } = await import("../src/main/memory/memory-store.js");
const { __setTasksDataDir, taskStore } = await import("../src/main/tasks/task-store.js");
const { applyCapabilityResolution, __resetCapabilityState } = await import(
  "../src/main/capability/capability-state.js"
);
const { MEMORY_CAPABILITY_ID } = await import(
  "../src/main/capability/manifests/memory.manifest.js"
);
const { TASKS_CAPABILITY_ID } = await import("../src/main/capability/manifests/tasks.manifest.js");
const { OFFICE_SKILLS_CAPABILITY_ID } = await import(
  "../src/main/capability/manifests/office-skills.manifest.js"
);

const WS = "ws-conv";
const TZ = "Asia/Shanghai";
const NOW = Date.parse("2026-08-19T01:00:00+08:00");

let memDir: string;
let taskDir: string;

beforeEach(() => {
  memDir = path.join(userData, `m-${Math.random().toString(36).slice(2)}`);
  taskDir = path.join(userData, `t-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(memDir, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  __setMemoryDataDir(memDir);
  __setTasksDataDir(taskDir);
  applyCapabilityResolution([MEMORY_CAPABILITY_ID, TASKS_CAPABILITY_ID, OFFICE_SKILLS_CAPABILITY_ID]);
});

afterEach(() => {
  __resetCapabilityState();
  __setMemoryDataDir(null);
  __setTasksDataDir(null);
});

describe("parseConversationIntents 只认明确口令", () => {
  it("记住：… 抽出内容；我记得 / 记住了 不抽", () => {
    expect(parseConversationIntents("记住：我不吃辣")).toEqual([
      { kind: "remember", content: "我不吃辣" },
    ]);
    expect(parseConversationIntents("请记住下周出差")).toEqual([
      { kind: "remember", content: "下周出差" },
    ]);
    expect(parseConversationIntents("我记得昨天说过")).toEqual([]);
    expect(parseConversationIntents("记住了吗")).toEqual([]);
    expect(parseConversationIntents("你还记得我的名字吗")).toEqual([]);
  });

  it("每天 / 每周 / 明天 + 提醒 才建计划；光说提醒不建", () => {
    const daily = parseConversationIntents("每天早上9点提醒我看待办");
    expect(daily).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        schedule: { kind: "daily", time: "09:00" },
      })
    );
    const weekly = parseConversationIntents("每周一9:00提醒我交周报");
    expect(weekly).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        schedule: { kind: "weekly", weekdays: [1], time: "09:00" },
      })
    );
    const tomorrow = parseConversationIntents("明天下午3点提醒我开会");
    expect(tomorrow).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        resolve: "tomorrow",
        wallTime: "15:00",
      })
    );
    expect(parseConversationIntents("提醒我一下这个文件怎么打开")).toEqual([]);
    expect(parseConversationIntents("每天都这样")).toEqual([]);
    expect(parseConversationIntents("不要每天早上9点提醒我看待办")).toEqual([]);
    expect(parseConversationIntents("解释这句话，不要创建任务")).toEqual([]);
    const friday = parseConversationIntents("每星期五9:00提醒我交周报");
    expect(friday).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        schedule: { kind: "weekly", weekdays: [5], time: "09:00" },
      })
    );
    const tomorrowNight = parseConversationIntents("明晚8点提醒我开会");
    expect(tomorrowNight).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        resolve: "tomorrow",
        wallTime: "20:00",
      })
    );
  });

  it("办公技能按关键词挂上；已有 /skill:office- 不再挂", () => {
    expect(parseConversationIntents("用文件整理技能，把下载文件夹里的图片按月份归档")).toEqual([
      { kind: "office-skill", skillName: "office-file-organize" },
    ]);
    expect(parseConversationIntents("用表格处理技能，把 客户.csv 按手机号去重")).toEqual([
      { kind: "office-skill", skillName: "office-table-clean" },
    ]);
    expect(parseConversationIntents("用文档转换技能，把 会议纪要.md 转成 PDF")).toEqual([
      { kind: "office-skill", skillName: "office-doc-convert" },
    ]);
    expect(parseConversationIntents("/skill:office-file-organize\n整理一下")).toEqual([]);
    expect(parseConversationIntents("帮我写一份文档提纲")).toEqual([]);
  });
});

describe("applyConversationActions 按能力落库", () => {
  it("记住写入记忆库，并在原文后附已处理说明", () => {
    const out = applyConversationActions("记住：我不吃辣", { workspaceId: WS });
    expect(out.remembered).toBe(1);
    expect(out.message).toContain("我不吃辣");
    expect(out.message).toContain("[PiBuddy 已处理]");
    const items = memoryStore().query({ workspaceId: WS });
    expect(items.some((m) => m.content === "我不吃辣")).toBe(true);
  });

  it("记忆能力关闭时不写库、原文不动", () => {
    applyCapabilityResolution([TASKS_CAPABILITY_ID, OFFICE_SKILLS_CAPABILITY_ID]);
    const src = "记住：我不吃辣";
    const out = applyConversationActions(src, { workspaceId: WS });
    expect(out.message).toBe(src);
    expect(out.remembered).toBe(0);
    expect(memoryStore().query({ workspaceId: WS })).toEqual([]);
  });

  it("每天提醒会建一条 daily 任务；相同内容不重复建", () => {
    const text = "每天早上9点提醒我看待办";
    const first = applyConversationActions(text, { workspaceId: WS, now: NOW, timeZone: TZ });
    expect(first.tasksCreated).toBe(1);
    expect(first.message).toContain("已排好：今天 9:00 会跑");
    const tasks = taskStore().listTasks(WS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.schedule).toEqual({ kind: "daily", time: "09:00" });
    const second = applyConversationActions(text, { workspaceId: WS, now: NOW, timeZone: TZ });
    expect(second.tasksCreated).toBe(0);
    expect(taskStore().listTasks(WS)).toHaveLength(1);
  });

  it("明天几点说成明天几点会跑", () => {
    const out = applyConversationActions("明天下午3点提醒我开会", {
      workspaceId: WS,
      now: NOW,
      timeZone: TZ,
    });
    expect(out.tasksCreated).toBe(1);
    expect(out.message).toContain("已排好：明天 15:00 会跑");
  });

  it("任务能力关闭时不建任务", () => {
    applyCapabilityResolution([MEMORY_CAPABILITY_ID, OFFICE_SKILLS_CAPABILITY_ID]);
    const src = "每天早上9点提醒我看待办";
    const out = applyConversationActions(src, { workspaceId: WS, now: NOW, timeZone: TZ });
    expect(out.tasksCreated).toBe(0);
    expect(out.message).toBe(src);
    expect(taskStore().listTasks(WS)).toHaveLength(0);
  });

  it("办公技能打开时在文首挂 /skill:；关掉则原文不动", () => {
    const text = "用文件整理技能，把下载文件夹里的图片按月份归档";
    const on = applyConversationActions(text, { workspaceId: WS });
    expect(on.skillAttached).toBe("office-file-organize");
    expect(on.message.startsWith("/skill:office-file-organize")).toBe(true);

    applyCapabilityResolution([MEMORY_CAPABILITY_ID, TASKS_CAPABILITY_ID]);
    const off = applyConversationActions(text, { workspaceId: WS });
    expect(off.skillAttached).toBeNull();
    expect(off.message).toBe(text);
  });

  it("计划模式不落库", () => {
    const out = applyConversationActions("每天早上9点提醒我看待办", {
      workspaceId: WS,
      now: NOW,
      timeZone: TZ,
      workMode: "plan",
    });
    expect(out.tasksCreated).toBe(0);
    expect(taskStore().listTasks(WS)).toHaveLength(0);
  });

  it("猜测记住只进待审 candidate", () => {
    const out = applyConversationActions("记住：我猜数据库是 PostgreSQL", { workspaceId: WS });
    expect(out.remembered).toBe(1);
    expect(memoryStore().query({ workspaceId: WS })).toEqual([]);
    expect(memoryStore().listCandidates(WS).some((c) => c.status === "pending")).toBe(true);
  });

  it("没有 workspace 时不写记忆、不建任务", () => {
    const out = applyConversationActions("记住：我不吃辣", {});
    expect(out.remembered).toBe(0);
    expect(out.message).toBe("记住：我不吃辣");
  });
});

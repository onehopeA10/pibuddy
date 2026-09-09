import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 任务库的两条结构保证：按 workspaceId 分区、schema 有版本。
 */
vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

const { TaskStore, TASKS_STORE_SCHEMA_VERSION } = await import("../src/main/tasks/task-store.js");
import type { NewTask } from "../src/main/tasks/task-store.js";

let dir: string;
let store: InstanceType<typeof TaskStore>;

const mk = (workspaceId: string): NewTask => ({
  workspaceId,
  name: "t",
  schedule: { kind: "daily", time: "09:00" },
  timezone: "UTC",
  agent: { provider: "", model: "", prompt: "p" },
  requiredPermissions: [],
  budgetUsd: null,
  timeoutMs: null,
  misfirePolicy: "skip",
  concurrencyPolicy: "forbid",
  failurePolicy: { retry: false, maxAttempts: 1, backoffMs: 0 },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-tasks-store-"));
  store = new TaskStore(path.join(dir, "tasks.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("按 workspaceId 分区", () => {
  it("一个工作区看不到另一个工作区的任务", () => {
    store.createTask(mk("wsA"), 1, null);
    store.createTask(mk("wsB"), 1, null);
    expect(store.listTasks("wsA").length).toBe(1);
    expect(store.listTasks("wsB").length).toBe(1);
    expect(store.listTasks("wsA")[0].workspaceId).toBe("wsA");
    // 对拍：不存在的工作区查出来是空，而不是全表。
    expect(store.listTasks("wsC")).toEqual([]);
  });
});

describe("schema 版本 + 迁移", () => {
  it("新库的 user_version 落在当前代际，重开不重建、数据仍在", () => {
    const file = path.join(dir, "reopen.db");
    const s1 = new TaskStore(file);
    const t = s1.createTask(mk("ws"), 1, null);
    s1.close();
    // 重新打开：migrate() 认出已是当前代际，不重建；任务原样还在。
    const s2 = new TaskStore(file);
    expect(s2.getTask(t.id)?.id).toBe(t.id);
    s2.close();
    expect(TASKS_STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("queue 原子准入", () => {
  it("只 claim FIFO 首项；已有 running 时下一条不能被重复准入", () => {
    const now = 1_000;
    const task = store.createTask({ ...mk("ws"), concurrencyPolicy: "queue" }, now, null);
    const first = store.createRun({
      taskId: task.id, workspaceId: "ws", scheduledFor: 20, idempotencyKey: "first",
      attempt: 1, input: task.agent, status: "pending", now,
    })!;
    const second = store.createRun({
      taskId: task.id, workspaceId: "ws", scheduledFor: 10, idempotencyKey: "second",
      attempt: 1, input: task.agent, status: "pending", now,
    })!;

    expect(store.claimNextPendingRun(task.id)?.id).toBe(first.id);
    expect(store.claimNextPendingRun(task.id)).toBeNull();
    store.updateRun(first.id, { status: "succeeded", finishedAt: now + 1 });
    expect(store.claimNextPendingRun(task.id)?.id).toBe(second.id);
  });
});

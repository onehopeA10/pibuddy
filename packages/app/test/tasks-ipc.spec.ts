import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(
  () => new Map<string, (req: Record<string, unknown>) => unknown>()
);

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../src/main/ipc-guard.js", () => ({
  registerHandler: (
    channel: string,
    _schema: unknown,
    handler: (req: Record<string, unknown>) => unknown
  ) => {
    registered.set(channel, handler);
  },
}));

import { CHANNELS } from "@pibuddy/contract";
import { CHANNEL_PERMISSION_REQUIREMENTS } from "../src/main/permission/channel-permission-requirements.js";
import { TASKS_GATED_CHANNELS, TASKS_PERMISSION } from "../src/main/tasks/task-ipc-permission.js";
const { __setTasksDataDir, taskStore } = await import("../src/main/tasks/task-store.js");
const { disposeTasksResources, registerTasksIpc } = await import(
  "../src/main/tasks/tasks-ipc.js"
);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-tasks-ipc-"));
  __setTasksDataDir(dir);
  registered.clear();
  registerTasksIpc();
});

afterEach(() => {
  disposeTasksResources();
  __setTasksDataDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tasks mutate channels are gated", () => {
  it("create/update/delete/run-now 等挂 tasks.manage，list/get 不闸", () => {
    for (const channel of TASKS_GATED_CHANNELS) {
      expect(CHANNEL_PERMISSION_REQUIREMENTS[channel]).toMatchObject({
        capabilityId: "common.tasks",
        permission: TASKS_PERMISSION,
      });
    }
    expect(CHANNEL_PERMISSION_REQUIREMENTS[CHANNELS.tasksList]).toBeUndefined();
    expect(CHANNEL_PERMISSION_REQUIREMENTS[CHANNELS.tasksGet]).toBeUndefined();
  });
});

describe("tasks:get workspace boundary", () => {
  it("cross-workspace task detail and run history are denied", async () => {
    const store = taskStore();
    const task = store.createTask(
      {
        workspaceId: "ws-owner",
        name: "private task",
        schedule: { kind: "daily", time: "09:00" },
        timezone: "UTC",
        agent: { provider: "openai", model: "gpt", prompt: "private prompt" },
        requiredPermissions: [],
        budgetUsd: null,
        timeoutMs: null,
        misfirePolicy: "skip",
        concurrencyPolicy: "forbid",
        failurePolicy: { retry: false, maxAttempts: 1, backoffMs: 0 },
      },
      1,
      null
    );
    store.createRun({
      taskId: task.id,
      workspaceId: "ws-owner",
      scheduledFor: 1,
      idempotencyKey: "private-run",
      attempt: 1,
      input: task.agent,
      status: "succeeded",
      now: 1,
    });

    const get = registered.get(CHANNELS.tasksGet)!;
    expect(get({ id: task.id, workspaceId: "ws-other" })).toBeNull();

    const own = await get({ id: task.id, workspaceId: "ws-owner" });
    expect(own).toMatchObject({ task: { id: task.id, workspaceId: "ws-owner" } });
    expect((own as { runs: unknown[] }).runs).toHaveLength(1);
  });
});

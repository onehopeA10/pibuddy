import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowDefinition, WorkflowRun } from "@pibuddy/contract";
import {
  WorkflowStore,
  WORKFLOW_RUN_HISTORY_LIMIT,
  __setWorkflowDataDir,
} from "../src/main/workflow/workflow-store.js";

/**
 * 工作流落盘（common.workflow）：按工作区分区、可移植、schema 版本、历史上界。
 */

let dir = "";

function makeDef(id: string, name = id): WorkflowDefinition {
  return {
    id,
    name,
    schemaVersion: 1,
    nodes: [{ kind: "start", id: "start", title: "", position: { x: 0, y: 0 } }],
    edges: [],
    createdAt: 1,
    updatedAt: 2,
  };
}
function makeRun(id: string, definitionId: string, startedAt: number): WorkflowRun {
  return {
    id,
    definitionId,
    definitionName: definitionId,
    workspaceId: "ws1",
    state: "succeeded",
    nodes: [],
    error: null,
    startedAt,
    endedAt: startedAt + 1,
    sequence: 1,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-"));
  __setWorkflowDataDir(dir);
});
afterEach(() => {
  __setWorkflowDataDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowStore：定义 CRUD 与工作区隔离", () => {
  it("save / list / get / delete，按 workspaceId 分区互不串", () => {
    const store = new WorkflowStore(path.join(dir, "workflows.db"));
    store.saveDefinition("ws1", makeDef("a"));
    store.saveDefinition("ws1", makeDef("b"));
    store.saveDefinition("ws2", makeDef("c"));

    expect(store.listDefinitions("ws1").map((d) => d.id).sort()).toEqual(["a", "b"]);
    expect(store.listDefinitions("ws2").map((d) => d.id)).toEqual(["c"]);
    expect(store.getDefinition("ws1", "a")?.id).toBe("a");
    // ws1 的定义在 ws2 里查不到（分区隔离）。
    expect(store.getDefinition("ws2", "a")).toBeNull();

    store.deleteDefinition("ws1", "a");
    expect(store.listDefinitions("ws1").map((d) => d.id)).toEqual(["b"]);
    store.close();
  });

  it("upsert：同 id 再存即覆盖，不新增", () => {
    const store = new WorkflowStore(path.join(dir, "workflows.db"));
    store.saveDefinition("ws1", makeDef("a", "旧名"));
    store.saveDefinition("ws1", makeDef("a", "新名"));
    expect(store.listDefinitions("ws1")).toHaveLength(1);
    expect(store.getDefinition("ws1", "a")?.name).toBe("新名");
    store.close();
  });
});

describe("WorkflowStore：持久化 roundtrip", () => {
  it("关掉再打开同一文件，定义仍在（真的落盘）", () => {
    const file = path.join(dir, "workflows.db");
    const s1 = new WorkflowStore(file);
    s1.saveDefinition("ws1", makeDef("a"));
    s1.close();

    const s2 = new WorkflowStore(file);
    expect(s2.getDefinition("ws1", "a")?.id).toBe("a");
    s2.close();
  });
});

describe("WorkflowStore：运行历史与上界", () => {
  it("append 超过上界时裁掉最老的", () => {
    const store = new WorkflowStore(path.join(dir, "workflows.db"));
    const total = WORKFLOW_RUN_HISTORY_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      store.appendRun("ws1", makeRun(`r${i}`, "a", i));
    }
    const runs = store.listRuns("ws1");
    expect(runs).toHaveLength(WORKFLOW_RUN_HISTORY_LIMIT);
    // 保留的是最近的（startedAt 最大的那批），最老的 r0 被裁掉。
    expect(runs.some((r) => r.id === "r0")).toBe(false);
    expect(runs.some((r) => r.id === `r${total - 1}`)).toBe(true);
    store.close();
  });

  it("同 id 再 append 即更新，不新增一条", () => {
    const store = new WorkflowStore(path.join(dir, "workflows.db"));
    store.appendRun("ws1", makeRun("r1", "a", 1));
    const updated = { ...makeRun("r1", "a", 1), state: "failed" as const };
    store.appendRun("ws1", updated);
    const runs = store.listRuns("ws1");
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
    store.close();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 500 会话的首屏基准（c[7]）。
 *
 * 被取代的实现是「readdirSync + 每文件 statSync + 整文件 readFileSync +
 * split 逐行 parse」，而 agent_settled 每次都触发它 —— 这条基准存在的意义
 * 就是让那种写法再也回不来：query 走的是一次 SQLite 查询，与会话数量的
 * 关系是索引查找而不是目录遍历。
 */

let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { trashItem: vi.fn(async () => undefined) },
}));

const { SessionIndex, __setSessionIndexDataDir } = await import("./session-index.js");
const { __setWorkspaceDataDir, workspaceIdFor } = await import("../workspace-registry.js");

const SESSION_COUNT = 500;

let tmpRoot = "";
let sessionDir = "";
let workspaceDir = "";
let settings: Parameters<InstanceType<typeof SessionIndex>["syncWorkspace"]>[1];
let index: InstanceType<typeof SessionIndex>;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pibuddy-bench-"));
  userDataDir = path.join(tmpRoot, "userData");
  sessionDir = path.join(tmpRoot, "sessions");
  workspaceDir = path.join(tmpRoot, "work");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  __setWorkspaceDataDir(userDataDir);
  __setSessionIndexDataDir(userDataDir);
  settings = {
    schemaVersion: 1,
    piRuntimeMode: "bundled",
    sessionDir,
  } as typeof settings;
  index = new SessionIndex(path.join(userDataDir, "bench.db"));

  await Promise.all(
    Array.from({ length: SESSION_COUNT }, async (_unused, i) => {
      const id = `s${String(i).padStart(4, "0")}`;
      const lines = [
        JSON.stringify({ type: "session", version: 3, id, cwd: workspaceDir }),
        JSON.stringify({ type: "session_info", name: `任务 ${i}` }),
        JSON.stringify({
          type: "message",
          id: `${id}-0`,
          message: { role: "user", content: [{ type: "text", text: `第 ${i} 号任务的内容` }] },
        }),
      ];
      await writeFile(path.join(sessionDir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
    })
  );
});

afterEach(async () => {
  index.close();
  __setWorkspaceDataDir(null);
  __setSessionIndexDataDir(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("500 会话基准", () => {
  it("首屏 query 耗时 < 200ms，且第二次 sync 一个文件都不读", async () => {
    await index.syncWorkspace(workspaceDir, settings);
    const workspaceId = workspaceIdFor(workspaceDir);

    const started = performance.now();
    const rows = index.query({ workspaceId, limit: 200 });
    const elapsed = performance.now() - started;

    expect(rows.length).toBe(200);
    expect(elapsed).toBeLessThan(200);

    // 稳态：目录没变化时 sync 不重解析任何文件
    const again = await index.syncWorkspace(workspaceDir, settings);
    expect(again.scanned).toBe(SESSION_COUNT);
    expect(again.reparsed).toBe(0);
  });

  it("带关键字的搜索同样在 200ms 内返回", async () => {
    await index.syncWorkspace(workspaceDir, settings);
    const workspaceId = workspaceIdFor(workspaceDir);

    const started = performance.now();
    const rows = index.query({ workspaceId, search: "第 499 号" });
    const elapsed = performance.now() - started;

    expect(rows.length).toBe(1);
    expect(elapsed).toBeLessThan(200);
  });
});

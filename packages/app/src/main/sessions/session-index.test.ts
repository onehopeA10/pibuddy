import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * SES-101：SQLite 增量索引的关键路径断言（不做穷举矩阵）。
 *
 *   1. 未变化的目录第二次 sync 一个字节都不读（reparsed === 0）
 *   2. 追加一条 message 后只重解析那一个文件，且**原有字节前缀不被改写**
 *   3. workspace_id 跨「重启」稳定 —— 否则历史会话在重启后全部查不出来
 *      且不报任何错
 *   4. 写入事务化：写一半抛错则整次 sync 回滚
 *   5. 回收站只改状态，.jsonl 的 sha256 不变
 *   6. saveDraft 对不存在的会话返回 false 且不插新行
 */

let userDataDir = "";
const trashed: string[] = [];

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: {
    trashItem: vi.fn(async (p: string) => {
      trashed.push(p);
    }),
  },
}));

const { SessionIndex, SESSION_INDEX_SCHEMA_VERSION, __setSessionIndexDataDir } = await import(
  "./session-index.js"
);
const { __setWorkspaceDataDir, registerWorkspace, workspaceIdFor } = await import(
  "../workspace-registry.js"
);

type Settings = Parameters<InstanceType<typeof SessionIndex>["syncWorkspace"]>[1];

let tmpRoot = "";
let sessionDir = "";
let workspaceDir = "";
let settings: Settings;
let index: InstanceType<typeof SessionIndex>;

/** 一行 pi 的 message entry。text 长度可控，用于把文件撑到指定量级。 */
function messageLine(id: string, role: "user" | "assistant", text: string): string {
  const message: Record<string, unknown> = { role, content: [{ type: "text", text }] };
  if (role === "assistant") {
    message.model = "gpt-5.6-sol";
    message.usage = { totalTokens: 100, cost: { total: 0.5 } };
  }
  return `${JSON.stringify({ type: "message", id, parentId: null, message })}\n`;
}

function sessionHeader(id: string): string {
  return `${JSON.stringify({ type: "session", version: 3, id, cwd: "C:\\\\w" })}\n`;
}

async function makeSession(id: string, messages = 2): Promise<string> {
  let text = sessionHeader(id);
  text += `${JSON.stringify({ type: "session_info", name: `会话 ${id}` })}\n`;
  for (let i = 0; i < messages; i++) {
    text += messageLine(`${id}-m${i}`, i % 2 === 0 ? "user" : "assistant", `内容 ${id} ${i}`);
  }
  const file = path.join(sessionDir, `${id}.jsonl`);
  await writeFile(file, text, "utf8");
  return file;
}

beforeEach(async () => {
  trashed.length = 0;
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pibuddy-idx-"));
  userDataDir = path.join(tmpRoot, "userData");
  sessionDir = path.join(tmpRoot, "sessions");
  workspaceDir = path.join(tmpRoot, "work");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  __setWorkspaceDataDir(userDataDir);
  __setSessionIndexDataDir(userDataDir);
  settings = { schemaVersion: 1, piRuntimeMode: "bundled", sessionDir } as Settings;
  index = new SessionIndex(path.join(userDataDir, "test-index.db"));
});

afterEach(async () => {
  index.close();
  __setWorkspaceDataDir(null);
  __setSessionIndexDataDir(null);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("增量同步", () => {
  it("同一目录连续 sync 两次，第二次 reparsed === 0", async () => {
    await makeSession("a");
    await makeSession("b");

    const first = await index.syncWorkspace(workspaceDir, settings);
    expect(first).toEqual({ scanned: 2, reparsed: 2 });

    const second = await index.syncWorkspace(workspaceDir, settings);
    expect(second.scanned).toBe(2);
    expect(second.reparsed).toBe(0);
  });

  it("追加一条 message 后只重解析那一个文件，messageCount +1", async () => {
    const file = await makeSession("a", 2);
    await makeSession("b", 2);
    await index.syncWorkspace(workspaceDir, settings);
    const before = index.bySourcePath(file)!;
    expect(before.messageCount).toBe(2);

    // mtime 的分辨率在某些文件系统上只有 1s：size 一定会变，短路条件用的是
    // 「mtime 与 size 都命中」，因此这里不需要等待。
    await appendFile(file, messageLine("a-m2", "user", "又一条"), "utf8");

    const result = await index.syncWorkspace(workspaceDir, settings);
    expect(result.reparsed).toBe(1);
    expect(index.bySourcePath(file)!.messageCount).toBe(3);
  });

  it("JSONL 只读不改写：追加后原有字节前缀逐字节相同", async () => {
    const file = await makeSession("a", 2);
    const snapshot = await readFile(file);
    await index.syncWorkspace(workspaceDir, settings);

    await appendFile(file, messageLine("a-m2", "assistant", "回复"), "utf8");
    await index.syncWorkspace(workspaceDir, settings);

    const after = await readFile(file);
    expect(after.subarray(0, snapshot.length).equals(snapshot)).toBe(true);
  });

  it("文件被外部重写（头部哈希变化）时全量重扫，统计不会翻倍", async () => {
    const file = await makeSession("a", 4);
    await index.syncWorkspace(workspaceDir, settings);
    expect(index.bySourcePath(file)!.messageCount).toBe(4);

    // 原地重写成一个更短的会话
    await writeFile(file, sessionHeader("a") + messageLine("a-x", "user", "新的"), "utf8");
    await index.syncWorkspace(workspaceDir, settings);
    expect(index.bySourcePath(file)!.messageCount).toBe(1);
  });
});

describe("workspace_id 跨重启稳定（裁定3）", () => {
  it("重开索引 DB 后，同一目录仍能查回全部会话", async () => {
    const record = registerWorkspace(workspaceDir);
    await makeSession("a");
    await makeSession("b");
    await index.syncWorkspace(record.root, settings);
    expect(index.query({ workspaceId: record.workspaceId }).length).toBe(2);

    // 「重启」：关掉 DB 再打开同一个文件，并重新注册同一个工作目录
    index.close();
    index = new SessionIndex(path.join(userDataDir, "test-index.db"));
    const again = registerWorkspace(workspaceDir);

    expect(again.workspaceId).toBe(record.workspaceId);
    expect(workspaceIdFor(again.root)).toBe(record.workspaceId);
    const rows = index.query({ workspaceId: again.workspaceId });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.workspaceId === record.workspaceId)).toBe(true);
  });
});

describe("查询", () => {
  it("按关键字命中 name / preview，按 status 隔离回收站", async () => {
    const a = await makeSession("alpha");
    await makeSession("beta");
    const ws = workspaceIdFor(workspaceDir);
    await index.syncWorkspace(workspaceDir, settings);

    expect(index.query({ workspaceId: ws, search: "alpha" }).length).toBe(1);

    index.setStatus(a, "trashed");
    expect(index.query({ workspaceId: ws }).length).toBe(1);
    expect(index.query({ workspaceId: ws, status: "trashed" }).length).toBe(1);
  });

  it("置顶的会话恒排在最前", async () => {
    await makeSession("old");
    const fresh = await makeSession("new");
    const ws = workspaceIdFor(workspaceDir);
    await index.syncWorkspace(workspaceDir, settings);

    const older = index.query({ workspaceId: ws }).at(-1)!;
    index.setPinned(older.sourcePath, true);
    expect(index.query({ workspaceId: ws })[0].sourcePath).toBe(older.sourcePath);
    expect(fresh).toBeTruthy();
  });
});

describe("写入事务化与并发（SYS-2：断言行为而非字面量）", () => {
  it("写到一半抛错则整次 sync 回滚，user_version 不变", async () => {
    await makeSession("a");
    await index.syncWorkspace(workspaceDir, settings);
    const ws = workspaceIdFor(workspaceDir);
    const rowsBefore = index.query({ workspaceId: ws }).length;

    await makeSession("b");
    await makeSession("c");

    // 让第二次入库抛错：BEGIN 之后已写的行必须被 ROLLBACK 掉
    const original = Reflect.get(index, "upsert") as (row: unknown) => void;
    let calls = 0;
    Reflect.set(index, "upsert", function (this: unknown, row: unknown) {
      calls++;
      if (calls === 2) throw new Error("boom");
      return original.call(this, row);
    });

    await expect(index.syncWorkspace(workspaceDir, settings)).rejects.toThrow("boom");
    Reflect.set(index, "upsert", original);

    expect(index.query({ workspaceId: ws }).length).toBe(rowsBefore);
    expect(SESSION_INDEX_SCHEMA_VERSION).toBe(1);
    const version = Reflect.get(index, "db") as { prepare(s: string): { get(): unknown } };
    expect((version.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      SESSION_INDEX_SCHEMA_VERSION
    );
  });

  it("并发两次 syncWorkspace 不产生重复行", async () => {
    await makeSession("a");
    await makeSession("b");
    await Promise.all([
      index.syncWorkspace(workspaceDir, settings),
      index.syncWorkspace(workspaceDir, settings),
    ]);
    const ws = workspaceIdFor(workspaceDir);
    const rows = index.query({ workspaceId: ws });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.sourcePath)).size).toBe(2);
  });
});

describe("回收站不动真相源", () => {
  it("setStatus('trashed') 后 .jsonl 的 sha256 不变，且未调用 trashItem", async () => {
    const file = await makeSession("a");
    await index.syncWorkspace(workspaceDir, settings);
    const before = createHash("sha256").update(await readFile(file)).digest("hex");

    index.setStatus(file, "trashed");

    const after = createHash("sha256").update(await readFile(file)).digest("hex");
    expect(after).toBe(before);
    expect(trashed).toEqual([]);
  });

  it("只有 purge 才把文件交给系统回收站，并删掉索引行", async () => {
    const file = await makeSession("a");
    await index.syncWorkspace(workspaceDir, settings);

    await index.purge(file);

    expect(trashed).toEqual([file]);
    expect(index.bySourcePath(file)).toBe(null);
  });
});

describe("草稿", () => {
  it("无草稿返回 null，而不是 {}", async () => {
    const file = await makeSession("a");
    await index.syncWorkspace(workspaceDir, settings);
    expect(index.getDraft(file)).toBe(null);
  });

  it("对不存在的会话 saveDraft 返回 false 且不插新行", async () => {
    await makeSession("a");
    await index.syncWorkspace(workspaceDir, settings);
    const ws = workspaceIdFor(workspaceDir);
    const before = index.query({ workspaceId: ws }).length;

    const ok = index.saveDraft(path.join(sessionDir, "nope.jsonl"), {
      text: "草稿",
      attachments: [],
      queue: { steering: [], followUp: [] },
      updatedAt: Date.now(),
    });

    expect(ok).toBe(false);
    expect(index.query({ workspaceId: ws }).length).toBe(before);
  });

  it("存在的会话可以存取草稿", async () => {
    const file = await makeSession("a");
    await index.syncWorkspace(workspaceDir, settings);
    const draft = {
      text: "写一半的话",
      attachments: [],
      queue: { steering: ["插话"], followUp: [] },
      updatedAt: 123,
    };
    expect(index.saveDraft(file, draft)).toBe(true);
    expect(index.getDraft(file)).toEqual(draft);
  });
});

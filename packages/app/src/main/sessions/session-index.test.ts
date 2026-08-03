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

/**
 * pi 写下的会话头部。`cwd` 是**归属判据**（session-index 的 headerCwd）：
 * 多个工作区共用一个 settings.sessionDir 时，目录名什么都证明不了，只有这
 * 一行说得清这份会话属于谁。默认取当前用例的工作目录。
 */
function sessionHeader(id: string, cwd = workspaceDir): string {
  return `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`;
}

async function makeSession(id: string, messages = 2, cwd = workspaceDir): Promise<string> {
  let text = sessionHeader(id, cwd);
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

/**
 * 共享自定义 sessionDir 的归属（SES-2）。
 *
 * `settings.sessionDir` 允许多个工作区共用同一个会话目录 —— 此时目录名什么
 * 都证明不了，而同步是无条件把 workspace_id 写成「本次同步的那个工作区」。
 * 表现是两个工作区互相抢会话：A 同步一次，B 的历史全变成 A 的；B 再同步
 * 一次又抢回去。用户看到的是「历史会话时有时无」，日志里一行错都没有。
 *
 * 判据只能是 JSONL 头部的 cwd —— 那是 pi 自己写下的归属。
 */
describe("共享 sessionDir 的会话归属（SES-2）", () => {
  let otherWorkspace = "";

  beforeEach(async () => {
    otherWorkspace = path.join(tmpRoot, "work-2");
    await mkdir(otherWorkspace, { recursive: true });
  });

  it("同一个会话目录被两个工作区共用时，各自只看得到自己的会话", async () => {
    await makeSession("mine");
    await makeSession("theirs", 2, otherWorkspace);

    await index.syncWorkspace(workspaceDir, settings);
    await index.syncWorkspace(otherWorkspace, settings);

    const mine = index
      .query({ workspaceId: workspaceIdFor(workspaceDir) })
      .map((r) => r.sessionId);
    const theirs = index
      .query({ workspaceId: workspaceIdFor(otherWorkspace) })
      .map((r) => r.sessionId);

    expect(mine).toEqual(["mine"]);
    expect(theirs).toEqual(["theirs"]);
  });

  it("对方的会话被追加内容后，本工作区再同步也不会把它重标成自己的", async () => {
    const theirs = await makeSession("theirs", 2, otherWorkspace);
    await index.syncWorkspace(otherWorkspace, settings);
    expect(index.bySourcePath(theirs)!.workspaceId).toBe(workspaceIdFor(otherWorkspace));

    // 追加内容 → mtime/size 都变了，本工作区的下一次同步一定会重新解析它。
    // 这正是「无条件重标」发作的时刻。
    await appendFile(theirs, messageLine("theirs-m9", "user", "对方的新消息"), "utf8");
    const result = await index.syncWorkspace(workspaceDir, settings);

    expect(result.reparsed).toBe(0);
    expect(index.bySourcePath(theirs)!.workspaceId).toBe(workspaceIdFor(otherWorkspace));
    expect(index.query({ workspaceId: workspaceIdFor(workspaceDir) })).toEqual([]);
  });

  it("头部没写 cwd 的老会话按当前工作区收下（不能因为读不出字段就把历史藏起来）", async () => {
    const file = path.join(sessionDir, "legacy.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", id: "legacy" })}\n${messageLine("legacy-m0", "user", "老会话")}`,
      "utf8"
    );

    await index.syncWorkspace(workspaceDir, settings);

    expect(
      index.query({ workspaceId: workspaceIdFor(workspaceDir) }).map((r) => r.sessionId)
    ).toContain("legacy");
  });
});

/**
 * 同 id 会话跨工作区（SES-4）。
 *
 * sessionId 由 pi 写在 JSONL 头部，复制一份会话文件、从备份里恢复、或两个
 * 工作区共用一个 session-dir，都能让同一个 id 出现两行。早先 bySessionId 是
 * 全局「取最近修改的那行」—— 于是重命名 / 归档 / **彻底删除** / 草稿读写都
 * 可能落到另一个工作区的会话上。
 */
describe("同 id 会话按工作区限定（SES-4）", () => {
  it("bySessionId 解出的是本工作区那一份，哪怕另一个工作区的更新", async () => {
    const otherWorkspace = path.join(tmpRoot, "work-2");
    const otherSessionDir = path.join(tmpRoot, "sessions-2");
    await mkdir(otherWorkspace, { recursive: true });
    await mkdir(otherSessionDir, { recursive: true });
    const otherSettings = { ...settings, sessionDir: otherSessionDir } as typeof settings;

    // 先写本工作区那份，再写另一个工作区的同 id 会话 —— 后者 mtime 更新，
    // 全局「取最近修改的那行」一定会命中它。
    const mine = await makeSession("dup");
    await index.syncWorkspace(workspaceDir, settings);

    const theirs = path.join(otherSessionDir, "dup.jsonl");
    await writeFile(
      theirs,
      `${JSON.stringify({ type: "session", version: 3, id: "dup", cwd: otherWorkspace })}\n${messageLine("dup-m0", "user", "另一个工作区的同 id 会话")}`,
      "utf8"
    );
    await index.syncWorkspace(otherWorkspace, otherSettings);

    expect(index.bySessionId("dup", workspaceIdFor(workspaceDir))!.sourcePath).toBe(mine);
    expect(index.bySessionId("dup", workspaceIdFor(otherWorkspace))!.sourcePath).toBe(theirs);
    // 没注册过的工作区一条都查不到，而不是退化成全局查询
    expect(index.bySessionId("dup", "not-a-workspace")).toBe(null);
  });
});

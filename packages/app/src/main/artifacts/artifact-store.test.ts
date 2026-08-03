import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Artifact 仓库的四条不变量（ART-102）。
 *
 *   1. 二次生成 version+1 而不是覆盖 —— 覆盖会让历史消息里的链接
 *      悄悄指向另一份内容，而系统里没有任何地方记录这件事发生过。
 *   2. 链接按 artifactId + version 解析 —— 文件挪到别处照样解析得到。
 *   3. 软删只写两列 —— 真删文件的话「恢复」就是一句空话。
 *   4. 磁盘内容被外部改动 → conflicted —— 否则我们对外宣称的 sha256 是假的。
 */
import type { ArtifactStatus } from "@pibuddy/contract";

let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
}));

type StoreMod = typeof import("./artifact-store.js");

let tmpRoot = "";
let workspaceDir = "";
let workspaceId = "";
let opened: StoreMod | null = null;

async function fresh(): Promise<StoreMod> {
  vi.resetModules();
  const registry = await import("../workspace-registry.js");
  registry.__setWorkspaceDataDir(userDataDir);
  workspaceId = registry.registerWorkspace(workspaceDir).workspaceId;
  const mod = await import("./artifact-store.js");
  mod.__setArtifactDataDir(userDataDir);
  opened = mod;
  return mod;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-artifact-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(tmpRoot, "work");
  fs.mkdirSync(path.join(workspaceDir, "reports"), { recursive: true });
});

afterEach(() => {
  // Windows 上 SQLite 的 WAL 文件在句柄没关之前删不掉
  opened?.closeArtifactStore();
  opened = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(relative: string, content: string): string {
  const abs = path.join(workspaceDir, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function sha(abs: string): string {
  return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

describe("建表字段完整", () => {
  it("十四个必需字段一个不缺，status 取值受约束", async () => {
    const mod = await fresh();
    write("reports/q1.docx", "第一版");
    const store = mod.artifactStore();
    const created = store.markReady(
      store.begin({ workspaceId, relativePath: "reports/q1.docx" }).id
    );

    for (const key of [
      "id",
      "kind",
      "sourceSessionId",
      "sourceTurnId",
      "sourceToolCallId",
      "workspaceId",
      "version",
      "sha256",
      "createdAt",
      "updatedAt",
      "previewPath",
      "exportPath",
      "status",
      "deletedAt",
    ]) {
      expect(created, key).toHaveProperty(key);
    }
    expect(created.status).toBe("ready");
    expect(created.kind).toBe("document");
  });

  it("非法 status 被 CHECK 约束拒掉（不会静默落盘）", async () => {
    const mod = await fresh();
    write("reports/q1.docx", "x");
    const store = mod.artifactStore();
    const record = store.begin({ workspaceId, relativePath: "reports/q1.docx" });
    expect(() => store.setStatus(record.id, "readey" as ArtifactStatus)).toThrow();
  });
});

describe("版本链", () => {
  it("同一逻辑产物二次生成是 version+1，前一版原样留着", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();

    write("reports/q1.docx", "第一版内容");
    const v1 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q1.docx" }).id);
    expect(v1.version).toBe(1);

    write("reports/q1.docx", "第二版内容，比第一版长一些");
    const v2 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q1.docx" }).id);
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);

    // 第一版没有被覆盖
    const stillThere = store.get(v1.id);
    expect(stillThere?.version).toBe(1);
    expect(stillThere?.sha256).toBe(v1.sha256);
    expect(store.versionsOf(v2.id).map((r) => r.version)).toEqual([1, 2]);
  });

  it("(c[6]) 文件被移到别处之后，历史链接仍然解析到当时那一版", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();

    write("reports/q1.docx", "第一版内容");
    const v1 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q1.docx" }).id);
    write("reports/q1.docx", "第二版内容");
    const v2 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q1.docx" }).id);

    // 把文件挪到一个完全不同的位置（历史链接里如果存的是路径，这一步就断了）
    fs.mkdirSync(path.join(workspaceDir, "归档"), { recursive: true });
    fs.renameSync(
      path.join(workspaceDir, "reports/q1.docx"),
      path.join(workspaceDir, "归档/q1.docx")
    );

    const resolved = store.resolveLink(v2.id, 1);
    expect(resolved?.id).toBe(v1.id);
    expect(resolved?.version).toBe(1);
    expect(resolved?.sha256).toBe(v1.sha256);
  });
});

describe("状态机", () => {
  it("generating → ready / failed；失败时原文件仍在且 sha256 不变", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();

    const abs = write("reports/half.xlsx", "写了一半的内容");
    const before = sha(abs);
    const record = store.begin({ workspaceId, relativePath: "reports/half.xlsx" });
    expect(record.status).toBe("generating");

    const failed = store.markFailed(record.id);
    expect(failed.status).toBe("failed");
    // 转换/生成失败不丢原文件
    expect(fs.existsSync(abs)).toBe(true);
    expect(sha(abs)).toBe(before);
  });

  it("磁盘内容被外部改动之后 verify() 置 conflicted", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    const abs = write("reports/r.md", "Agent 写的内容");
    const ready = store.markReady(store.begin({ workspaceId, relativePath: "reports/r.md" }).id);
    expect(store.verify(ready.id).status).toBe("ready");

    fs.writeFileSync(abs, "用户在外面又改了一遍", "utf8");
    expect(store.verify(ready.id).status).toBe("conflicted");
  });
});

describe("回收站", () => {
  it("(c[17]) trashed 只写 status 与 deleted_at，磁盘文件一个字节不动", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    const abs = write("reports/keep.docx", "别删我");
    const before = sha(abs);
    const record = store.markReady(
      store.begin({ workspaceId, relativePath: "reports/keep.docx" }).id
    );

    const trashed = store.setStatus(record.id, "trashed");
    expect(trashed.status).toBe("trashed");
    expect(trashed.deletedAt).not.toBeNull();
    expect(trashed.sha256).toBe(record.sha256);
    expect(trashed.exportPath).toBe(record.exportPath);
    expect(trashed.version).toBe(record.version);
    expect(fs.existsSync(abs)).toBe(true);
    expect(sha(abs)).toBe(before);

    const restored = store.setStatus(record.id, "ready");
    expect(restored.status).toBe("ready");
    expect(restored.deletedAt).toBeNull();
  });

  it("默认列表看不到回收站里的条目，trashed:true 才看得到", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    write("reports/a.md", "a");
    write("reports/b.md", "b");
    const a = store.markReady(store.begin({ workspaceId, relativePath: "reports/a.md" }).id);
    store.markReady(store.begin({ workspaceId, relativePath: "reports/b.md" }).id);
    store.setStatus(a.id, "trashed");

    expect(store.query({ workspaceId }).items.map((r) => r.name)).toEqual(["b.md"]);
    expect(store.query({ workspaceId, trashed: true }).items.map((r) => r.name)).toEqual([
      "a.md",
    ]);
  });
});

describe("搜索、复制与版本比较", () => {
  it("按名字子串搜索、按 kind 筛选", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    write("reports/销售报表.xlsx", "x");
    write("reports/会议纪要.md", "y");
    store.markReady(store.begin({ workspaceId, relativePath: "reports/销售报表.xlsx" }).id);
    store.markReady(store.begin({ workspaceId, relativePath: "reports/会议纪要.md" }).id);

    expect(store.query({ workspaceId, query: "销售" }).items).toHaveLength(1);
    expect(store.query({ workspaceId, kind: "spreadsheet" }).items).toHaveLength(1);
    expect(store.query({ workspaceId, kind: "text" }).items[0].name).toBe("会议纪要.md");
  });

  it("复制一份是独立产物（新 logicalKey），原链的版本不受影响", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    write("reports/plan.md", "计划正文");
    const original = store.markReady(
      store.begin({ workspaceId, relativePath: "reports/plan.md" }).id
    );

    const copy = await store.duplicate(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.logicalKey).not.toBe(original.logicalKey);
    expect(copy.version).toBe(1);
    expect(copy.sha256).toBe(original.sha256);
    expect(fs.existsSync(path.join(workspaceDir, copy.exportPath))).toBe(true);
    // 原链还是只有一版
    expect(store.versionsOf(original.id)).toHaveLength(1);
  });

  it("两版比较：sha256 判 identical，文本可比时给逐行差异", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    write("reports/n.md", "第一行\n第二行");
    const v1 = store.markReady(store.begin({ workspaceId, relativePath: "reports/n.md" }).id);
    write("reports/n.md", "第一行\n改过的第二行");
    const v2 = store.markReady(store.begin({ workspaceId, relativePath: "reports/n.md" }).id);

    const cmp = store.compare(v1.id, v2.id);
    expect(cmp.identical).toBe(false);
    expect(cmp.left.version).toBe(1);
    expect(cmp.right.version).toBe(2);
    // 同一条链的两版指向同一个磁盘路径，而磁盘上只有最新那一份 ——
    // 这时候必须**如实降级**，而不是拿同一段文本比出一个空 diff 冒充
    // 「两版一样」。用户看到空 diff 会以为自己的改动丢了。
    expect(cmp.degraded).not.toBeNull();
    expect(cmp.textDiff).toEqual([]);
  });

  it("两版内容都还在磁盘上时（不同路径）才真的算逐行 diff", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    write("reports/a.md", "第一行\n第二行");
    const a = store.markReady(store.begin({ workspaceId, relativePath: "reports/a.md" }).id);
    write("reports/b.md", "第一行\n改过的第二行");
    const b = store.markReady(store.begin({ workspaceId, relativePath: "reports/b.md" }).id);

    const cmp = store.compare(a.id, b.id);
    expect(cmp.degraded).toBeNull();
    expect(cmp.textDiff.length).toBeGreaterThan(0);
    expect(cmp.textDiff.some((d) => d.text.includes("改过的第二行"))).toBe(true);
  });

  it("rename 只改显示名，不动 exportPath（改路径等于改历史链接指向）", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();
    write("reports/x.md", "x");
    const r = store.markReady(store.begin({ workspaceId, relativePath: "reports/x.md" }).id);
    const renamed = store.rename(r.id, "季度总结");
    expect(renamed.name).toBe("季度总结");
    expect(renamed.exportPath).toBe(r.exportPath);
  });
});

/**
 * latestOnly 的判据是 **version 最大**，不是 updated_at 最大。
 *
 * 这两者不是同一件事：rename / restore 只改 updated_at，不改 version。
 * 下面两条用例把 updated_at 与 version 的顺序**真的做反**（v1 的
 * updated_at 大于 v2 的），旧实现「按 updated_at 排序后取第一条」会返回
 * v1 —— 界面上写着 v1、磁盘上躺着 v2 的内容，且不报任何错。
 */
describe("latestOnly 取的是版本号最大的那一版", () => {
  it("给旧版本改名（updated_at 越过新版本）之后，列表里仍然是新版本", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();

    write("reports/q1.docx", "第一版");
    const v1 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q1.docx", now: 1_000 }).id, { now: 1_000 });
    write("reports/q1.docx", "第二版");
    const v2 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q1.docx", now: 2_000 }).id, { now: 2_000 });

    // 用户给**老版本**改了个名字：只有 updated_at 被推到最新，version 还是 1
    const renamed = store.rename(v1.id, "季度总结（初稿）", 9_000);
    expect(renamed.version).toBe(1);
    expect(renamed.updatedAt).toBeGreaterThan(v2.updatedAt);

    const listed = store.query({ workspaceId, latestOnly: true });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].version).toBe(2);
    expect(listed.items[0].id).toBe(v2.id);
  });

  it("把旧版本从回收站恢复之后，列表里仍然是新版本", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();

    write("reports/q2.docx", "第一版");
    const v1 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q2.docx", now: 1_000 }).id, { now: 1_000 });
    write("reports/q2.docx", "第二版");
    const v2 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q2.docx", now: 2_000 }).id, { now: 2_000 });

    store.setStatus(v1.id, "trashed", 8_000);
    const restored = store.setStatus(v1.id, "ready", 9_000);
    expect(restored.version).toBe(1);
    expect(restored.updatedAt).toBeGreaterThan(v2.updatedAt);

    const listed = store.query({ workspaceId, latestOnly: true });
    expect(listed.items.map((r) => r.version)).toEqual([2]);
  });

  it("最新一版进了回收站时，非回收站视图里的「最新」是仍然可见的那一版", async () => {
    const mod = await fresh();
    const store = mod.artifactStore();

    write("reports/q3.docx", "第一版");
    const v1 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q3.docx", now: 1_000 }).id, { now: 1_000 });
    write("reports/q3.docx", "第二版");
    const v2 = store.markReady(store.begin({ workspaceId, relativePath: "reports/q3.docx", now: 2_000 }).id, { now: 2_000 });
    store.setStatus(v2.id, "trashed", 3_000);

    const listed = store.query({ workspaceId, latestOnly: true });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].id).toBe(v1.id);

    const trash = store.query({ workspaceId, latestOnly: true, trashed: true });
    expect(trash.items.map((r) => r.id)).toEqual([v2.id]);
  });
});

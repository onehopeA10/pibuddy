/**
 * 备份 / 校验 / 恢复的真临时目录往返与损坏注入（BKP-101）。
 *
 * 数据目录不是造出来的假库：12 个 store 类**各自被真实构造一次**，DDL、
 * user_version、usage 的 meta 行全部由生产代码自己写。因此这里同时兜住了
 * 两件事——备份能不能跑通，以及 backup-manifest 里那张登记表（代际、必需表）
 * 有没有和各域的 store 漂移。登记表是字面量副本，漂移只能靠这一层拦住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let userDataDir = "";

vi.mock("electron", () => ({
  app: { getPath: () => userDataDir, getVersion: () => "0.0.0-test" },
}));

import {
  BACKUP_DB_DIR,
  BACKUP_MANIFEST_FILE,
  PENDING_RESTORE_DIR,
  SQLITE_STORES,
  WORKSPACE_REGISTRY_FILE,
} from "./backup-manifest.js";
import {
  applyPendingRestore,
  createBackup,
  hasPendingRestore,
  quarantinePendingRestore,
  stagePendingRestore,
  validateBackupAt,
} from "./backup-service.js";

let tmpRoot = "";
let backupParent = "";
const opened: Array<{ close(): void }> = [];

/** 用生产代码本身建出 12 个库。返回 SessionIndex 实例供后续断言数据。 */
async function buildRealUserData(): Promise<void> {
  const p = (file: string): string => path.join(userDataDir, file);

  const { ArtifactStore } = await import("../artifacts/artifact-store.js");
  const { ChangesetStore } = await import("../changeset/changeset-store.js");
  const { ConnectorStore } = await import("../connector/connector-store.js");
  const { HomeStore } = await import("../home/ha-store.js");
  const { AutomationStore } = await import("../home-automation/automation-store.js");
  const { MemoryStore } = await import("../memory/memory-store.js");
  const { RemoteRegistry } = await import("../remote/device-registry.js");
  const { SessionIndex } = await import("../sessions/session-index.js");
  const { TaskStore } = await import("../tasks/task-store.js");
  const { UsageStore } = await import("../usage/usage-store.js");
  const { WorkflowStore } = await import("../workflow/workflow-store.js");
  const { WorkspaceStore } = await import("../workspace/workspace-store.js");

  opened.push(new ArtifactStore(p("artifacts.db")));
  opened.push(new ChangesetStore(p("changesets.db")));
  opened.push(new ConnectorStore(p("connectors.db")));
  opened.push(new HomeStore(p("home-assistant.db")));
  opened.push(new AutomationStore(p("home-automation.db")));
  opened.push(new MemoryStore(p("memory.db")));
  opened.push(new RemoteRegistry(p("remote.db")));
  opened.push(new SessionIndex(p("session-index.db")));
  opened.push(new TaskStore(p("tasks.db")));
  opened.push(new UsageStore(p("usage.db")));
  opened.push(new WorkflowStore(p("workflows.db")));
  opened.push(new WorkspaceStore(p("workspaces.db")));
  for (const store of opened) store.close();
  opened.length = 0;
}

/** 往会话索引里塞一行，作为「数据确实被备份 / 恢复了」的可观测标记。 */
function seedSessions(count: number): void {
  const db = new DatabaseSync(path.join(userDataDir, "session-index.db"));
  try {
    db.exec("DELETE FROM sessions");
    const stmt = db.prepare(
      `INSERT INTO sessions (source_path, workspace_root, workspace_id, session_id,
        mtime_ms, size_bytes, content_hash, name, last_indexed_at, schema_version)
       VALUES (?,?,?,?,?,?,?,?,?,1)`
    );
    for (let i = 0; i < count; i++) {
      stmt.run(`/w/s-${i}.jsonl`, "/w", "ws", `s-${i}`, 1000 + i, 1, "h", `会话 ${i}`, 1);
    }
  } finally {
    db.close();
  }
}

function sessionCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c);
  } finally {
    db.close();
  }
}

function journalModeOf(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  } finally {
    db.close();
  }
}

/** 递归列出目录下全部文件的相对路径（用来断言「没有清单外的伴生文件」）。 */
function listAll(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listAll(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * 改坏一个库之后重算它的 sha256 写回清单。
 *
 * 不做这一步的话，所有损坏注入用例都会先被 sha256 那一层拦住，而
 * 「缺表」「代际不符」那几层永远得不到执行——它们的绿灯是假的。
 */
function repairManifestFor(backupRoot: string, relPath: string): void {
  const manifestPath = path.join(backupRoot, BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    files: Array<{ path: string; size: number; sha256: string }>;
  };
  const abs = path.join(backupRoot, ...relPath.split("/"));
  const bytes = fs.readFileSync(abs);
  const entry = manifest.files.find((f) => f.path === relPath);
  if (!entry) throw new Error(`清单里没有 ${relPath}`);
  entry.size = bytes.byteLength;
  entry.sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

beforeEach(async () => {
  vi.resetModules();
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pibuddy-backup-"));
  userDataDir = path.join(tmpRoot, "userData");
  backupParent = path.join(tmpRoot, "backups");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(backupParent, { recursive: true });
  await buildRealUserData();
  seedSessions(3);
  fs.writeFileSync(
    path.join(userDataDir, WORKSPACE_REGISTRY_FILE),
    JSON.stringify({ ws: { root: tmpRoot, registeredAt: 1 } })
  );
});

afterEach(() => {
  for (const store of opened) {
    try {
      store.close();
    } catch {
      /* 已经关了 */
    }
  }
  opened.length = 0;
  // Windows 上只要还有句柄占着 -wal / -shm，rmSync 就会 EPERM，
  // 而那种失败会把一个通过的用例报成红的。
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

async function backupOnce(name = "bk"): Promise<string> {
  const result = await createBackup({
    dataDir: userDataDir,
    destinationRoot: path.join(backupParent, name),
    appVersion: "0.0.0-test",
  });
  expect(result.validation.ok).toBe(true);
  return result.path;
}

describe("备份 → 校验 → 恢复 往返", () => {
  it("12 个库全部进备份，清单自校验通过，且不含 -wal / -shm", async () => {
    const root = await backupOnce();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, BACKUP_MANIFEST_FILE), "utf8")
    ) as { stores: Array<{ id: string; schemaVersion: number }>; consistency: string };
    expect(manifest.stores.map((s) => s.id).sort()).toEqual(
      SQLITE_STORES.map((s) => s.id).sort()
    );
    // 一致性口径必须原样落在清单里：将来真做出原子快照时，老备份不会被误读。
    expect(manifest.consistency).toBe("per-store");

    // 再校验一次（这一步会以只读方式打开每个快照）。
    const validation = await validateBackupAt(root);
    expect(validation.ok).toBe(true);
    expect(validation.reasons).toEqual([]);
    expect(validation.stores.sort()).toEqual(SQLITE_STORES.map((s) => s.id).sort());

    // 自包含性：快照必须是 journal_mode=delete 的单文件库。
    // 若 normalizeStandaloneSqliteSnapshot 被拿掉，快照会继承源库的 WAL 模式，
    // 于是上面那次只读打开会在备份目录里**凭空造出 -wal / -shm**——而它们
    // 被盘点显式排除在外，也就是说备份从此依赖着清单管不到的文件。
    for (const store of manifest.stores) {
      expect(journalModeOf(path.join(root, BACKUP_DB_DIR, `${store.id}.db`))).toBe("delete");
    }
    expect(listAll(root).filter((f) => f.endsWith("-wal") || f.endsWith("-shm"))).toEqual([]);
  });

  it("备份目录里就是清单列的那些文件，一个不多一个不少", async () => {
    const root = await backupOnce();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, BACKUP_MANIFEST_FILE), "utf8")
    ) as { files: Array<{ path: string }> };
    expect(listAll(root)).toEqual(
      [...manifest.files.map((f) => f.path), BACKUP_MANIFEST_FILE].sort()
    );
    expect(manifest.files.map((f) => f.path)).toContain(WORKSPACE_REGISTRY_FILE);
  });

  it("恢复：暂存 → 启动期套用 → 数据回到备份时刻", async () => {
    const root = await backupOnce();
    expect(sessionCount(path.join(root, BACKUP_DB_DIR, "session-index.db"))).toBe(3);

    // 备份之后又写了一批数据 —— 恢复应当把它们盖掉。
    seedSessions(7);
    expect(sessionCount(path.join(userDataDir, "session-index.db"))).toBe(7);

    await stagePendingRestore(root, userDataDir);
    expect(await hasPendingRestore(userDataDir)).toBe(true);
    // 暂存**不当场生效**：句柄还开着，此刻活库必须仍是 7 条。
    expect(sessionCount(path.join(userDataDir, "session-index.db"))).toBe(7);

    const outcome = await applyPendingRestore(userDataDir);
    expect(outcome.applied).toBe(true);
    expect(outcome.stores).toContain("session-index.db");
    expect(sessionCount(path.join(userDataDir, "session-index.db"))).toBe(3);
    expect(await hasPendingRestore(userDataDir)).toBe(false);
  });

  it("套用是幂等的：暂存区没删干净时再套用一次结果一样", async () => {
    const root = await backupOnce();
    seedSessions(9);
    await stagePendingRestore(root, userDataDir);
    await applyPendingRestore(userDataDir);
    expect(sessionCount(path.join(userDataDir, "session-index.db"))).toBe(3);
    // 暂存区已被删，再调一次是空转而不是报错
    const again = await applyPendingRestore(userDataDir);
    expect(again.applied).toBe(false);
    expect(again.reason).toBeNull();
  });

  it("备份目标已存在时拒绝，且不留下暂存目录", async () => {
    const root = await backupOnce();
    await expect(
      createBackup({ dataDir: userDataDir, destinationRoot: root, appVersion: "x" })
    ).rejects.toThrow(/已存在/);
    expect(fs.readdirSync(backupParent).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("备份到数据目录自己的子目录要被拒（否则盘点会自我膨胀）", async () => {
    await expect(
      createBackup({
        dataDir: userDataDir,
        destinationRoot: path.join(userDataDir, "inner"),
        appVersion: "x",
      })
    ).rejects.toThrow(/不得重叠/);
  });
});

describe("损坏注入：每一层都要真的挡得住，且说得出原因", () => {
  it("改一个字节 → sha256 不匹配被拒", async () => {
    const root = await backupOnce();
    const victim = path.join(root, BACKUP_DB_DIR, "tasks.db");
    const bytes = fs.readFileSync(victim);
    // 改页尾的一个字节：sqlite 的 integrity_check 未必看得出来，
    // 但内容哈希一定看得出来——这正是要单独有一层 sha256 的理由。
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(victim, bytes);

    const validation = await validateBackupAt(root);
    expect(validation.ok).toBe(false);
    expect(validation.reasons).toContain(`文件 sha256 与清单不符：${BACKUP_DB_DIR}/tasks.db`);
    // 恢复必须因此被拒
    await expect(stagePendingRestore(root, userDataDir)).rejects.toThrow(/拒绝恢复/);
  });

  it("删一张表 → 缺表被拒（且原因点名是哪张表）", async () => {
    const root = await backupOnce();
    const victim = path.join(root, BACKUP_DB_DIR, "tasks.db");
    const db = new DatabaseSync(victim);
    try {
      db.exec("DROP TABLE runs");
    } finally {
      db.close();
    }
    repairManifestFor(root, `${BACKUP_DB_DIR}/tasks.db`);

    const validation = await validateBackupAt(root);
    expect(validation.ok).toBe(false);
    expect(validation.reasons).toContain("库 tasks 校验失败：缺少必需的表：runs");
    await expect(stagePendingRestore(root, userDataDir)).rejects.toThrow(/拒绝恢复/);
  });

  it("改 schema 代际 → 版本不符被拒（含期望值与实际值）", async () => {
    const root = await backupOnce();
    const victim = path.join(root, BACKUP_DB_DIR, "memory.db");
    const db = new DatabaseSync(victim);
    try {
      db.exec("PRAGMA user_version = 99");
    } finally {
      db.close();
    }
    repairManifestFor(root, `${BACKUP_DB_DIR}/memory.db`);

    const validation = await validateBackupAt(root);
    expect(validation.ok).toBe(false);
    expect(validation.reasons).toContain(
      "库 memory 校验失败：schema 代际不符（期望 4，实际 99）"
    );
  });

  it("usage 的代际写在业务表里，改它同样要被抓到", async () => {
    const root = await backupOnce();
    const victim = path.join(root, BACKUP_DB_DIR, "usage.db");
    const db = new DatabaseSync(victim);
    try {
      db.exec("UPDATE usage_meta SET value = '1' WHERE key = 'schemaVersion'");
    } finally {
      db.close();
    }
    repairManifestFor(root, `${BACKUP_DB_DIR}/usage.db`);

    const validation = await validateBackupAt(root);
    expect(validation.ok).toBe(false);
    expect(validation.reasons).toContain("库 usage 校验失败：schema 代际不符（期望 2，实际 1）");
  });

  it("整个删掉一个库文件 → 报「缺少文件」而不是一句「无效」", async () => {
    const root = await backupOnce();
    fs.rmSync(path.join(root, BACKUP_DB_DIR, "workflows.db"));
    const validation = await validateBackupAt(root);
    expect(validation.ok).toBe(false);
    expect(validation.reasons).toContain(`备份缺少文件：${BACKUP_DB_DIR}/workflows.db`);
  });

  it("清单被换成别的格式 / 别的代际，各自报各自的话", async () => {
    const root = await backupOnce();
    const manifestPath = path.join(root, BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, format: "someone-else" }));
    expect((await validateBackupAt(root)).reasons[0]).toMatch(/不是 PiBuddy 备份/);

    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 99 }));
    expect((await validateBackupAt(root)).reasons[0]).toMatch(/备份代际不受支持/);

    fs.writeFileSync(manifestPath, "{ 这不是 JSON");
    expect((await validateBackupAt(root)).reasons[0]).toMatch(/清单缺失或不是合法 JSON/);
  });

  it("清单里塞一条越界路径 → 在 copyFile 之前就被挡住", async () => {
    const root = await backupOnce();
    const manifestPath = path.join(root, BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    manifest.files.push({ path: "../../evil.db", size: 1, sha256: `sha256:${"0".repeat(64)}` });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect((await validateBackupAt(root)).reasons[0]).toMatch(/越界段/);
  });

  it("坏掉的暂存区在启动期被丢弃，而不是每次启动都重试一遍", async () => {
    const root = await backupOnce();
    await stagePendingRestore(root, userDataDir);
    const pending = path.join(userDataDir, PENDING_RESTORE_DIR);
    fs.rmSync(path.join(pending, BACKUP_DB_DIR, "usage.db"));

    const outcome = await applyPendingRestore(userDataDir);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toMatch(/已丢弃/);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("套用异常后的暂存区可隔离，后续启动不再永久重试", async () => {
    const root = await backupOnce();
    await stagePendingRestore(root, userDataDir);
    const quarantined = await quarantinePendingRestore(userDataDir);
    expect(quarantined).not.toBeNull();
    expect(fs.existsSync(quarantined!)).toBe(true);
    expect(await hasPendingRestore(userDataDir)).toBe(false);
    expect((await applyPendingRestore(userDataDir)).applied).toBe(false);
  });
});

describe("产物对账：如实报数，但不决定备份是否可用", () => {
  it("文件不在磁盘上时计入 missing，validation 仍然可用", async () => {
    // 造一条 ready 产物，指向一个并不存在的相对路径。
    const db = new DatabaseSync(path.join(userDataDir, "artifacts.db"));
    try {
      db.prepare(
        `INSERT INTO artifacts (id, logical_key, name, kind, workspace_id, version, sha256,
          created_at, updated_at, export_path, status, size_bytes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run("a1", "报告.docx", "报告.docx", "document", "ws", 1, "ff", 1, 1, "报告.docx", "ready", 42);
    } finally {
      db.close();
    }

    const root = await backupOnce();
    const validation = await validateBackupAt(root);
    expect(validation.ok).toBe(true);
    expect(validation.artifacts).toEqual({
      checked: 1,
      missing: 1,
      sizeMismatch: 0,
      unresolvedWorkspaces: 0,
    });
  });

  it("产物导出路径越界属于元数据自身损坏，这一条是硬判据", async () => {
    const db = new DatabaseSync(path.join(userDataDir, "artifacts.db"));
    try {
      db.prepare(
        `INSERT INTO artifacts (id, logical_key, name, kind, workspace_id, version, sha256,
          created_at, updated_at, export_path, status, size_bytes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run("a2", "x", "x", "other", "ws", 1, "ff", 1, 1, "../../etc/passwd", "ready", 1);
    } finally {
      db.close();
    }

    // 备份自校验就该在这里失败——一条越界的产物记录被恢复回去之后，
    // 「打开产物」就成了一条读任意文件的路。
    await expect(
      createBackup({
        dataDir: userDataDir,
        destinationRoot: path.join(backupParent, "bad"),
        appVersion: "x",
      })
    ).rejects.toThrow(/越界段/);
  });
});

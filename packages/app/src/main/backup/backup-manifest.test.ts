/**
 * 备份清单纯逻辑的对拍（BKP-101）。
 *
 * 这个文件里没有任何 IO：它测的是「路径能不能落在根里」「两份盘点一不一致、
 * 哪里不一致」这两件可以被逐条对拍的事。真正开库、读盘、fsync 的往返在
 * backup-service.test.ts。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BACKUP_DB_DIR,
  BackupError,
  SQLITE_STORES,
  assertSeparateRoots,
  diffInventory,
  findStoreByBackupPath,
  resolveInside,
  sameInventory,
  sortInventory,
  storeBackupPath,
  type InventoryEntry,
} from "./backup-manifest.js";

const sha = (n: string): string => `sha256:${n.repeat(64).slice(0, 64)}`;

describe("resolveInside：清单里的路径不许逃出备份根", () => {
  it("普通相对路径原样落在根里", () => {
    expect(resolveInside("/root", "db/artifacts.db")).toBe("/root/db/artifacts.db");
    // Windows 分隔符也接受（清单归一成 `/`，但手改过的清单可能是 `\`）
    expect(resolveInside("/root", "db\\artifacts.db")).toBe("/root/db/artifacts.db");
    // 根末尾的斜杠不该多出一层
    expect(resolveInside("/root/", "a.json")).toBe("/root/a.json");
  });

  it.each([
    ["空路径", ""],
    ["向上一层", "../evil"],
    ["藏在中间的向上一层", "db/../../evil"],
    ["POSIX 绝对路径", "/etc/passwd"],
    ["Windows 盘符绝对形态", "C:\\Windows\\System32\\x.dll"],
    // 盘符相对形态：`C:foo` 在 Windows 上解到「C 盘当前目录下的 foo」，
    // 而那个「当前目录」和我们的备份根毫无关系。
    ["Windows 盘符相对形态", "C:evil"],
    ["UNC", "\\\\server\\share\\x"],
    ["含 NUL", "db/a\0b.db"],
    ["双斜杠制造的空段", "db//a.db"],
  ])("拒绝 %s", (_label, bad) => {
    expect(() => resolveInside("/root", bad)).toThrow(BackupError);
  });
});

describe("assertSeparateRoots：备份根与数据根不得重叠", () => {
  const rel = path.posix.relative;

  it("兄弟目录放行", () => {
    expect(() => assertSeparateRoots("/a/data", "/a/backup", rel)).not.toThrow();
  });

  it("完全相同要拒", () => {
    expect(() => assertSeparateRoots("/a/data", "/a/data", rel)).toThrow(BackupError);
  });

  it("备份到自己的子目录要拒（否则盘点会把刚写的文件再算一遍）", () => {
    expect(() => assertSeparateRoots("/a/data", "/a/data/backup", rel)).toThrow(BackupError);
  });

  it("反向嵌套同样要拒", () => {
    expect(() => assertSeparateRoots("/a/data/inner", "/a/data", rel)).toThrow(BackupError);
  });

  it("「兄弟目录名恰好以对方为前缀」不算嵌套", () => {
    // 字符串前缀比较会把 /a/data-old 误判成在 /a/data 之内
    expect(() => assertSeparateRoots("/a/data", "/a/data-old", rel)).not.toThrow();
  });
});

describe("盘点比较", () => {
  const a: InventoryEntry = { path: "db/a.db", size: 10, sha256: sha("a") };
  const b: InventoryEntry = { path: "db/b.db", size: 20, sha256: sha("b") };

  it("排序按 localeCompare，使全等比较可用", () => {
    expect(sortInventory([b, a]).map((e) => e.path)).toEqual(["db/a.db", "db/b.db"]);
  });

  it("同一份盘点全等", () => {
    expect(sameInventory([a, b], [a, b])).toBe(true);
  });

  it("内容变了即不等，且 diff 指出是哪个文件的 sha256", () => {
    const tampered = { ...a, sha256: sha("c") };
    expect(sameInventory([tampered, b], [a, b])).toBe(false);
    expect(diffInventory([tampered, b], [a, b])).toEqual(["文件 sha256 与清单不符：db/a.db"]);
  });

  it("大小变了单独报一条", () => {
    const grown = { ...a, size: 11 };
    expect(diffInventory([grown, b], [a, b])).toContain(
      "文件大小与清单不符：db/a.db（清单 10，实际 11）"
    );
  });

  it("缺文件 / 多文件各自报出具体路径", () => {
    expect(diffInventory([a], [a, b])).toEqual(["备份缺少文件：db/b.db"]);
    expect(diffInventory([a, b], [a])).toEqual(["备份多出清单外的文件：db/b.db"]);
  });
});

describe("库登记表", () => {
  it("id 与文件名都唯一（重复会让清单里两条记录互相覆盖）", () => {
    expect(new Set(SQLITE_STORES.map((s) => s.id)).size).toBe(SQLITE_STORES.length);
    expect(new Set(SQLITE_STORES.map((s) => s.file)).size).toBe(SQLITE_STORES.length);
  });

  it("备份内路径可反查回描述符", () => {
    for (const store of SQLITE_STORES) {
      expect(storeBackupPath(store)).toBe(`${BACKUP_DB_DIR}/${store.file}`);
      expect(findStoreByBackupPath(storeBackupPath(store))?.id).toBe(store.id);
    }
    expect(findStoreByBackupPath("db/not-ours.db")).toBeNull();
  });

  it("每个库都至少声明一张必需表", () => {
    for (const store of SQLITE_STORES) {
      expect(store.requiredTables.length).toBeGreaterThan(0);
    }
  });

  /**
   * 登记表里的数字是字面量副本（备份域不能反向 import 各 store）。
   * 任一 store 推代际而这里没跟上，备份会把刚写出来的库判成「代际不符」。
   */
  it("登记表代际与各 store 常量一致", async () => {
    const { MEMORY_DATA_SCHEMA_VERSION } = await import("@pibuddy/contract");
    const { ARTIFACT_SCHEMA_VERSION } = await import("../artifacts/artifact-store.js");
    const { CHANGESET_SCHEMA_VERSION } = await import("../changeset/changeset-store.js");
    const { CONNECTOR_STORE_SCHEMA_VERSION } = await import("../connector/connector-store.js");
    const { HOME_STORE_SCHEMA_VERSION } = await import("../home/ha-store.js");
    const { AUTOMATION_STORE_SCHEMA_VERSION } = await import(
      "../home-automation/automation-store.js"
    );
    const { REMOTE_REGISTRY_SCHEMA_VERSION } = await import("../remote/device-registry.js");
    const { SESSION_INDEX_SCHEMA_VERSION } = await import("../sessions/session-index.js");
    const { TASKS_STORE_SCHEMA_VERSION } = await import("../tasks/task-store.js");
    const { USAGE_SCHEMA_VERSION } = await import("../usage/usage-store.js");
    const { WORKFLOW_STORE_SCHEMA_VERSION } = await import("../workflow/workflow-store.js");
    const { WORKSPACE_STORE_SCHEMA_VERSION } = await import("../workspace/workspace-store.js");

    const expected: Record<string, number> = {
      artifacts: ARTIFACT_SCHEMA_VERSION,
      changesets: CHANGESET_SCHEMA_VERSION,
      connectors: CONNECTOR_STORE_SCHEMA_VERSION,
      "home-assistant": HOME_STORE_SCHEMA_VERSION,
      "home-automation": AUTOMATION_STORE_SCHEMA_VERSION,
      memory: MEMORY_DATA_SCHEMA_VERSION,
      remote: REMOTE_REGISTRY_SCHEMA_VERSION,
      "session-index": SESSION_INDEX_SCHEMA_VERSION,
      tasks: TASKS_STORE_SCHEMA_VERSION,
      usage: USAGE_SCHEMA_VERSION,
      workflows: WORKFLOW_STORE_SCHEMA_VERSION,
      workspaces: WORKSPACE_STORE_SCHEMA_VERSION,
    };
    expect(Object.keys(expected).sort()).toEqual(SQLITE_STORES.map((s) => s.id).sort());
    for (const store of SQLITE_STORES) {
      expect(store.schemaVersion, store.id).toBe(expected[store.id]);
    }
  });
});

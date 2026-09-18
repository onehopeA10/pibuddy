/**
 * 备份清单的**纯逻辑**（BKP-101）：库登记表、清单编解码、路径收容判定。
 *
 * 本文件不 import electron、不 import node:fs、不做任何 IO —— 它是可以被
 * 直接对拍的那一半：给一份清单和一份实际盘点，它说得出「一不一致、哪里不
 * 一致」；给一段用户可控的相对路径，它说得出「这条路径能不能落在根目录里」。
 * 真正读盘、开库、fsync 的那一半在 backup-service.ts。
 *
 * ## 为什么盘点要排序
 *
 * 校验最终退化成一次 `JSON.stringify(actual) === JSON.stringify(expected)`。
 * 那要求两侧的条目顺序完全一致，而 readdir 的顺序在不同文件系统上不同
 * （Windows NTFS 与 ext4 就不同）。因此盘点在返回前一律按 `localeCompare`
 * 排序，路径分隔符一律归一成 `/`。少了这两步，同一份备份在另一台机器上校验
 * 就会「无缘无故」失败，而失败信息指不出任何具体的坏文件。
 */

/** 备份目录里的清单文件名（与契约同名常量同值，此处不再重复定义）。 */
export { BACKUP_MANIFEST_FILE } from "@pibuddy/contract";

/** 备份目录里放 sqlite 库的子目录。 */
export const BACKUP_DB_DIR = "db";

/** 工作区注册表文件名（sqlite 里的 workspace_id 列全靠它才有含义）。 */
export const WORKSPACE_REGISTRY_FILE = "workspaces.json";

/** 恢复暂存区目录名（落在 userData 下，下次启动前套用）。 */
export const PENDING_RESTORE_DIR = "pending-restore";

/** 备份状态落盘文件名（上次备份时间 / 上次校验结论）。 */
export const BACKUP_STATE_FILE = "backup-state.json";

// ---------------------------------------------------------------- 错误

export type BackupErrorCode =
  | "invalid_root"
  | "overlapping_roots"
  | "destination_not_empty"
  | "unsupported_schema"
  | "corrupt_backup"
  | "no_stores";

/**
 * 备份域的唯一错误类型。
 *
 * `code` 供调用方分支，`message` 必须**已经含有具体原因**：一句「备份无效」
 * 让运维分不清是 sha256 对不上、完整性坏了、外键失配、代际不符还是缺表，
 * 而 `cause` 在跨进程 / 落日志的路上几乎总会被丢掉。
 */
export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BackupError";
  }
}

// ---------------------------------------------------------------- 库登记表

/** 一个库的 schema 代际存在哪儿。 */
export type SchemaVersionSource =
  | { kind: "user_version" }
  /** usage.db 把代际写在 usage_meta 表的一行里，而不是 PRAGMA user_version */
  | { kind: "meta_table"; table: string; keyColumn: string; valueColumn: string; key: string };

export interface SqliteStoreDescriptor {
  /** 稳定标识（= 文件名去扩展名）。清单里记的就是它。 */
  readonly id: string;
  /** userData 下的文件名 */
  readonly file: string;
  /** 一句人话，说明这个库装的是什么（UI 直接列出来） */
  readonly title: string;
  /**
   * 备份时刻应有的 schema 代际。
   *
   * 这里是**字面量副本**，不是从各 store 模块 import 来的常量：内核的备份域
   * 若为了取 12 个数字而 import 12 个能力域的 store 模块，就把「谁依赖谁」
   * 反过来了（能力可以依赖内核，内核不该依赖能力）。副本的漂移风险由
   * backup-manifest.test.ts 的对账用例兜住 —— 任何一个 store 改了代际而没改
   * 这里，那个用例当场红。
   */
  readonly schemaVersion: number;
  readonly versionSource: SchemaVersionSource;
  /**
   * 必须存在的表。缺一张就是「库在、但内容已经不是那个库」——
   * 这种备份恢复回去的表现是应用起得来、面板全空、不报任何错。
   */
  readonly requiredTables: readonly string[];
}

const USER_VERSION: SchemaVersionSource = { kind: "user_version" };

/**
 * 全部 12 个 sqlite 库。
 *
 * 它们**互相之间没有外键、没有跨库事务**（全仓 `FOREIGN KEY` / `REFERENCES` /
 * `ATTACH DATABASE` 命中数为 0，D4 铁律：一个能力域一个库）。这正是「逐库
 * 备份 + 统一清单」这个方案成立的前提：没有跨库不变量要维护，逐库快照点不同
 * 不会撕裂任何一条约束。
 */
export const SQLITE_STORES: readonly SqliteStoreDescriptor[] = [
  {
    id: "artifacts",
    file: "artifacts.db",
    title: "产物库（版本链与状态；文件本体在工作区，不在备份里）",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["artifacts"],
  },
  {
    id: "changesets",
    file: "changesets.db",
    title: "变更集（工作区改动评审）",
    schemaVersion: 2,
    versionSource: USER_VERSION,
    requiredTables: ["changesets"],
  },
  {
    id: "connectors",
    file: "connectors.db",
    title: "外部渠道连接器",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["connectors"],
  },
  {
    id: "home-assistant",
    file: "home-assistant.db",
    title: "智能家居实体注册表",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["ha_registry"],
  },
  {
    id: "home-automation",
    file: "home-automation.db",
    title: "智能家居自动化规则",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["automation_rules"],
  },
  {
    id: "memory",
    file: "memory.db",
    title: "长期记忆与知识库（含向量）",
    schemaVersion: 4,
    versionSource: USER_VERSION,
    requiredTables: [
      "memories",
      "memories_fts",
      "memory_meta",
      "embeddings",
      "knowledge",
      "knowledge_fts",
      "working_items",
      "memory_candidates",
      "memory_conflicts",
      "memory_route_events",
    ],
  },
  {
    id: "remote",
    file: "remote.db",
    title: "远程访问设备与审计",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["remote_devices", "remote_challenges", "remote_config", "remote_audit"],
  },
  {
    id: "session-index",
    file: "session-index.db",
    title: "会话索引",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["sessions"],
  },
  {
    id: "tasks",
    file: "tasks.db",
    title: "定时任务与运行记录",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["tasks", "runs"],
  },
  {
    id: "usage",
    file: "usage.db",
    title: "本地用量与花费统计",
    schemaVersion: 2,
    // usage 是唯一把代际写进业务表的库（usage_meta 的一行），不是 user_version。
    // 用统一口径去读它会恒读到 0，然后每次恢复都报「代际不符」。
    versionSource: {
      kind: "meta_table",
      table: "usage_meta",
      keyColumn: "key",
      valueColumn: "value",
      key: "schemaVersion",
    },
    requiredTables: ["usage_meta", "usage_daily", "usage_session_seen", "usage_session_daily"],
  },
  {
    id: "workflows",
    file: "workflows.db",
    title: "可视化工作流定义与运行",
    schemaVersion: 1,
    versionSource: USER_VERSION,
    requiredTables: ["workflow_definitions", "workflow_runs"],
  },
  {
    id: "workspaces",
    file: "workspaces.db",
    title: "工作区偏好",
    schemaVersion: 2,
    versionSource: USER_VERSION,
    requiredTables: ["workspaces"],
  },
];

/** 备份内该库的相对路径（`/` 归一，清单里逐字记这个值）。 */
export function storeBackupPath(store: SqliteStoreDescriptor): string {
  return `${BACKUP_DB_DIR}/${store.file}`;
}

export function findStoreByBackupPath(path: string): SqliteStoreDescriptor | null {
  return SQLITE_STORES.find((s) => storeBackupPath(s) === path) ?? null;
}

// ---------------------------------------------------------------- 路径收容

/**
 * 把一段**来自清单**的相对路径解到 root 之内，越界即抛。
 *
 * 清单是磁盘上的文件，可以被手改。`../../` 与 Windows 盘符（`C:\…`、
 * `C:foo` 这种盘符相对形态）都必须挡在 copyFile 之前 —— 恢复流程写的是
 * 用户的应用数据目录，一条越界路径等于「用备份里的任意内容覆盖任意文件」。
 *
 * 判据与 workspace-registry 的 resolveInWorkspace 同源：`relative()` 之后
 * 看是否以 `..` 开头。额外拒绝空串（那是 root 自身，不是一个文件）。
 */
export function resolveInside(root: string, candidatePath: string): string {
  // 这里刻意用手写的 posix/win 双形态判定而不是 node:path：本文件要保持
  // 零 IO、零平台依赖，且判定逻辑本身要能被逐条对拍。
  if (typeof candidatePath !== "string" || candidatePath === "") {
    throw new BackupError("corrupt_backup", `备份内路径非法（空路径）`);
  }
  if (candidatePath.includes("\0")) {
    throw new BackupError("corrupt_backup", `备份内路径非法（含 NUL）：${candidatePath}`);
  }
  // 绝对路径（POSIX 根、Windows 盘符、UNC）一律拒绝
  if (
    candidatePath.startsWith("/") ||
    candidatePath.startsWith("\\") ||
    /^[a-zA-Z]:/.test(candidatePath)
  ) {
    throw new BackupError("corrupt_backup", `备份内路径必须是相对路径：${candidatePath}`);
  }
  const segments = candidatePath.split(/[\\/]/);
  if (segments.some((s) => s === ".." || s === "")) {
    throw new BackupError("corrupt_backup", `备份内路径含越界段：${candidatePath}`);
  }
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return `${normalizedRoot}/${segments.join("/")}`;
}

/**
 * 两个根目录不得重叠（含「互为子目录」与「完全相同」）。
 *
 * 双向 `relative()`：只判一个方向的话，「备份到自己的子目录」会通过 —— 那
 * 会让备份把自己刚写出来的文件再盘点一遍，`inventory` 与清单永远对不上，
 * 而且规模每跑一次翻一倍。
 *
 * 形参收的是已经 resolve 过的绝对路径；`relative` 由调用方注入（保持本文件
 * 零 node 依赖，同时让 Windows 的大小写不敏感语义由 node:path 负责）。
 */
export function assertSeparateRoots(
  left: string,
  right: string,
  relative: (from: string, to: string) => string
): void {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const escapes = (rel: string): boolean => rel.startsWith("..") || /^[a-zA-Z]:/.test(rel);
  if (left === right || !escapes(leftToRight) || !escapes(rightToLeft)) {
    throw new BackupError(
      "overlapping_roots",
      `备份目录与数据目录不得重叠：${left} 与 ${right}`
    );
  }
}

// ---------------------------------------------------------------- 盘点比较

export interface InventoryEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** 按路径的 `localeCompare` 排序（见文件头：校验要退化成一次全等比较）。 */
export function sortInventory<T extends { path: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 两份盘点是否逐字相同。
 *
 * 用 `JSON.stringify` 全等而不是逐字段循环：字段一旦增加（比如将来加
 * mtime），循环版本会安静地漏比新字段，而全等版本会立刻红。
 */
export function sameInventory(
  actual: readonly InventoryEntry[],
  expected: readonly InventoryEntry[]
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * 逐条比出**具体**哪里不一致（缺文件 / 多文件 / 大小变了 / 内容变了）。
 *
 * `sameInventory` 只回答「一不一致」。用户看到的必须是「artifacts.db 的
 * sha256 与清单不符」，而不是一句「备份文件清单不匹配」。
 */
export function diffInventory(
  actual: readonly InventoryEntry[],
  expected: readonly InventoryEntry[]
): string[] {
  const reasons: string[] = [];
  const actualByPath = new Map(actual.map((e) => [e.path, e]));
  const expectedByPath = new Map(expected.map((e) => [e.path, e]));
  for (const want of expected) {
    const got = actualByPath.get(want.path);
    if (!got) {
      reasons.push(`备份缺少文件：${want.path}`);
      continue;
    }
    if (got.size !== want.size) {
      reasons.push(`文件大小与清单不符：${want.path}（清单 ${want.size}，实际 ${got.size}）`);
    }
    if (got.sha256 !== want.sha256) {
      reasons.push(`文件 sha256 与清单不符：${want.path}`);
    }
  }
  for (const got of actual) {
    if (!expectedByPath.has(got.path)) reasons.push(`备份多出清单外的文件：${got.path}`);
  }
  return reasons;
}

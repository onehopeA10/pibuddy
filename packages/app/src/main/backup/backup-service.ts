/**
 * 备份 / 校验 / 恢复的 IO 面（BKP-101）。
 *
 * **本文件不 import electron**：数据目录、备份目录、应用版本、时钟一律由
 * 调用方（backup-ipc.ts）注入。因此完整的 备份→校验→恢复 往返可以在真临时
 * 目录上被单测直接跑一遍，而不必先搭一套 Electron 打桩。
 *
 * ## 写入序列：暂存 → fsync → 复盘点 → 原子 rename
 *
 * 备份先写到 `<dest>.<pid>.<uuid>.tmp`，每个文件 copy 后 chmod 0600 + fsync，
 * 目录链一路 fsync，然后**重新盘点一次再校验一次**，最后才 rename 到目标名，
 * 再 fsync 父目录。中途任何一步失败就 rm -rf 掉暂存区。
 *
 * 少了「rename 才现身」这一步，一次断电 / 一次 Ctrl-C 留下的是一个**看起来
 * 像备份的半成品**：目录在、清单在、少了三个库。用户会在真正需要它的那天
 * 才发现，而那天已经没有第二份了。
 *
 * ## 快照必须自包含
 *
 * `backup()` 出来的快照继承源库的 `journal_mode = WAL`。WAL 库的数据分布在
 * `.db` / `.db-wal` / `.db-shm` 三个文件里，而备份只收 `.db`（`-wal`/`-shm`
 * 是随时可再生的运行期文件，收进去反而会在恢复时被 sqlite 当成待重放的日志）。
 * 因此快照落地后立刻 `PRAGMA journal_mode = DELETE` 并**校验返回值**——
 * 这条 PRAGMA 在有活跃读者时会静默返回 `wal`（不报错），不校验返回值的话，
 * 备份里躺的就是一个缺了最近若干次写入的库，而校验全绿。
 *
 * ## Windows 特判
 *
 * fsync 在只读句柄上 Windows 返回 EPERM，因此 syncFile 用 `open(path, 'r+')`
 * 重开一次；目录 fsync 在 win32 上不被支持，直接 return（那台机器上的目录项
 * 持久化由文件系统自己负责）。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  backupManifestSchema,
  type ArtifactReconciliation,
  type BackupManifest,
  type BackupValidation,
} from "@pibuddy/contract";

import {
  BACKUP_DB_DIR,
  BACKUP_MANIFEST_FILE,
  BACKUP_STATE_FILE,
  BackupError,
  PENDING_RESTORE_DIR,
  SQLITE_STORES,
  WORKSPACE_REGISTRY_FILE,
  assertSeparateRoots,
  diffInventory,
  findStoreByBackupPath,
  resolveInside,
  sameInventory,
  sortInventory,
  storeBackupPath,
  type InventoryEntry,
  type SqliteStoreDescriptor,
} from "./backup-manifest.js";

// ---------------------------------------------------------------- 稳定存储

/**
 * 文件级 fsync。
 *
 * Windows 拒绝在只读句柄上 fsync（EPERM），而这里要 sync 的都是我们刚写出来
 * 的文件，因此用 `r+` 重开：不创建、不截断，只是拿一个可写句柄来落屏障。
 */
async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 目录级 fsync。win32 不支持对目录 fsync，直接 return。 */
async function syncDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 从 `dir` 一路 fsync 到 `root`（含两端）。
 *
 * 只 fsync 文件不 fsync 目录，掉电后可能拿到「文件内容在、目录项不在」的
 * 状态 —— 表现是备份目录里少了几个文件，而清单里有。
 */
async function syncDirectoryChain(dir: string, root: string): Promise<void> {
  const boundary = path.resolve(root);
  let current = path.resolve(dir);
  const fromBoundary = path.relative(boundary, current);
  if (fromBoundary === ".." || fromBoundary.startsWith(`..${path.sep}`) || path.isAbsolute(fromBoundary)) {
    throw new BackupError("invalid_root", `fsync 路径越出备份根：${dir}`);
  }
  for (;;) {
    await syncDirectory(current);
    if (current === boundary) return;
    current = path.dirname(current);
  }
}

// ---------------------------------------------------------------- 盘点

/**
 * 流式算 size + sha256。
 *
 * 不 readFile 再 hash：sqlite 库能长到几百 MB，一次性读进内存在一台内存吃紧
 * 的机器上就是一次 OOM，而 OOM 发生在「用户点了备份」这一刻。
 *
 * 路径以 `/` 归一后记录：Windows 上 `relative()` 给的是 `db\artifacts.db`，
 * 那样的清单换到 macOS 上校验会逐条对不上。
 */
async function describeFile(root: string, absPath: string): Promise<InventoryEntry> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(absPath)) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return {
    path: path.relative(root, absPath).split("\\").join("/"),
    size,
    sha256: `sha256:${hash.digest("hex")}`,
  };
}

async function walk(root: string, current: string, out: InventoryEntry[]): Promise<void> {
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    // 清单自己不进清单（它含着清单的哈希，自指的话永远算不出来）。
    if (current === root && entry.name === BACKUP_MANIFEST_FILE) continue;
    // -wal / -shm 显式跳过：它们是运行期文件，且我们已把快照归一成自包含。
    // 收进清单会让「同一份备份换台机器校验」因为 sqlite 自己重建了 -shm 而失败。
    if (entry.name.endsWith("-wal") || entry.name.endsWith("-shm")) continue;
    const abs = path.resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new BackupError("corrupt_backup", `备份内不允许出现符号链接：${entry.name}`);
    }
    if (entry.isDirectory()) {
      await walk(root, abs, out);
      continue;
    }
    if (!entry.isFile()) {
      throw new BackupError("corrupt_backup", `备份内出现非普通文件：${entry.name}`);
    }
    out.push(await describeFile(root, abs));
  }
}

/** 盘点整棵树，排序后返回（见 backup-manifest 文件头）。 */
export async function inventory(root: string): Promise<InventoryEntry[]> {
  const out: InventoryEntry[] = [];
  await walk(path.resolve(root), path.resolve(root), out);
  return sortInventory(out);
}

// ---------------------------------------------------------------- 快照归一

/**
 * 把刚 backup() 出来的快照转成**自包含**的单文件库。
 *
 * 返回值必须校验：`PRAGMA journal_mode = DELETE` 在切不动时返回旧模式而不是
 * 抛错，于是一个仍然依赖 `-wal` 的快照会被当成成功的备份写进清单。
 */
function normalizeStandaloneSqliteSnapshot(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("PRAGMA journal_mode = DELETE").get() as
      | { journal_mode?: unknown }
      | undefined;
    if (row?.journal_mode !== "delete") {
      throw new BackupError(
        "corrupt_backup",
        `无法把 ${path.basename(file)} 的快照转成自包含（journal_mode 仍为 ${String(row?.journal_mode)}）`
      );
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 逐库校验

function readSchemaVersion(db: DatabaseSync, store: SqliteStoreDescriptor): number {
  if (store.versionSource.kind === "user_version") {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }
  const src = store.versionSource;
  const row = db
    .prepare(`SELECT ${src.valueColumn} AS v FROM ${src.table} WHERE ${src.keyColumn} = ?`)
    .get(src.key) as { v?: unknown } | undefined;
  return Number(row?.v ?? 0);
}

/**
 * 一个库的多层校验。失败**抛出带具体原因的 BackupError**。
 *
 * 五层，缺一层都会让一类坏备份看起来是好的：
 *   1. `integrity_check`  —— 页损坏 / 索引与表对不上；
 *   2. `foreign_key_check`—— 库内引用完整性（现网各库无外键，这一层是给
 *      将来加了外键的库预留的常驻闸，不是可选项）；
 *   3. schema 代际        —— 版本不符的库恢复回去会被 migrate 当成旧库处理；
 *   4. 必需表存在性       —— 表没了的表现是「应用起得来、面板全空、不报错」；
 *   5. 只读事务           —— 全程 readOnly + query_only + BEGIN/ROLLBACK，
 *      校验这件事本身一个字节都不许改到被校验的库。
 */
function validateSqlite(file: string, store: SqliteStoreDescriptor): void {
  try {
    const meta = statSync(file);
    if (!meta.isFile()) throw new Error("不是普通文件");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; BEGIN");

      const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check?: unknown;
      }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
        throw new Error(
          `integrity_check 未通过（${integrity.map((r) => String(r.integrity_check)).join("; ")}）`
        );
      }

      const fk = db.prepare("PRAGMA foreign_key_check").all();
      if (fk.length > 0) throw new Error(`foreign_key_check 有 ${fk.length} 条违规`);

      const tableExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?"
      );
      const missing = store.requiredTables.filter((t) => tableExists.get(t) === undefined);
      if (missing.length > 0) throw new Error(`缺少必需的表：${missing.join(", ")}`);

      // 代际读在必需表校验**之后**：usage 的代际就存在 usage_meta 里，
      // 表都没了的话先报「缺表」比报一句「代际为 0」有用得多。
      const version = readSchemaVersion(db, store);
      if (version !== store.schemaVersion) {
        throw new Error(`schema 代际不符（期望 ${store.schemaVersion}，实际 ${version}）`);
      }
    } finally {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 保留原始校验错误，不要被收尾动作的错误盖掉。
      }
      db.close();
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new BackupError("corrupt_backup", `库 ${store.id} 校验失败：${reason}`, { cause: err });
  }
}

// ---------------------------------------------------------------- 产物对账

/**
 * 产物元数据（sqlite）↔ 产物本体（文件系统）的交叉对账。
 *
 * ## 为什么它不是准入判据
 *
 * 参考实现（maka）把产物本体一并收进备份，因此那里的对账是硬判据。**我们
 * 不收**：产物本体是用户工作区里的普通 .docx / .xlsx，属于用户自己的文件，
 * 备份它等于未经同意复制用户全部工作产出。于是对账的对象变成了「备份里的
 * 元数据」与「此刻磁盘上的活文件」——后者随时可能被用户改、删、连同工作区
 * 一起搬走，而那恰恰是 artifact-store 用 `conflicted` / `failed` 建模的正常
 * 情形。让它决定备份能不能做，等于「你昨天编辑过一个表格，所以今天不许备份」。
 *
 * 因此它**如实报数**（缺了几个、几个大小对不上、几个工作区已不在注册表里）
 * 并原样呈现在 UI 上，但不改变 ok。真正硬的是下面这条：元数据**自身**的
 * 自洽性（导出路径必须落在工作区内、ready 的记录必须有 sha256），那是备份
 * 内部的事，坏了就是坏了。
 */
function crossCheckArtifacts(backupRoot: string): ArtifactReconciliation | null {
  const file = path.join(backupRoot, BACKUP_DB_DIR, "artifacts.db");
  let roots: Map<string, string>;
  try {
    statSync(file);
  } catch {
    return null; // 这份备份里没有产物库（该 store 从未被创建过）
  }
  try {
    roots = readWorkspaceRoots(backupRoot);
  } catch {
    roots = new Map();
  }

  const db = new DatabaseSync(file, { readOnly: true });
  let checked = 0;
  let missing = 0;
  let sizeMismatch = 0;
  let unresolved = 0;
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    const rows = db
      .prepare(
        "SELECT id, workspace_id, export_path, size_bytes, sha256 FROM artifacts WHERE status = 'ready' ORDER BY id"
      )
      .all() as Array<{
      id?: unknown;
      workspace_id?: unknown;
      export_path?: unknown;
      size_bytes?: unknown;
      sha256?: unknown;
    }>;
    for (const row of rows) {
      const id = String(row.id);
      const exportPath = row.export_path;
      if (typeof exportPath !== "string" || exportPath === "") {
        throw new BackupError("corrupt_backup", `产物 ${id} 的导出路径为空`);
      }
      if (typeof row.sha256 !== "string" || row.sha256 === "") {
        throw new BackupError("corrupt_backup", `产物 ${id} 标为 ready 却没有 sha256`);
      }
      // 硬判据：导出路径必须能落在工作区内。越界的记录一旦被恢复回去，
      // 「打开产物」就成了一条读任意文件的路。
      resolveInside("/workspace-root", exportPath);
      checked += 1;
      const root = roots.get(String(row.workspace_id));
      if (root === undefined) {
        unresolved += 1;
        continue;
      }
      try {
        const st = statSync(path.resolve(root, exportPath));
        if (st.size !== Number(row.size_bytes)) sizeMismatch += 1;
      } catch {
        missing += 1;
      }
    }
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 保留原始错误 */
    }
    db.close();
  }
  return { checked, missing, sizeMismatch, unresolvedWorkspaces: unresolved };
}

function readWorkspaceRoots(backupRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  // 同步读：整个对账跑在一个 sqlite 只读事务里，中途 await 会把那个事务
  // 跨到别的微任务上去。注册表只有几 KB。
  const raw = JSON.parse(
    readFileSync(path.join(backupRoot, WORKSPACE_REGISTRY_FILE), "utf8")
  ) as Record<string, { root?: unknown }>;
  for (const [id, rec] of Object.entries(raw ?? {})) {
    if (rec && typeof rec.root === "string" && rec.root !== "") map.set(id, rec.root);
  }
  return map;
}

// ---------------------------------------------------------------- 清单

function decodeManifest(raw: unknown): BackupManifest {
  const parsed = backupManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const record = (raw ?? {}) as Record<string, unknown>;
    if (record.format !== BACKUP_FORMAT) {
      throw new BackupError("corrupt_backup", `不是 PiBuddy 备份（format=${String(record.format)}）`);
    }
    if (record.schemaVersion !== BACKUP_SCHEMA_VERSION) {
      throw new BackupError(
        "unsupported_schema",
        `备份代际不受支持（期望 ${BACKUP_SCHEMA_VERSION}，实际 ${String(record.schemaVersion)}）`
      );
    }
    throw new BackupError(
      "corrupt_backup",
      `备份清单结构非法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
    );
  }
  const manifest = parsed.data;
  for (const file of manifest.files) {
    if (file.path === BACKUP_MANIFEST_FILE) {
      throw new BackupError("corrupt_backup", "备份清单不得把自己列进文件表");
    }
    resolveInside("/backup-root", file.path);
  }
  const paths = new Set(manifest.files.map((f) => f.path));
  for (const store of manifest.stores) {
    if (!paths.has(store.path)) {
      throw new BackupError("corrupt_backup", `清单声明了库 ${store.id} 却没有对应的文件条目`);
    }
    if (findStoreByBackupPath(store.path) === null) {
      throw new BackupError("corrupt_backup", `清单声明了本版本不认识的库：${store.id}`);
    }
  }
  return manifest;
}

async function readManifest(backupRoot: string): Promise<BackupManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(backupRoot, BACKUP_MANIFEST_FILE), "utf8"));
  } catch (err) {
    throw new BackupError("corrupt_backup", `备份清单缺失或不是合法 JSON：${backupRoot}`, {
      cause: err,
    });
  }
  return decodeManifest(raw);
}

// ---------------------------------------------------------------- 校验入口

/**
 * 校验一份备份。**不抛**校验失败——把每一条失败原因如实收进 `reasons`。
 *
 * 抛错的写法逼着 UI 只能显示第一条原因；而「sha256 对不上」与「memory 库缺
 * 了 knowledge 表」同时发生时，只看到前一条的人会去查磁盘，看不到后一条。
 */
export async function validateBackupAt(
  backupRoot: string,
  now: () => number = Date.now
): Promise<BackupValidation> {
  const root = path.resolve(backupRoot);
  const checkedAt = now();
  const empty: BackupValidation = {
    ok: false,
    path: root,
    createdAt: null,
    fileCount: 0,
    totalBytes: 0,
    stores: [],
    reasons: [],
    artifacts: null,
    checkedAt,
  };

  let manifest: BackupManifest;
  try {
    manifest = await readManifest(root);
  } catch (err) {
    return { ...empty, reasons: [reasonOf(err)] };
  }

  const reasons: string[] = [];
  let actual: InventoryEntry[] = [];
  try {
    actual = await inventory(root);
  } catch (err) {
    return { ...empty, createdAt: manifest.createdAt, reasons: [reasonOf(err)] };
  }

  // 显式重建条目而不是直接把 manifest.files 当成盘点：全等比较对键的**顺序**
  // 敏感，而 JSON 解析出来的键序取决于磁盘上那份文件怎么写的。
  const expected = sortInventory(
    manifest.files.map((f): InventoryEntry => ({ path: f.path, size: f.size, sha256: f.sha256 }))
  );
  if (!sameInventory(actual, expected)) {
    reasons.push(...diffInventory(actual, expected));
    // 盘点对不上时不再开库：一个 sha256 已经不符的文件，sqlite 报出来的
    // 错误信息只会把注意力引到错的方向上。
    return {
      ...empty,
      createdAt: manifest.createdAt,
      fileCount: actual.length,
      totalBytes: actual.reduce((s, e) => s + e.size, 0),
      reasons,
    };
  }

  const okStores: string[] = [];
  for (const declared of manifest.stores) {
    const store = findStoreByBackupPath(declared.path);
    if (store === null) {
      reasons.push(`清单声明了本版本不认识的库：${declared.id}`);
      continue;
    }
    if (declared.schemaVersion !== store.schemaVersion) {
      reasons.push(
        `库 ${store.id} 校验失败：清单记的代际 ${declared.schemaVersion} 与本版本期望的 ${store.schemaVersion} 不符`
      );
      continue;
    }
    try {
      validateSqlite(path.join(root, ...declared.path.split("/")), store);
      okStores.push(store.id);
    } catch (err) {
      reasons.push(reasonOf(err));
    }
  }

  let artifacts: ArtifactReconciliation | null = null;
  try {
    artifacts = crossCheckArtifacts(root);
  } catch (err) {
    reasons.push(reasonOf(err));
  }

  return {
    ok: reasons.length === 0,
    path: root,
    createdAt: manifest.createdAt,
    fileCount: actual.length,
    totalBytes: actual.reduce((s, e) => s + e.size, 0),
    stores: okStores,
    reasons,
    artifacts,
    checkedAt,
  };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- 创建备份

export interface CreateBackupInput {
  /** 应用数据目录（12 个库所在处） */
  readonly dataDir: string;
  /** 备份要落成的目录名。必须**尚不存在**。 */
  readonly destinationRoot: string;
  readonly appVersion: string;
  readonly now?: () => number;
}

export interface CreateBackupOutput {
  readonly path: string;
  readonly manifest: BackupManifest;
  readonly validation: BackupValidation;
}

export async function createBackup(input: CreateBackupInput): Promise<CreateBackupOutput> {
  const dataDir = path.resolve(input.dataDir);
  const destinationRoot = path.resolve(input.destinationRoot);
  const now = input.now ?? Date.now;
  assertSeparateRoots(dataDir, destinationRoot, path.relative);
  if (await pathExists(destinationRoot)) {
    throw new BackupError("destination_not_empty", `备份目标已存在：${destinationRoot}`);
  }

  const staging = `${destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.join(staging, BACKUP_DB_DIR), { recursive: true, mode: 0o700 });

    const stores: BackupManifest["stores"] = [];
    for (const store of SQLITE_STORES) {
      const source = path.join(dataDir, store.file);
      // 从没被打开过的库在磁盘上不存在。跳过而不是造一个空库：空库恢复回去
      // 会把「这个能力从没被用过」变成「这个能力的数据被清空了」。
      if (!(await pathExists(source))) continue;
      const snapshot = path.join(staging, BACKUP_DB_DIR, store.file);
      // readOnly 连接足以做在线 backup（实测），且保证备份这件事本身
      // 一个字节都不会写到用户的活库上。
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await sqliteBackup(db, snapshot);
      } finally {
        db.close();
      }
      normalizeStandaloneSqliteSnapshot(snapshot);
      await chmod(snapshot, 0o600);
      await syncFile(snapshot);
      await syncDirectoryChain(path.dirname(snapshot), staging);
      stores.push({
        id: store.id,
        path: storeBackupPath(store),
        schemaVersion: store.schemaVersion,
      });
    }
    if (stores.length === 0) {
      throw new BackupError("no_stores", `数据目录里一个 sqlite 库都没有：${dataDir}`);
    }

    // 工作区注册表：库里的 workspace_id 列全靠它才有含义。它不含任何凭据，
    // 只有「不透明 id → 目录真实路径」。
    const registry = path.join(dataDir, WORKSPACE_REGISTRY_FILE);
    if (await pathExists(registry)) {
      const target = path.join(staging, WORKSPACE_REGISTRY_FILE);
      await copyFile(registry, target);
      await chmod(target, 0o600);
      await syncFile(target);
    }

    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new BackupError("corrupt_backup", `备份时间戳非法：${createdAt}`);
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: input.appVersion,
      createdAt,
      consistency: "per-store",
      stores,
      files: await inventory(staging),
    };
    const manifestPath = path.join(staging, BACKUP_MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(manifestPath);

    // 就位之前先自己校验一遍。校验不过的备份不该存在——它只会在真正需要
    // 它的那天才被发现是坏的。
    const validation = await validateBackupAt(staging, now);
    if (!validation.ok) {
      throw new BackupError(
        "corrupt_backup",
        `新建的备份没通过自校验：${validation.reasons.join("；")}`
      );
    }

    await syncDirectoryChain(staging, staging);
    await mkdir(path.dirname(destinationRoot), { recursive: true });
    await rename(staging, destinationRoot);
    await syncDirectory(path.dirname(destinationRoot));
    return {
      path: destinationRoot,
      manifest,
      validation: { ...validation, path: destinationRoot },
    };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------- 恢复

export interface StageRestoreOutput {
  readonly validation: BackupValidation;
  readonly stagedAt: string;
}

/**
 * 把一份备份**暂存**成待套用的恢复，不当场生效。
 *
 * 12 个 sqlite 句柄此刻正被各 store 持有。Windows 上对一个仍被打开的文件
 * rename 覆盖会 EPERM；即便在 POSIX 上换掉了 inode，进程里那些已打开的句柄
 * 仍指向旧文件，用户会看到「恢复成功了但数据没变」。所以这里只做到「校验
 * 通过的副本已经稳稳落在 userData/pending-restore」，真正的套用由下次启动
 * 在任何 store 打开之前完成（applyPendingRestore）。
 */
export async function stagePendingRestore(
  backupRoot: string,
  dataDir: string,
  now: () => number = Date.now
): Promise<StageRestoreOutput> {
  const root = path.resolve(backupRoot);
  const data = path.resolve(dataDir);
  assertSeparateRoots(data, root, path.relative);

  const validation = await validateBackupAt(root, now);
  if (!validation.ok) {
    throw new BackupError(
      "corrupt_backup",
      `备份未通过校验，拒绝恢复：${validation.reasons.join("；")}`
    );
  }
  const manifest = await readManifest(root);

  const target = path.join(data, PENDING_RESTORE_DIR);
  const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await rm(target, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
      const from = resolveInside(root, file.path);
      const to = resolveInside(staging, file.path);
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to);
      await chmod(to, 0o600);
      await syncFile(to);
      await syncDirectoryChain(path.dirname(to), staging);
    }
    const manifestPath = path.join(staging, BACKUP_MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(manifestPath);

    // 复制之后**重新盘点、重新校验**：这一份才是真正会被套用的字节。
    const restaged = await validateBackupAt(staging, now);
    if (!restaged.ok) {
      throw new BackupError(
        "corrupt_backup",
        `恢复副本没通过复校验：${restaged.reasons.join("；")}`
      );
    }
    await syncDirectoryChain(staging, staging);
    await rename(staging, target);
    await syncDirectory(data);
    return { validation: { ...validation, path: root }, stagedAt: target };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export interface ApplyRestoreOutcome {
  readonly applied: boolean;
  readonly stores: string[];
  readonly reason: string | null;
}

/**
 * 启动期套用暂存的恢复。**必须在任何 store 打开之前调用。**
 *
 * ## 崩在半路会怎样
 *
 * 逐库 rename 是逐个原子的，整批不是。因此暂存区**在全部 rename 成功之后
 * 才删**：中途崩了，下次启动会从同一个暂存区再套用一遍，直到成功为止
 * （复制是幂等的）。反过来先删暂存区的写法，会留下一半新一半旧且再也无法
 * 收敛的 userData。
 *
 * ## 为什么要删 -wal / -shm
 *
 * 恢复进来的库是自包含的（journal_mode=DELETE）。但目标位置上可能还躺着
 * 上一个库留下的 `.db-wal`：sqlite 打开时会尝试拿它去重放。留着它等于
 * 「恢复了一个库，然后拿另一个库的日志盖上去」。
 */
export async function applyPendingRestore(dataDir: string): Promise<ApplyRestoreOutcome> {
  const data = path.resolve(dataDir);
  const pending = path.join(data, PENDING_RESTORE_DIR);
  if (!(await pathExists(pending))) return { applied: false, stores: [], reason: null };

  const validation = await validateBackupAt(pending);
  if (!validation.ok) {
    // 坏了的暂存区必须删掉：留着它会让每一次启动都重试一次注定失败的恢复。
    await rm(pending, { recursive: true, force: true }).catch(() => {});
    return {
      applied: false,
      stores: [],
      reason: `待套用的恢复未通过校验，已丢弃：${validation.reasons.join("；")}`,
    };
  }

  const manifest = await readManifest(pending);
  const applied: string[] = [];
  // 先全部复制成 <target>.restoring，fsync，再逐个 rename 就位。
  const staged: Array<{ tmp: string; target: string }> = [];
  for (const file of manifest.files) {
    const from = resolveInside(pending, file.path);
    const base = file.path.startsWith(`${BACKUP_DB_DIR}/`)
      ? file.path.slice(BACKUP_DB_DIR.length + 1)
      : file.path;
    const target = resolveInside(data, base);
    const tmp = `${target}.restoring`;
    await copyFile(from, tmp);
    await syncFile(tmp);
    staged.push({ tmp, target });
  }
  for (const { tmp, target } of staged) {
    await rename(tmp, target);
    await unlink(`${target}-wal`).catch(() => {});
    await unlink(`${target}-shm`).catch(() => {});
    applied.push(path.basename(target));
  }
  await syncDirectory(data);
  await rm(pending, { recursive: true, force: true });
  return { applied: true, stores: applied, reason: null };
}

export async function hasPendingRestore(dataDir: string): Promise<boolean> {
  return pathExists(path.join(path.resolve(dataDir), PENDING_RESTORE_DIR));
}

/** 将无法套用的 staging 移出启动扫描路径，保留现场供诊断或人工恢复。 */
export async function quarantinePendingRestore(dataDir: string): Promise<string | null> {
  const pending = path.join(path.resolve(dataDir), PENDING_RESTORE_DIR);
  if (!(await pathExists(pending))) return null;
  const quarantined = `${pending}.failed-${Date.now()}`;
  await rename(pending, quarantined);
  return quarantined;
}

// ---------------------------------------------------------------- 状态落盘

export interface BackupStateFile {
  lastBackup: { path: string; at: number; fileCount: number; totalBytes: number } | null;
  lastValidation: BackupValidation | null;
}

export async function readBackupState(dataDir: string): Promise<BackupStateFile> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(path.resolve(dataDir), BACKUP_STATE_FILE), "utf8")
    ) as Partial<BackupStateFile>;
    return {
      lastBackup: raw.lastBackup ?? null,
      lastValidation: raw.lastValidation ?? null,
    };
  } catch {
    // 没备份过 / 文件被手改坏：当作「从没备份过」，下一次备份会重写它。
    return { lastBackup: null, lastValidation: null };
  }
}

export async function writeBackupState(dataDir: string, state: BackupStateFile): Promise<void> {
  const file = path.join(path.resolve(dataDir), BACKUP_STATE_FILE);
  const tmp = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await syncFile(tmp);
  await rename(tmp, file);
}

// ---------------------------------------------------------------- 工具

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** 备份目录名：`pibuddy-backup-YYYYMMDD-HHmmss`（本地时区，便于用户自己认）。 */
export function backupDirName(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `pibuddy-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 仅供诊断 / UI：本次构建会备份哪些库。 */
export function backupStoreIds(): string[] {
  return SQLITE_STORES.map((s) => s.id);
}

/**
 * 库 id → 一句人话。
 *
 * 目前无消费者：BackupPanel 自己排版库名。留着是因为清单里的 `title` 本来就
 * 是为「给用户看」写的，接 UI 时不必再想一遍措辞——但**不导出**，否则死代码
 * 闸门会把它算进存量（那道闸的价值全在于不给例外）。
 */
function backupStoreTitles(): Array<{ id: string; title: string }> {
  return SQLITE_STORES.map((s) => ({ id: s.id, title: s.title }));
}
void backupStoreTitles;

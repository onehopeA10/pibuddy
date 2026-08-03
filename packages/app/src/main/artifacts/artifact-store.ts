/**
 * Artifact 仓库（ART-102）。
 *
 * ## 版本是 +1 而不是覆盖
 *
 * Agent 第二次生成同一份报告时，如果直接改写那一行，历史消息里指向
 * 第一版的链接就悄悄变成了指向第二版 —— 用户点开发现内容和当时聊的
 * 对不上，而系统里没有任何地方记录发生过这件事。因此
 * `(workspace_id, logical_key)` 是版本链的键，每次生成 `version = max+1`，
 * 老版本原样留着。
 *
 * ## 软删除绝不碰磁盘文件
 *
 * `setStatus(id, "trashed")` 只写 status 与 deleted_at 两列。产物库的
 * 「移入回收站」如果真的删文件，恢复功能就成了一句空话，而用户点下去
 * 的那一刻是不知道这一点的。本目录下因此**不出现任何删除文件的调用**
 * （SYS-1 守卫直接对 packages/app/src/main/artifacts/ 做结构断言）。
 *
 * ## conflicted 是怎么来的
 *
 * 记录里存着生成那一刻的 sha256。`verify()` 重算一遍磁盘上的内容，
 * 不一致就置 conflicted —— 「Agent 写完之后用户又用 Excel 改了一遍」
 * 是每天都在发生的事，没有这个状态的话，我们对外宣称的 sha256 就是假的。
 */
import { app } from "electron";
import type {
  ArtifactComparison,
  ArtifactKind,
  ArtifactQueryResult,
  ArtifactRecord,
  ArtifactStatus,
} from "@pibuddy/contract";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { requireWorkspaceRoot } from "../workspace-registry.js";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * 建表语句。
 *
 * status 的取值由 CHECK 约束钉死：状态机写在应用层而约束不写在库里的
 * 话，一次 typo（"readey"）会安静地落盘，然后产物库里那一条永远不显示，
 * 且不报任何错。'trashed' 与四个业务态并列 —— 回收站是状态而不是另一
 * 张表，否则「恢复」要在两张表之间搬行，搬一半崩了就丢数据。
 */
const DDL = `CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_session_id TEXT,
  source_turn_id TEXT,
  source_tool_call_id TEXT,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  preview_path TEXT,
  export_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating','ready','failed','conflicted','trashed')),
  deleted_at INTEGER,
  size_bytes INTEGER NOT NULL DEFAULT 0
)`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_artifacts_chain ON artifacts(workspace_id, logical_key, version)",
  "CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(workspace_id, status)",
];

/** 测试注入用；生产环境恒为 null，走 app.getPath("userData")。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把产物库指向临时目录。 */
export function __setArtifactDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "artifacts.db");
}

interface Row {
  id: string;
  logical_key: string;
  name: string;
  kind: string;
  source_session_id: string | null;
  source_turn_id: string | null;
  source_tool_call_id: string | null;
  workspace_id: string;
  version: number;
  sha256: string;
  created_at: number;
  updated_at: number;
  preview_path: string | null;
  export_path: string;
  status: string;
  deleted_at: number | null;
  size_bytes: number;
}

function toRecord(row: Row): ArtifactRecord {
  return {
    id: row.id,
    logicalKey: row.logical_key,
    name: row.name,
    kind: row.kind as ArtifactKind,
    sourceSessionId: row.source_session_id,
    sourceTurnId: row.source_turn_id,
    sourceToolCallId: row.source_tool_call_id,
    workspaceId: row.workspace_id,
    version: row.version,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    previewPath: row.preview_path,
    exportPath: row.export_path,
    status: row.status as ArtifactStatus,
    deletedAt: row.deleted_at,
    sizeBytes: row.size_bytes,
  };
}

/** 扩展名 → 产物类别。产物库的筛选器按它分组。 */
export function artifactKindFor(relativePath: string): ArtifactKind {
  const ext = path.extname(relativePath).toLowerCase();
  if ([".doc", ".docx", ".docm", ".odt", ".rtf"].includes(ext)) return "document";
  if ([".xls", ".xlsx", ".xlsm", ".ods"].includes(ext)) return "spreadsheet";
  if ([".ppt", ".pptx", ".pptm", ".odp"].includes(ext)) return "presentation";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".m4a", ".mp4", ".mov", ".webm", ".mkv"].includes(ext)) return "media";
  if ([".csv", ".tsv", ".json", ".jsonl", ".xml", ".yml", ".yaml"].includes(ext)) return "data";
  if ([".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".sh"].includes(ext))
    return "code";
  if ([".md", ".txt", ".log"].includes(ext)) return "text";
  return "other";
}

export interface BeginOptions {
  workspaceId: string;
  /** 相对工作区的路径。同时充当版本链的 logicalKey */
  relativePath: string;
  name?: string;
  sessionId?: string | null;
  turnId?: string | null;
  toolCallId?: string | null;
  now?: number;
}

export interface ReadyOptions {
  sha256?: string;
  sizeBytes?: number;
  previewPath?: string | null;
  now?: number;
}

export class ArtifactStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    // node:sqlite 在 Electron 43 内 require 成功（TASK-001 的探针实测定稿），
    // 与 workspace-store / session-index 同一口径，不额外引任何原生依赖。
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL);
    for (const sql of INDEXES) this.db.exec(sql);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current === ARTIFACT_SCHEMA_VERSION) return;
    if (current > ARTIFACT_SCHEMA_VERSION) return;
    this.db.exec(`PRAGMA user_version = ${ARTIFACT_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 工具开始写文件：插一条 `generating`。
   *
   * 版本号取同一 `(workspace_id, logical_key)` 下的 max+1，**不覆盖**
   * 前一版。第一次生成即 version 1。
   */
  begin(options: BeginOptions): ArtifactRecord {
    const now = options.now ?? Date.now();
    const logicalKey = options.relativePath.split(path.sep).join("/");
    const prev = this.db
      .prepare(
        "SELECT MAX(version) AS v FROM artifacts WHERE workspace_id = ? AND logical_key = ?"
      )
      .get(options.workspaceId, logicalKey) as { v?: number | null } | undefined;
    const version = Number(prev?.v ?? 0) + 1;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO artifacts
         (id, logical_key, name, kind, source_session_id, source_turn_id, source_tool_call_id,
          workspace_id, version, sha256, created_at, updated_at, preview_path, export_path,
          status, deleted_at, size_bytes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        logicalKey,
        options.name ?? path.basename(logicalKey),
        artifactKindFor(logicalKey),
        options.sessionId ?? null,
        options.turnId ?? null,
        options.toolCallId ?? null,
        options.workspaceId,
        version,
        "",
        now,
        now,
        null,
        logicalKey,
        "generating",
        null,
        0
      );
    return this.require(id);
  }

  /** 工具写完了：算 hash、置 ready。 */
  markReady(id: string, options: ReadyOptions = {}): ArtifactRecord {
    const record = this.require(id);
    const now = options.now ?? Date.now();
    let sha256 = options.sha256 ?? "";
    let size = options.sizeBytes ?? 0;
    if (!options.sha256) {
      const abs = this.absolutePathOf(record);
      try {
        const buf = fs.readFileSync(abs);
        sha256 = createHash("sha256").update(buf).digest("hex");
        size = buf.byteLength;
      } catch {
        // 文件不在了：这不是 ready，是 failed。绝不假装成功。
        return this.markFailed(id, now);
      }
    }
    this.db
      .prepare(
        "UPDATE artifacts SET status='ready', sha256=?, size_bytes=?, preview_path=?, updated_at=? WHERE id=?"
      )
      .run(sha256, size, options.previewPath ?? null, now, id);
    return this.require(id);
  }

  /**
   * 工具失败了：置 failed。
   *
   * **原始文件一个字节都不动** —— 转换/生成失败最常见的形态是「写了
   * 一半」，那半个文件对用户仍然可能有用，而且他有权自己决定要不要。
   */
  markFailed(id: string, now: number = Date.now()): ArtifactRecord {
    this.db
      .prepare("UPDATE artifacts SET status='failed', updated_at=? WHERE id=?")
      .run(now, id);
    return this.require(id);
  }

  /** 重算磁盘上的 hash；与记录不符即置 conflicted。 */
  verify(id: string, now: number = Date.now()): ArtifactRecord {
    const record = this.require(id);
    if (record.status !== "ready") return record;
    let actual = "";
    try {
      actual = createHash("sha256")
        .update(fs.readFileSync(this.absolutePathOf(record)))
        .digest("hex");
    } catch {
      return this.markFailed(id, now);
    }
    if (actual === record.sha256) return record;
    this.db
      .prepare("UPDATE artifacts SET status='conflicted', updated_at=? WHERE id=?")
      .run(now, id);
    return this.require(id);
  }

  /**
   * 改状态。
   *
   * `trashed` 是唯一会同时写 deleted_at 的分支，而且**只写这两列**：
   * 磁盘上的文件不动、sha256 不动、版本链不动。restore 把它们复原。
   */
  setStatus(id: string, status: ArtifactStatus, now: number = Date.now()): ArtifactRecord {
    if (status === "trashed") {
      this.db
        .prepare("UPDATE artifacts SET status='trashed', deleted_at=?, updated_at=? WHERE id=?")
        .run(now, now, id);
      return this.require(id);
    }
    this.db
      .prepare("UPDATE artifacts SET status=?, deleted_at=NULL, updated_at=? WHERE id=?")
      .run(status, now, id);
    return this.require(id);
  }

  rename(id: string, name: string, now: number = Date.now()): ArtifactRecord {
    // 只改显示名，不动 export_path：改路径等于改一条历史链接指向的东西。
    this.db.prepare("UPDATE artifacts SET name=?, updated_at=? WHERE id=?").run(name, now, id);
    return this.require(id);
  }

  /**
   * 复制一份。
   *
   * 新条目是**新的 logicalKey**（文件名加「副本」后缀）而不是同链的
   * 下一版：用户点「复制一份」的意思是「我要一个独立的东西」，把它
   * 记成同一条链的新版本会让原链的历史链接跟着变。
   */
  async duplicate(id: string, now: number = Date.now()): Promise<ArtifactRecord> {
    const record = this.require(id);
    const root = requireWorkspaceRoot(record.workspaceId);
    const src = this.absolutePathOf(record);
    const ext = path.extname(record.exportPath);
    const stem = record.exportPath.slice(0, record.exportPath.length - ext.length);
    let relative = `${stem} 副本${ext}`;
    let n = 2;
    while (fs.existsSync(path.join(root, relative))) {
      relative = `${stem} 副本${n}${ext}`;
      n++;
    }
    await fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fsp.copyFile(src, path.join(root, relative));
    const created = this.begin({
      workspaceId: record.workspaceId,
      relativePath: relative,
      name: path.basename(relative),
      sessionId: record.sourceSessionId,
      turnId: record.sourceTurnId,
      toolCallId: record.sourceToolCallId,
      now,
    });
    return this.markReady(created.id, { now });
  }

  /** 按 id 取；不存在返回 null。 */
  get(id: string): ArtifactRecord | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toRecord(row) : null;
  }

  require(id: string): ArtifactRecord {
    const record = this.get(id);
    if (!record) throw new Error(`ARTIFACT_UNKNOWN: ${id}`);
    return record;
  }

  /**
   * 按 artifactId + version 解析（ART-102 的核心不变量）。
   *
   * 聊天消息里存的就是这两个值。文件被挪到别处、被重命名、上面又生成
   * 了三个新版本 —— 这个查询的结果都不变，因为它一个字节的路径信息
   * 都没用到。
   */
  resolveLink(artifactId: string, version: number): ArtifactRecord | null {
    const anchor = this.get(artifactId);
    if (!anchor) return null;
    if (anchor.version === version) return anchor;
    const row = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE workspace_id=? AND logical_key=? AND version=? LIMIT 1"
      )
      .get(anchor.workspaceId, anchor.logicalKey, version) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** 同一条版本链的全部版本，按 version 升序。 */
  versionsOf(id: string): ArtifactRecord[] {
    const anchor = this.get(id);
    if (!anchor) return [];
    const rows = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE workspace_id=? AND logical_key=? ORDER BY version ASC"
      )
      .all(anchor.workspaceId, anchor.logicalKey) as unknown as Row[];
    return rows.map(toRecord);
  }

  query(request: {
    workspaceId: string;
    query?: string;
    kind?: ArtifactKind;
    status?: ArtifactStatus;
    sessionId?: string;
    trashed?: boolean;
    latestOnly?: boolean;
    limit?: number;
  }): ArtifactQueryResult {
    const where: string[] = ["workspace_id = ?"];
    const params: (string | number)[] = [request.workspaceId];
    // 回收站是**显式**视图：默认列表里看不到已删的东西，否则「移入
    // 回收站」在界面上等于什么都没发生。
    where.push(request.trashed === true ? "status = 'trashed'" : "status != 'trashed'");
    if (request.query) {
      where.push("(lower(name) LIKE ? OR lower(logical_key) LIKE ?)");
      const like = `%${request.query.toLowerCase()}%`;
      params.push(like, like);
    }
    if (request.kind) {
      where.push("kind = ?");
      params.push(request.kind);
    }
    if (request.status) {
      where.push("status = ?");
      params.push(request.status);
    }
    if (request.sessionId) {
      where.push("source_session_id = ?");
      params.push(request.sessionId);
    }
    const sql = `SELECT * FROM artifacts WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, version DESC`;
    let rows = (this.db.prepare(sql).all(...params) as unknown as Row[]).map(toRecord);
    if (request.latestOnly) {
      // 「最新一版」的判据是 **version 最大**，不是 updated_at 最大。
      //
      // 这两者会真的分开：rename 只改 name 与 updated_at，restore 只改
      // status 与 updated_at —— 对 v1 做任意一个动作，v1 的 updated_at 就
      // 越过了 v2。此前这里靠「按 updated_at 排完序取第一条」去重，于是
      // 产物库里显示的是 v1、点开拿到的是 v1 的记录，而磁盘上躺着的是
      // v2 的内容 —— 用户看到的版本号和内容对不上，且不报任何错。
      //
      // 去重在 JS 里做而不是塞进 SQL 子查询，是因为 MAX(version) 必须与
      // 上面那串 where（trashed / kind / status / sessionId / query）**同一
      // 套过滤条件**才正确：v2 进了回收站时，非回收站视图里的「最新一版」
      // 是 v1。子查询要重复一遍这些条件，重复就会漂移。
      const best = new Map<string, ArtifactRecord>();
      for (const r of rows) {
        const key = `${r.workspaceId}#${r.logicalKey}`;
        const prev = best.get(key);
        if (!prev || r.version > prev.version) best.set(key, r);
      }
      const keep = new Set([...best.values()].map((r) => r.id));
      // filter 而不是直接用 map 的值：外层的 updated_at 排序要原样保留。
      rows = rows.filter((r) => keep.has(r.id));
    }
    const total = rows.length;
    if (request.limit && request.limit > 0) rows = rows.slice(0, request.limit);
    return { items: rows, total };
  }

  /** 两版比较。identical 由 sha256 判定 —— 二进制产物没有可比的文本。 */
  compare(id: string, otherId: string): ArtifactComparison {
    const left = this.require(id);
    const right = this.require(otherId);
    const identical = left.sha256 !== "" && left.sha256 === right.sha256;
    const comparison: ArtifactComparison = {
      left,
      right,
      identical,
      sizeDelta: right.sizeBytes - left.sizeBytes,
      textDiff: [],
      degraded: null,
    };
    if (identical) return comparison;

    // 同一条链上的老版本与新版本**指向同一个磁盘路径**，而磁盘上躺着的
    // 只有最新那一份。直接读两次得到的是同一段文本，逐行 diff 出来是空的
    // —— 那不是「两版一样」，而是「我们根本没有老版本的内容」。这两件事
    // 在界面上必须能分辨，否则用户会以为改动丢了。
    //
    // 判据：记录里的 sha256 与磁盘现状不符 = 这一版的内容已经取不到了。
    const leftLive = this.contentMatches(left);
    const rightLive = this.contentMatches(right);
    if (!leftLive || !rightLive) {
      comparison.degraded =
        "只能比大小和校验值：历史版本的内容没有单独存档，磁盘上现在只有最新那一份。";
      return comparison;
    }

    const leftText = this.readTextOrNull(left);
    const rightText = this.readTextOrNull(right);
    if (leftText === null || rightText === null) {
      comparison.degraded = "这两版里至少有一版是二进制或过大的内容，只能比大小和校验值。";
      return comparison;
    }
    const a = leftText.split(/\r?\n/);
    const b = rightText.split(/\r?\n/);
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max && comparison.textDiff.length < 500; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] !== undefined) comparison.textDiff.push({ op: "remove", line: i, text: a[i] });
      if (b[i] !== undefined) comparison.textDiff.push({ op: "add", line: i, text: b[i] });
    }
    return comparison;
  }

  /** 主进程内部使用的绝对路径。**永不外发给渲染进程。** */
  absolutePathOf(record: ArtifactRecord): string {
    return path.join(requireWorkspaceRoot(record.workspaceId), record.exportPath);
  }

  /** 磁盘上的内容是不是这一版记录的那一份（sha256 逐字节判定）。 */
  private contentMatches(record: ArtifactRecord): boolean {
    if (record.sha256 === "") return false;
    try {
      const actual = createHash("sha256")
        .update(fs.readFileSync(this.absolutePathOf(record)))
        .digest("hex");
      return actual === record.sha256;
    } catch {
      return false;
    }
  }

  private readTextOrNull(record: ArtifactRecord): string | null {
    if (record.sizeBytes > 2 * 1024 * 1024) return null;
    try {
      const buf = fs.readFileSync(this.absolutePathOf(record));
      // 有 NUL 字节即认定是二进制：那种内容做逐行 diff 只会刷屏。
      if (buf.includes(0)) return null;
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }
}

let shared: ArtifactStore | null = null;

/** 全进程唯一的产物库实例。 */
export function artifactStore(): ArtifactStore {
  if (!shared) shared = new ArtifactStore();
  return shared;
}

/** 应用退出时关掉句柄（Windows 上 WAL 文件在句柄没关之前删不掉）。 */
export function closeArtifactStore(): void {
  shared?.close();
  shared = null;
}

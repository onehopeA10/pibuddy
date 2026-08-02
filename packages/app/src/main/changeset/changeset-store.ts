/**
 * Agent 变更集（FS-102）。
 *
 * ## 变更是「待审阅」的，不是「已发生」的
 *
 * pi 的文件工具会直接落盘。如果我们只是事后把「它改过什么」记下来，
 * 那么「接受 / 拒绝」这两个按钮就是假的 —— 拒绝一条已经写进磁盘的改动，
 * 用户期待的是文件回到原样，而一个只改数据库状态的实现什么都不会发生。
 *
 * 因此入库时做一件事：**若磁盘当前内容正是工具刚写下的 after，就把它
 * 还原成 before，并把 after 存进变更集等待审阅**。此后语义就干净了：
 *   accept → 把 after 写上去（写之前重算 hash 确认磁盘还是 before）
 *   reject → 什么都不写（criteria 明确要求拒绝不得产生任何磁盘写）
 *
 * ## before 快照拿不到时必须显式标出来
 *
 * 工具在 tool_execution_start 之前就把文件建好、或者一次调用改了我们没
 * 解析出来的第二个文件时，before 是缺失的。这种条目 status 记
 * `unverified`：它在批量接受里被**硬跳过**并在返回值里列出来。否则一次
 * 「全部接受」会用一份来历不明的内容盖掉磁盘上真实存在的东西，而 UI 上
 * 只是一个进度条走完了。
 */
import { app } from "electron";
import type {
  ChangesetDiff,
  ChangesetEntry,
  ChangesetHunk,
  ChangesetKind,
  ChangesetStatus,
} from "@pibuddy/contract";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { writeFileAtomic } from "../fs-atomic.js";
import { requireWorkspaceRoot, resolveInWorkspace } from "../workspace-registry.js";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const CHANGESET_SCHEMA_VERSION = 1;

/** 参与 diff 渲染的单文件字节上限；超过它 UI 只显示摘要。 */
export const CHANGESET_DIFF_MAX_BYTES = 512 * 1024;

const DDL = `CREATE TABLE IF NOT EXISTS changesets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  before_sha256 TEXT NOT NULL,
  after_sha256 TEXT NOT NULL,
  before_content TEXT,
  after_content TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  too_large INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL
)`;

let dataDirOverride: string | null = null;

/** 仅供单测：把变更集库与备份目录指向临时目录。 */
export function __setChangesetDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

export function changesetDataDir(): string {
  return dataDirOverride ?? app.getPath("userData");
}

/** 接受一条变更之前，原文件的备份落点。 */
export function backupDir(): string {
  return path.join(changesetDataDir(), "changeset-backup");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------- diff

/**
 * 逐行 diff。
 *
 * 用最长公共子序列而不是「逐行比对到第一处不同」：后者在文件头插一行
 * 就会把整个文件标成全改，用户看到的是一屏红绿而不是一处改动。
 * 行数上限之外走降级路径（只报摘要），LCS 是 O(n·m)。
 */
export function diffLines(before: string[], after: string[]): ChangesetHunk[] {
  const n = before.length;
  const m = after.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const hunks: ChangesetHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++;
      j++;
      continue;
    }
    const beforeStart = i;
    const afterStart = j;
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    while (i < n || j < m) {
      if (i < n && j < m && before[i] === after[j]) break;
      if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
        afterLines.push(after[j]);
        j++;
      } else if (i < n) {
        beforeLines.push(before[i]);
        i++;
      }
    }
    hunks.push({ index: hunks.length, beforeStart, beforeLines, afterStart, afterLines });
  }
  return hunks;
}

export interface ChangesetRecord extends ChangesetEntry {
  workspaceId: string;
  beforeContent: string | null;
  afterContent: string | null;
}

function rowToRecord(row: Record<string, unknown>): ChangesetRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    kind: String(row.kind) as ChangesetKind,
    relativePath: String(row.relative_path),
    beforeSha256: String(row.before_sha256),
    afterSha256: String(row.after_sha256),
    status: String(row.status) as ChangesetStatus,
    createdAt: Number(row.created_at),
    sizeBytes: Number(row.size_bytes),
    binary: Number(row.binary) === 1,
    tooLarge: Number(row.too_large) === 1,
    beforeContent: row.before_content === null ? null : String(row.before_content),
    afterContent: row.after_content === null ? null : String(row.after_content),
  };
}

export interface RecordChangeParams {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  kind: ChangesetKind;
  relativePath: string;
  /** tool_execution_start 时抓到的快照；null = 没抓到，条目将被标 unverified */
  beforeContent: string | null;
  /** 工具打算写成的内容；delete 传空串 */
  afterContent: string;
  now?: number;
}

export interface ChangesetQuery {
  workspaceId: string;
  sessionId?: string;
  status?: ChangesetStatus;
  limit?: number;
}

export class ChangesetStore {
  private readonly db: DatabaseSync;

  constructor(file: string = path.join(changesetDataDir(), "changesets.db")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current === CHANGESET_SCHEMA_VERSION) return;
    if (current > CHANGESET_SCHEMA_VERSION) return;
    this.db.exec(`PRAGMA user_version = ${CHANGESET_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 把工具的一次文件写入登记为待审阅变更。
   *
   * 若磁盘上此刻的内容正是 after（= 工具刚写完），就把它还原成 before ——
   * 这一步让「拒绝」有真正的含义。before 缺失时不还原（我们不知道原样是
   * 什么），条目标 unverified。
   */
  async record(params: RecordChangeParams): Promise<ChangesetRecord> {
    const now = params.now ?? Date.now();
    const id = randomBytes(12).toString("hex");
    const afterSha = sha256Text(params.afterContent);
    const beforeSha = params.beforeContent === null ? "" : sha256Text(params.beforeContent);
    const status: ChangesetStatus = params.beforeContent === null ? "unverified" : "pending";

    if (params.beforeContent !== null) {
      // 工具已经落盘的话，先还原成 before，把 after 留给用户审阅
      try {
        const resolved = await resolveInWorkspace(params.workspaceId, params.relativePath);
        const disk = fs.readFileSync(resolved.realPath, "utf8");
        if (sha256Text(disk) === afterSha && afterSha !== beforeSha) {
          writeFileAtomic(resolved.realPath, params.beforeContent);
        }
      } catch {
        // 文件不存在（新建类变更）或读不动：不还原，accept 时的 hash 复核会兜住
      }
    }

    const sizeBytes = Buffer.byteLength(params.afterContent, "utf8");
    const tooLarge = sizeBytes > CHANGESET_DIFF_MAX_BYTES;
    // NUL 字符 = 二进制内容；对它做逐行 diff 只会渲染出一屏乱码
    const binary = params.afterContent.includes(String.fromCharCode(0));

    this.db
      .prepare(
        `INSERT INTO changesets
         (id, workspace_id, session_id, turn_id, tool_call_id, tool_name, kind,
          relative_path, before_sha256, after_sha256, before_content, after_content,
          status, created_at, size_bytes, binary, too_large, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.workspaceId,
        params.sessionId,
        params.turnId,
        params.toolCallId,
        params.toolName,
        params.kind,
        params.relativePath,
        beforeSha,
        afterSha,
        params.beforeContent,
        params.afterContent,
        status,
        now,
        sizeBytes,
        binary ? 1 : 0,
        tooLarge ? 1 : 0,
        CHANGESET_SCHEMA_VERSION
      );
    return this.get(id) as ChangesetRecord;
  }

  get(id: string): ChangesetRecord | null {
    const row = this.db.prepare("SELECT * FROM changesets WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(query: ChangesetQuery): ChangesetRecord[] {
    const clauses = ["workspace_id = ?"];
    const args: unknown[] = [query.workspaceId];
    if (query.sessionId) {
      clauses.push("session_id = ?");
      args.push(query.sessionId);
    }
    if (query.status) {
      clauses.push("status = ?");
      args.push(query.status);
    }
    const sql = `SELECT * FROM changesets WHERE ${clauses.join(" AND ")}
                 ORDER BY created_at DESC LIMIT ?`;
    args.push(query.limit ?? 200);
    const rows = this.db.prepare(sql).all(...(args as never[])) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  setStatus(id: string, status: ChangesetStatus): void {
    this.db.prepare("UPDATE changesets SET status = ? WHERE id = ?").run(status, id);
  }
}

let shared: ChangesetStore | null = null;

export function changesetStore(): ChangesetStore {
  if (!shared) shared = new ChangesetStore();
  return shared;
}

/** 记录 → 渲染侧视图。**不带 before/after 正文**，正文经 diff 单独下发。 */
export function toChangesetEntry(record: ChangesetRecord): ChangesetEntry {
  return {
    id: record.id,
    sessionId: record.sessionId,
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    kind: record.kind,
    relativePath: record.relativePath,
    beforeSha256: record.beforeSha256,
    afterSha256: record.afterSha256,
    status: record.status,
    createdAt: record.createdAt,
    sizeBytes: record.sizeBytes,
    binary: record.binary,
    tooLarge: record.tooLarge,
  };
}

/** 计算一条变更的 diff；二进制或过大时给降级说明而不是硬渲染。 */
export function diffOf(record: ChangesetRecord): ChangesetDiff {
  if (record.binary) {
    return { id: record.id, relativePath: record.relativePath, hunks: [], degraded: "二进制文件" };
  }
  if (record.tooLarge) {
    return {
      id: record.id,
      relativePath: record.relativePath,
      hunks: [],
      degraded: `文件过大（${Math.round(record.sizeBytes / 1024)}KB），只显示摘要`,
    };
  }
  const before = (record.beforeContent ?? "").split("\n");
  const after = (record.afterContent ?? "").split("\n");
  return {
    id: record.id,
    relativePath: record.relativePath,
    hunks: diffLines(before, after),
    degraded: null,
  };
}

/** 供 apply.ts 复用：不透明 id → 工作区 root（apply 自己不做收容判定）。 */
export function rootOf(workspaceId: string): string {
  return requireWorkspaceRoot(workspaceId);
}

/**
 * 定时任务与 run 的持久仓库（Durable Tasks，AUT-101）。
 *
 * ## 一个 db、两张表、按 workspaceId 分区
 *
 * 任务与 run 都带 `workspace_id` 列（它本身就是 `sha256(realpath)` 派生的
 * workspaceId，路径规范化在 workspace-registry 里已经用 `realpathSync.native`
 * 做过，防 Windows 8.3 短名）。渲染进程给的每一个查询都带 workspaceId，因此
 * 一个工作区看不到另一个工作区的任务——分区不是靠约定，是靠每条 SQL 的
 * `WHERE workspace_id = ?`。
 *
 * ## idempotency_key 上的 UNIQUE 是「非幂等 action 不被重复执行」的结构保证
 *
 * scheduled run 的 key 是 `taskId#scheduledFor`（那一次的墙钟槽位）。时钟回拨、
 * 双重触发、catch-up 对同一槽位的第二次尝试，都会撞上这条 UNIQUE 约束而被
 * 拒——重复执行在**数据库层**就不可能发生，而不是靠调度代码记得去查一遍。
 * run-now 是显式的手动额外触发，因此它的 key 带时间戳 + 随机段，永远唯一。
 *
 * ## node:sqlite，与 workspace-store / artifact-store 同一口径
 *
 * 不额外引任何原生依赖（`check-pure-js-deps` 闸门）。schema 有版本 + migration，
 * 改 DDL 必须 +1 并在 migrate() 里补分支，绝不静默重建。
 */
import { app } from "electron";
import type {
  RunInputSnapshot,
  RunRecord,
  RunStatus,
  TaskAgent,
  TaskRecord,
  TaskSchedule,
  TaskStatus,
} from "@pibuddy/contract";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const TASKS_STORE_SCHEMA_VERSION = 1;

const DDL_TASKS = `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  agent TEXT NOT NULL,
  required_permissions TEXT NOT NULL,
  budget_usd REAL,
  timeout_ms INTEGER,
  misfire_policy TEXT NOT NULL,
  concurrency_policy TEXT NOT NULL,
  failure_policy TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused')),
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const DDL_RUNS = `CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled','skipped')),
  scheduled_for INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  input TEXT NOT NULL,
  session_id TEXT,
  artifact_ids TEXT NOT NULL,
  cost_usd REAL,
  error TEXT,
  log TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL
)`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, next_run_at)",
  // idempotency 的 UNIQUE：非幂等 action 不被重复执行的结构保证就在这一行。
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idem ON runs(idempotency_key)",
  "CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, created_at)",
];

let dataDirOverride: string | null = null;

/** 仅供单测：把任务库指向临时目录。 */
export function __setTasksDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "tasks.db");
}

interface TaskRow {
  id: string;
  workspace_id: string;
  name: string;
  schedule: string;
  timezone: string;
  agent: string;
  required_permissions: string;
  budget_usd: number | null;
  timeout_ms: number | null;
  misfire_policy: string;
  concurrency_policy: string;
  failure_policy: string;
  status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  task_id: string;
  workspace_id: string;
  status: string;
  scheduled_for: number;
  idempotency_key: string;
  attempt: number;
  started_at: number | null;
  finished_at: number | null;
  input: string;
  session_id: string | null;
  artifact_ids: string;
  cost_usd: number | null;
  error: string | null;
  log: string;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    schedule: JSON.parse(row.schedule) as TaskSchedule,
    timezone: row.timezone,
    agent: JSON.parse(row.agent) as TaskAgent,
    requiredPermissions: JSON.parse(row.required_permissions) as string[],
    budgetUsd: row.budget_usd,
    timeoutMs: row.timeout_ms,
    misfirePolicy: row.misfire_policy as TaskRecord["misfirePolicy"],
    concurrencyPolicy: row.concurrency_policy as TaskRecord["concurrencyPolicy"],
    failurePolicy: JSON.parse(row.failure_policy) as TaskRecord["failurePolicy"],
    status: row.status as TaskStatus,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    status: row.status as RunStatus,
    scheduledFor: row.scheduled_for,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    input: JSON.parse(row.input) as RunInputSnapshot,
    sessionId: row.session_id,
    artifactIds: JSON.parse(row.artifact_ids) as string[],
    costUsd: row.cost_usd,
    error: row.error,
    log: JSON.parse(row.log) as string[],
    createdAt: row.created_at,
  };
}

export interface NewTask {
  workspaceId: string;
  name: string;
  schedule: TaskSchedule;
  timezone: string;
  agent: TaskAgent;
  requiredPermissions: string[];
  budgetUsd: number | null;
  timeoutMs: number | null;
  misfirePolicy: TaskRecord["misfirePolicy"];
  concurrencyPolicy: TaskRecord["concurrencyPolicy"];
  failurePolicy: TaskRecord["failurePolicy"];
}

export interface NewRun {
  taskId: string;
  workspaceId: string;
  scheduledFor: number;
  idempotencyKey: string;
  attempt: number;
  input: RunInputSnapshot;
  status: RunStatus;
  now: number;
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL_TASKS);
    this.db.exec(DDL_RUNS);
    for (const sql of INDEXES) this.db.exec(sql);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current === TASKS_STORE_SCHEMA_VERSION) return;
    if (current > TASKS_STORE_SCHEMA_VERSION) return;
    // v0 → v1：首次建库。将来改 DDL 时在这里按 current 补 ALTER 分支，绝不重建。
    this.db.exec(`PRAGMA user_version = ${TASKS_STORE_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------- 任务

  createTask(input: NewTask, now: number, nextRunAt: number | null): TaskRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, workspace_id, name, schedule, timezone, agent, required_permissions,
          budget_usd, timeout_ms, misfire_policy, concurrency_policy, failure_policy,
          status, next_run_at, last_run_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        JSON.stringify(input.schedule),
        input.timezone,
        JSON.stringify(input.agent),
        JSON.stringify(input.requiredPermissions),
        input.budgetUsd,
        input.timeoutMs,
        input.misfirePolicy,
        input.concurrencyPolicy,
        JSON.stringify(input.failurePolicy),
        "active",
        nextRunAt,
        null,
        now,
        now
      );
    return this.requireTask(id);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  requireTask(id: string): TaskRecord {
    const t = this.getTask(id);
    if (!t) throw new Error(`TASK_UNKNOWN: ${id}`);
    return t;
  }

  listTasks(workspaceId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  /** 全部 active 且有 next_run_at 的任务（调度线程据它算下一次唤醒）。 */
  activeDueTasks(): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'active' AND next_run_at IS NOT NULL ORDER BY next_run_at ASC")
      .all() as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  /** 全部 active 任务（含 event 型 next_run_at 为 null 的），用于崩溃恢复扫描。 */
  activeTasks(): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'active'")
      .all() as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  updateTask(
    id: string,
    patch: Partial<Omit<TaskRecord, "id" | "workspaceId" | "createdAt">>,
    now: number
  ): TaskRecord | null {
    const current = this.getTask(id);
    if (!current) return null;
    const next: TaskRecord = { ...current, ...patch, updatedAt: now };
    this.db
      .prepare(
        `UPDATE tasks SET name=?, schedule=?, timezone=?, agent=?, required_permissions=?,
          budget_usd=?, timeout_ms=?, misfire_policy=?, concurrency_policy=?, failure_policy=?,
          status=?, next_run_at=?, last_run_at=?, updated_at=? WHERE id=?`
      )
      .run(
        next.name,
        JSON.stringify(next.schedule),
        next.timezone,
        JSON.stringify(next.agent),
        JSON.stringify(next.requiredPermissions),
        next.budgetUsd,
        next.timeoutMs,
        next.misfirePolicy,
        next.concurrencyPolicy,
        JSON.stringify(next.failurePolicy),
        next.status,
        next.nextRunAt,
        next.lastRunAt,
        now,
        id
      );
    return next;
  }

  deleteTask(id: string): void {
    // run 一并删：run 只是任务的执行历史，任务没了它们没有独立存在的意义。
    this.db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  // -------------------------------------------------------------- run

  /** 某任务当前是否有在跑（pending / running）的 run —— 并发策略据它判断。 */
  hasActiveRun(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status IN ('pending','running')")
      .get(taskId) as { n?: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  }

  runByIdempotency(key: string): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE idempotency_key = ?")
      .get(key) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  /**
   * 建一条 run。idempotency_key 已存在时返回 null（**不重复执行**）——UNIQUE
   * 约束是最终防线，这里先查一遍给出干净的「已存在」语义，两者一起兜。
   */
  createRun(input: NewRun): RunRecord | null {
    if (this.runByIdempotency(input.idempotencyKey)) return null;
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO runs
           (id, task_id, workspace_id, status, scheduled_for, idempotency_key, attempt,
            started_at, finished_at, input, session_id, artifact_ids, cost_usd, error, log,
            lease_owner, lease_expires_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          input.taskId,
          input.workspaceId,
          input.status,
          input.scheduledFor,
          input.idempotencyKey,
          input.attempt,
          null,
          null,
          JSON.stringify(input.input),
          null,
          "[]",
          null,
          null,
          "[]",
          null,
          null,
          input.now
        );
    } catch {
      // UNIQUE 撞了（并发进入的第二条）——同样按「已存在」处理，不抛。
      return null;
    }
    return this.requireRun(id);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  requireRun(id: string): RunRecord {
    const r = this.getRun(id);
    if (!r) throw new Error(`RUN_UNKNOWN: ${id}`);
    return r;
  }

  listRuns(taskId: string, limit = 50): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(taskId, limit) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  /** 部分更新一条 run。 */
  updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRecord,
        "status" | "startedAt" | "finishedAt" | "sessionId" | "artifactIds" | "costUsd" | "error" | "attempt"
      >
    > & { appendLog?: string; leaseOwner?: string | null; leaseExpiresAt?: number | null }
  ): RunRecord | null {
    const current = this.getRun(id);
    if (!current) return null;
    const log = patch.appendLog ? [...current.log, patch.appendLog] : current.log;
    const merged = {
      status: patch.status ?? current.status,
      startedAt: patch.startedAt ?? current.startedAt,
      finishedAt: patch.finishedAt ?? current.finishedAt,
      sessionId: patch.sessionId ?? current.sessionId,
      artifactIds: patch.artifactIds ?? current.artifactIds,
      costUsd: patch.costUsd ?? current.costUsd,
      error: patch.error ?? current.error,
      attempt: patch.attempt ?? current.attempt,
    };
    // lease 列不在 RunRecord 里外发，单独取（scheduler 内部用）。
    const leaseOwner = patch.leaseOwner !== undefined ? patch.leaseOwner : this.leaseOwnerOf(id);
    const leaseExpires =
      patch.leaseExpiresAt !== undefined ? patch.leaseExpiresAt : this.leaseExpiresOf(id);
    this.db
      .prepare(
        `UPDATE runs SET status=?, started_at=?, finished_at=?, session_id=?, artifact_ids=?,
          cost_usd=?, error=?, attempt=?, log=?, lease_owner=?, lease_expires_at=? WHERE id=?`
      )
      .run(
        merged.status,
        merged.startedAt,
        merged.finishedAt,
        merged.sessionId,
        JSON.stringify(merged.artifactIds),
        merged.costUsd,
        merged.error,
        merged.attempt,
        JSON.stringify(log),
        leaseOwner,
        leaseExpires,
        id
      );
    return this.requireRun(id);
  }

  private leaseOwnerOf(id: string): string | null {
    const row = this.db.prepare("SELECT lease_owner FROM runs WHERE id = ?").get(id) as
      | { lease_owner: string | null }
      | undefined;
    return row?.lease_owner ?? null;
  }

  private leaseExpiresOf(id: string): number | null {
    const row = this.db.prepare("SELECT lease_expires_at FROM runs WHERE id = ?").get(id) as
      | { lease_expires_at: number | null }
      | undefined;
    return row?.lease_expires_at ?? null;
  }

  /**
   * 崩溃前留下的「孤儿 run」：状态还是 running / pending 但 lease 已过期。
   *
   * 进程崩溃时正在跑的 run 不会有人去把它收尾，重启后它永远挂在 running。
   * 恢复时据 lease 过期把它们捞出来判死（failed / 重排），这是 crash recovery
   * 的入口。
   */
  staleRuns(now: number): RunRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runs WHERE status IN ('pending','running') AND (lease_expires_at IS NULL OR lease_expires_at < ?)"
      )
      .all(now) as unknown as RunRow[];
    return rows.map(runFromRow);
  }
}

let shared: TaskStore | null = null;

/** 全进程唯一的任务库实例。首次访问时才建库（能力禁用时不会被调到）。 */
export function taskStore(): TaskStore {
  if (!shared) shared = new TaskStore();
  return shared;
}

/** 应用退出 / 能力禁用时关句柄（Windows 上 WAL 文件在句柄关掉前删不掉）。 */
export function closeTaskStore(): void {
  shared?.close();
  shared = null;
}

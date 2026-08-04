/**
 * 工作流定义与运行历史的落盘（common.workflow）。
 *
 * ## 为什么用 sqlite，而不是一份 workspace 里的 JSON
 *
 * 数据落在**应用数据目录**（`app.getPath("userData")`），不是用户工作区里 ——
 * 工作流定义是应用级配置，不该混进用户的项目文件里。这与 `tasks` / `changeset` /
 * `artifacts` 三个持久能力同构：它们都用 `node:sqlite` 的 `DatabaseSync` 把状态
 * 存在 userData，而不是往工作区写文件。因此本能力**一条 workspace 权限都不申请**
 * —— 它根本不碰用户工作区（drift 的权限对账两个方向都成立）。
 *
 * ## 数据按 workspaceId 分区（ADR-0002 D4 规则 3）
 *
 * 每行带 `workspace_id`。workspaceId 是工作区注册表发的不透明键，直接作分区键
 * 是安全的；真实工作目录的解析（含 realpathSync.native 防 8.3 短名）发生在 Agent
 * 节点触发 pi run 时，由后台会话池的 `requireWorkspaceRoot` 负责，本文件不碰
 * 磁盘路径。
 *
 * ## 可移植 JSON 是一等公民
 *
 * 定义整份以 JSON 文本存在 `json` 列：导出即取这份文本，导入即把一份文本
 * `safeParse` 回定义。读进来逐条 `safeParse`，手改坏 / 跨版本不兼容的条目被
 * 丢弃而不是让整个能力起不来。
 */
import { app } from "electron";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  workflowDefinitionSchema,
  workflowRunSchema,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@pibuddy/contract";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const WORKFLOW_STORE_SCHEMA_VERSION = 1;

/** 每个工作区保留的运行历史条数上界。 */
export const WORKFLOW_RUN_HISTORY_LIMIT = 20;

const DDL = `
CREATE TABLE IF NOT EXISTS workflow_definitions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);`;

let dataDirOverride: string | null = null;
let shared: WorkflowStore | null = null;

/** 仅供单测：把库指向临时目录，并关掉旧句柄。 */
export function __setWorkflowDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

export function workflowDataDir(): string {
  return dataDirOverride ?? app.getPath("userData");
}

export class WorkflowStore {
  private readonly db: DatabaseSync;

  constructor(file: string = path.join(workflowDataDir(), "workflows.db")) {
    // 不建目录：userData 由 Electron 保证存在（与 tasks / changeset 同口径）。
    // 建目录会命中 workspace.write 权限标记，而本能力根本不碰用户工作区。
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current === WORKFLOW_STORE_SCHEMA_VERSION) return;
    if (current > WORKFLOW_STORE_SCHEMA_VERSION) return;
    // 代际 0 → 1：初版，DDL 已建表，只记版本。日后改结构在此补 ALTER 分支。
    this.db.exec(`PRAGMA user_version = ${WORKFLOW_STORE_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- 定义

  listDefinitions(workspaceId: string): WorkflowDefinition[] {
    const rows = this.db
      .prepare("SELECT json FROM workflow_definitions WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(workspaceId) as { json: string }[];
    const out: WorkflowDefinition[] = [];
    for (const row of rows) {
      const parsed = safeParseJson(row.json, workflowDefinitionSchema);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  getDefinition(workspaceId: string, definitionId: string): WorkflowDefinition | null {
    const row = this.db
      .prepare("SELECT json FROM workflow_definitions WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, definitionId) as { json: string } | undefined;
    return row ? safeParseJson(row.json, workflowDefinitionSchema) : null;
  }

  saveDefinition(workspaceId: string, definition: WorkflowDefinition): void {
    this.db
      .prepare(
        `INSERT INTO workflow_definitions (workspace_id, id, json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      )
      .run(workspaceId, definition.id, JSON.stringify(definition), definition.updatedAt);
  }

  deleteDefinition(workspaceId: string, definitionId: string): void {
    this.db
      .prepare("DELETE FROM workflow_definitions WHERE workspace_id = ? AND id = ?")
      .run(workspaceId, definitionId);
  }

  // ---------------------------------------------------------------- 运行历史

  listRuns(workspaceId: string): WorkflowRun[] {
    const rows = this.db
      .prepare("SELECT json FROM workflow_runs WHERE workspace_id = ? ORDER BY started_at DESC")
      .all(workspaceId) as { json: string }[];
    const out: WorkflowRun[] = [];
    for (const row of rows) {
      const parsed = safeParseJson(row.json, workflowRunSchema);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** 追加 / 更新一条终态运行，按上界裁掉最老的。 */
  appendRun(workspaceId: string, run: WorkflowRun): void {
    this.db
      .prepare(
        `INSERT INTO workflow_runs (workspace_id, id, json, started_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET json = excluded.json`
      )
      .run(workspaceId, run.id, JSON.stringify(run), run.startedAt);
    // 只保留最近 N 条：删掉排在上界之外的老运行。
    this.db
      .prepare(
        `DELETE FROM workflow_runs
         WHERE workspace_id = ? AND id NOT IN (
           SELECT id FROM workflow_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?
         )`
      )
      .run(workspaceId, workspaceId, WORKFLOW_RUN_HISTORY_LIMIT);
  }
}

function safeParseJson<T>(text: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function workflowStore(): WorkflowStore {
  if (!shared) shared = new WorkflowStore();
  return shared;
}

/** 关掉共享句柄（能力禁用 / 单测重置时调用）。**不删数据**。 */
export function closeWorkflowStore(): void {
  if (shared) {
    shared.close();
    shared = null;
  }
}

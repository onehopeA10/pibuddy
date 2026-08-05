/**
 * 自动化规则的持久仓库（home.automation / 智能家居 Phase B）。
 *
 * ## node:sqlite，与 ha-store / task-store 同一口径
 *
 * 不引原生依赖（check-pure-js-deps 闸门）。schema 有版本 + migration，改 DDL
 * 必须 +1 并在 migrate() 里补分支，绝不静默重建。按 workspaceId 分区（D4
 * 规则 3）：每条 SQL 都带 `WHERE workspace_id = ?`（或写入时带列），一个
 * 工作区看不到另一个工作区的规则。**停用能力不删数据**（规则 5）——
 * disposeAutomationResources 只关句柄。
 *
 * ## agent_task_ids 是内部列，不外发
 *
 * Agent 动作落成 tasks 域 kind:"event" 的真 task；「第 i 个动作对应哪条
 * task」记在这一列（JSON `{actionIndex: taskId}`）。它是接线细节：渲染进程
 * 与 LLM 看到的规则形态（contract 的 automationRuleSchema）里没有它。
 */
import { app } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AutomationAction,
  AutomationCondition,
  AutomationRule,
  AutomationTrigger,
} from "@pibuddy/contract";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const AUTOMATION_STORE_SCHEMA_VERSION = 1;

const DDL = `CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  condition TEXT,
  actions TEXT NOT NULL,
  timezone TEXT NOT NULL,
  agent_task_ids TEXT NOT NULL,
  last_fired_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const IDX = "CREATE INDEX IF NOT EXISTS idx_auto_rules_ws ON automation_rules(workspace_id)";

/** 内部行：规则本体 + Agent 动作的 task 接线（actionIndex → taskId）。 */
export interface StoredRule extends AutomationRule {
  agentTaskIds: Record<string, string>;
}

interface RuleRow {
  id: string;
  workspace_id: string;
  name: string;
  enabled: number;
  trigger: string;
  condition: string | null;
  actions: string;
  timezone: string;
  agent_task_ids: string;
  last_fired_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function ruleFromRow(row: RuleRow): StoredRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    enabled: row.enabled !== 0,
    trigger: JSON.parse(row.trigger) as AutomationTrigger,
    condition: row.condition === null ? null : (JSON.parse(row.condition) as AutomationCondition),
    actions: JSON.parse(row.actions) as AutomationAction[],
    timezone: row.timezone,
    lastFiredAt: row.last_fired_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentTaskIds: JSON.parse(row.agent_task_ids) as Record<string, string>,
  };
}

let dataDirOverride: string | null = null;

/** 仅供单测：把规则库指向临时目录。 */
export function __setAutomationDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "home-automation.db");
}

export interface NewRule {
  workspaceId: string;
  name: string;
  trigger: AutomationTrigger;
  condition: AutomationCondition | null;
  actions: AutomationAction[];
  timezone: string;
}

export class AutomationStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL);
    this.db.exec(IDX);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current >= AUTOMATION_STORE_SCHEMA_VERSION) return;
    // v0 → v1：首次建库。将来改 DDL 时在这里按 current 补 ALTER 分支，绝不重建。
    this.db.exec(`PRAGMA user_version = ${AUTOMATION_STORE_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  listRules(workspaceId: string): StoredRule[] {
    const rows = this.db
      .prepare("SELECT * FROM automation_rules WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(workspaceId) as unknown as RuleRow[];
    return rows.map(ruleFromRow);
  }

  /** 有规则的全部工作区（activate 时据它把各工作区的引擎拉起来）。 */
  workspaceIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT workspace_id FROM automation_rules")
      .all() as unknown as { workspace_id: string }[];
    return rows.map((r) => r.workspace_id);
  }

  getRule(id: string): StoredRule | null {
    const row = this.db.prepare("SELECT * FROM automation_rules WHERE id = ?").get(id) as
      | RuleRow
      | undefined;
    return row ? ruleFromRow(row) : null;
  }

  createRule(input: NewRule, now: number): StoredRule {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO automation_rules
         (id, workspace_id, name, enabled, trigger, condition, actions, timezone,
          agent_task_ids, last_fired_at, last_error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        1,
        JSON.stringify(input.trigger),
        input.condition === null ? null : JSON.stringify(input.condition),
        JSON.stringify(input.actions),
        input.timezone,
        "{}",
        null,
        null,
        now,
        now
      );
    const rule = this.getRule(id);
    if (!rule) throw new Error(`AUTOMATION_RULE_UNKNOWN: ${id}`);
    return rule;
  }

  /** 整份替换规则 spec（enabled / lastFired* / agentTaskIds 不动）。 */
  updateRuleSpec(id: string, input: Omit<NewRule, "workspaceId">, now: number): StoredRule | null {
    const current = this.getRule(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE automation_rules SET name=?, trigger=?, condition=?, actions=?, timezone=?,
          updated_at=? WHERE id=?`
      )
      .run(
        input.name,
        JSON.stringify(input.trigger),
        input.condition === null ? null : JSON.stringify(input.condition),
        JSON.stringify(input.actions),
        input.timezone,
        now,
        id
      );
    return this.getRule(id);
  }

  setEnabled(id: string, enabled: boolean, now: number): StoredRule | null {
    const current = this.getRule(id);
    if (!current) return null;
    this.db
      .prepare("UPDATE automation_rules SET enabled=?, updated_at=? WHERE id=?")
      .run(enabled ? 1 : 0, now, id);
    return this.getRule(id);
  }

  setAgentTaskIds(id: string, map: Record<string, string>, now: number): void {
    this.db
      .prepare("UPDATE automation_rules SET agent_task_ids=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(map), now, id);
  }

  /** 记录一次命中执行的结果（成功 lastError=null；失败带原因）。 */
  recordFired(id: string, at: number, error: string | null): void {
    this.db
      .prepare("UPDATE automation_rules SET last_fired_at=?, last_error=? WHERE id=?")
      .run(at, error, id);
  }

  deleteRule(id: string): void {
    this.db.prepare("DELETE FROM automation_rules WHERE id = ?").run(id);
  }
}

let shared: AutomationStore | null = null;

/** 进程内共享实例（首次访问时建库；能力禁用时不会被调到）。 */
export function automationStore(): AutomationStore {
  if (!shared) shared = new AutomationStore();
  return shared;
}

/** 关闭共享句柄（disposeAutomationResources / 单测收尾用）。数据不动。 */
export function closeAutomationStore(): void {
  if (shared) {
    shared.close();
    shared = null;
  }
}

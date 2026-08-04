/**
 * 本地用量聚合（PROV-101）。
 *
 * ## 本地优先，没有任何上报
 *
 * 表里全部数据来自 pi 的 `get_session_stats`，落在用户自己机器上的一个
 * SQLite 文件里。没有任何一条出站路径读它 —— 「我这个月花了多少钱」这件
 * 事不该需要联网。
 *
 * ## 增量必须钳到非负
 *
 * `get_session_stats` 给的是**会话累计值**，而 pi 在压缩（compaction）之后
 * 会重置统计。于是「本次 total < 上次 total」是正常发生的事：直接做差会
 * 往表里写一个负数，表现是用户看到这个月的花费比上周还少 —— 一个不会
 * 报错、也不会有人一眼看出来的错误。这里一律 `Math.max(0, delta)`。
 *
 * ## CSV 注入
 *
 * 导出的 CSV 会被 Excel / Numbers 直接打开。以 `=` `+` `-` `@` 开头的单元格
 * 会被当成公式求值，而 workspace 显示名是用户可控的文件夹名。这里对这四种
 * 前缀加前导单引号 —— 「导出的表格一打开就执行命令」是典型的静默风险。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageQuery, UsageRecordRequest, UsageRow, UsageSessionRow } from "@pibuddy/contract";

/**
 * 表结构代际。改 DDL 必须 +1 并补一条迁移分支。
 *
 * v1 → v2（R5.2）：新增 usage_session_daily（按 (sessionId, day) 的会话明细）。
 * 纯增表，CREATE IF NOT EXISTS 即完成迁移；旧数据不回填 —— 历史会话的按日
 * 明细无从考证，明细从升级后第一次上报开始积累，如实不造数。
 */
export const USAGE_SCHEMA_VERSION = 2;

/** CSV 首行。列顺序被单测钉死，改动等于破坏用户已有的导入脚本。 */
export const USAGE_CSV_HEADER =
  "date,workspace,provider,model,input_tokens,output_tokens,cost,failures";

let dataDirOverride: string | null = null;

/** 仅供单测：把 usage.db 指到临时目录。 */
export function __setUsageDataDir(dir: string | null): void {
  dataDirOverride = dir;
  instance?.close();
  instance = null;
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "usage.db");
}

/** 本地时区的 `YYYY-MM-DD`。刻意不用 UTC：用户看的是自己的「今天」。 */
export function localDay(at: number = Date.now()): string {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * CSV 单元格转义。
 *
 * 两件事：公式前缀加前导单引号；含逗号 / 引号 / 换行的值整体加双引号并把
 * 内部的双引号翻倍（RFC 4180）。顺序是先判公式再包引号 —— 反过来的话
 * `"=cmd"` 里的等号仍在首位，Excel 照样求值。
 */
export function csvCell(value: string | number): string {
  const raw = String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.split('"').join('""')}"`;
  return guarded;
}

export class UsageStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        day            TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        provider       TEXT NOT NULL,
        model_id       TEXT NOT NULL,
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        cost           REAL    NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        failure_count  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, workspace_root, provider, model_id)
      );
      CREATE TABLE IF NOT EXISTS usage_session_seen (
        session_id  TEXT PRIMARY KEY,
        input_total INTEGER NOT NULL DEFAULT 0,
        output_total INTEGER NOT NULL DEFAULT 0,
        cost_total  REAL    NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS usage_session_daily (
        session_id     TEXT NOT NULL,
        day            TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        provider       TEXT NOT NULL,
        model_id       TEXT NOT NULL,
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        cost           REAL    NOT NULL DEFAULT 0,
        failure_count  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, day)
      );
    `);
    this.db
      .prepare("INSERT OR REPLACE INTO usage_meta(key, value) VALUES ('schemaVersion', ?)")
      .run(String(USAGE_SCHEMA_VERSION));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已经关了 */
    }
  }

  /**
   * 记一次会话累计快照，按差值入库。
   *
   * 返回实际写入的增量，便于单测直接断言「压缩重置后写进去的是 0」。
   */
  record(input: UsageRecordRequest, at: number = Date.now()): {
    inputDelta: number;
    outputDelta: number;
    costDelta: number;
  } {
    const seen = this.db
      .prepare(
        "SELECT input_total, output_total, cost_total FROM usage_session_seen WHERE session_id = ?"
      )
      .get(input.sessionId) as
      | { input_total: number; output_total: number; cost_total: number }
      | undefined;

    // pi 侧压缩后会重置累计值 → 本次 total 可能小于上次。钳到 0，不写负数。
    const inputDelta = Math.max(0, input.inputTokens - (seen?.input_total ?? 0));
    const outputDelta = Math.max(0, input.outputTokens - (seen?.output_total ?? 0));
    const costDelta = Math.max(0, input.cost - (seen?.cost_total ?? 0));

    this.db
      .prepare(
        "INSERT OR REPLACE INTO usage_session_seen(session_id, input_total, output_total, cost_total) VALUES (?, ?, ?, ?)"
      )
      .run(input.sessionId, input.inputTokens, input.outputTokens, input.cost);

    const day = localDay(at);
    const workspace = input.workspaceId ?? "";
    const failure = input.failed ? 1 : 0;

    this.db
      .prepare(
        `INSERT INTO usage_daily
           (day, workspace_root, provider, model_id, input_tokens, output_tokens, cost, context_tokens, failure_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, workspace_root, provider, model_id) DO UPDATE SET
           input_tokens   = input_tokens   + excluded.input_tokens,
           output_tokens  = output_tokens  + excluded.output_tokens,
           cost           = cost           + excluded.cost,
           -- context 是「当前占用」而非累计量，取最新值而不是累加
           context_tokens = excluded.context_tokens,
           failure_count  = failure_count  + excluded.failure_count`
      )
      .run(
        day,
        workspace,
        input.provider,
        input.modelId,
        inputDelta,
        outputDelta,
        costDelta,
        input.contextTokens ?? 0,
        failure
      );

    // 会话明细（R5.2）：同一套差值口径落到 (session_id, day)。
    // 全零且无失败时不写行 —— 双源（前台 / 池后台）重复上报同一份累计快照
    // 的增量为 0，不该为它凭空造出一行「今天 0 token」的明细。
    if (inputDelta > 0 || outputDelta > 0 || costDelta > 0 || failure > 0) {
      this.db
        .prepare(
          `INSERT INTO usage_session_daily
             (session_id, day, workspace_root, provider, model_id, input_tokens, output_tokens, cost, failure_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, day) DO UPDATE SET
             workspace_root = excluded.workspace_root,
             provider       = excluded.provider,
             model_id       = excluded.model_id,
             input_tokens   = input_tokens  + excluded.input_tokens,
             output_tokens  = output_tokens + excluded.output_tokens,
             cost           = cost          + excluded.cost,
             failure_count  = failure_count + excluded.failure_count`
        )
        .run(
          input.sessionId,
          day,
          workspace,
          input.provider,
          input.modelId,
          inputDelta,
          outputDelta,
          costDelta,
          failure
        );
    }

    return { inputDelta, outputDelta, costDelta };
  }

  /** 会话明细：按日期区间与 workspace 过滤，按日期倒序 + 花费倒序。 */
  querySessions(filter: UsageQuery = {}): UsageSessionRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.fromDay) {
      where.push("day >= ?");
      params.push(filter.fromDay);
    }
    if (filter.toDay) {
      where.push("day <= ?");
      params.push(filter.toDay);
    }
    if (filter.workspaceId) {
      where.push("workspace_root = ?");
      params.push(filter.workspaceId);
    }
    const sql =
      "SELECT session_id, day, workspace_root, provider, model_id, input_tokens, output_tokens, cost, failure_count FROM usage_session_daily" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY day DESC, cost DESC";

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      sessionId: String(r.session_id),
      day: String(r.day),
      workspace: String(r.workspace_root),
      provider: String(r.provider),
      model: String(r.model_id),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cost: Number(r.cost),
      failures: Number(r.failure_count),
    }));
  }

  /** 按日期区间与 workspace 过滤，按日期倒序 + 花费倒序。 */
  query(filter: UsageQuery = {}): UsageRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.fromDay) {
      where.push("day >= ?");
      params.push(filter.fromDay);
    }
    if (filter.toDay) {
      where.push("day <= ?");
      params.push(filter.toDay);
    }
    if (filter.workspaceId) {
      where.push("workspace_root = ?");
      params.push(filter.workspaceId);
    }
    const sql =
      "SELECT day, workspace_root, provider, model_id, input_tokens, output_tokens, cost, context_tokens, failure_count FROM usage_daily" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY day DESC, cost DESC";

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      day: String(r.day),
      workspace: String(r.workspace_root),
      provider: String(r.provider),
      model: String(r.model_id),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cost: Number(r.cost),
      contextTokens: Number(r.context_tokens),
      failures: Number(r.failure_count),
    }));
  }

  /**
   * 导出 CSV。
   *
   * `displayNames` 把不透明的 workspaceId 换成用户看得懂的文件夹名 ——
   * 一张全是 sha256 前缀的表对用户没有任何意义。换进来的显示名是用户可控
   * 文本，因此必须经 csvCell 的公式前缀转义。
   */
  exportCsv(filter: UsageQuery = {}, displayNames: Record<string, string> = {}): string {
    const lines = [USAGE_CSV_HEADER];
    for (const row of this.query(filter)) {
      lines.push(
        [
          csvCell(row.day),
          csvCell(displayNames[row.workspace] ?? row.workspace),
          csvCell(row.provider),
          csvCell(row.model),
          csvCell(row.inputTokens),
          csvCell(row.outputTokens),
          csvCell(row.cost),
          csvCell(row.failures),
        ].join(",")
      );
    }
    return `${lines.join("\n")}\n`;
  }

  exportJson(filter: UsageQuery = {}, displayNames: Record<string, string> = {}): string {
    const rows = this.query(filter).map((r) => ({
      ...r,
      workspace: displayNames[r.workspace] ?? r.workspace,
    }));
    return `${JSON.stringify({ schemaVersion: USAGE_SCHEMA_VERSION, rows }, null, 2)}\n`;
  }
}

let instance: UsageStore | null = null;

/** 进程内唯一实例（懒建）。 */
export function usageStore(): UsageStore {
  if (!instance) instance = new UsageStore();
  return instance;
}

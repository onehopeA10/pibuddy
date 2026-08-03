/**
 * 连接器实例的持久仓库（连接器 v1 / CON-101）。
 *
 * ## 一个 db、一张表、只存非敏感配置
 *
 * 表里存的是 id / kind / 显示名 / **目标域名** / 启停态——**没有完整 webhook
 * URL**。URL 里带着密令（`.../hook/<token>`），因此它归 secret-store（safeStorage
 * 加密、只进不出）保管，见 `connector-secret.ts`。这张表存的域名是从 URL 里
 * 拆出来的 host，不敏感，用来给渲染进程显示「这条连的是哪个平台」。
 *
 * ## node:sqlite，与 task-store / memory-store 同一口径
 *
 * 不额外引任何原生依赖（`check-pure-js-deps` 闸门）。schema 有版本 + migration，
 * 改 DDL 必须 +1 并在 migrate() 里补分支，绝不静默重建。写操作全部走
 * DatabaseSync 的 prepare().run()，因此本文件不出现任何 fs 写调用——连接器
 * 能力只申请 `network:`，一条 `workspace.write` 都不需要（drift 权限对账据此
 * 成立）。
 */
import { app } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const CONNECTOR_STORE_SCHEMA_VERSION = 1;

const DDL_CONNECTORS = `CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

let dataDirOverride: string | null = null;

/** 仅供单测：把连接器库指向临时目录。 */
export function __setConnectorDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "connectors.db");
}

/** 一条连接器实例（非敏感部分）。 */
export interface ConnectorRecord {
  id: string;
  kind: "webhook";
  displayName: string;
  domain: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ConnectorRow {
  id: string;
  kind: string;
  display_name: string;
  domain: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function fromRow(row: ConnectorRow): ConnectorRecord {
  return {
    id: row.id,
    kind: row.kind as "webhook",
    displayName: row.display_name,
    domain: row.domain,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewConnector {
  kind: "webhook";
  displayName: string;
  domain: string;
}

export class ConnectorStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL_CONNECTORS);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current >= CONNECTOR_STORE_SCHEMA_VERSION) return;
    // v0 → v1：首次建库。将来改 DDL 时在这里按 current 补 ALTER 分支，绝不重建。
    this.db.exec(`PRAGMA user_version = ${CONNECTOR_STORE_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  create(input: NewConnector, now: number): ConnectorRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO connectors (id, kind, display_name, domain, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(id, input.kind, input.displayName, input.domain, 1, now, now);
    return this.require(id);
  }

  get(id: string): ConnectorRecord | null {
    const row = this.db.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as
      | ConnectorRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  require(id: string): ConnectorRecord {
    const c = this.get(id);
    if (!c) throw new Error(`CONNECTOR_UNKNOWN: ${id}`);
    return c;
  }

  list(): ConnectorRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM connectors ORDER BY created_at ASC")
      .all() as unknown as ConnectorRow[];
    return rows.map(fromRow);
  }

  /** 部分更新（改名 / 换域名 / 启停）。域名随凭证轮换而变。 */
  update(
    id: string,
    patch: Partial<Pick<ConnectorRecord, "displayName" | "domain" | "enabled">>,
    now: number
  ): ConnectorRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const next: ConnectorRecord = { ...current, ...patch, updatedAt: now };
    this.db
      .prepare(
        "UPDATE connectors SET display_name=?, domain=?, enabled=?, updated_at=? WHERE id=?"
      )
      .run(next.displayName, next.domain, next.enabled ? 1 : 0, now, id);
    return next;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
  }
}

let shared: ConnectorStore | null = null;

/** 全进程唯一的连接器库实例。首次访问时才建库（能力禁用时不会被调到）。 */
export function connectorStore(): ConnectorStore {
  if (!shared) shared = new ConnectorStore();
  return shared;
}

/** 应用退出 / 能力禁用时关句柄（Windows 上 WAL 文件在句柄关掉前删不掉）。 */
export function closeConnectorStore(): void {
  shared?.close();
  shared = null;
}

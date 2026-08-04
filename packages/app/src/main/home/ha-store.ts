/**
 * 实体注册表的轻量快照（home.assistant / 智能家居 Phase B）。
 *
 * ## 只落注册表，不落状态
 *
 * 表里存的是 entity_id / 显示名 / domain / area——「家里有哪些设备」这份
 * 慢变清单，冷启动时面板据它秒开（先显示设备列表，状态随首次 REST/WS 拉取
 * 补上）。**状态值刻意不落盘**：它易变（落了也是过期的）且含隐私（「几点
 * 开的卧室灯」不该躺在磁盘上）。
 *
 * ## node:sqlite，与 connector-store / task-store 同一口径
 *
 * 不引原生依赖（check-pure-js-deps 闸门）。schema 有版本 + migration，改 DDL
 * 必须 +1 并在 migrate() 里补分支，绝不静默重建。按 workspaceId 分区（D4
 * 规则 3）；停用能力不删数据（规则 5）。
 */
import { app } from "electron";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const HOME_STORE_SCHEMA_VERSION = 1;

const DDL = `CREATE TABLE IF NOT EXISTS ha_registry (
  workspace_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  area TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, entity_id)
)`;

/** 一条注册表快照行（无状态值——见文件头）。 */
export interface HaRegistryRow {
  entityId: string;
  name: string;
  domain: string;
  area: string | null;
}

interface RegistryDbRow {
  entity_id: string;
  name: string;
  domain: string;
  area: string | null;
}

let dataDirOverride: string | null = null;

/** 仅供单测：把快照库指向临时目录。 */
export function __setHomeStoreDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "home-assistant.db");
}

export class HomeStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
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
    if (current >= HOME_STORE_SCHEMA_VERSION) return;
    // v0 → v1：首次建库。将来改 DDL 时在这里按 current 补 ALTER 分支，绝不重建。
    this.db.exec(`PRAGMA user_version = ${HOME_STORE_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  /** 读某工作区的快照（按 entity_id 排序，输出稳定）。 */
  loadRegistry(workspaceId: string): HaRegistryRow[] {
    const rows = this.db
      .prepare(
        "SELECT entity_id, name, domain, area FROM ha_registry WHERE workspace_id = ? ORDER BY entity_id"
      )
      .all(workspaceId) as unknown as RegistryDbRow[];
    return rows.map((r) => ({
      entityId: r.entity_id,
      name: r.name,
      domain: r.domain,
      area: r.area,
    }));
  }

  /** 整份替换某工作区的快照（注册表是全量语义，不做逐行 diff）。 */
  saveRegistry(workspaceId: string, rows: readonly HaRegistryRow[], now = Date.now()): void {
    const del = this.db.prepare("DELETE FROM ha_registry WHERE workspace_id = ?");
    const ins = this.db.prepare(
      "INSERT INTO ha_registry (workspace_id, entity_id, name, domain, area, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      del.run(workspaceId);
      for (const row of rows) {
        ins.run(workspaceId, row.entityId, row.name, row.domain, row.area, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

let shared: HomeStore | null = null;

/** 进程内共享实例（首次访问时建库）。 */
export function homeStore(): HomeStore {
  if (!shared) shared = new HomeStore();
  return shared;
}

/** 关闭共享句柄（disposeHomeResources / 单测收尾用）。 */
export function closeHomeStore(): void {
  if (shared) {
    shared.close();
    shared = null;
  }
}

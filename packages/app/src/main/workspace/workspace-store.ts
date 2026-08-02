/**
 * Workspace 档案表（FS-101）。
 *
 * ## 与 workspace-registry 的分工
 *
 * `workspace-registry.ts` 回答「这个 id 对应磁盘上的哪个目录」以及「这条
 * 路径在不在里面」——那是**安全**边界，全计划唯一（CT-18），本文件一行都
 * 不重复它。本文件回答的是「用户对这个工作区做过什么设定」：显示名、
 * 信任态、ignore 策略、默认模型、IPC 准入规则。两件事分开的理由很实际：
 * 收容原语被复制一份的代价是安全漏洞，档案字段被复制一份的代价只是脏数据。
 *
 * ## canonicalRoot 为什么必须是 realpath
 *
 * 用户可以从三个不同的入口选中同一个目录：`D:\Work`、`D:\work`、
 * 一条指向它的符号链接。不 realpath 的话它们会变成三条 workspace 记录，
 * 而三条记录各带一套 ignore 策略和默认模型 —— 表现是「我明明设过，
 * 换个方式打开就没了」，且不报任何错。
 */
import { app } from "electron";
import type { PermissionRule, WorkspaceTrust } from "@pibuddy/contract";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { workspaceIdFor } from "../workspace-registry.js";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const WORKSPACE_STORE_SCHEMA_VERSION = 1;

/**
 * 默认 ignore 策略。
 *
 * `node_modules` 与 `.git` 写死在这里而不是靠用户的 .gitignore：绝大多数
 * 项目的 .gitignore 里根本没有 `.git/`（git 自己不需要），而一次误展开
 * `.git/objects` 就是几万个两字符目录。
 */
export const DEFAULT_IGNORE_POLICY: string[] = [
  "node_modules",
  ".git",
  ".pnpm-store",
  "dist",
  "out",
  ".DS_Store",
];

/** 工作区档案。字段集合由 FS-101 固定，增删字段需要同步 migrate()。 */
export interface WorkspaceProfile {
  id: string;
  /** canonical realpath —— 只存在于主进程，永不外发给渲染进程 */
  canonicalRoot: string;
  displayName: string;
  trust: WorkspaceTrust;
  createdAt: number;
  lastOpenedAt: number;
  ignorePolicy: string[];
  defaultModel: string | null;
  permissionRules: PermissionRule[];
}

const DDL = `CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL,
  ignore_policy TEXT NOT NULL,
  default_model TEXT,
  permission_rules TEXT NOT NULL,
  schema_version INTEGER NOT NULL
)`;

/** 测试注入用；生产环境恒为 null，走 app.getPath("userData")。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把档案库指向临时目录。 */
export function __setWorkspaceStoreDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "workspaces.db");
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 被手改坏的一列不该让整个工作区打不开
    return fallback;
  }
}

export class WorkspaceStore {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL);
    this.migrate();
  }

  /** 用 `PRAGMA user_version` 记代际；升级时补分支，绝不静默重建。 */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current === WORKSPACE_STORE_SCHEMA_VERSION) return;
    if (current > WORKSPACE_STORE_SCHEMA_VERSION) return;
    this.db.exec(`PRAGMA user_version = ${WORKSPACE_STORE_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 打开（或首次创建）一个工作区档案。
   *
   * 幂等：同一个目录反复调用只会刷新 lastOpenedAt，用户设过的 ignore
   * 策略 / 默认模型 / 信任态一个都不会被重置回默认值。
   */
  open(absPath: string, now: number = Date.now()): WorkspaceProfile {
    const canonicalRoot = fs.realpathSync.native(absPath);
    const id = workspaceIdFor(canonicalRoot);
    const existing = this.get(id);
    if (existing) {
      this.db
        .prepare("UPDATE workspaces SET last_opened_at = ?, canonical_root = ? WHERE id = ?")
        .run(now, canonicalRoot, id);
      return { ...existing, lastOpenedAt: now, canonicalRoot };
    }
    const profile: WorkspaceProfile = {
      id,
      canonicalRoot,
      displayName: path.basename(canonicalRoot) || canonicalRoot,
      trust: "unknown",
      createdAt: now,
      lastOpenedAt: now,
      ignorePolicy: [...DEFAULT_IGNORE_POLICY],
      defaultModel: null,
      permissionRules: [],
    };
    this.db
      .prepare(
        `INSERT INTO workspaces
         (id, canonical_root, display_name, trust, created_at, last_opened_at,
          ignore_policy, default_model, permission_rules, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profile.id,
        profile.canonicalRoot,
        profile.displayName,
        profile.trust,
        profile.createdAt,
        profile.lastOpenedAt,
        JSON.stringify(profile.ignorePolicy),
        profile.defaultModel,
        JSON.stringify(profile.permissionRules),
        WORKSPACE_STORE_SCHEMA_VERSION
      );
    return profile;
  }

  get(id: string): WorkspaceProfile | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      canonicalRoot: String(row.canonical_root),
      displayName: String(row.display_name),
      trust: String(row.trust) as WorkspaceTrust,
      createdAt: Number(row.created_at),
      lastOpenedAt: Number(row.last_opened_at),
      ignorePolicy: parseJson<string[]>(row.ignore_policy, [...DEFAULT_IGNORE_POLICY]),
      defaultModel: row.default_model === null ? null : String(row.default_model),
      permissionRules: parseJson<PermissionRule[]>(row.permission_rules, []),
    };
  }

  /** 部分更新。未传的字段一个都不动。 */
  update(id: string, patch: Partial<Omit<WorkspaceProfile, "id">>): WorkspaceProfile | null {
    const current = this.get(id);
    if (!current) return null;
    const next: WorkspaceProfile = { ...current, ...patch, id };
    this.db
      .prepare(
        `UPDATE workspaces SET display_name = ?, trust = ?, last_opened_at = ?,
          ignore_policy = ?, default_model = ?, permission_rules = ? WHERE id = ?`
      )
      .run(
        next.displayName,
        next.trust,
        next.lastOpenedAt,
        JSON.stringify(next.ignorePolicy),
        next.defaultModel,
        JSON.stringify(next.permissionRules),
        id
      );
    return next;
  }

  list(): WorkspaceProfile[] {
    const rows = this.db.prepare("SELECT id FROM workspaces ORDER BY last_opened_at DESC").all() as {
      id: string;
    }[];
    return rows.map((r) => this.get(r.id)).filter((p): p is WorkspaceProfile => p !== null);
  }
}

let shared: WorkspaceStore | null = null;

/** 进程内共享实例。首次访问时才建库（测试可先 __setWorkspaceStoreDataDir）。 */
export function workspaceStore(): WorkspaceStore {
  if (!shared) shared = new WorkspaceStore();
  return shared;
}

/** 取某个工作区的 ignore 策略；未建档时回落到默认值。 */
export function ignorePolicyFor(workspaceId: string): string[] {
  return workspaceStore().get(workspaceId)?.ignorePolicy ?? [...DEFAULT_IGNORE_POLICY];
}

/**
 * 远程访问的设备 / 配对 / 配置 / 审计的唯一持久仓库（REM-101）。
 *
 * ## 只存 hash，绝不存明文 token
 *
 * 一台设备配对后拿到一个长期 bearer token（128+ bit 随机）。**主进程只存它的
 * sha256(pepper:token) hash**（列上有唯一索引，鉴权时按 hash O(1) 查）。token
 * 原文只在配对那一刻经网络发给设备本身，之后主进程再也拿不回它——即便本文件的
 * 数据库整个泄漏，攻击者也拿不到任何一台设备的 token（hash 不可逆，且 token 是
 * 高熵随机值，无字典可撞）。sha256 对高熵随机 token 是恰当选择（scrypt/argon2 是
 * 为低熵口令抗暴力设计的，对随机 token 无额外收益，还会拖慢每次鉴权）。
 *
 * ## 配对 challenge 同样只存 hash、且单次 + 短时
 *
 * 配对 challenge 也是随机 secret，同样只存 hash（`challenge_hash`）。consume 时
 * 在**一条 UPDATE ... WHERE used=0** 上原子置 used=1：并发两次消费同一 challenge
 * 时，只有一条 `changes===1`，另一条 0，天然单次。过期由 `expires_at` 判。
 *
 * ## node:sqlite，与 connector-store / task-store 同一口径
 *
 * 不引任何原生依赖（`check-pure-js-deps` 闸门）。schema 有版本 + migration。写操作
 * 全部走 DatabaseSync 的 prepare().run()——本文件不出现任何 fs 写调用，因此
 * `connector.remote` 一条 `workspace.write` 都不需要（drift 权限对账据此成立）。
 */
import { app } from "electron";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RemoteBindScope, RemoteScope } from "@pibuddy/contract";

/** 表结构代际。改 DDL 必须 +1 并在 migrate() 里补分支。 */
export const REMOTE_REGISTRY_SCHEMA_VERSION = 1;

const DDL_DEVICES = `CREATE TABLE IF NOT EXISTS remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
)`;
const DDL_CHALLENGES = `CREATE TABLE IF NOT EXISTS remote_challenges (
  id TEXT PRIMARY KEY,
  challenge_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  rotate_device_id TEXT,
  created_at INTEGER NOT NULL
)`;
const DDL_CONFIG = `CREATE TABLE IF NOT EXISTS remote_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;
const DDL_AUDIT = `CREATE TABLE IF NOT EXISTS remote_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL
)`;

let dataDirOverride: string | null = null;

/** 仅供单测：把远程库指向临时目录。 */
export function __setRemoteDataDir(dir: string | null): void {
  dataDirOverride = dir;
  if (shared) {
    shared.close();
    shared = null;
  }
}

/** 远程库文件是否已存在（决定「从没配过 = 不碰任何东西」）。existsSync 非写操作。 */
export function remoteRegistryExists(): boolean {
  return existsSync(dbPath());
}

function dbPath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, "remote.db");
}

/** sha256(pepper:secret) 的 hex。token / challenge 的存储与查找都经它。 */
export function hashSecret(pepper: string, secret: string): string {
  return createHash("sha256").update(`${pepper}:${secret}`).digest("hex");
}

/** 生成一个高熵 secret（token / challenge 用），URL 安全。 */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface RemoteDeviceRow {
  id: string;
  name: string;
  tokenHash: string;
  scopes: RemoteScope[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface RemoteChallengeRow {
  id: string;
  expiresAt: number;
  used: boolean;
  rotateDeviceId: string | null;
  createdAt: number;
}

interface DeviceDbRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
}
interface ChallengeDbRow {
  id: string;
  challenge_hash: string;
  expires_at: number;
  used: number;
  rotate_device_id: string | null;
  created_at: number;
}

function toDeviceRow(row: DeviceDbRow): RemoteDeviceRow {
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    scopes: JSON.parse(row.scopes) as RemoteScope[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export interface RemoteAuditEntry {
  at: number;
  event: string;
  detail: string;
}

export class RemoteRegistry {
  private readonly db: DatabaseSync;

  constructor(file: string = dbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(DDL_DEVICES);
    this.db.exec(DDL_CHALLENGES);
    this.db.exec(DDL_CONFIG);
    this.db.exec(DDL_AUDIT);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current >= REMOTE_REGISTRY_SCHEMA_VERSION) return;
    this.db.exec(`PRAGMA user_version = ${REMOTE_REGISTRY_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- 配置

  private getConfig(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM remote_config WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  private setConfig(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO remote_config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  /** 服务器 pepper：首次访问时生成并落库（不是 token，但让 hash 表离线更难被批量预算）。 */
  pepper(): string {
    let p = this.getConfig("pepper");
    if (!p) {
      p = newSecret(32);
      this.setConfig("pepper", p);
    }
    return p;
  }

  isEnabled(): boolean {
    return this.getConfig("enabled") === "1";
  }
  setEnabled(enabled: boolean): void {
    this.setConfig("enabled", enabled ? "1" : "0");
  }

  bindScope(): RemoteBindScope {
    return this.getConfig("bindScope") === "lan" ? "lan" : "loopback";
  }
  setBindScope(scope: RemoteBindScope): void {
    this.setConfig("bindScope", scope);
  }

  // ---------------------------------------------------------------- 设备

  createDevice(name: string, tokenHash: string, scopes: RemoteScope[], now: number): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO remote_devices (id, name, token_hash, scopes, created_at, last_used_at) VALUES (?,?,?,?,?,NULL)"
      )
      .run(id, name, tokenHash, JSON.stringify(scopes), now);
    return id;
  }

  deviceByTokenHash(tokenHash: string): RemoteDeviceRow | null {
    const row = this.db.prepare("SELECT * FROM remote_devices WHERE token_hash = ?").get(tokenHash) as
      | DeviceDbRow
      | undefined;
    return row ? toDeviceRow(row) : null;
  }

  deviceById(id: string): RemoteDeviceRow | null {
    const row = this.db.prepare("SELECT * FROM remote_devices WHERE id = ?").get(id) as
      | DeviceDbRow
      | undefined;
    return row ? toDeviceRow(row) : null;
  }

  listDevices(): RemoteDeviceRow[] {
    const rows = this.db
      .prepare("SELECT * FROM remote_devices ORDER BY created_at ASC")
      .all() as unknown as DeviceDbRow[];
    return rows.map(toDeviceRow);
  }

  touchDevice(id: string, now: number): void {
    this.db.prepare("UPDATE remote_devices SET last_used_at = ? WHERE id = ?").run(now, id);
  }

  setDeviceScopes(id: string, scopes: RemoteScope[]): void {
    this.db.prepare("UPDATE remote_devices SET scopes = ? WHERE id = ?").run(JSON.stringify(scopes), id);
  }

  setDeviceToken(id: string, tokenHash: string): void {
    this.db.prepare("UPDATE remote_devices SET token_hash = ? WHERE id = ?").run(tokenHash, id);
  }

  deleteDevice(id: string): void {
    this.db.prepare("DELETE FROM remote_devices WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------------- 配对 challenge

  /** 生成一条 challenge（先作废旧的未消费 challenge：同一时刻只允许一个活跃配对）。 */
  createChallenge(
    challengeHash: string,
    expiresAt: number,
    now: number,
    rotateDeviceId: string | null
  ): string {
    this.db.prepare("UPDATE remote_challenges SET used = 1 WHERE used = 0").run();
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO remote_challenges (id, challenge_hash, expires_at, used, rotate_device_id, created_at) VALUES (?,?,?,0,?,?)"
      )
      .run(id, challengeHash, expiresAt, rotateDeviceId, now);
    return id;
  }

  /**
   * 消费一条 challenge：原子置 used=1，仅当此前 used=0 且未过期。
   * 返回被消费的 challenge（含 rotate_device_id）；不存在 / 已用 / 过期一律返回 null。
   */
  consumeChallenge(challengeHash: string, now: number): RemoteChallengeRow | null {
    const row = this.db
      .prepare("SELECT * FROM remote_challenges WHERE challenge_hash = ?")
      .get(challengeHash) as ChallengeDbRow | undefined;
    if (!row) return null;
    if (row.used !== 0) return null;
    if (row.expires_at <= now) return null;
    const res = this.db
      .prepare("UPDATE remote_challenges SET used = 1 WHERE id = ? AND used = 0")
      .run(row.id);
    if (res.changes !== 1) return null; // 并发消费，输的一方拿不到
    return {
      id: row.id,
      expiresAt: row.expires_at,
      used: true,
      rotateDeviceId: row.rotate_device_id,
      createdAt: row.created_at,
    };
  }

  activeChallengeExists(now: number): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM remote_challenges WHERE used = 0 AND expires_at > ?")
      .get(now) as { n: number };
    return row.n > 0;
  }

  cancelChallenges(): void {
    this.db.prepare("UPDATE remote_challenges SET used = 1 WHERE used = 0").run();
  }

  // ---------------------------------------------------------------- 审计

  audit(event: string, detail: string, now: number): void {
    this.db.prepare("INSERT INTO remote_audit (at, event, detail) VALUES (?,?,?)").run(now, event, detail);
    // 有界：只留最近 500 条
    this.db
      .prepare(
        "DELETE FROM remote_audit WHERE id NOT IN (SELECT id FROM remote_audit ORDER BY id DESC LIMIT 500)"
      )
      .run();
  }

  recentAudit(limit: number): RemoteAuditEntry[] {
    const rows = this.db
      .prepare("SELECT at, event, detail FROM remote_audit ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as RemoteAuditEntry[];
    return rows;
  }
}

let shared: RemoteRegistry | null = null;

/** 全进程唯一的远程库实例。首次访问时才建库（能力禁用 / 从未配置时不会被调到）。 */
export function remoteRegistry(): RemoteRegistry {
  if (!shared) shared = new RemoteRegistry();
  return shared;
}

/** 应用退出 / 能力禁用时关句柄（Windows 上 WAL 文件在句柄关掉前删不掉）。 */
export function closeRemoteRegistry(): void {
  shared?.close();
  shared = null;
}

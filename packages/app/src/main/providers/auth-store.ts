/**
 * `~/.pi/agent/auth.json` 的合并式读写（PROV-101 / CT-24 例外）。
 *
 * ## 这个文件不是我们的
 *
 * 它同时属于用户终端里的 `pi`。里面可能已经躺着 `/login` 存下的 OAuth 条目
 * （Claude Pro/Max、Codex、Copilot…），那些条目 PiBuddy 既产生不了也恢复
 * 不了。因此本模块只做三件事，一件都不能少：
 *
 *   1. **先读再合并** —— 写入前把整份文件读进来，只替换目标 providerId 那
 *      一个键。整文件覆盖会在用户下一次开终端跑 pi 时表现为「所有账号都
 *      退出了」，而且没有任何提示。
 *   2. **写前备份** —— 覆盖前把原文件复制到
 *      `<userData>/auth-backup/auth.<epochMs>.json`。写坏用户终端里的 pi 是
 *      不可逆事故，一份可校验的备份是唯一的退路。
 *   3. **0600 + 原子写** —— 走 fs-atomic.ts 的 writeJsonAtomic（全仓唯一的
 *      原子写实现），随后 chmod 0600。本文件里没有任何裸的同步写调用：
 *      非原子的覆盖写在掉电时会留下半截 JSON，而那份 JSON 会让用户终端里
 *      的 pi 直接起不来。结构断言见 auth-store.test.ts 的「结构性约束」。
 *
 * ## Windows 上如实降级
 *
 * `fs.chmodSync(p, 0o600)` 在 Windows 上不会报错，但对 NTFS ACL 基本无效 ——
 * 文件仍然是「本机其它用户可读」。这里显式分支、记一条 warning、并把
 * `permissionEnforced: false` 一路送到界面上，而不是假装已经加固了。
 * 假装加固比不加固更糟：用户会据此以为可以在共享机器上存密钥。
 *
 * ## key 的形态
 *
 * providers.md 的 Key Resolution 允许 `"!command"`（执行 shell 取 stdout）与
 * `"$ENV"`（环境变量插值）。PiBuddy 写进去的一律是**字面量**：从界面收来的
 * 字符串如果以 `!` 开头，会被转义成 `$!` —— 否则用户粘错一个字符串就变成
 * 了「pi 每次启动都执行它」。读回来时同样不做任何求值。
 */
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderAuthKind } from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";
import { createLogger, type Logger } from "../logger.js";

/**
 * providers/ 这一域共用的 logger 取用点。
 *
 * 惰性创建：`createLogger` 在构造时就 mkdir 日志目录，模块加载期直接建一个
 * 会让任何 import 本文件的单测在 tmp 下留一堆空目录。可注入是 PROV-101 的
 * 硬需求 —— 「密钥不进日志」这条只能靠 spy 住全部调用参数来证伪。
 */
let providerLoggerImpl: Logger | null = null;

/** 仅供单测：注入一个 spy logger；传 null 恢复真实实现。 */
export function __setProviderLogger(logger: Logger | null): void {
  providerLoggerImpl = logger;
}

export function providerLogger(): Logger {
  if (!providerLoggerImpl) providerLoggerImpl = createLogger("main");
  return providerLoggerImpl;
}

/**
 * auth.json 的目标权限。
 *
 * providers.md 原文：「The file is created with `0600` permissions
 * (user read/write only)」。我们写回去时必须复现同一个 `mode: 0o600`，
 * 否则一次 PiBuddy 保存就会把用户原本 0600 的文件放宽成 umask 默认值。
 */
export const AUTH_FILE_MODE = 0o600;

/**
 * auth.json 里的一条凭据。
 *
 * `type` 刻意是宽松的 string 而不是联合：pi 将来加一种凭据形态时，我们
 * 只要能把它原样读出来、原样写回去就够了。收窄成联合会让未知形态在
 * JSON.parse 之后被当成非法值丢掉 —— 那正是「合并写入」要防的事故。
 */
export interface PiCredential {
  type: string;
  key?: string;
  env?: Record<string, string>;
  /** OAuth 条目里的 refresh/access token 等字段原样保留 */
  [extra: string]: unknown;
}

export interface WriteCredentialResult {
  /** 0600 是否真的生效（Windows 恒为 false） */
  permissionEnforced: boolean;
  /** 本次写入前留下的备份文件绝对路径；原文件不存在时为 null */
  backupPath: string | null;
}

/** 仅供单测：把 `~/.pi` 与 userData 指到临时目录。 */
let homeOverride: string | null = null;
let userDataOverride: string | null = null;

export function __setAuthStoreDirs(dirs: {
  home?: string | null;
  userData?: string | null;
}): void {
  if (dirs.home !== undefined) homeOverride = dirs.home;
  if (dirs.userData !== undefined) userDataOverride = dirs.userData;
}

function homeDir(): string {
  return homeOverride ?? os.homedir();
}

function userDataDir(): string {
  return userDataOverride ?? app.getPath("userData");
}

/** `~/.pi/agent/auth.json` —— 路径写死，不接受任何外部输入。 */
export function authFilePath(): string {
  return path.join(homeDir(), ".pi", "agent", "auth.json");
}

export function backupDir(): string {
  return path.join(userDataDir(), "auth-backup");
}

/**
 * 读整份 auth.json。
 *
 * 文件不存在 / 坏掉时返回 `{}`。**这里不能抛**：抛出去的表现是
 * 「Provider 中心整页打不开」，而实际上只是用户还没配过任何账号。
 */
export function readAuthFile(): Record<string, PiCredential> {
  try {
    const raw = JSON.parse(fs.readFileSync(authFilePath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, PiCredential> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[id] = value as PiCredential;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 某条凭据的形态。OAuth 条目一律判为 oauth（本轮端内登录不支持）。 */
export function authKindOf(cred: PiCredential | undefined): ProviderAuthKind {
  if (!cred) return "none";
  return cred.type === "api_key" ? "api_key" : "oauth";
}

/**
 * 界面能看到的尾四位。
 *
 * 只对字面量 key 取尾四位：`$ENV` 与 `!command` 两种形态下，「尾四位」
 * 显示的是变量名或命令的结尾，对用户毫无意义且会误导。
 */
export function last4Of(cred: PiCredential | undefined): string {
  const key = typeof cred?.key === "string" ? cred.key : "";
  if (key === "" || key.startsWith("$") || key.startsWith("!")) return "";
  return key.slice(-4);
}

/**
 * 把用户输入的密钥转成**字面量**形态。
 *
 * providers.md 规定 `!` 开头会被当成 shell 命令执行、`$` 开头会被当成环境
 * 变量插值。用户粘进来的密钥不该有这两种语义，因此按文档给的转义写法
 * （`$!` / `$$`）钉成字面量。
 */
export function literalKey(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("!")) return `$!${value.slice(1)}`;
  if (value.startsWith("$")) return `$$${value.slice(1)}`;
  return value;
}

/** 0600 是否可能生效。Windows 上 chmod 对 ACL 无效，恒为 false。 */
export function canEnforcePermissions(): boolean {
  return process.platform !== "win32";
}

/**
 * 覆盖前把原文件复制到 `<userData>/auth-backup/auth.<epochMs>.json`。
 *
 * 返回备份路径；原文件不存在（第一次配置）时返回 null。备份失败**必须
 * 抛**，与 settings.ts 的「备份失败不阻断保存」相反 —— 那边写坏的是我们
 * 自己的设置，这边写坏的是用户终端里 pi 的登录态。
 */
function backupExisting(now: number): string | null {
  const source = authFilePath();
  if (!fs.existsSync(source)) return null;
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `auth.${now}.json`);
  fs.copyFileSync(source, target);
  return target;
}

/**
 * 合并写入一条凭据。`cred.key` 为空串表示**删除**该 provider 的条目。
 *
 * 顺序不可换：读 → 备份 → 合并 → 原子写 → chmod。备份排在原子写之前，
 * 因为 rename 之后原文件就不存在了。
 */
export function writeCredential(
  providerId: string,
  cred: { type: "api_key"; key: string; env?: Record<string, string> },
  now: number = Date.now()
): WriteCredentialResult {
  const merged = readAuthFile();
  const backupPath = backupExisting(now);

  if (cred.key.trim() === "") {
    delete merged[providerId];
  } else {
    // 已有条目的其它字段原样保留（用户可能在 auth.json 里手写过 env）
    const previous = merged[providerId];
    merged[providerId] = {
      ...(previous ?? {}),
      type: "api_key",
      key: literalKey(cred.key),
      ...(cred.env && Object.keys(cred.env).length > 0 ? { env: cred.env } : {}),
    };
  }

  const target = authFilePath();
  writeJsonAtomic(target, merged);

  let permissionEnforced = false;
  if (canEnforcePermissions()) {
    try {
      fs.chmodSync(target, AUTH_FILE_MODE);
      permissionEnforced = true;
    } catch (err) {
      providerLogger().warn("auth_chmod_failed", { reason: (err as Error).message });
    }
  } else {
    // 如实记录，而不是静默地让 permissionEnforced 停在 false ——
    // 没有这条日志的话，「为什么界面上说权限没收紧」在现场无从查起。
    providerLogger().warn("auth_permission_unenforceable", {
      platform: process.platform,
      hint: "Windows 上 chmod 0600 对 NTFS ACL 无效，auth.json 仍可被本机其它用户读取",
    });
  }

  return { permissionEnforced, backupPath };
}

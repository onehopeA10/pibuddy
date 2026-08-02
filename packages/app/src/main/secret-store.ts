/**
 * PiBuddy 自有凭据的唯一保管处（SEC-004）。
 *
 * ## fail closed，绝不降级
 *
 * `safeStorage.isEncryptionAvailable()` 为 false 时（典型是没有 libsecret /
 * gnome-keyring 的 Linux 桌面），本模块**拒绝保存**并抛
 * SECRET_STORE_UNAVAILABLE，不会退回明文写盘。理由很直接：一个「加密不可用
 * 就写明文」的实现，攻击者只要让加密不可用就拿到了明文，等于没加密。用户
 * 会看到一句可读的提示，而不是一个自称安全的假象。
 *
 * ## 只进不出
 *
 * 对外只有 saveSecret / loadSecret / describeSecret 三个动作，其中 loadSecret
 * **仅供主进程内部使用**，没有任何 IPC 通道能把明文送到渲染进程。渲染进程能
 * 看到的极限是 describeSecret 返回的 `{configured, last4}`。
 *
 * ## 例外声明（CT-24）
 *
 * pi 运行时自己要读 `~/.pi/agent/auth.json`，那份 provider 凭据**不归本模块
 * 管**，由 TASK-014 以 0o600 + 原子写 + 写前备份的文件权限模型保护。「不明文
 * 落盘」这条约束的范围是 PiBuddy 自己直接使用的凭据。
 */
import { app, safeStorage } from "electron";
import path from "node:path";
import fs from "node:fs";
// 「配没配 + 尾四位」这个形状要跨 IPC 送到渲染进程，因此归契约包所有；
// 本文件不再自己声明一份同形状的 interface（那是漂移的起点）。
import type { SecretDescriptor } from "@pibuddy/contract";

import { writeJsonAtomic } from "./fs-atomic.js";

/** 落盘文件名。内容是 base64 的密文，不是明文。 */
const STORE_FILE = "secrets.json";

/** 密钥槽位名。加一把就在这里加一行。 */
export const SECRET_KEYS = {
  sttApiKey: "stt.apiKey",
} as const;

export type SecretSlot = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];

export const SECRET_STORE_UNAVAILABLE = "SECRET_STORE_UNAVAILABLE";

interface SecretFile {
  version: number;
  /** slot → base64(safeStorage 密文) */
  secrets: Record<string, string>;
}

/** 测试注入用的数据目录；生产环境恒为 null。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把 secrets.json 指向临时目录。 */
export function __setSecretDataDir(dir: string | null): void {
  dataDirOverride = dir;
}

function storePath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, STORE_FILE);
}

function readFileOrEmpty(): SecretFile {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const candidate = raw as Partial<SecretFile>;
      if (candidate.secrets && typeof candidate.secrets === "object") {
        return { version: candidate.version ?? 1, secrets: { ...candidate.secrets } };
      }
    }
  } catch {
    /* 文件不存在 / 被改坏：当成空表，下一次保存会覆盖它 */
  }
  return { version: 1, secrets: {} };
}

/** 加密可用性。不可用时**没有**任何写入路径可走。 */
export function isSecretStoreAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 保存一把密钥。value 为空串表示清除该槽位。
 *
 * 加密不可用时先抛错**再**碰磁盘 —— 顺序反过来的话，就会出现「报了错但
 * 明文已经躺在 secrets.json 里」这种最坏结果。
 */
export function saveSecret(slot: string, value: string): SecretDescriptor {
  const file = readFileOrEmpty();

  if (value === "") {
    delete file.secrets[slot];
    writeJsonAtomic(storePath(), file);
    return { configured: false, last4: "" };
  }

  if (!isSecretStoreAvailable()) {
    throw new Error(
      `${SECRET_STORE_UNAVAILABLE}: 当前系统没有可用的安全存储（Linux 上通常是缺少 gnome-keyring / KWallet）。` +
        `PiBuddy 拒绝把密钥明文写入磁盘，请先安装并登录系统密钥环后重试。`
    );
  }

  const encrypted = safeStorage.encryptString(value);
  file.secrets[slot] = encrypted.toString("base64");
  writeJsonAtomic(storePath(), file);
  return { configured: true, last4: value.slice(-4) };
}

/**
 * 取回明文。**只允许主进程内部调用**（组装 Authorization 头时）。
 * 未配置返回 null；配置了但解不开（换了机器 / 换了用户）也返回 null。
 */
export function loadSecret(slot: string): string | null {
  const stored = readFileOrEmpty().secrets[slot];
  if (!stored) return null;
  if (!isSecretStoreAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return null;
  }
}

/** 渲染进程唯一能看到的形态：配没配 + 尾四位。 */
export function describeSecret(slot: string): SecretDescriptor {
  const stored = readFileOrEmpty().secrets[slot];
  if (!stored) return { configured: false, last4: "" };
  const plain = loadSecret(slot);
  // 解不开时仍然报 configured=true：磁盘上确实有东西，界面要能提示用户
  // 「这把密钥在本机解不开，请重新填写」，而不是显示成「没配过」。
  return { configured: true, last4: plain ? plain.slice(-4) : "" };
}

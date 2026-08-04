/**
 * 配对流程（REM-101）—— 不 import electron。
 *
 * ## challenge：短时、单次
 *
 * 生成配对时造一个随机 secret，**只存它的 hash**（device-registry.hashSecret）。
 * secret 经 QR / 短码交给设备，设备回 `/pair` 时带上；主进程 hash 后 consume，
 * consume 在一条 `UPDATE ... WHERE used=0` 上原子置位——用一次即失效，且过期
 * （默认 3 分钟）自动作废。即便旁人瞥见短码，也只能配一台设备且很快失效。
 *
 * ## token：配对成功那一刻才存在，且只发一次
 *
 * consume 成功后铸一个高熵 token（32 字节随机），**只把它的 hash 落库**，token
 * 原文作为返回值一次性交给设备。之后主进程再也拿不回它。新配对的设备只拿到
 * **安全 scope**（`REMOTE_SAFE_SCOPES`）——危险 scope 必须 owner 事后在主机上
 * 逐个授予，配对本身给不了。
 *
 * 轮换（rotate）复用同一条链路：challenge 带 `rotateDeviceId`，consume 时不建新
 * 设备，而是替换该设备的 token hash（旧 token 立即失效，scopes 原样保留）。
 */
import {
  REMOTE_SAFE_SCOPES,
  type RemoteScope,
} from "@pibuddy/contract";

import {
  hashSecret,
  newSecret,
  type RemoteRegistry,
} from "./device-registry.js";

/** 配对 challenge 有效期（ms）。短是刻意的：配对是一次现场动作，不该长期挂着。 */
export const PAIRING_TTL_MS = 3 * 60 * 1000;

export interface CreatedPairing {
  /** 承载 secret 的配对地址（QR / 打开） */
  url: string;
  /** secret 的可读短码形态（手动输入） */
  code: string;
  expiresAt: number;
}

/**
 * 生成一次配对。`baseUrl` 由服务器按当前监听地址给出（如 http://127.0.0.1:8787）。
 * `rotateDeviceId` 非空时是「轮换某台设备的凭证」。
 */
export function createPairing(
  registry: RemoteRegistry,
  baseUrl: string,
  now: number,
  rotateDeviceId: string | null = null
): CreatedPairing {
  const secret = newSecret(18);
  const challengeHash = hashSecret(registry.pepper(), secret);
  const expiresAt = now + PAIRING_TTL_MS;
  registry.createChallenge(challengeHash, expiresAt, now, rotateDeviceId);
  registry.audit("pairing_created", rotateDeviceId ? `rotate ${rotateDeviceId}` : "new device", now);
  const url = `${baseUrl}/pair.html?c=${encodeURIComponent(secret)}`;
  return { url, code: secret, expiresAt };
}

export interface PairedResult {
  deviceId: string;
  /** 长期 token 原文——**唯一一次**出现，之后主进程只有它的 hash */
  token: string;
  scopes: RemoteScope[];
  /** 是否是轮换（而非新配对） */
  rotated: boolean;
}

/**
 * 消费一个配对 secret，铸出设备 token。secret 非法 / 已用 / 过期一律返回 null
 * （由调用方回 401，不泄露是哪一种）。
 */
export function consumePairing(
  registry: RemoteRegistry,
  secret: string,
  deviceName: string,
  now: number
): PairedResult | null {
  const challengeHash = hashSecret(registry.pepper(), secret);
  const challenge = registry.consumeChallenge(challengeHash, now);
  if (!challenge) {
    registry.audit("pairing_rejected", "invalid/expired/used challenge", now);
    return null;
  }

  const token = newSecret(32);
  const tokenHash = hashSecret(registry.pepper(), token);
  const name = deviceName.slice(0, 64) || "未命名设备";

  if (challenge.rotateDeviceId) {
    const existing = registry.deviceById(challenge.rotateDeviceId);
    if (!existing) {
      registry.audit("pairing_rejected", "rotate target gone", now);
      return null;
    }
    registry.setDeviceToken(existing.id, tokenHash);
    registry.audit("device_rotated", existing.id, now);
    return { deviceId: existing.id, token, scopes: existing.scopes, rotated: true };
  }

  const scopes: RemoteScope[] = [...REMOTE_SAFE_SCOPES];
  const deviceId = registry.createDevice(name, tokenHash, scopes, now);
  registry.audit("device_paired", deviceId, now);
  return { deviceId, token, scopes, rotated: false };
}

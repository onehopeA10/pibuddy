import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC-004：凭据保管。
 *
 * 两条路径，两条都断言**磁盘上不含明文**：
 *   (a) safeStorage 不可用 → saveSecret 抛错，且落盘文件里没有明文
 *       （fail closed 的判据不是「报了错」，而是「报了错之后磁盘上什么都没多」）
 *   (b) safeStorage 可用   → 存进去能取回来，但落盘的是密文
 */

/**
 * 可开关的假 safeStorage。
 *
 * 真实实现走 OS 密钥环，单测里跑不了；这里用一个固定密钥的 XOR 顶替 ——
 * 它对本测试要证明的事情是充分的：被验证的不是「加密算法多强」，而是
 * **落盘的字节来自 safeStorage 的输出，而不是明文本身**。
 */
let available = true;
const XOR_KEY = 0x5a;

function xorBuf(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! ^ XOR_KEY;
  return out;
}

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => xorBuf(Buffer.from(plain, "utf8")),
    decryptString: (buf: Buffer) => xorBuf(buf).toString("utf8"),
  },
}));

import {
  SECRET_KEYS,
  SECRET_STORE_UNAVAILABLE,
  __setSecretDataDir,
  describeSecret,
  loadSecret,
  saveSecret,
} from "../src/main/secret-store.js";

const PLAINTEXT = "sk-live-XYZ";

let dir = "";
const secretsFile = (): string => path.join(dir, "secrets.json");

/** 磁盘上的全部字节（文件不存在时返回空串）。 */
function onDisk(): string {
  try {
    return fs.readFileSync(secretsFile(), "utf8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  available = true;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-secret-"));
  __setSecretDataDir(dir);
});

afterEach(() => {
  __setSecretDataDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("secret-store", () => {
  it("safeStorage 不可用时拒绝保存，且磁盘上不含明文", () => {
    available = false;

    expect(() => saveSecret(SECRET_KEYS.sttApiKey, PLAINTEXT)).toThrow(
      SECRET_STORE_UNAVAILABLE
    );
    expect(onDisk()).not.toContain(PLAINTEXT);
    expect(describeSecret(SECRET_KEYS.sttApiKey).configured).toBe(false);
  });

  it("safeStorage 可用时存得进取得回，且磁盘上仍不含明文", () => {
    const described = saveSecret(SECRET_KEYS.sttApiKey, PLAINTEXT);

    expect(loadSecret(SECRET_KEYS.sttApiKey)).toBe(PLAINTEXT);
    expect(onDisk()).not.toContain(PLAINTEXT);
    expect(onDisk().length).toBeGreaterThan(0);
    expect(described).toEqual({ configured: true, last4: "-XYZ" });
    expect(describeSecret(SECRET_KEYS.sttApiKey)).toEqual({
      configured: true,
      last4: "-XYZ",
    });
  });

  it("传空串等于清除该槽位", () => {
    saveSecret(SECRET_KEYS.sttApiKey, PLAINTEXT);
    expect(saveSecret(SECRET_KEYS.sttApiKey, "")).toEqual({
      configured: false,
      last4: "",
    });
    expect(loadSecret(SECRET_KEYS.sttApiKey)).toBeNull();
  });
});

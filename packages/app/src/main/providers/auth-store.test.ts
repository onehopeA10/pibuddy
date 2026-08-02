/**
 * `~/.pi/agent/auth.json` 的合并式读写（PROV-101）。
 *
 * 这个文件同时属于用户终端里的 pi，写坏它是**不可逆事故**。因此这里断言的
 * 全是「不能出事」而不是「功能可用」：
 *
 *   1. 写入一条 api_key 之后，原文件里已有的其它条目（含一条 OAuth 形状的）
 *      **逐字段 deep-equal 保留**；
 *   2. 写前的备份文件存在，且其字节 sha256 与写入前的原文件一致；
 *   3. 本文件不走 writeFileSync —— 原子写归 fs-atomic.ts 唯一实现；
 *   4. Windows 上 0600 无效时如实返回 permissionEnforced:false，不抛异常。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderAuthKind } from "@pibuddy/contract";

vi.mock("electron", () => ({ app: { getPath: () => userDataDir } }));

let tmpRoot = "";
let homeDir = "";
let userDataDir = "";

type Store = typeof import("./auth-store.js");

async function freshStore(): Promise<Store> {
  vi.resetModules();
  const mod = await import("./auth-store.js");
  mod.__setAuthStoreDirs({ home: homeDir, userData: userDataDir });
  // 真实 logger 会往 tmp 里建目录并落盘；单测一律注入哑实现
  mod.__setProviderLogger({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    filePath: () => "",
    logFiles: () => [],
  } as never);
  return mod;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 写一份「已经有东西」的 auth.json，含一条 OAuth 形状的条目。 */
function seedAuthFile(store: Store): Record<string, unknown> {
  const existing = {
    // 用户在终端里 /login 存下的订阅账号。PiBuddy 既产生不了也恢复不了它。
    "anthropic-oauth": {
      type: "oauth",
      access: "acc-token-abc",
      refresh: "ref-token-xyz",
      expires: 1893456000000,
      scopes: ["user:inference", "user:profile"],
    },
    openai: { type: "api_key", key: "sk-existing-openai-0000" },
    "cloudflare-ai-gateway": {
      type: "api_key",
      key: "$CLOUDFLARE_API_KEY",
      env: { CLOUDFLARE_API_KEY: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct-1" },
    },
  };
  const file = store.authFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  return existing;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pibuddy-auth-"));
  homeDir = path.join(tmpRoot, "home");
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("合并写入：绝不抹掉已有条目", () => {
  it("写 anthropic 的 api_key 后，其余条目（含 OAuth）逐字段 deep-equal 保留", async () => {
    const store = await freshStore();
    const existing = seedAuthFile(store);

    store.writeCredential("anthropic", { type: "api_key", key: "sk-ant-newkey-1234" });

    const after = store.readAuthFile();
    // OAuth 条目：一个字段都不许变
    expect(after["anthropic-oauth"]).toEqual(existing["anthropic-oauth"]);
    expect(after.openai).toEqual(existing.openai);
    expect(after["cloudflare-ai-gateway"]).toEqual(existing["cloudflare-ai-gateway"]);
    // 新写的那一条
    expect(after.anthropic).toEqual({ type: "api_key", key: "sk-ant-newkey-1234" });
    // 条目总数 = 原有 3 条 + 新增 1 条
    expect(Object.keys(after).sort()).toEqual([
      "anthropic",
      "anthropic-oauth",
      "cloudflare-ai-gateway",
      "openai",
    ]);
  });

  it("覆盖已有 api_key 时保留该条目上手写的 env", async () => {
    const store = await freshStore();
    seedAuthFile(store);
    store.writeCredential("cloudflare-ai-gateway", { type: "api_key", key: "new-cf-key" });
    const entry = store.readAuthFile()["cloudflare-ai-gateway"];
    expect(entry.key).toBe("new-cf-key");
    // 用户手写的 env 块不该因为改了个 key 就消失
    expect(entry.env).toEqual({ CLOUDFLARE_API_KEY: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct-1" });
  });

  it("key 为空串 = 删除该条目，其余不动", async () => {
    const store = await freshStore();
    seedAuthFile(store);
    store.writeCredential("openai", { type: "api_key", key: "" });
    const after = store.readAuthFile();
    expect(after.openai).toBeUndefined();
    expect(after["anthropic-oauth"]).toBeDefined();
  });

  it("原文件不存在时也能写（第一次配置）", async () => {
    const store = await freshStore();
    const result = store.writeCredential("openai", { type: "api_key", key: "sk-first" });
    expect(store.readAuthFile().openai).toEqual({ type: "api_key", key: "sk-first" });
    expect(result.backupPath).toBeNull();
  });

  it("文件被改坏时 readAuthFile 返回 {} 而不是抛", async () => {
    const store = await freshStore();
    const file = store.authFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ 这不是 JSON");
    expect(store.readAuthFile()).toEqual({});
  });
});

describe("写前备份可验证", () => {
  it("备份文件存在，且字节 sha256 与写入前的原文件相同", async () => {
    const store = await freshStore();
    seedAuthFile(store);
    const before = sha256(store.authFilePath());

    const result = store.writeCredential(
      "anthropic",
      { type: "api_key", key: "sk-ant-x" },
      1730000000000
    );

    expect(result.backupPath).toBe(
      path.join(store.backupDir(), "auth.1730000000000.json")
    );
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(sha256(result.backupPath!)).toBe(before);
    // 主文件确实变了（否则「备份和主文件一样」这条断言是平凡成立的）
    expect(sha256(store.authFilePath())).not.toBe(before);
  });
});

describe("权限：Windows 上如实降级", () => {
  it("writeCredential 不抛，且 permissionEnforced 随平台如实取值", async () => {
    const store = await freshStore();
    const result = store.writeCredential("openai", { type: "api_key", key: "sk-x" });
    expect(result.permissionEnforced).toBe(process.platform !== "win32");
    if (process.platform === "win32") {
      // Windows：chmod 对 NTFS ACL 无效，必须如实报 false 而不是假装加固
      expect(result.permissionEnforced).toBe(false);
    } else {
      const mode = fs.statSync(store.authFilePath()).mode & 0o777;
      expect(mode).toBe(store.AUTH_FILE_MODE);
    }
  });

  it("canEnforcePermissions 与平台一致", async () => {
    const store = await freshStore();
    expect(store.canEnforcePermissions()).toBe(process.platform !== "win32");
  });
});

describe("key 一律钉成字面量", () => {
  it("`!` 开头被转义成 `$!`，不会变成「pi 每次启动都执行它」", async () => {
    const store = await freshStore();
    store.writeCredential("openai", { type: "api_key", key: "!rm -rf /tmp/x" });
    expect(store.readAuthFile().openai.key).toBe("$!rm -rf /tmp/x");
  });

  it("`$` 开头被转义成 `$$`，不会被当成环境变量插值", async () => {
    const store = await freshStore();
    store.writeCredential("openai", { type: "api_key", key: "$HOME" });
    expect(store.readAuthFile().openai.key).toBe("$$HOME");
  });

  it("普通密钥原样写入", async () => {
    const store = await freshStore();
    store.writeCredential("openai", { type: "api_key", key: "  sk-plain-1234  " });
    expect(store.readAuthFile().openai.key).toBe("sk-plain-1234");
  });
});

describe("形态与尾四位判定", () => {
  it("api_key / oauth / 缺席 三态", async () => {
    const store = await freshStore();
    const cases: [unknown, ProviderAuthKind][] = [
      [{ type: "api_key", key: "sk-1" }, "api_key"],
      [{ type: "oauth", access: "a" }, "oauth"],
      [undefined, "none"],
    ];
    for (const [cred, expected] of cases) {
      expect(store.authKindOf(cred as never)).toBe(expected);
    }
  });

  it("$ENV / !command 形态不显示尾四位（那四个字符对用户毫无意义）", async () => {
    const store = await freshStore();
    expect(store.last4Of({ type: "api_key", key: "sk-abcd1234" })).toBe("1234");
    expect(store.last4Of({ type: "api_key", key: "$MY_KEY" })).toBe("");
    expect(store.last4Of({ type: "api_key", key: "!op read x" })).toBe("");
    expect(store.last4Of(undefined)).toBe("");
  });
});

describe("结构性约束", () => {
  it("源码里没有 writeFileSync —— 原子写归 fs-atomic.ts 唯一实现", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "auth-store.ts"),
      "utf8"
    );
    expect(source.includes("writeFileSync(")).toBe(false);
    expect(source.includes("writeJsonAtomic(")).toBe(true);
    // 路径写死，不接受任何外部输入
    expect(source.includes('".pi", "agent", "auth.json"')).toBe(true);
  });
});

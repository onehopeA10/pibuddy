import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENV_ALLOWLIST,
  PI_RUNTIME_RESOLVE_FAILED,
  assertRuntimeHandshake,
  buildChildEnv,
  buildPiSpawn,
} from "../src/main/pi-launcher.js";

/** 记录 logger 收到的每条记录，供断言 level / code。 */
function fakeLogger(): {
  records: { level: string; event: string; fields?: Record<string, unknown> }[];
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
} {
  const records: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  return {
    records,
    info: (event, fields) => records.push({ level: "info", event, fields }),
    warn: (event, fields) => records.push({ level: "warn", event, fields }),
    error: (event, fields) => records.push({ level: "error", event, fields }),
  };
}

const POLLUTION = {
  NODE_OPTIONS: "--inspect",
  ELECTRON_RUN_AS_NODE: "0",
  NODE_INSPECT_RESUME_ON_START: "1",
  LD_PRELOAD: "/tmp/x.so",
  DYLD_INSERT_LIBRARIES: "/tmp/y.dylib",
} as const;

const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

function pollute(): void {
  for (const [k, v] of Object.entries(POLLUTION)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
}

describe("子进程环境变量白名单", () => {
  it("注入类变量被剔除，ELECTRON_RUN_AS_NODE 被显式置 1", () => {
    pollute();
    const spawn = buildPiSpawn();

    expect(spawn.env).toBeDefined();
    const env = spawn.env!;
    for (const key of [
      "NODE_OPTIONS",
      "NODE_INSPECT_RESUME_ON_START",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
      expect(env[key]).toBeUndefined();
    }
    // 父进程里的 "0" 不得被继承
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    // 全 argv、绝不走 shell
    expect(spawn.shell).toBe(false);
  });

  it("buildChildEnv 只保留白名单键", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      NODE_OPTIONS: "--inspect",
      SOME_SECRET_TOKEN: "leak",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SOME_SECRET_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(
      Object.keys(env).every(
        (k) => k === "ELECTRON_RUN_AS_NODE" || (ENV_ALLOWLIST as readonly string[]).includes(k)
      )
    ).toBe(true);
  });

  it("模型厂商密钥与 PI_ 配置按模式放行（否则环境变量登录会被这层白名单打断）", () => {
    const env = buildChildEnv({
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      PI_OFFLINE: "1",
      NODE_OPTIONS: "--inspect",
      LD_PRELOAD: "/tmp/x.so",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
    expect(env.PI_OFFLINE).toBe("1");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
  });
});

describe("运行时定位失败", () => {
  it("解析失败时抛出带错误码的错误，并记一条 error 日志", () => {
    const logger = fakeLogger();
    expect(() =>
      buildPiSpawn({
        logger,
        resolveDevEntry: () => {
          throw new Error("注入的解析失败：ERR_PACKAGE_PATH_NOT_EXPORTED");
        },
      })
    ).toThrow();

    let message = "";
    try {
      buildPiSpawn({
        logger,
        resolveDevEntry: () => {
          throw new Error("注入的解析失败：ERR_PACKAGE_PATH_NOT_EXPORTED");
        },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(message).toContain(PI_RUNTIME_RESOLVE_FAILED);

    const errorRecords = logger.records.filter(
      (r) => r.level === "error" && r.fields?.code === PI_RUNTIME_RESOLVE_FAILED
    );
    expect(errorRecords.length).toBeGreaterThanOrEqual(1);
  });

  it("external 模式指向不存在的命令时报 ENOENT 并带上命令名", () => {
    let message = "";
    try {
      buildPiSpawn({
        settings: { piRuntimeMode: "external", piExternalCommand: "pi-does-not-exist-xyz" },
        env: { PATH: "/nonexistent-dir" },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("ENOENT");
    expect(message).toContain("pi-does-not-exist-xyz");
  });

  it("打包形态下清单缺失时抛出提到 runtime-manifest.json 的错误，而不是回退全局 pi", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-res-"));
    expect(() =>
      buildPiSpawn({ packaged: true, resourcesPath: tmp })
    ).toThrow(/runtime-manifest\.json/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("assertRuntimeHandshake", () => {
  it("版本不一致时抛出同时含两侧取值的错误", () => {
    let message = "";
    try {
      assertRuntimeHandshake(
        { runtimeVersion: "0.83.0", protocolVersion: 1 },
        { version: "0.99.0", protocolVersion: 1 }
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("0.83.0");
    expect(message).toContain("0.99.0");
  });

  it("版本与协议一致时不抛错", () => {
    expect(() =>
      assertRuntimeHandshake(
        { runtimeVersion: "0.83.0", protocolVersion: 1 },
        { version: "0.83.0", protocolVersion: 1 }
      )
    ).not.toThrow();
  });
});

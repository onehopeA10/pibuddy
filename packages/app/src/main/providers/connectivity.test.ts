/**
 * Provider 连通性探测（PROV-101）。
 *
 * 三组断言，每一组对应一类会静默出事的路径：
 *
 *   1. **脱敏** —— 上游 401 的正文里常常原样回显你发过去的 Authorization。
 *      返回给渲染进程的 redactedMessage 里不得含密钥子串。
 *   2. **key 不进日志** —— 只脱敏返回值是不够的：密钥仍会经 logger 落盘，
 *      而那是一条不报错的泄漏。这里 spy 住 logger 的**全部调用参数**。
 *   3. **SSRF** —— testProvider / discoverModels 是本任务新增的两条出站路径，
 *      必须和语音转写走同一个 safeFetch。169.254.169.254 / file:// / 10.x
 *      三个拒绝用例的错误码都是 OUTBOUND_BLOCKED。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderTestResult } from "@pibuddy/contract";

vi.mock("electron", () => ({ app: { getPath: () => userDataDir } }));

/** 测试用的密钥字面量。它**一个字节都不许**出现在返回值或日志里。 */
const SECRET = "sk-ant-0123456789";

let tmpRoot = "";
let homeDir = "";
let userDataDir = "";

let logCalls: unknown[][] = [];

type AuthStore = typeof import("./auth-store.js");
type Connectivity = typeof import("./connectivity.js");
type Guard = typeof import("../net/outbound-guard.js");
type ModelsStore = typeof import("./models-store.js");

interface Modules {
  auth: AuthStore;
  conn: Connectivity;
  guard: Guard;
  models: ModelsStore;
}

function spyLogger(): unknown {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logCalls.push([level, ...args]);
    };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => spyLogger(),
    filePath: () => "",
    logFiles: () => [],
  };
}

async function freshModules(): Promise<Modules> {
  vi.resetModules();
  logCalls = [];
  const auth = await import("./auth-store.js");
  auth.__setAuthStoreDirs({ home: homeDir, userData: userDataDir });
  auth.__setProviderLogger(spyLogger() as never);
  const models = await import("./models-store.js");
  models.__setModelsStoreHome(homeDir);
  const guard = await import("../net/outbound-guard.js");
  const conn = await import("./connectivity.js");
  return { auth, conn, guard, models };
}

/** 直接落一份 auth.json，避开 writeCredential 的转义逻辑。 */
function seedKey(auth: AuthStore, providerId: string, key: string): void {
  const file = auth.authFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [providerId]: { type: "api_key", key } }));
}

/** 造一个 fetch 替身，返回指定状态码与正文。 */
function fakeFetch(status: number, body: string, contentType = "application/json") {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": contentType }),
    body: null,
    text: async () => body,
  })) as never;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pibuddy-conn-"));
  homeDir = path.join(tmpRoot, "home");
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterEach(async () => {
  const guard = await import("../net/outbound-guard.js");
  guard.__setOutboundDeps({ lookup: null, fetch: null });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("返回体脱敏", () => {
  it("底层错误消息含密钥时，redactedMessage 不含该子串", async () => {
    const { auth, conn, guard } = await freshModules();
    seedKey(auth, "openai", SECRET);
    guard.__setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.7", family: 4 }],
      // 上游 401 把请求头原样回显了 —— 这是真实会发生的事
      fetch: fakeFetch(401, JSON.stringify({ error: `invalid key: ${SECRET}` })),
    });

    const result = await conn.testProvider("openai");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("auth");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // 状态码必须留下来：401 和 404 是两件完全不同的事
    expect(result.redactedMessage).toContain("401");
  });

  it("抛出的错误消息含密钥时同样脱敏", async () => {
    const { auth, conn, guard } = await freshModules();
    seedKey(auth, "openai", SECRET);
    guard.__setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.7", family: 4 }],
      fetch: vi.fn(async () => {
        throw new Error(`connect failed with Authorization Bearer ${SECRET}`);
      }) as never,
    });
    const result = await conn.testProvider("openai");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("key 不进日志", () => {
  it("失败路径跑完后，logger 捕获到的全部调用参数里不含密钥子串", async () => {
    const { auth, conn, guard } = await freshModules();
    seedKey(auth, "openai", SECRET);
    guard.__setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.7", family: 4 }],
      fetch: fakeFetch(401, JSON.stringify({ error: `bad key ${SECRET}` })),
    });

    await conn.testProvider("openai");

    // 确实记了日志（否则这条断言是平凡成立的）
    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toContain(SECRET);
  });
});

describe("SSRF：新增的两条出站路径同样被拦", () => {
  const CASES: { name: string; baseUrl: string }[] = [
    { name: "云元数据 169.254.169.254", baseUrl: "https://169.254.169.254/v1" },
    { name: "file:// 协议", baseUrl: "file:///etc/passwd" },
    { name: "内网 10.x", baseUrl: "https://10.1.2.3/v1" },
  ];

  for (const testCase of CASES) {
    it(`registerEndpoint 拒绝 ${testCase.name}，错误码 OUTBOUND_BLOCKED`, async () => {
      const { models } = await freshModules();
      await expect(
        models.upsertCustomProvider({
          id: "evil",
          name: "evil",
          baseUrl: testCase.baseUrl,
          models: [],
        })
      ).rejects.toThrow(/OUTBOUND_BLOCKED/);
      // 被拒的地址一个字节都不落盘
      expect(models.listCustomProviders().evil).toBeUndefined();
    });
  }

  it("safeFetch 在 discoverModels 路径上对内网地址抛 OUTBOUND_BLOCKED", async () => {
    const { models, guard } = await freshModules();
    // 先合法登记一个公网端点
    guard.__setOutboundDeps({ lookup: async () => [{ address: "203.0.113.7", family: 4 }] });
    await models.upsertCustomProvider({
      id: "local",
      name: "local",
      baseUrl: "https://models.example.com/v1",
      models: [],
    });
    // 再让 DNS 把它解析到内网 —— 这就是 DNS rebinding 的第一跳
    guard.__setOutboundDeps({ lookup: async () => [{ address: "10.0.0.5", family: 4 }] });
    await expect(models.discoverModels("local")).rejects.toThrow(/OUTBOUND_BLOCKED/);
  });
});

describe("错误分类", () => {
  it("401/403 → auth，404 → model，5xx → network，其余 unknown", async () => {
    const { conn } = await freshModules();
    const table: [number, ProviderTestResult["errorCode"]][] = [
      [401, "auth"],
      [403, "auth"],
      [404, "model"],
      [500, "network"],
      [418, "unknown"],
    ];
    for (const [status, expected] of table) {
      expect(conn.classifyStatus(status)).toBe(expected);
    }
  });

  it("网络类错误（ENOTFOUND / 超时 / 被守卫拦）归到 network", async () => {
    const { conn, guard } = await freshModules();
    expect(conn.classifyError(new guard.OutboundBlockedError("x"))).toBe("network");
    expect(conn.classifyError(new guard.OutboundDnsError("h"))).toBe("network");
    expect(conn.classifyError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe(
      "network"
    );
    expect(conn.classifyError(new Error("OUTBOUND_TIMEOUT: 请求超时"))).toBe("network");
    expect(conn.classifyError(new Error("什么都不像"))).toBe("unknown");
  });
});

describe("永不抛：失败也是「测试」的正常结果", () => {
  it("没配 key 时返回 auth 而不是抛", async () => {
    const { conn } = await freshModules();
    const result = await conn.testProvider("openai");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("auth");
    expect(result.redactedMessage).toContain("API Key");
  });

  it("OAuth 条目如实说明「需要在终端管理」，不假装测过", async () => {
    const { auth, conn } = await freshModules();
    const file = auth.authFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ anthropic: { type: "oauth", access: "a" } }));
    const result = await conn.testProvider("anthropic");
    expect(result.ok).toBe(false);
    expect(result.redactedMessage).toContain("终端");
  });

  it("成功路径返回 ok 与耗时", async () => {
    const { auth, conn, guard } = await freshModules();
    seedKey(auth, "openai", SECRET);
    guard.__setOutboundDeps({
      lookup: async () => [{ address: "203.0.113.7", family: 4 }],
      fetch: fakeFetch(200, JSON.stringify({ data: [{ id: "some-model" }] })),
    });
    const result = await conn.testProvider("openai");
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("脱敏函数复用而非各写一份", () => {
  it("connectivity.ts 从 logger-redact 导入 redactSecrets", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "connectivity.ts"),
      "utf8"
    );
    expect(/from\s+"[^"]*logger-redact/.test(source)).toBe(true);
    // 本文件里不许有第二份实现
    expect(/export\s+(function|const)\s+redactSecrets/.test(source)).toBe(false);
  });
});

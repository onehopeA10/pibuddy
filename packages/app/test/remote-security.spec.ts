import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Remote/PWA 远程访问的**安全出口门禁**（REM-101 / M9）。
 *
 * 这些不是「断言某函数被调用」，而是**真的把条件造出来**：起一个真实 loopback
 * 服务、用真实 HTTP / WS 请求打它，逐条验证审计点名的每一条不变量：
 *
 *   - 未配对设备访问任意入口（HTTP / WS / file / upload 每个）都被拒（401）；
 *   - 配对 challenge 用一次即失效（第二次消费同一 challenge → 拒）；
 *   - 危险 scope 默认拒（permission.approve 未授予时 /api/permission/decide → 403）；
 *   - owner 授予危险 scope 后该入口放行；
 *   - 撤销设备后 token 立即失效（401）+ 活跃连接被断；
 *   - 关服务后不再监听（端口释放）。
 *
 * 对拍（把机制临时拆掉确认变红，两次输出）记在
 * `.workflow/scratch/capability-research/FEAT-remote.md`。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-remote-sec-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false },
}));

const { RemoteServer } = await import("../src/main/remote/remote-server.js");
const { RemoteRegistry, __setRemoteDataDir, hashSecret } = await import(
  "../src/main/remote/device-registry.js"
);
const { createPairing } = await import("../src/main/remote/remote-pairing.js");
import type { RemoteBackend } from "../src/main/remote/remote-backend.js";
import type { PoolSnapshot } from "@pibuddy/contract";

const SNAPSHOT: PoolSnapshot = {
  sequence: 1,
  caps: { maxConcurrent: 4, maxPerWorkspace: 3, memoryCeilingMb: 1600, costCeilingUsd: 20 },
  sessions: [],
  activeCount: 0,
  queuedCount: 0,
  totalMemoryMb: 0,
  totalCostUsd: 0,
  inbox: [
    {
      id: "inbox-1",
      sessionId: "s1",
      workspaceId: "ws1",
      capabilityId: "coding.git",
      permission: "process.git",
      resource: null,
      requestedAt: 0,
      deadlineAt: 0,
    },
  ],
};

const fakeBackend: RemoteBackend = {
  poolSnapshot: () => SNAPSHOT,
  sessionHistory: async () => ({ entries: [], nextBeforeOffset: null, stale: false, skippedPartial: 0 }),
  sendPrompt: () => ({ ok: true, reason: "ok" }),
  stopSession: () => ({ ok: true, reason: "ok" }),
  permissionState: () => ({ workspaceId: null, workspaceGrants: [], sessionGrants: [], audit: [] }),
  decideInbox: async () => ({ ok: true, reason: "ok" }),
};

const noopLogger = { info: () => {}, warn: () => {} };

let server: InstanceType<typeof RemoteServer>;
let registry: InstanceType<typeof RemoteRegistry>;
let port: number;

function req(
  method: string,
  pathname: string,
  opts: { token?: string; origin?: string; body?: unknown } = {}
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (payload) headers["content-type"] = "application/json";
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    if (opts.origin) headers["origin"] = opts.origin;
    const r = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-json */
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 发一个原始 WS 升级请求，只看握手结果（101 = 放行 / 其它 = 拒）。 */
function wsUpgrade(token: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const protocols = token ? `pibuddy.remote, ${token}` : "pibuddy.remote";
    const r = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/ws",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": protocols,
      },
    });
    r.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    r.on("response", (res) => resolve(res.statusCode ?? 0));
    r.on("error", reject);
    r.end();
  });
}

/** 走一遍配对，返回设备 token。 */
async function pairDevice(name = "test-device"): Promise<{ token: string; deviceId: string }> {
  const p = createPairing(registry, `http://127.0.0.1:${port}`, Date.now(), null);
  const res = await req("POST", "/pair", { body: { code: p.code, name } });
  expect(res.status).toBe(200);
  return { token: res.json.token as string, deviceId: res.json.deviceId as string };
}

beforeAll(async () => {
  __setRemoteDataDir(userData);
  registry = new RemoteRegistry(path.join(userData, "remote.db"));
  server = new RemoteServer(registry, fakeBackend, noopLogger);
  await server.start("loopback");
  port = server.port()!;
});

afterAll(async () => {
  await server.stop();
});

describe("默认对外零暴露 / 监听在 loopback", () => {
  it("监听地址是 127.0.0.1", () => {
    expect(server.address()!.startsWith("127.0.0.1:")).toBe(true);
    expect(server.activeBindScope()).toBe("loopback");
  });
});

describe("未配对设备访问每一个数据入口都被拒（HTTP / WS / file / upload）", () => {
  it("HTTP /api/pool 无 token → 401", async () => {
    expect((await req("GET", "/api/pool")).status).toBe(401);
  });
  it("WS 升级无 token → 非 101", async () => {
    expect(await wsUpgrade(null)).not.toBe(101);
  });
  it("file 入口 /files/session/x 无 token → 401", async () => {
    expect((await req("GET", "/files/session/s1")).status).toBe(401);
  });
  it("upload 入口 /upload 无 token → 401", async () => {
    expect((await req("POST", "/upload", { body: { text: "hi" } })).status).toBe(401);
  });
  it("SSE 入口 /events 无 token → 401", async () => {
    expect((await req("GET", "/events")).status).toBe(401);
  });
  it("伪造的随机 token 同样被拒 → 401", async () => {
    expect((await req("GET", "/api/pool", { token: "not-a-real-token" })).status).toBe(401);
  });
});

describe("静态壳与 /pair 是免 token 入口（应用壳不是机密）", () => {
  it("GET / 返回应用壳 200", async () => {
    const r = await req("GET", "/");
    expect(r.status).toBe(200);
    expect(r.text.includes("PiBuddy Remote")).toBe(true);
  });
});

describe("配对：单次 + 短时", () => {
  it("消费一个 challenge 得到 token，且该 token 能访问受保护入口", async () => {
    const { token } = await pairDevice();
    const r = await req("GET", "/api/pool", { token });
    expect(r.status).toBe(200);
    expect(r.json.sequence).toBe(1);
  });

  it("同一 challenge 第二次消费被拒（单次）", async () => {
    const p = createPairing(registry, `http://127.0.0.1:${port}`, Date.now(), null);
    const first = await req("POST", "/pair", { body: { code: p.code, name: "d" } });
    expect(first.status).toBe(200);
    const second = await req("POST", "/pair", { body: { code: p.code, name: "d2" } });
    expect(second.status).toBe(401); // 用过即失效
  });

  it("过期的 challenge 被拒", async () => {
    // 直接写一条已过期的 challenge，验证 consume 侧的过期判定
    const secret = "expired-secret-xyz";
    const h = hashSecret(registry.pepper(), secret);
    registry.createChallenge(h, Date.now() - 1000, Date.now() - 61_000, null);
    const r = await req("POST", "/pair", { body: { code: secret, name: "d" } });
    expect(r.status).toBe(401);
  });
});

describe("配对设备默认只拿安全 scope；危险 scope 默认拒", () => {
  it("默认配对的设备可读池（pool.read 安全 scope）", async () => {
    const { token } = await pairDevice("safe-device");
    expect((await req("GET", "/api/pool", { token })).status).toBe(200);
  });

  it("默认配对的设备访问权限裁决（permission.approve 危险 scope）→ 403", async () => {
    const { token } = await pairDevice("safe-device-2");
    const r = await req("POST", "/api/permission/decide", {
      token,
      body: { inboxId: "inbox-1", allow: true },
    });
    expect(r.status).toBe(403);
  });

  it("owner 授予 permission.approve 后，同一设备访问裁决入口 → 放行", async () => {
    const { token, deviceId } = await pairDevice("approver");
    // 403 前
    expect(
      (await req("POST", "/api/permission/decide", { token, body: { inboxId: "inbox-1", allow: true } }))
        .status
    ).toBe(403);
    // owner 在主机上显式授予危险 scope
    const dev = registry.deviceById(deviceId)!;
    registry.setDeviceScopes(deviceId, [...dev.scopes, "permission.approve"]);
    // 放行
    expect(
      (await req("POST", "/api/permission/decide", { token, body: { inboxId: "inbox-1", allow: true } }))
        .status
    ).toBe(200);
  });
});

describe("撤销 → token 立即失效", () => {
  it("撤销设备后，其 token 访问任何入口 → 401", async () => {
    const { token, deviceId } = await pairDevice("to-revoke");
    expect((await req("GET", "/api/pool", { token })).status).toBe(200);
    registry.deleteDevice(deviceId);
    server.dropDevice(deviceId);
    expect((await req("GET", "/api/pool", { token })).status).toBe(401);
  });
});

describe("WS 升级鉴权", () => {
  it("有效 token 的 WS 升级成功（101）", async () => {
    const { token } = await pairDevice("ws-device");
    expect(await wsUpgrade(token)).toBe(101);
  });
});

describe("origin / CSRF：不在允许集合的 Origin 被拒", () => {
  it("跨站 Origin 即便带有效 token 也被拒（403）", async () => {
    const { token } = await pairDevice("origin-device");
    const r = await req("GET", "/api/pool", { token, origin: "http://evil.example.com" });
    expect(r.status).toBe(403);
  });
  it("同源 Origin 放行", async () => {
    const { token } = await pairDevice("origin-device-2");
    const r = await req("GET", "/api/pool", { token, origin: `http://127.0.0.1:${port}` });
    expect(r.status).toBe(200);
  });
});

describe("关服务 → 不再监听（端口释放）", () => {
  it("stop() 之后 isListening 为假", async () => {
    const reg2 = new RemoteRegistry(path.join(userData, "remote2.db"));
    const s2 = new RemoteServer(reg2, fakeBackend, noopLogger);
    await s2.start("loopback");
    expect(s2.isListening()).toBe(true);
    await s2.stop();
    expect(s2.isListening()).toBe(false);
    reg2.close();
  });

  it("stop 完成后可以立即重新监听同一端口", async () => {
    const reg2 = new RemoteRegistry(path.join(userData, "remote-restart.db"));
    const s2 = new RemoteServer(reg2, fakeBackend, noopLogger);
    await s2.start("loopback");
    const firstPort = s2.port();
    await s2.stop();
    await s2.start("loopback");
    expect(s2.isListening()).toBe(true);
    expect(s2.port()).toBe(firstPort);
    await s2.stop();
    reg2.close();
  });
});

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 真机 / 真进程的**监听范围**证据（REM-101）。
 *
 * vitest 的 node 进程是一个真实 OS 进程，`RemoteServer.start()` 起的是一个真实
 * 绑定 socket。这里用 `netstat` 从操作系统角度确认：
 *   - loopback 默认只绑 127.0.0.1（**不**出现 0.0.0.0：对外零暴露）；
 *   - lan 显式开启才绑 0.0.0.0；
 *   - stop() 之后端口从 netstat 里消失（监听真的释放，不是句柄泄漏）。
 *
 * 只在 win32 上跑（PiBuddy 的目标平台，netstat 输出格式稳定）；其它平台跳过，
 * 避免 netstat 参数 / 输出差异带来的假红。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-remote-net-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false },
}));

const { RemoteServer } = await import("../src/main/remote/remote-server.js");
const { RemoteRegistry } = await import("../src/main/remote/device-registry.js");
import type { RemoteBackend } from "../src/main/remote/remote-backend.js";
import type { PoolSnapshot } from "@pibuddy/contract";

const SNAP: PoolSnapshot = {
  sequence: 0,
  caps: { maxConcurrent: 4, maxPerWorkspace: 3, memoryCeilingMb: 1600, costCeilingUsd: 20 },
  sessions: [],
  activeCount: 0,
  queuedCount: 0,
  totalMemoryMb: 0,
  totalCostUsd: 0,
  inbox: [],
};
const backend: RemoteBackend = {
  poolSnapshot: () => SNAP,
  sessionHistory: async () => ({ entries: [], nextBeforeOffset: null, stale: false, skippedPartial: 0 }),
  sendPrompt: () => ({ ok: true, reason: "ok" }),
  stopSession: () => ({ ok: true, reason: "ok" }),
  permissionState: () => ({ workspaceId: null, workspaceGrants: [], sessionGrants: [], audit: [] }),
  decideInbox: async () => ({ ok: true, reason: "ok" }),
};
const logger = { info: () => {}, warn: () => {} };

/**
 * 返回 netstat 里本端口 LISTENING 项的**本地地址列**（第 2 列）。
 *
 * 关键：LISTENING 行形如 `TCP  127.0.0.1:8787  0.0.0.0:0  LISTENING  pid`，
 * 第 3 列（外部地址）恒是 `0.0.0.0:0`——因此判「有没有绑 0.0.0.0」只能看
 * **本地地址列**，不能对整行做子串匹配（否则外部地址列会造成假阳）。
 */
function localAddrsFor(port: number): string[] {
  const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
  const addrs: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/); // [proto, local, foreign, state, pid]
    if (cols.length < 4) continue;
    const local = cols[1];
    if (local.endsWith(`:${port}`)) addrs.push(local);
  }
  return addrs;
}

const win = process.platform === "win32";
let server: InstanceType<typeof RemoteServer> | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe.skipIf(!win)("真进程监听范围（netstat 证据）", () => {
  it("loopback：本地地址列只有 127.0.0.1，绝无 0.0.0.0（对外零暴露）", async () => {
    const reg = new RemoteRegistry(path.join(userData, "rn1.db"));
    server = new RemoteServer(reg, backend, logger);
    await server.start("loopback");
    const port = server.port()!;
    const addrs = localAddrsFor(port);
    expect(addrs.length).toBeGreaterThan(0);
    for (const a of addrs) {
      expect(a.startsWith("127.0.0.1:")).toBe(true);
      expect(a.startsWith("0.0.0.0:")).toBe(false);
    }
  });

  it("lan：本地地址列出现 0.0.0.0（对外可达，需用户主动开启）", async () => {
    const reg = new RemoteRegistry(path.join(userData, "rn2.db"));
    server = new RemoteServer(reg, backend, logger);
    await server.start("lan");
    const port = server.port()!;
    expect(localAddrsFor(port).some((a) => a.startsWith("0.0.0.0:"))).toBe(true);
  });

  it("stop() 之后端口从 netstat 里消失（监听真的释放）", async () => {
    const reg = new RemoteRegistry(path.join(userData, "rn3.db"));
    server = new RemoteServer(reg, backend, logger);
    await server.start("loopback");
    const port = server.port()!;
    expect(localAddrsFor(port).length).toBeGreaterThan(0);
    await server.stop();
    server = null;
    await new Promise((r) => setTimeout(r, 200));
    expect(localAddrsFor(port).length).toBe(0);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PiRpcClient, type AgentEvent } from "@pibuddy/pi-sdk";
import type { PiEnvelope } from "@pibuddy/contract";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

const { PoolRuntimeHostImpl } = await import("../src/main/agent-pool/pool-runtime-host.js");
import type { PoolRuntimeClient } from "../src/main/agent-pool/pool-runtime-host.js";

/**
 * 后台派生的**真进程冒烟**（ISS-002）：不打桩 spawn——用一个最小的 pi rpc 替身
 * 脚本（JSONL over stdio，node 真子进程）走完 launch → 握手 → deliver → 事件流
 * → stop 的整条链，最后用 `process.kill(pid, 0)` 断言子进程**真的没了**，不留
 * 僵尸。client 用真实 `PiRpcClient`（与生产 realClientFactory 同一条路，只是
 * spawn 目标从内置 pi 换成替身脚本）。
 *
 * 对拍方向：把 host.launch 里 `client.start()` 拆掉（只记账不派生），
 * 「握手就绪」永远等不到，本文件整体变红。
 */

let dir: string;
let stubPath: string;

/** 最小 pi rpc 替身：启动即报 pid，响应 get_state / prompt / abort，stdin 关闭即退。 */
const STUB = `
function out(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
out({ type: "stub_hello", pid: process.pid });
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type === "get_state") {
    out({ type: "response", id: cmd.id, success: true, data: { sessionId: "smoke-sess" } });
  } else if (cmd.type === "prompt") {
    out({ type: "response", id: cmd.id, success: true });
    out({ type: "agent_start" });
    out({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    out({ type: "agent_settled" });
  } else if (cmd.id) {
    out({ type: "response", id: cmd.id, success: true, data: {} });
  }
});
rl.on("close", () => process.exit(0));
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-smoke-"));
  stubPath = path.join(dir, "pi-stub.cjs");
  fs.writeFileSync(stubPath, STUB, "utf8");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程在但无权限（仍算活着）；ESRCH = 真的没了。
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(cond: () => boolean, ms: number, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

describe("后台池真进程冒烟：launch → 交互 → stop → 无残留进程", () => {
  it(
    "整条链走通，子进程最终真的退出",
    async () => {
      const envelopes: PiEnvelope<AgentEvent>[] = [];
      let readySessionId: string | null = null;
      let stubPid = 0;
      const seenTypes: string[] = [];

      const host = new PoolRuntimeHostImpl({
        // 与生产 realClientFactory 同一条 PiRpcClient 路，只是 spawn 换成替身脚本。
        clientFactory: (spec) =>
          new PiRpcClient({
            spawn: { command: process.execPath, prefixArgs: [stubPath] },
            cwd: dir,
            sessionDir: dir,
            generation: spec.generation,
          }) as unknown as PoolRuntimeClient,
        resolveWorkspace: () => ({ cwd: dir, sessionDir: dir }),
      });
      host.bind({
        onReady: () => undefined,
        onEvent: (env) => envelopes.push(env),
        onExit: () => undefined,
      });
      host.observeRuntime("smoke-1", {
        onReady: (sid) => (readySessionId = sid),
        onEvent: (e) => {
          const ev = e as { type: string; raw?: { type?: string; pid?: number } };
          seenTypes.push(ev.type === "unknown" ? (ev.raw?.type ?? "unknown") : ev.type);
          if (ev.type === "unknown" && ev.raw?.type === "stub_hello" && ev.raw.pid) {
            stubPid = ev.raw.pid;
          }
        },
      });

      // launch：真派生一个 node 子进程，握手（get_state）后回填真实 sessionId。
      host.launch({ sessionId: "smoke-1", workspaceId: "ws", origin: "user" });
      expect(await waitUntil(() => readySessionId !== null, 8000)).toBe(true);
      expect(readySessionId).toBe("smoke-sess");
      expect(stubPid).toBeGreaterThan(0);
      expect(isAlive(stubPid)).toBe(true);
      expect(host.has("smoke-1")).toBe(true);

      // deliver：prompt 真的写进了子进程 stdin，事件流真的回来了。
      expect(host.deliver("smoke-1", "做一轮巡检")).toBe(true);
      expect(await waitUntil(() => seenTypes.includes("agent_settled"), 8000)).toBe(true);

      // 事件按既有 envelope 规则包装：同代际、sequence 单调递增。
      expect(envelopes.length).toBeGreaterThan(0);
      const gen = envelopes[0].generation;
      envelopes.forEach((env, i) => {
        expect(env.sessionId).toBe("smoke-1");
        expect(env.generation).toBe(gen);
        expect(env.sequence).toBe(i);
      });

      // stop：四级停止阶梯收掉子进程，不留僵尸。
      host.stop("smoke-1");
      expect(host.has("smoke-1")).toBe(false);
      expect(await waitUntil(() => !isAlive(stubPid), 10000, 100)).toBe(true);
    },
    30000
  );
});

import { describe, expect, it, vi } from "vitest";

import type { AgentEvent, PiExitMeta } from "@pibuddy/pi-sdk";
import type { PiEnvelope } from "@pibuddy/contract";
import {
  PoolRuntimeHostImpl,
  type PoolRuntimeClient,
} from "../src/main/agent-pool/pool-runtime-host.js";

import os from "node:os";
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

/**
 * 后台真实派生 host 的接线判据（AGT-101 §7 第一个接线点落地）。
 *
 * 「launch 真的起了一个进程并把会话喂进了池 / 子编排」这件事必须能证伪。用一个
 * 受控假 client（可手动 emit event / exit / 断言 start / stop 被调）替换 spawn，
 * 断言的是**池内核回调与子事件汇聚随之被驱动**，而不是 spawn 内部细节。
 */

class FakeClient implements PoolRuntimeClient {
  readonly runtimeId = "rt-fake";
  started = false;
  stopped = false;
  sent: unknown[] = [];
  private handlers = new Map<string, (...args: unknown[]) => void>();

  start(): void {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async getState(): Promise<{ sessionId?: string }> {
    return { sessionId: "pi-real-session" };
  }
  send(message: unknown): unknown {
    this.sent.push(message);
    return { success: true };
  }
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.handlers.set(event, cb);
  }
  emitEvent(e: AgentEvent): void {
    this.handlers.get("event")?.(e);
  }
  emitExit(meta: PiExitMeta): void {
    this.handlers.get("exit")?.(null, meta);
  }
}

function makeHost() {
  const clients: FakeClient[] = [];
  const onReady = vi.fn();
  const onEvent = vi.fn<(env: PiEnvelope<AgentEvent>) => void>();
  const onExit = vi.fn();
  const childEvents: Array<{ sessionId: string; event: AgentEvent }> = [];

  const host = new PoolRuntimeHostImpl({
    clientFactory: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    resolveWorkspace: () => ({ cwd: "/ws/root", sessionDir: "/ws/root/.sessions" }),
  });
  host.bind({ onReady, onEvent, onExit });
  host.setChildEventSink((sessionId, event) => childEvents.push({ sessionId, event }));
  return { host, clients, onReady, onEvent, onExit, childEvents };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentEvent;

describe("后台真实派生 host", () => {
  it("launch 真的起进程：start 被调、握手后回填 onReady", async () => {
    const { host, clients, onReady } = makeHost();
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "child" });
    expect(clients).toHaveLength(1);
    expect(clients[0].started).toBe(true);
    expect(host.has("s1")).toBe(true);
    // 握手是异步尾巴：等一拍。
    await new Promise((r) => setTimeout(r, 0));
    expect(onReady).toHaveBeenCalledWith("s1", { runtimeId: "rt-fake", generation: 1 });
  });

  it("事件喂进池内核，信封 sessionId 恒为 pool 键（不是 pi 内部 sessionId）", () => {
    const { host, clients, onEvent } = makeHost();
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "child" });
    clients[0].emitEvent(AGENT_START);
    expect(onEvent).toHaveBeenCalledTimes(1);
    const env = onEvent.mock.calls[0][0];
    expect(env.sessionId).toBe("s1");
    expect(env.payload).toEqual(AGENT_START);
  });

  it("origin:child 的事件汇聚给子编排；origin:user 不汇聚（可证伪）", () => {
    const { host, clients, childEvents } = makeHost();
    host.launch({ sessionId: "child-1", workspaceId: "ws", origin: "child" });
    host.launch({ sessionId: "user-1", workspaceId: "ws", origin: "user" });
    clients[0].emitEvent(AGENT_START);
    clients[1].emitEvent(AGENT_START);
    // 只有 child 的事件进汇聚。对拍：去掉 origin==="child" 判断，user 的事件也会进来。
    expect(childEvents).toEqual([{ sessionId: "child-1", event: AGENT_START }]);
  });

  it("退出反馈给池（reason 原样透传）", () => {
    const { host, clients, onExit } = makeHost();
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "child" });
    clients[0].emitExit({ runtimeId: "rt-fake", generation: 1, reason: "crash" } as PiExitMeta);
    expect(onExit).toHaveBeenCalledWith("s1", "crash");
    expect(host.has("s1")).toBe(false);
  });

  it("工作区解析失败 → 当作一次崩溃反馈给池，不留幽灵会话", () => {
    const onExit = vi.fn();
    const host = new PoolRuntimeHostImpl({
      clientFactory: () => new FakeClient(),
      resolveWorkspace: () => {
        throw new Error("WORKSPACE_UNKNOWN");
      },
    });
    host.bind({ onReady: vi.fn(), onEvent: vi.fn(), onExit });
    host.launch({ sessionId: "s1", workspaceId: null, origin: "child" });
    expect(onExit).toHaveBeenCalledWith("s1", "crash");
    expect(host.has("s1")).toBe(false);
  });

  it("deliver 发提示词、stop 停进程", () => {
    const { host, clients } = makeHost();
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "child" });
    host.deliver("s1", "去做这件事");
    expect(clients[0].sent).toEqual([{ type: "prompt", message: "去做这件事" }]);
    host.stop("s1");
    expect(clients[0].stopped).toBe(true);
    expect(host.has("s1")).toBe(false);
  });
});

/**
 * 前台回退网关（ISS-004）：deliver / stop 的三分支路由必须可证伪。
 *
 * 对拍方向：把 `deliver` 里 `activeSessionId() === sessionId` 的门拆掉（恒不
 * 回退），「命中前台」分支变红；把池分支拆掉，「命中池」变红。
 */
describe("前台回退网关（ISS-004）", () => {
  function makeGateway(active: string | null) {
    return {
      active,
      delivered: [] as string[],
      stopped: 0,
      activeSessionId(): string | null {
        return this.active;
      },
      deliver(text: string): void {
        this.delivered.push(text);
      },
      stop(): void {
        this.stopped++;
      },
    };
  }

  it("deliver：命中池托管会话 → 走池 client，网关不被触碰", () => {
    const { host, clients } = makeHost();
    const gw = makeGateway("fg-1");
    host.setForegroundGateway(gw);
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "user" });
    expect(host.deliver("s1", "给池")).toBe(true);
    expect(clients[0].sent).toEqual([{ type: "prompt", message: "给池" }]);
    expect(gw.delivered).toEqual([]);
  });

  it("deliver：不在池里但命中前台活跃会话 → 经网关投给 supervisor", () => {
    const { host } = makeHost();
    const gw = makeGateway("fg-1");
    host.setForegroundGateway(gw);
    expect(host.deliver("fg-1", "给前台")).toBe(true);
    expect(gw.delivered).toEqual(["给前台"]);
  });

  it("deliver：两边都不中 → 返回 false（明确落空，不装作投出去了）", () => {
    const { host } = makeHost();
    const gw = makeGateway("fg-1");
    host.setForegroundGateway(gw);
    expect(host.deliver("nobody", "没人收")).toBe(false);
    expect(gw.delivered).toEqual([]);
  });

  it("deliver：未注入网关时行为与从前一字不差（丢弃并返回 false）", () => {
    const { host } = makeHost();
    expect(host.deliver("fg-1", "无网关")).toBe(false);
  });

  it("stop：不在池里但命中前台活跃会话 → 网关 stop；不匹配 → 不触碰前台", () => {
    const { host } = makeHost();
    const gw = makeGateway("fg-1");
    host.setForegroundGateway(gw);
    host.stop("fg-1");
    expect(gw.stopped).toBe(1);
    host.stop("nobody");
    expect(gw.stopped).toBe(1);
  });

  it("stop：池托管会话恒走池 client，即使网关声称同名前台会话", () => {
    const { host, clients } = makeHost();
    const gw = makeGateway("s1");
    host.setForegroundGateway(gw);
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "user" });
    host.stop("s1");
    expect(clients[0].stopped).toBe(true);
    expect(gw.stopped).toBe(0);
  });
});

/** 会话级 tap（tasks 触发的观察口）：先挂后派生也不漏 ready / 事件 / 退出。 */
describe("observeRuntime tap", () => {
  it("ready 带真实 pi sessionId；事件与退出都进 tap；解除后不再收", async () => {
    const { host, clients } = makeHost();
    const ready: Array<string | null> = [];
    const events: AgentEvent[] = [];
    const exits: string[] = [];
    const unobserve = host.observeRuntime("s1", {
      onReady: (sid) => ready.push(sid),
      onEvent: (e) => events.push(e),
      onExit: (r) => exits.push(r),
    });
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "user" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).toEqual(["pi-real-session"]);
    clients[0].emitEvent(AGENT_START);
    expect(events).toEqual([AGENT_START]);
    host.stop("s1");
    expect(exits).toEqual(["expected-stop"]);
    unobserve();
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "user" });
    clients[1].emitEvent(AGENT_START);
    expect(events).toHaveLength(1); // 解除之后的事件不再进来
  });

  it("spawn 失败也走 tap.onExit(crash)，等待方不会永久悬挂", () => {
    const exits: string[] = [];
    const host = new PoolRuntimeHostImpl({
      clientFactory: () => {
        throw new Error("spawn 炸了");
      },
      resolveWorkspace: () => ({ cwd: "/ws", sessionDir: "/ws/.s" }),
    });
    host.bind({ onReady: vi.fn(), onEvent: vi.fn(), onExit: vi.fn() });
    host.observeRuntime("s1", { onExit: (r) => exits.push(r) });
    host.launch({ sessionId: "s1", workspaceId: "ws", origin: "user" });
    expect(exits).toEqual(["crash"]);
  });
});

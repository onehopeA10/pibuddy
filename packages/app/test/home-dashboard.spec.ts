import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * home.dashboard 的三组判据（智能家居监控面板，基座诚实遗留 #7 的落点）。
 *
 * ## A. 消费者计数联动（纯逻辑 + 注入时钟）
 *
 * subscribe = cache.acquire（计数 > 0 维持 WS）+ onChange 挂播；unsubscribe =
 * 释放 + 摘播（归零后 5min linger 拆线——linger 用注入时钟走真，不等真 5 分钟）。
 * 幂等语义（每 workspace 至多一个面板消费者）与代际递增一并钉住。
 *
 * **对拍**（手工做一次，输出记在交付报告里）：把 dashboard-service.unsubscribe
 * 里的 `sub.release()` 拆掉 → 「unsubscribe 归零 → linger 到点拆线」变红
 * （计数泄漏，WS 永不拆线）——证明这组断言不是恒真的。
 *
 * ## B. 快照与增量推送（复用 home-assistant-e2e 的假 HA 模式）
 *
 * 起一个真 http + 手写 WS 的假 Home Assistant，走完整链：subscribe 拿快照 →
 * 假 HA 推 state_changed → dashboard 信封增量到达（sequence 单调）→ 掐线
 * link stale=true → 自动重连 resync → link stale=false。
 *
 * ## C. 懒加载闸门首个非空生效（contract capability.ts 的 D2 连带约束）
 *
 * 此前全体内置清单都是 inline，「lazy 必须给 entry / inline 不得给 entry」
 * 两条断言对空集恒真。本包是第一份 lazy 清单：正向绿 + 两个变异红，外加
 * AppShell 侧真的用动态 import（静态 import 会把 lazy 声明变成一句空话）。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-dashboard-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  dialog: { showMessageBox: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

const { EntityCache, HA_WS_LINGER_MS } = await import("../src/main/home/entity-cache.js");
const { HomeDashboardService } = await import(
  "../src/main/home-dashboard/dashboard-service.js"
);
const { HomeAssistantService } = await import("../src/main/home/home-service.js");
const { computeAcceptKey, decodeFrames, encodePong, encodeTextFrame } = await import(
  "../src/main/remote/remote-ws.js"
);
const { validateCapabilityManifest } = await import("@pibuddy/contract");
const { homeDashboardCapability } = await import(
  "../src/main/capability/manifests/home-dashboard.manifest.js"
);
const { BUILT_IN_CAPABILITIES } = await import(
  "../src/main/capability/capability-manifests.js"
);

type Envelope = import("@pibuddy/contract").PiEnvelope<
  import("@pibuddy/contract").DashboardEventPayload
>;
type CacheSession = import("../src/main/home/entity-cache.js").EntityCacheSession;
type RawState = import("../src/main/home/entity-cache.js").RawHaState;

const WORKSPACE = "ws-dash";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: 等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ================================================================ A. 纯逻辑

/** 假 WS 会话：可手工触发 subscribed / down / state_changed。 */
class FakeSession {
  started = false;
  stopped = false;
  private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();

  on(event: string, handler: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }
}

/** 注入时钟 + 假会话 + 假 REST 的完整纯逻辑装配。 */
function makeFixture(states: RawState[] = []) {
  let now = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean; fired: boolean }[] = [];
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: now + ms, fn, cancelled: false, fired: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (!timer.cancelled && !timer.fired && timer.at <= now) {
        timer.fired = true;
        timer.fn();
      }
    }
  };

  const sessions: FakeSession[] = [];
  const cache = new EntityCache({
    now: () => now,
    schedule,
    fetchStates: async () => states,
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session as unknown as CacheSession;
    },
    loadSnapshot: () => [],
    saveSnapshot: () => undefined,
  });

  const envelopes: Envelope[] = [];
  const dash = new HomeDashboardService({
    cache: () => cache,
    broadcast: (envelope) => envelopes.push(envelope),
  });

  return { cache, dash, envelopes, sessions, advance };
}

describe("A. 消费者计数联动（subscribe→WS 维持，unsubscribe→归零拆线，注入时钟）", () => {
  it("subscribe 登记消费者并建立 WS；同 workspace 幂等（reload 不泄漏计数）", async () => {
    const { cache, dash, sessions } = makeFixture();
    const first = await dash.subscribe(WORKSPACE, 500);
    expect(cache.status().consumers).toBe(1);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.started).toBe(true);

    // 窗口 reload 后再 subscribe：不叠加计数、沿用同一代际。
    const again = await dash.subscribe(WORKSPACE, 500);
    expect(cache.status().consumers).toBe(1);
    expect(again.generation).toBe(first.generation);
    expect(dash.subscriptionCount()).toBe(1);
  });

  it("unsubscribe 归零 → linger 到点拆线（注入时钟走真 5 分钟）", async () => {
    const { cache, dash, sessions, advance } = makeFixture();
    await dash.subscribe(WORKSPACE, 500);

    const result = dash.unsubscribe(WORKSPACE);
    expect(result.released).toBe(true);
    expect(cache.status().consumers).toBe(0);
    // linger 语义：归零不立即拆线（来回切面板不该造成连接抖动）……
    advance(HA_WS_LINGER_MS - 1);
    expect(sessions[0]!.stopped).toBe(false);
    // ……到点才拆。
    advance(1);
    expect(sessions[0]!.stopped).toBe(true);

    // 重复释放幂等：不把计数打成负数。
    expect(dash.unsubscribe(WORKSPACE)).toEqual({ released: false });
    expect(cache.status().consumers).toBe(0);
  });

  it("再订阅代际 +1、会话重建（上一次订阅的迟到帧可被信封规则丢弃）", async () => {
    const { dash, sessions, advance } = makeFixture();
    const first = await dash.subscribe(WORKSPACE, 500);
    dash.unsubscribe(WORKSPACE);
    advance(HA_WS_LINGER_MS);

    const second = await dash.subscribe(WORKSPACE, 500);
    expect(second.generation).toBe(first.generation + 1);
    expect(sessions.length).toBe(2);
    expect(sessions[1]!.started).toBe(true);
  });

  it("state_changed → 增量信封广播（sequence 单调）；unsubscribe 后停播", async () => {
    const { dash, envelopes, sessions } = makeFixture();
    const { generation } = await dash.subscribe(WORKSPACE, 500);
    const session = sessions[0]!;
    session.emit("subscribed");
    await flush();

    session.emit("state_changed", { entityId: "light.a", state: "on", name: "灯A" });
    session.emit("state_changed", { entityId: "light.a", state: "off", name: null });
    const stateEvents = envelopes.filter((e) => e.payload.type === "state-changed");
    expect(stateEvents.map((e) => e.payload)).toEqual([
      { type: "state-changed", entityId: "light.a", state: "on", name: "灯A" },
      { type: "state-changed", entityId: "light.a", state: "off", name: null },
    ]);
    // 信封形状：代际 = 订阅代际；sequence 全程严格递增（含 link 事件在内）。
    for (const envelope of envelopes) {
      expect(envelope.generation).toBe(generation);
      expect(envelope.workspaceId).toBe(WORKSPACE);
    }
    const sequences = envelopes.map((e) => e.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);

    // 释放后缓存再有变化也不再广播（监听已摘）。
    const count = envelopes.length;
    dash.unsubscribe(WORKSPACE);
    session.emit("state_changed", { entityId: "light.a", state: "on", name: null });
    expect(envelopes.length).toBe(count);
  });

  it("断线 → link stale=true；resync 完成 → link stale=false（面板据此重拉快照）", async () => {
    const { dash, envelopes, sessions } = makeFixture([
      { entity_id: "light.a", state: "on", attributes: { friendly_name: "灯A" } },
    ]);
    await dash.subscribe(WORKSPACE, 500);
    const session = sessions[0]!;
    session.emit("subscribed");
    await flush();

    session.emit("down");
    expect(envelopes.at(-1)?.payload).toEqual({ type: "link", stale: true });

    // 重连成功 → 全量 resync 清 stale → link stale=false。
    session.emit("subscribed");
    await flush();
    expect(envelopes.at(-1)?.payload).toEqual({ type: "link", stale: false });
  });

  it("dispose 释放全部面板消费者（deactivate 不留死角）", async () => {
    const { cache, dash } = makeFixture();
    await dash.subscribe(WORKSPACE, 500);
    await dash.subscribe("ws-other", 500);
    expect(cache.status().consumers).toBe(2);
    dash.dispose();
    expect(cache.status().consumers).toBe(0);
    expect(dash.subscriptionCount()).toBe(0);
  });
});

// ================================================================ B. 假 HA

interface FakeEntity {
  entity_id: string;
  state: string;
  attributes: { friendly_name: string };
}

interface WsPeer {
  socket: Socket;
  authed: boolean;
  subscriptionId: number | null;
}

const HA_TOKEN = "dashboard-e2e-token";

/** 假 Home Assistant（home-assistant-e2e.spec 的同款模式，取本组用得到的子集）。 */
class FakeHomeAssistant {
  readonly server = http.createServer((req, res) => this.onRequest(req, res));
  port = 0;
  private readonly peers = new Set<WsPeer>();

  readonly entities: FakeEntity[] = [
    { entity_id: "light.living_room", state: "off", attributes: { friendly_name: "客厅灯" } },
    { entity_id: "switch.kettle", state: "off", attributes: { friendly_name: "烧水壶" } },
    { entity_id: "sensor.temp", state: "21.5", attributes: { friendly_name: "温度" } },
  ];

  async start(): Promise<void> {
    this.server.on("upgrade", (req, socket) => this.onUpgrade(req, socket as Socket));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) peer.socket.destroy();
    this.peers.clear();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  pushStateChanged(entityId: string, state: string): void {
    const entity = this.entities.find((e) => e.entity_id === entityId);
    if (entity) entity.state = state;
    for (const peer of this.peers) {
      if (!peer.authed || peer.subscriptionId === null || peer.socket.destroyed) continue;
      peer.socket.write(
        encodeTextFrame(
          JSON.stringify({
            id: peer.subscriptionId,
            type: "event",
            event: {
              event_type: "state_changed",
              data: {
                entity_id: entityId,
                new_state: entity
                  ? { entity_id: entityId, state, attributes: entity.attributes }
                  : null,
              },
            },
          })
        )
      );
    }
  }

  destroyWsConnections(): void {
    for (const peer of this.peers) peer.socket.destroy();
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: "Invalid token" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/") {
      res.end(JSON.stringify({ message: "API running." }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/states") {
      res.end(JSON.stringify(this.entities));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  }

  private onUpgrade(req: http.IncomingMessage, socket: Socket): void {
    if (req.url !== "/api/websocket") {
      socket.destroy();
      return;
    }
    const key = String(req.headers["sec-websocket-key"] ?? "");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`
    );
    const peer: WsPeer = { socket, authed: false, subscriptionId: null };
    this.peers.add(peer);
    socket.write(encodeTextFrame(JSON.stringify({ type: "auth_required", ha_version: "2024.1" })));

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x9) {
          socket.write(encodePong(frame.payload));
          continue;
        }
        if (frame.opcode === 0x8) {
          socket.destroy();
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        this.onWsMessage(peer, frame.payload.toString("utf8"));
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.peers.delete(peer));
  }

  private onWsMessage(peer: WsPeer, text: string): void {
    const msg = JSON.parse(text) as { type?: string; id?: number; access_token?: string };
    const send = (payload: unknown): void => {
      if (!peer.socket.destroyed) peer.socket.write(encodeTextFrame(JSON.stringify(payload)));
    };
    if (msg.type === "auth") {
      if (msg.access_token === HA_TOKEN) {
        peer.authed = true;
        send({ type: "auth_ok", ha_version: "2024.1" });
      } else {
        send({ type: "auth_invalid", message: "Invalid access token" });
        peer.socket.destroy();
      }
      return;
    }
    if (!peer.authed || typeof msg.id !== "number") return;
    if (msg.type === "subscribe_events") {
      peer.subscriptionId = msg.id;
      send({ id: msg.id, type: "result", success: true, result: null });
      return;
    }
    if (msg.type === "config/entity_registry/list") {
      send({
        id: msg.id,
        type: "result",
        success: true,
        result: [
          { entity_id: "light.living_room", name: null, area_id: "living" },
          { entity_id: "switch.kettle", name: null, area_id: "kitchen" },
          { entity_id: "sensor.temp", name: null, area_id: "living" },
        ],
      });
      return;
    }
    if (msg.type === "config/area_registry/list") {
      send({
        id: msg.id,
        type: "result",
        success: true,
        result: [
          { area_id: "living", name: "客厅" },
          { area_id: "kitchen", name: "厨房" },
        ],
      });
      return;
    }
    send({ id: msg.id, type: "result", success: false, error: { message: "unknown command" } });
  }
}

describe("B. 快照与增量推送（假 HA 整链：REST 快照 → WS 增量 → 断线/重连）", () => {
  const fake = new FakeHomeAssistant();
  const envelopes: Envelope[] = [];
  let service: InstanceType<typeof HomeAssistantService>;
  let dash: InstanceType<typeof HomeDashboardService>;

  /** 重连退避（1s 起步）压到 100ms；命令应答超时（10s）保持原值（同 e2e）。 */
  function fastSchedule(fn: () => void, ms: number): () => void {
    const timer = setTimeout(fn, ms >= 10000 ? ms : Math.min(ms, 100));
    timer.unref();
    return () => clearTimeout(timer);
  }

  beforeAll(async () => {
    await fake.start();
    service = new HomeAssistantService({
      config: () => ({ host: "127.0.0.1", port: fake.port }),
      token: () => HA_TOKEN,
      authDeps: () => ({
        isDeclared: () => true,
        evaluate: () => ({ allowed: true, reason: null }),
      }),
      loadSnapshot: () => [],
      saveSnapshot: () => undefined,
      wsTuning: { schedule: fastSchedule, jitter: () => 0 },
    });
    dash = new HomeDashboardService({
      cache: (workspaceId) => service.cache(workspaceId),
      broadcast: (envelope) => envelopes.push(envelope),
    });
  });

  afterAll(async () => {
    dash.dispose();
    service.dispose();
    await fake.stop();
  });

  it("subscribe：登记消费者 → WS 建立，快照 3 实体、live、不 stale", async () => {
    const result = await dash.subscribe(WORKSPACE, 500);
    expect(result.snapshot.total).toBe(3);
    expect(result.snapshot.source).toBe("live");
    expect(result.snapshot.stale).toBe(false);
    expect(result.snapshot.entities.map((e) => e.id)).toEqual([
      "light.living_room",
      "sensor.temp",
      "switch.kettle",
    ]);
    // 消费者信令真的接上了：基座计数 1、WS 鉴权序列走通。
    expect(service.status(WORKSPACE).consumers).toBe(1);
    await until(() => service.status(WORKSPACE).wsStatus === "connected");
  });

  it("假 HA 推 state_changed → dashboard 增量信封到达，快照通道同步可见", async () => {
    fake.pushStateChanged("light.living_room", "on");
    await until(() =>
      envelopes.some(
        (e) =>
          e.payload.type === "state-changed" &&
          e.payload.entityId === "light.living_room" &&
          e.payload.state === "on"
      )
    );
    // sequence 严格递增（渲染侧 shouldAcceptEnvelope 的前提）。
    const sequences = envelopes.map((e) => e.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);

    const snapshot = await dash.snapshot(WORKSPACE, 500);
    expect(snapshot.entities.find((e) => e.id === "light.living_room")?.state).toBe("on");
  });

  it("掐线 → link stale=true；自动重连 resync → link stale=false", async () => {
    fake.destroyWsConnections();
    await until(() => envelopes.some((e) => e.payload.type === "link" && e.payload.stale));
    // fastSchedule 把退避压到 100ms：重连 → auth 重走 → 全量 resync 清 stale。
    await until(() => envelopes.some((e) => e.payload.type === "link" && !e.payload.stale));
    await until(() => service.status(WORKSPACE).wsStatus === "connected");
    const snapshot = await dash.snapshot(WORKSPACE, 500);
    expect(snapshot.stale).toBe(false);
  });

  it("unsubscribe：消费者归零（linger 由基座接管，dispose 一并收）", () => {
    expect(dash.unsubscribe(WORKSPACE)).toEqual({ released: true });
    expect(service.status(WORKSPACE).consumers).toBe(0);
  });
});

// ================================================================ C. 懒加载闸门

describe("C. 懒加载闸门首个非空生效（capability.ts D2 连带约束的红绿对拍）", () => {
  it("本清单是首份 lazy 清单：loading=lazy + entry + bundleBudgetKb，装配期校验绿", () => {
    expect(homeDashboardCapability.runtime.loading).toBe("lazy");
    expect(homeDashboardCapability.runtime.entry).toBe(
      "renderer/src/components/HomeDashboardPanel.vue"
    );
    expect(homeDashboardCapability.runtime.bundleBudgetKb).toBeDefined();
    expect(validateCapabilityManifest(homeDashboardCapability)).toEqual([]);
    // 闸门不再对空集恒真：内置清单里从此至少有一份 lazy。
    expect(BUILT_IN_CAPABILITIES.some((m) => m.runtime.loading === "lazy")).toBe(true);
  });

  it("对拍红：lazy 却没有 entry → 闸门必须报「无从懒加载」", () => {
    const mutated = {
      ...homeDashboardCapability,
      runtime: { ...homeDashboardCapability.runtime, entry: undefined },
    };
    const errors = validateCapabilityManifest(mutated);
    expect(errors.some((e) => e.includes("无从懒加载"))).toBe(true);
  });

  it("对拍红：inline 却带 entry → 闸门必须报「inline 资产没有独立入口」", () => {
    const mutated = {
      ...homeDashboardCapability,
      runtime: { ...homeDashboardCapability.runtime, loading: "inline" as const },
    };
    const errors = validateCapabilityManifest(mutated);
    expect(errors.some((e) => e.includes("inline 资产没有独立入口"))).toBe(true);
  });

  it("渲染侧真的懒：AppShell 用动态 import，且没有静态 import 这个组件", () => {
    // 静态 import 会把组件打进主 chunk——manifest 的 lazy 声明与实际打包行为
    // 之间必须有一条机器能走的路（与 drift 2 的 module/host 对账同一手法）。
    const appShell = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/renderer/src/components/AppShell.vue"),
      "utf8"
    );
    expect(appShell).toContain('defineAsyncComponent(() => import("./HomeDashboardPanel.vue"))');
    expect(/^import\s+HomeDashboardPanel\s+from/m.test(appShell)).toBe(false);
  });
});

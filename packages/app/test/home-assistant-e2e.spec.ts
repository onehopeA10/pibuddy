import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * home.assistant 基座的假 HA server E2E（智能家居 Phase B）。
 *
 * 127.0.0.1 在 local 车道允许集内——这里起一个 node http + 手写 WS 的假
 * Home Assistant（鉴权序列照 HA 官方文档：GET /api/ 校验 Bearer；WS
 * auth_required → auth → auth_ok → subscribe_events → event），走完整链：
 *
 *   授权（evaluate 注入允许）→ test-connection → 实体全量拉取（快照落
 *   sqlite）→ WS 订阅收 state_changed 增量 → 工具经 bridge 往返（起真
 *   bridge + 模拟 extension 侧客户端）→ 断 WS 验证重连与 stale 标记。
 *
 * 对拍：token 错 → 401 拒；未授权端点 → 三道关拒；bridge token 错 → 拒；
 * 授权被撤 → 重连前的 evaluate 把会话停死（不再有任何连接尝试打到服务器）。
 *
 * WS 服务端帧码客串自 remote-ws（服务端方向：收必掩码、发不掩码）——它的
 * decodeFrames 只认掩码帧，「假 HA 能解出我们的帧」本身就证明客户端在掩码
 * （与 local-lane.spec 同一手法）。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-ha-e2e-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  dialog: { showMessageBox: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

const { OUTBOUND_BLOCKED } = await import("../src/main/net/outbound-guard.js");
const { computeAcceptKey, decodeFrames, encodePong, encodeTextFrame } = await import(
  "../src/main/remote/remote-ws.js"
);
const { HomeAssistantService } = await import("../src/main/home/home-service.js");
const { HomeToolBridge } = await import("../src/main/home/tool-bridge.js");
const { HomeStore } = await import("../src/main/home/ha-store.js");
const { verifyCapabilityAssets } = await import("../src/main/capability/capability-assets.js");
const { homeAssistantCapability } = await import(
  "../src/main/capability/manifests/home-assistant.manifest.js"
);

const HA_TOKEN = "e2e-long-lived-token";
const WORKSPACE = "ws-e2e";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: 等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------- 假 HA

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

class FakeHomeAssistant {
  readonly server = http.createServer((req, res) => this.onRequest(req, res));
  port = 0;
  /** 收到过的 POST /api/services/ 调用（path + body） */
  readonly serviceCalls: { path: string; body: unknown }[] = [];
  /** WS upgrade 尝试计数（含被拒的） */
  upgradeCount = 0;
  /** 全部 HTTP 请求计数（「零出站」断言用） */
  httpRequests = 0;
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

  liveWsCount(): number {
    return [...this.peers].filter((p) => !p.socket.destroyed).length;
  }

  /** 模拟设备状态变化：改内存状态并向全部已订阅连接推 state_changed。 */
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

  /** 掐断全部 WS 连接（模拟网络故障）。 */
  destroyWsConnections(): void {
    for (const peer of this.peers) peer.socket.destroy();
  }

  // ---------------------------------------------------------- REST

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.httpRequests++;
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
    if (req.method === "POST" && req.url?.startsWith("/api/services/")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          entity_id?: string;
        };
        this.serviceCalls.push({ path: req.url!, body });
        // 照 HA 语义：turn_on / turn_off 改状态并广播 state_changed。
        const match = /^\/api\/services\/[a-z0-9_]+\/(turn_on|turn_off)$/.exec(req.url!);
        if (match && typeof body.entity_id === "string") {
          this.pushStateChanged(body.entity_id, match[1] === "turn_on" ? "on" : "off");
        }
        res.end(JSON.stringify([]));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  }

  // ---------------------------------------------------------- WS

  private onUpgrade(req: http.IncomingMessage, socket: Socket): void {
    this.upgradeCount++;
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
    // HA 鉴权序列第一步：服务端先说 auth_required。
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
    const msg = JSON.parse(text) as {
      type?: string;
      id?: number;
      access_token?: string;
      event_type?: string;
    };
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
          { entity_id: "sensor.temp", name: "客厅温度计", area_id: "living" },
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

// ---------------------------------------------------------------- 装配

const fake = new FakeHomeAssistant();
let store: InstanceType<typeof HomeStore>;

/** 可翻转的授权开关（模拟用户撤销授权）+ evaluate 调用计数。 */
let endpointAuthorized = true;
let evaluateCalls = 0;

/**
 * WS 时序压缩：重连退避（1s 起步）压到 100ms 让断线用例快跑；命令应答超时
 * （10s）保持原值——压掉它会让 subscribe/registry 在 CI 抖动下误判超时。
 */
function fastSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms >= 10000 ? ms : Math.min(ms, 100));
  timer.unref();
  return () => clearTimeout(timer);
}

function makeService(token: string, authorized: () => boolean) {
  return new HomeAssistantService({
    config: () => ({ host: "127.0.0.1", port: fake.port }),
    token: () => token,
    authDeps: () => ({
      isDeclared: () => true,
      evaluate: () => {
        evaluateCalls++;
        return authorized()
          ? { allowed: true, reason: null }
          : { allowed: false, reason: "授权已被撤销" };
      },
    }),
    loadSnapshot: (workspaceId) => store.loadRegistry(workspaceId),
    saveSnapshot: (workspaceId, rows) => store.saveRegistry(workspaceId, rows),
    wsTuning: { schedule: fastSchedule, jitter: () => 0 },
  });
}

let service: ReturnType<typeof makeService>;

beforeAll(async () => {
  await fake.start();
  store = new HomeStore(path.join(userData, "home-e2e.db"));
  service = makeService(HA_TOKEN, () => endpointAuthorized);
});

afterAll(async () => {
  service.dispose();
  store.close();
  await fake.stop();
});

// ---------------------------------------------------------------- 用例

describe("test-connection：三道关 → GET /api/", () => {
  it("正向：授权注入允许 → HA 返回 API running.", async () => {
    const result = await service.testConnection(WORKSPACE);
    expect(result).toEqual({ ok: true, message: "API running." });
  });

  it("对拍：token 错 → 401 拒（连接可达但令牌被拒，两种失败可区分）", async () => {
    const wrongToken = makeService("wrong-token", () => true);
    const result = await wrongToken.testConnection(WORKSPACE);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
    wrongToken.dispose();
  });

  it("对拍：未授权端点 → 三道关第二关拒，一个字节都不出站", async () => {
    const requestsBefore = fake.httpRequests;
    const unauthorized = makeService(HA_TOKEN, () => false);
    expect(() => unauthorized.authorize(WORKSPACE)).toThrow(OUTBOUND_BLOCKED);
    const result = await unauthorized.testConnection(WORKSPACE);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未获授权");
    expect(fake.httpRequests).toBe(requestsBefore);
    unauthorized.dispose();
  });
});

describe("实体缓存：REST 全量 → sqlite 快照 → WS 增量", () => {
  it("首次全量 GET /api/states，names 取 friendly_name，注册表快照落 sqlite", async () => {
    const result = await service.entities(WORKSPACE, 200);
    expect(result.source).toBe("live");
    expect(result.stale).toBe(false);
    expect(result.total).toBe(3);
    expect(result.entities.map((e) => e.id)).toEqual([
      "light.living_room",
      "sensor.temp",
      "switch.kettle",
    ]);
    expect(result.entities.find((e) => e.id === "light.living_room")?.name).toBe("客厅灯");

    // 冷启动秒开的那份快照真的落了盘（状态不落盘：快照行没有 state 列）。
    const snapshot = store.loadRegistry(WORKSPACE);
    expect(snapshot.map((r) => r.entityId).sort()).toEqual([
      "light.living_room",
      "sensor.temp",
      "switch.kettle",
    ]);
  });

  it("消费者计数 > 0 → WS 鉴权序列走通 → state_changed 增量维护", async () => {
    const cache = service.cache(WORKSPACE);
    const release = cache.acquire();
    await until(() => cache.status().wsStatus === "connected");

    fake.pushStateChanged("light.living_room", "on");
    // WS 活着时 getStates 不再打 REST，读的就是增量维护的缓存。
    let light: { state: string | null; area: string | null } = { state: null, area: null };
    await until(() => {
      void cache.getStates(["light.living_room"]).then((rows) => (light = rows[0]!));
      return light.state === "on";
    });
    // WS 注册表命令的成果：区域名合并进了实体行。
    await until(() => {
      void cache.getStates(["light.living_room"]).then((rows) => (light = rows[0]!));
      return light.area === "客厅";
    });
    release();
  });
});

describe("工具经 bridge 往返（起真 bridge + 模拟 extension 侧客户端）", () => {
  let bridge: InstanceType<typeof HomeToolBridge>;
  let pipePath: string;

  beforeAll(async () => {
    // 执行面接真 service（权限 evaluate 在生产里由 home-ipc 按 manifest.tools
    // 逐条做；这里的 evaluate 注入已覆盖授权轴，bridge 用例聚焦协议往返）。
    bridge = new HomeToolBridge(async (tool, args) =>
      service.executeTool(tool, args, WORKSPACE)
    );
    pipePath = await bridge.start();
  });

  afterAll(async () => {
    await bridge.stop();
  });

  /** 模拟 extension 侧：连管道 → 一行 JSON 请求 → 一行 JSON 响应。 */
  function bridgeCall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("bridge 调用超时"));
      }, 5000);
      socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it("env() 注入的就是管道路径与一次性 token（未启用则为空对象）", () => {
    const env = bridge.env();
    expect(env.PIBUDDY_HOME_BRIDGE).toBe(pipePath);
    expect(env.PIBUDDY_HOME_BRIDGE_TOKEN).toBe(bridge.__token());
  });

  it("list_entities：紧凑行 id | name | state | area", async () => {
    const res = await bridgeCall({
      id: 1,
      token: bridge.__token(),
      tool: "home.assistant.list_entities",
      args: { domain: "light" },
    });
    expect(res.ok).toBe(true);
    const result = res.result as { total: number; entities: string[] };
    expect(result.entities.length).toBe(1);
    expect(result.entities[0]).toContain("light.living_room | 客厅灯 | on");
  });

  it("call_service：POST /api/services/<domain>/<service> 真打到假 HA，状态经 WS 回流", async () => {
    const res = await bridgeCall({
      id: 2,
      token: bridge.__token(),
      tool: "home.assistant.call_service",
      args: { domain: "light", service: "turn_off", entity_id: "light.living_room" },
    });
    expect(res.ok).toBe(true);
    expect(fake.serviceCalls.at(-1)).toEqual({
      path: "/api/services/light/turn_off",
      body: { entity_id: "light.living_room" },
    });

    const state = await bridgeCall({
      id: 3,
      token: bridge.__token(),
      tool: "home.assistant.get_state",
      args: { entity_ids: ["light.living_room"] },
    });
    expect(state.ok).toBe(true);
    const rows = (state.result as { states: { id: string; state: string | null }[] }).states;
    expect(rows[0]).toMatchObject({ id: "light.living_room", state: "off" });
  });

  it("对拍：bridge token 错 → 拒，一次执行都不发生", async () => {
    const before = fake.serviceCalls.length;
    const res = await bridgeCall({
      id: 4,
      token: "forged-token",
      tool: "home.assistant.call_service",
      args: { domain: "light", service: "turn_on", entity_id: "light.living_room" },
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("token 校验失败");
    expect(fake.serviceCalls.length).toBe(before);
  });

  it("对拍：未知工具 / 非法 domain 形态被拒（路径注入写不出来）", async () => {
    const unknown = await bridgeCall({ id: 5, token: bridge.__token(), tool: "home.assistant.nuke" });
    expect(unknown.ok).toBe(false);
    const inject = await bridgeCall({
      id: 6,
      token: bridge.__token(),
      tool: "home.assistant.call_service",
      args: { domain: "light/../../admin", service: "turn_on" },
    });
    expect(inject.ok).toBe(false);
  });
});

describe("断线：stale 标记 → 指数退避重连 → 全量 resync；授权撤销即停", () => {
  it("掐断 WS → stale=true；服务器仍在 → 自动重连并 resync 清除 stale", async () => {
    const cache = service.cache(WORKSPACE);
    const release = cache.acquire();
    await until(() => cache.status().wsStatus === "connected");

    const evaluatesBefore = evaluateCalls;
    fake.destroyWsConnections();
    await until(() => cache.status().stale);

    // 重连（fastSchedule 把 1s 退避压到 100ms）→ auth 序列重走 → resync。
    await until(() => cache.status().wsStatus === "connected" && !cache.status().stale);
    // 重连前确实重新过了 evaluate（授权判定不是连一次就免检）。
    expect(evaluateCalls).toBeGreaterThan(evaluatesBefore);
    release();
  });

  it("授权被撤 → 重连前 evaluate 拒 → 会话停死，不再有连接尝试打到服务器", async () => {
    const cache = service.cache(WORKSPACE);
    const release = cache.acquire();
    await until(() => cache.status().wsStatus === "connected");

    endpointAuthorized = false;
    fake.destroyWsConnections();
    await until(() => cache.status().stale);

    // 给足几个退避周期：upgrade 计数不再增长 = authorize 在连接前就把会话停了。
    await new Promise((resolve) => setTimeout(resolve, 400));
    const upgrades = fake.upgradeCount;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.upgradeCount).toBe(upgrades);
    expect(fake.liveWsCount()).toBe(0);
    expect(cache.status().stale).toBe(true);

    endpointAuthorized = true;
    release();
  });
});

describe("extension 资产与 manifest 逐字对账", () => {
  const APP_ROOT = path.resolve(import.meta.dirname, "..");
  const ASSETS_ROOT = path.join(APP_ROOT, "resources", "capability-assets");
  const EXTENSION_FILE = path.join(ASSETS_ROOT, "home.assistant", "extensions", "ha-tools.ts");

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  it("manifest 声明的资产真实存在（verifyCapabilityAssets 对真实资源根）", async () => {
    expect(await verifyCapabilityAssets([homeAssistantCapability], ASSETS_ROOT)).toEqual([]);
  });

  it("manifest tools 恰 3+1，且 extension 逐字注册同名工具", () => {
    const declared = homeAssistantCapability.tools.map((t) => t.name);
    expect(declared).toEqual([
      "home.assistant.list_entities",
      "home.assistant.get_state",
      "home.assistant.call_service",
      "home.assistant.setup",
    ]);
    const source = fs.readFileSync(EXTENSION_FILE, "utf8");
    for (const name of declared) {
      expect([name, source.includes(`name: "${name}"`)]).toEqual([name, true]);
    }
  });

  it("extension 零 fetch 零 HA 直连：唯一 IO 是连 bridge 管道，env 名与主进程一致", () => {
    const source = stripComments(fs.readFileSync(EXTENSION_FILE, "utf8"));
    // 零 fetch / 零 WebSocket / 零 http 出站——HA 访问只能经主进程受控原语。
    expect(/\bfetch\s*\(/.test(source)).toBe(false);
    expect(/new\s+WebSocket\s*\(/.test(source)).toBe(false);
    expect(/\bhttps?\.request\s*\(/.test(source)).toBe(false);
    // 桥的接头暗号与主进程注入的 env 名逐字一致。
    expect(source).toContain("PIBUDDY_HOME_BRIDGE");
    expect(source).toContain("PIBUDDY_HOME_BRIDGE_TOKEN");
    // env 缺失时只注册 setup 引导工具（3→1）。
    expect(source).toContain('"home.assistant.setup"');
  });
});

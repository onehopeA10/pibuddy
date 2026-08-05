import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * home.automation 的假 HA server E2E（智能家居 Phase B）。
 *
 * 走完整链（与基座 e2e 同一手法：127.0.0.1 在 local 车道允许集内，假 HA 照
 * 官方鉴权序列）：
 *
 *   manage_rule 经**真 bridge**（named pipe + 一次性 token + 跨包注册口
 *   registerBridgeTool）建规则 → 状态触发规则占实体缓存消费者、WS 订阅走通 →
 *   state_changed 命中 → 确定性动作（service call）**真打到假 HA** →
 *   时间规则注入时钟推进 tick 触发 → Agent 动作投递给 tasks 域（真 TaskStore +
 *   真 Scheduler.runNow：kind:"event" task、幂等 key、run 审计全走真）。
 *
 * 对拍：bridge token 错 → 拒且规则不落库；条件求值不过 → 动作零执行（拆掉
 * 条件求值本组即红）；授权被撤 → 命中后动作失败且**一个字节都不出站**（拆掉
 * 「每次执行前 re-evaluate 授权」本组即红）。
 *
 * 诚实边界：bridge 的执行面在本测里注入（workspace 由测试钉死），生产的
 * cwd → workspaceId 解析（automation-ipc.workspaceIdOfCwd）不在此覆盖——
 * 与基座 e2e 对 bridge 执行面的注入口径一致。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-auto-e2e-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  dialog: { showMessageBox: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

const { computeAcceptKey, decodeFrames, encodePong, encodeTextFrame } = await import(
  "../src/main/remote/remote-ws.js"
);
const { HomeAssistantService } = await import("../src/main/home/home-service.js");
const { HomeToolBridge, registerBridgeTool } = await import("../src/main/home/tool-bridge.js");
const { HomeStore } = await import("../src/main/home/ha-store.js");
const { AutomationStore } = await import("../src/main/home-automation/automation-store.js");
const { AutomationService } = await import("../src/main/home-automation/automation-service.js");
const { TaskStore } = await import("../src/main/tasks/task-store.js");
const { Scheduler } = await import("../src/main/tasks/scheduler.js");
const { ManualClock } = await import("../src/main/tasks/clock.js");
const { verifyCapabilityAssets } = await import("../src/main/capability/capability-assets.js");
const { homeAutomationCapability } = await import(
  "../src/main/capability/manifests/home-automation.manifest.js"
);
const {
  AUTOMATION_TOOL_MANAGE_RULE,
  HOME_TOOL_CALL_SERVICE,
  manageRuleArgsSchema,
} = await import("@pibuddy/contract");
import type {
  AutomationHomePort,
  AutomationTaskPort,
} from "../src/main/home-automation/automation-service.js";
import type { TriggerContext } from "../src/main/tasks/task-trigger.js";

const HA_TOKEN = "e2e-long-lived-token";
const WORKSPACE = "ws-auto-e2e";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: 等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 假 HA（基座 e2e 的裁剪版）

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
  readonly serviceCalls: { path: string; body: unknown }[] = [];
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

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.httpRequests++;
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: "Invalid token" }));
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
    // 注册表命令：本测不关心显示名，返回空成功即可。
    send({ id: msg.id, type: "result", success: true, result: [] });
  }
}

// ---------------------------------------------------------------- 装配

const fake = new FakeHomeAssistant();
let haStore: InstanceType<typeof HomeStore>;
let service: InstanceType<typeof HomeAssistantService>;
let autoStore: InstanceType<typeof AutomationStore>;
let automation: InstanceType<typeof AutomationService>;
let tasksStore: InstanceType<typeof TaskStore>;
let taskScheduler: InstanceType<typeof Scheduler>;
let bridge: InstanceType<typeof HomeToolBridge>;
let pipePath: string;

/** 可翻转的授权开关（模拟用户撤销授权）。 */
let endpointAuthorized = true;
/** 注入时钟（automation 域）；tasks 域用 ManualClock 同步。 */
let nowMs = Date.UTC(2026, 0, 5, 0, 0);
const manualClock = new ManualClock(nowMs);
/** 真 Scheduler.runNow 触发到的后台 run 输入（Agent 动作的投递证据）。 */
const triggered: TriggerContext[] = [];

function fastSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms >= 10000 ? ms : Math.min(ms, 100));
  timer.unref();
  return () => clearTimeout(timer);
}

beforeAll(async () => {
  await fake.start();
  haStore = new HomeStore(path.join(userData, "home-e2e.db"));
  service = new HomeAssistantService({
    config: () => ({ host: "127.0.0.1", port: fake.port }),
    token: () => HA_TOKEN,
    authDeps: () => ({
      isDeclared: () => true,
      evaluate: () =>
        endpointAuthorized
          ? { allowed: true, reason: null }
          : { allowed: false, reason: "授权已被撤销" },
    }),
    loadSnapshot: (workspaceId) => haStore.loadRegistry(workspaceId),
    saveSnapshot: (workspaceId, rows) => haStore.saveRegistry(workspaceId, rows),
    wsTuning: { schedule: fastSchedule, jitter: () => 0 },
  });

  tasksStore = new TaskStore(path.join(userData, "tasks-e2e.db"));
  taskScheduler = new Scheduler({
    store: tasksStore,
    clock: manualClock,
    trigger: () => ({
      trigger: async (ctx) => {
        triggered.push(ctx);
        return {
          status: "succeeded",
          sessionId: null,
          artifactIds: [],
          costUsd: null,
          error: null,
          note: "e2e 触发 stub",
        };
      },
    }),
    workspaceGrants: () => [],
  });

  // 基座动作面：全部收敛到真 HomeAssistantService（与生产 productionHomePort 同构）。
  const homePort: AutomationHomePort = {
    async callService(workspaceId, args) {
      await service.executeTool(HOME_TOOL_CALL_SERVICE, args, workspaceId);
    },
    async getStates(workspaceId, entityIds) {
      const rows = await service.cache(workspaceId).getStates(entityIds);
      return rows.map((r) => ({ id: r.id, state: r.state }));
    },
    onStateChanged(workspaceId, fn) {
      return service.cache(workspaceId).onStateChanged(fn);
    },
    acquireConsumer(workspaceId) {
      return service.cache(workspaceId).acquire();
    },
  };

  // tasks 动作面：真 TaskStore + 真 Scheduler.runNow（与生产 deliverTaskEvent 同构）。
  const taskPort: AutomationTaskPort = {
    ensureTask({ workspaceId, ruleId, ruleName, prompt, timezone, existingTaskId }) {
      const now = manualClock.now();
      const name = `自动化规则「${ruleName}」的 Agent 动作`;
      if (existingTaskId !== null) {
        const current = tasksStore.getTask(existingTaskId);
        if (current !== null && current.workspaceId === workspaceId) {
          tasksStore.updateTask(
            existingTaskId,
            { name, timezone, agent: { ...current.agent, prompt } },
            now
          );
          return existingTaskId;
        }
      }
      const task = tasksStore.createTask(
        {
          workspaceId,
          name,
          schedule: { kind: "event", event: `home.automation:${ruleId}` },
          timezone,
          agent: { provider: "", model: "", prompt },
          requiredPermissions: [],
          budgetUsd: null,
          timeoutMs: null,
          misfirePolicy: "skip",
          concurrencyPolicy: "forbid",
          failurePolicy: { retry: false, maxAttempts: 1, backoffMs: 0 },
        },
        now,
        null
      );
      return task.id;
    },
    deleteTask(taskId) {
      tasksStore.deleteTask(taskId);
    },
    async deliver(taskId) {
      const task = tasksStore.getTask(taskId);
      if (!task || task.status !== "active" || task.schedule.kind !== "event") {
        throw new Error("AUTOMATION_EVENT_UNDELIVERED: backing task 不存在或已暂停");
      }
      await taskScheduler.runNow(task);
    },
  };

  autoStore = new AutomationStore(path.join(userData, "automation-e2e.db"));
  automation = new AutomationService({
    store: autoStore,
    home: homePort,
    tasks: taskPort,
    now: () => nowMs,
    // 对齐 tick 由测试手动 engine.tick(now) 驱动，不挂真实定时器。
    schedule: () => () => undefined,
  });

  // 真 bridge + 跨包注册口：manage_rule 的执行面注入（workspace 由测试钉死）。
  bridge = new HomeToolBridge(async (tool, args) => service.executeTool(tool, args, WORKSPACE));
  registerBridgeTool(AUTOMATION_TOOL_MANAGE_RULE, async (tool, args) => {
    if (tool !== AUTOMATION_TOOL_MANAGE_RULE) throw new Error(`unknown: ${tool}`);
    const parsed = manageRuleArgsSchema.parse(args ?? {});
    switch (parsed.action) {
      case "list":
        return { rules: automation.list(WORKSPACE) };
      case "create": {
        if (!parsed.rule) throw new Error("create 需要 rule");
        const rule = automation.upsert(WORKSPACE, null, parsed.rule);
        return { ok: true, rule_id: rule.id };
      }
      case "update": {
        if (!parsed.rule_id || !parsed.rule) throw new Error("update 需要 rule_id + rule");
        automation.upsert(WORKSPACE, parsed.rule_id, parsed.rule);
        return { ok: true };
      }
      case "delete": {
        if (!parsed.rule_id) throw new Error("delete 需要 rule_id");
        automation.remove(WORKSPACE, parsed.rule_id);
        return { ok: true };
      }
      case "enable":
      case "disable": {
        if (!parsed.rule_id) throw new Error("需要 rule_id");
        automation.setEnabled(WORKSPACE, parsed.rule_id, parsed.action === "enable");
        return { ok: true };
      }
    }
  });
  pipePath = await bridge.start();
});

afterAll(async () => {
  registerBridgeTool(AUTOMATION_TOOL_MANAGE_RULE, null);
  automation.dispose();
  service.dispose();
  await bridge.stop();
  autoStore.close();
  tasksStore.close();
  haStore.close();
  await fake.stop();
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

function serviceCallCount(pathSuffix: string): number {
  return fake.serviceCalls.filter((c) => c.path.endsWith(pathSuffix)).length;
}

// ---------------------------------------------------------------- 用例

let lightRuleId = "";

describe("manage_rule 经真 bridge（跨包注册口 registerBridgeTool）", () => {
  it("create：规则落库、引擎登记状态触发（占实体缓存消费者 → WS 拉起）", async () => {
    const res = await bridgeCall({
      id: 1,
      token: bridge.__token(),
      tool: AUTOMATION_TOOL_MANAGE_RULE,
      args: {
        action: "create",
        rule: {
          name: "灯亮开壶",
          trigger: { kind: "state", entityId: "light.living_room", to: "on" },
          actions: [
            { kind: "service", domain: "switch", service: "turn_on", entityId: "switch.kettle" },
          ],
        },
      },
    });
    expect(res.ok).toBe(true);
    lightRuleId = (res.result as { rule_id: string }).rule_id;
    expect(lightRuleId.length).toBeGreaterThan(0);

    const rules = automation.list(WORKSPACE);
    expect(rules.length).toBe(1);
    expect(rules[0]).toMatchObject({ name: "灯亮开壶", enabled: true });

    // 状态触发规则启用 = 一个常驻消费者维持 WS：鉴权序列走通。
    const cache = service.cache(WORKSPACE);
    await until(() => cache.status().wsStatus === "connected");
    expect(cache.status().consumers).toBeGreaterThanOrEqual(1);
  });

  it("对拍：bridge token 错 → 拒，一条规则都建不出来", async () => {
    const before = automation.list(WORKSPACE).length;
    const res = await bridgeCall({
      id: 2,
      token: "forged-token",
      tool: AUTOMATION_TOOL_MANAGE_RULE,
      args: { action: "create", rule: { name: "x", trigger: { kind: "time", time: "01:00" }, actions: [{ kind: "notify", message: "x" }] } },
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("token 校验失败");
    expect(automation.list(WORKSPACE).length).toBe(before);
  });

  it("list / enable / disable 往返", async () => {
    const disable = await bridgeCall({
      id: 3,
      token: bridge.__token(),
      tool: AUTOMATION_TOOL_MANAGE_RULE,
      args: { action: "disable", rule_id: lightRuleId },
    });
    expect(disable.ok).toBe(true);
    expect(automation.list(WORKSPACE)[0]!.enabled).toBe(false);

    const enable = await bridgeCall({
      id: 4,
      token: bridge.__token(),
      tool: AUTOMATION_TOOL_MANAGE_RULE,
      args: { action: "enable", rule_id: lightRuleId },
    });
    expect(enable.ok).toBe(true);
    const list = await bridgeCall({
      id: 5,
      token: bridge.__token(),
      tool: AUTOMATION_TOOL_MANAGE_RULE,
      args: { action: "list" },
    });
    expect((list.result as { rules: { enabled: boolean }[] }).rules[0]!.enabled).toBe(true);
  });
});

describe("状态触发 → 确定性动作真打到假 HA", () => {
  it("state_changed 命中 → POST /api/services/switch/turn_on；相同状态重复事件去重", async () => {
    const before = serviceCallCount("/switch/turn_on");
    fake.pushStateChanged("light.living_room", "on");
    await until(() => serviceCallCount("/switch/turn_on") === before + 1);
    expect(fake.serviceCalls.find((c) => c.path === "/api/services/switch/turn_on")?.body).toEqual({
      entity_id: "switch.kettle",
    });
    await until(() => automation.list(WORKSPACE)[0]!.lastFiredAt !== null);
    expect(automation.list(WORKSPACE)[0]!.lastError).toBe(null);

    // 相同状态再推一次：引擎 prev 已是 on → 去重，不再触发。
    fake.pushStateChanged("light.living_room", "on");
    await sleep(300);
    expect(serviceCallCount("/switch/turn_on")).toBe(before + 1);
  });
});

describe("条件求值挡在动作之前（对拍：拆掉条件求值本组即红）", () => {
  it("条件不成立 → 触发命中但动作零执行", async () => {
    automation.upsert(WORKSPACE, lightRuleId, {
      name: "灯亮开壶",
      trigger: { kind: "state", entityId: "light.living_room", to: "on" },
      condition: { kind: "state", entityId: "sensor.temp", op: "eq", value: "999" },
      actions: [{ kind: "service", domain: "switch", service: "turn_on", entityId: "switch.kettle" }],
    });
    const before = serviceCallCount("/switch/turn_on");
    fake.pushStateChanged("light.living_room", "off");
    fake.pushStateChanged("light.living_room", "on");
    await sleep(400);
    expect(serviceCallCount("/switch/turn_on")).toBe(before);
  });

  it("条件成立 → 动作执行（sensor.temp 实测 21.5）", async () => {
    automation.upsert(WORKSPACE, lightRuleId, {
      name: "灯亮开壶",
      trigger: { kind: "state", entityId: "light.living_room", to: "on" },
      condition: { kind: "state", entityId: "sensor.temp", op: "eq", value: "21.5" },
      actions: [{ kind: "service", domain: "switch", service: "turn_on", entityId: "switch.kettle" }],
    });
    const before = serviceCallCount("/switch/turn_on");
    fake.pushStateChanged("light.living_room", "off");
    fake.pushStateChanged("light.living_room", "on");
    await until(() => serviceCallCount("/switch/turn_on") === before + 1);
  });
});

describe("授权撤销即拒（对拍：拆掉「每次执行前 re-evaluate 授权」本组即红）", () => {
  it("撤权后命中 → 动作失败、lastError 如实、一个字节都不出站", async () => {
    endpointAuthorized = false;
    const httpBefore = fake.httpRequests;
    const callsBefore = fake.serviceCalls.length;

    fake.pushStateChanged("light.living_room", "off");
    fake.pushStateChanged("light.living_room", "on");
    await until(() => (automation.list(WORKSPACE)[0]!.lastError ?? "").includes("未获授权"));

    expect(fake.serviceCalls.length).toBe(callsBefore);
    expect(fake.httpRequests).toBe(httpBefore);

    endpointAuthorized = true;
  });
});

describe("时间触发：注入时钟推进 tick", () => {
  it("nextFire 按规则时区解出；tick 越过槽位 → service call 真打到假 HA", async () => {
    const rule = automation.upsert(WORKSPACE, null, {
      name: "每天中午开灯",
      trigger: { kind: "time", time: "12:00" },
      actions: [{ kind: "service", domain: "light", service: "turn_on", entityId: "light.living_room" }],
      timezone: "Asia/Shanghai",
    });
    const engine = automation.__engine(WORKSPACE)!;
    // now = 2026-01-05 00:00Z（上海 08:00）→ 当天 12:00 CST = 04:00Z。
    const slot = Date.UTC(2026, 0, 5, 4, 0);
    expect(engine.__nextFireAt(rule.id)).toBe(slot);

    const before = serviceCallCount("/light/turn_on");
    nowMs = slot + 1000;
    manualClock.set(nowMs);
    engine.tick(nowMs);
    await until(() => serviceCallCount("/light/turn_on") === before + 1);
    // 下一次已推进到次日槽位。
    expect(engine.__nextFireAt(rule.id)).toBe(Date.UTC(2026, 0, 6, 4, 0));

    automation.remove(WORKSPACE, rule.id);
  });
});

describe("Agent 动作：落成 kind:event 的真 task，命中即投递（tasks 纪律全继承）", () => {
  let agentRuleId = "";
  let backingTaskId = "";

  it("保存规则 → tasks 库出现 kind:event 的真 task（nextRunAt 恒 null，prompt 冻结）", async () => {
    const res = await bridgeCall({
      id: 10,
      token: bridge.__token(),
      tool: AUTOMATION_TOOL_MANAGE_RULE,
      args: {
        action: "create",
        rule: {
          name: "温度变化让 Agent 总结",
          trigger: { kind: "state", entityId: "sensor.temp" },
          actions: [{ kind: "agent", prompt: "总结今天的温度变化并给出建议" }],
        },
      },
    });
    expect(res.ok).toBe(true);
    agentRuleId = (res.result as { rule_id: string }).rule_id;

    const tasks = tasksStore.listTasks(WORKSPACE);
    expect(tasks.length).toBe(1);
    backingTaskId = tasks[0]!.id;
    expect(tasks[0]!.schedule).toEqual({ kind: "event", event: `home.automation:${agentRuleId}` });
    expect(tasks[0]!.nextRunAt).toBe(null); // 不由时钟驱动，等外部投递
    expect(tasks[0]!.agent.prompt).toBe("总结今天的温度变化并给出建议");
  });

  it("命中 → 经真 Scheduler.runNow 投递：run 落库、触发拿到冻结 prompt", async () => {
    const triggeredBefore = triggered.length;
    fake.pushStateChanged("sensor.temp", "23.0");
    await until(() => triggered.length === triggeredBefore + 1);
    expect(triggered.at(-1)!.taskId).toBe(backingTaskId);
    expect(triggered.at(-1)!.input.prompt).toBe("总结今天的温度变化并给出建议");

    const runs = tasksStore.listRuns(backingTaskId);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("succeeded");
  });

  it("规则改 prompt → backing task 跟着改；删规则 → backing task 一并删", async () => {
    automation.upsert(WORKSPACE, agentRuleId, {
      name: "温度变化让 Agent 总结",
      trigger: { kind: "state", entityId: "sensor.temp" },
      actions: [{ kind: "agent", prompt: "换一份提示词" }],
    });
    expect(tasksStore.getTask(backingTaskId)!.agent.prompt).toBe("换一份提示词");

    const del = await bridgeCall({
      id: 11,
      token: bridge.__token(),
      tool: AUTOMATION_TOOL_MANAGE_RULE,
      args: { action: "delete", rule_id: agentRuleId },
    });
    expect(del.ok).toBe(true);
    expect(tasksStore.getTask(backingTaskId)).toBe(null);
    expect(automation.list(WORKSPACE).some((r) => r.id === agentRuleId)).toBe(false);
  });
});

describe("extension 资产与 manifest 逐字对账", () => {
  const APP_ROOT = path.resolve(import.meta.dirname, "..");
  const ASSETS_ROOT = path.join(APP_ROOT, "resources", "capability-assets");
  const EXTENSION_FILE = path.join(ASSETS_ROOT, "home.automation", "extensions", "automation-tools.ts");

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  it("manifest 声明的资产真实存在（verifyCapabilityAssets 对真实资源根）", async () => {
    expect(await verifyCapabilityAssets([homeAutomationCapability], ASSETS_ROOT)).toEqual([]);
  });

  it("manifest tools 恰 1 个 manage_rule，且 extension 逐字注册同名工具", () => {
    expect(homeAutomationCapability.tools.map((t) => t.name)).toEqual([
      "home.automation.manage_rule",
    ]);
    const source = fs.readFileSync(EXTENSION_FILE, "utf8");
    expect(source).toContain('name: "home.automation.manage_rule"');
  });

  it("extension 零 fetch 零直连：唯一 IO 是连 bridge 管道，env 名与主进程一致", () => {
    const source = stripComments(fs.readFileSync(EXTENSION_FILE, "utf8"));
    expect(/\bfetch\s*\(/.test(source)).toBe(false);
    expect(/new\s+WebSocket\s*\(/.test(source)).toBe(false);
    expect(/\bhttps?\.request\s*\(/.test(source)).toBe(false);
    expect(source).toContain("PIBUDDY_HOME_BRIDGE");
    expect(source).toContain("PIBUDDY_HOME_BRIDGE_TOKEN");
  });
});

/**
 * HA WebSocket 会话（home.assistant / 智能家居 Phase B）。
 *
 * ## 协议客户端在 net/，会话策略在这里
 *
 * local-ws-client.ts 只管 RFC 6455（帧、心跳、握手），刻意不做重连——什么
 * 时候重连、退避多久、授权还在不在，是**会话**按自身生命周期决定的事。本文件
 * 就是那一层：HA 鉴权序列（auth_required → auth{token} → auth_ok →
 * subscribe_events state_changed）、指数退避重连 1s→60s+jitter、进程内
 * EventEmitter 导出状态事件（home.automation 将来订阅状态触发源就挂在这里）。
 *
 * ## 每次重连前重新 evaluate（授权被撤即停）
 *
 * `deps.authorize()` 在**每一次**连接尝试前都被重新调用（生产路径 =
 * authorizeLocalEndpoint，三道关的前两道）。用户在权限中心撤销 grant 之后，
 * 下一次重连尝试就地失败并把会话置为 stopped——长连接不成为「撤了权还连着」
 * 的死角。地址断言（第三道关）由 openLocalWebSocket 在连接时自己重跑。
 *
 * ## teardown
 *
 * stop() 幂等：取消重连定时器、关连接、拒绝全部挂起命令。上层（entity-cache
 * 归零 5 分钟拆线、disposeHomeResources）只需要调它。
 */
import { EventEmitter } from "node:events";

import { openLocalWebSocket, type LocalWsConnection } from "../net/local-ws-client.js";
import type { AuthorizedLocalEndpoint } from "../net/outbound-local-guard.js";

/** HA 的 WebSocket API 固定路径（HA 官方文档 /api/websocket）。 */
export const HA_WS_PATH = "/api/websocket";
/** 指数退避基数。 */
export const HA_RECONNECT_BASE_MS = 1000;
/** 退避上限。 */
export const HA_RECONNECT_MAX_MS = 60000;
/** WS 命令（subscribe / registry list）的应答超时。 */
export const HA_COMMAND_TIMEOUT_MS = 10000;

export type HaWsStatus = "idle" | "connecting" | "connected" | "stopped";

/** 一条 state_changed 的归一化视图（automation 的状态触发源就吃这个形状）。 */
export interface HaStateChanged {
  entityId: string;
  /** 新状态；实体被移除时为 null */
  state: string | null;
  /** friendly_name（新状态里带的话） */
  name: string | null;
}

/** WS 侧拉到的注册表行（entity registry + area registry 合并后）。 */
export interface HaWsRegistryEntry {
  entityId: string;
  /** registry 里用户改过的名字；没有为 null */
  name: string | null;
  /** area 显示名；没有为 null */
  area: string | null;
}

export interface HaWsSessionDeps {
  /** 每次连接尝试前重新过三道关的前两道；抛错 = 授权已不在 → 会话停 */
  authorize(): AuthorizedLocalEndpoint;
  /** 每次连接时现取 token（用户轮换 token 后重连自动用新的） */
  token(): string | null;
  /** 生产恒为 openLocalWebSocket；单测可注入 */
  open?: (endpoint: AuthorizedLocalEndpoint, path: string) => Promise<LocalWsConnection>;
  /** 定时器注入（返回取消函数）；生产为 setTimeout/clearTimeout（unref） */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** 退避 jitter（0-1）；单测注入 0 让时序可预测 */
  jitter?: () => number;
}

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  cancelTimeout: () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export class HaWsSession extends EventEmitter {
  private conn: LocalWsConnection | null = null;
  private stopped = true;
  private attempts = 0;
  private nextCommandId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private cancelReconnect: (() => void) | null = null;
  private statusValue: HaWsStatus = "idle";
  private readonly open: NonNullable<HaWsSessionDeps["open"]>;
  private readonly schedule: NonNullable<HaWsSessionDeps["schedule"]>;
  private readonly jitter: NonNullable<HaWsSessionDeps["jitter"]>;

  constructor(private readonly deps: HaWsSessionDeps) {
    super();
    this.open = deps.open ?? openLocalWebSocket;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.jitter = deps.jitter ?? Math.random;
  }

  status(): HaWsStatus {
    return this.statusValue;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    void this.connect();
  }

  /** 幂等拆卸：取消重连、关连接、拒绝挂起命令。 */
  stop(): void {
    this.stopped = true;
    if (this.cancelReconnect) {
      this.cancelReconnect();
      this.cancelReconnect = null;
    }
    this.rejectAllPending("会话已停止");
    if (this.conn) {
      const conn = this.conn;
      this.conn = null;
      conn.close();
    }
    this.setStatus("stopped");
  }

  /** 发一条带 id 的 WS 命令，等 result。仅在鉴权完成后可用。 */
  sendCommand(payload: Record<string, unknown>): Promise<unknown> {
    const conn = this.conn;
    if (conn === null) return Promise.reject(new Error("HA_WS_NOT_CONNECTED"));
    const id = this.nextCommandId++;
    return new Promise((resolve, reject) => {
      const cancelTimeout = this.schedule(() => {
        this.pending.delete(id);
        reject(new Error("HA_WS_COMMAND_TIMEOUT: 命令应答超时"));
      }, HA_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, cancelTimeout });
      try {
        conn.send(JSON.stringify({ id, ...payload }));
      } catch (err) {
        cancelTimeout();
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ---------------------------------------------------------------- 内部

  private setStatus(status: HaWsStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit("status", status);
  }

  private rejectAllPending(reason: string): void {
    for (const [, cmd] of this.pending) {
      cmd.cancelTimeout();
      cmd.reject(new Error(`HA_WS_CLOSED: ${reason}`));
    }
    this.pending.clear();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");

    // 关 1/2：每次重连都重新过 manifest 上界 + PermissionEngine 授权。
    // 撤了权的会话在这里终止，而不是继续抱着一条已经不该存在的连接。
    let endpoint: AuthorizedLocalEndpoint;
    try {
      endpoint = this.deps.authorize();
    } catch (err) {
      this.stopped = true;
      this.setStatus("stopped");
      this.emit("down", err instanceof Error ? err.message : "授权已失效");
      return;
    }
    const token = this.deps.token();
    if (token === null) {
      this.stopped = true;
      this.setStatus("stopped");
      this.emit("down", "未配置访问令牌");
      return;
    }

    let conn: LocalWsConnection;
    try {
      // 关 3（地址断言）在 openLocalWebSocket 里重跑。
      conn = await this.open(endpoint, HA_WS_PATH);
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      conn.close();
      return;
    }
    this.conn = conn;

    conn.on("message", (text) => this.onMessage(text, token));
    conn.on("error", () => {
      /* close 会跟着来，统一在 close 里处理 */
    });
    conn.on("close", () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.rejectAllPending("连接断开");
      this.emit("down", "连接断开");
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private onMessage(text: string, token: string): void {
    let msg: { type?: string; id?: number; success?: boolean; result?: unknown; event?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return; // 非 JSON 帧：HA 不会发，忽略
    }

    switch (msg.type) {
      case "auth_required":
        // token 不进日志、不进错误消息——这里是明文唯一出现的位置之一。
        this.conn?.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      case "auth_ok":
        this.attempts = 0;
        this.setStatus("connected");
        void this.subscribe();
        return;
      case "auth_invalid":
        // token 错 / 被吊销：不算网络故障，但也不永久放弃——用户在设置面
        // 换了 token 之后，下一次退避重连会用新 token 再试。
        this.conn?.close();
        return;
      case "result": {
        if (typeof msg.id !== "number") return;
        const cmd = this.pending.get(msg.id);
        if (!cmd) return;
        this.pending.delete(msg.id);
        cmd.cancelTimeout();
        if (msg.success === false) cmd.reject(new Error("HA_WS_COMMAND_FAILED"));
        else cmd.resolve(msg.result);
        return;
      }
      case "event": {
        const event = msg.event as
          | {
              event_type?: string;
              data?: {
                entity_id?: string;
                new_state?: {
                  state?: string;
                  attributes?: { friendly_name?: string };
                } | null;
              };
            }
          | undefined;
        if (event?.event_type !== "state_changed") return;
        const entityId = event.data?.entity_id;
        if (typeof entityId !== "string" || entityId === "") return;
        const newState = event.data?.new_state ?? null;
        const changed: HaStateChanged = {
          entityId,
          state: typeof newState?.state === "string" ? newState.state : null,
          name:
            typeof newState?.attributes?.friendly_name === "string"
              ? newState.attributes.friendly_name
              : null,
        };
        this.emit("state_changed", changed);
        return;
      }
      default:
        return; // 未知消息类型：向前兼容，忽略
    }
  }

  private async subscribe(): Promise<void> {
    try {
      await this.sendCommand({ type: "subscribe_events", event_type: "state_changed" });
    } catch {
      // 订阅失败的连接没有价值：断开走重连。
      this.conn?.close();
      return;
    }
    this.emit("subscribed");
    void this.fetchRegistry();
  }

  /**
   * 实体/区域注册表（显示名与房间归属只有 WS 命令面有）。两条命令任一失败都
   * 静默放弃——注册表是锦上添花（friendly_name 已经够用），不值得为它断连接。
   */
  private async fetchRegistry(): Promise<void> {
    try {
      const [entities, areas] = await Promise.all([
        this.sendCommand({ type: "config/entity_registry/list" }),
        this.sendCommand({ type: "config/area_registry/list" }),
      ]);
      const areaNames = new Map<string, string>();
      if (Array.isArray(areas)) {
        for (const raw of areas) {
          const area = raw as { area_id?: string; name?: string };
          if (typeof area?.area_id === "string" && typeof area?.name === "string") {
            areaNames.set(area.area_id, area.name);
          }
        }
      }
      const rows: HaWsRegistryEntry[] = [];
      if (Array.isArray(entities)) {
        for (const raw of entities) {
          const entry = raw as { entity_id?: string; name?: string | null; area_id?: string | null };
          if (typeof entry?.entity_id !== "string" || entry.entity_id === "") continue;
          rows.push({
            entityId: entry.entity_id,
            name: typeof entry.name === "string" && entry.name !== "" ? entry.name : null,
            area:
              typeof entry.area_id === "string" ? (areaNames.get(entry.area_id) ?? null) : null,
          });
        }
      }
      if (rows.length > 0) this.emit("registry", rows);
    } catch {
      /* 见上：注册表拉不到不致命 */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.cancelReconnect) return;
    const base = Math.min(HA_RECONNECT_MAX_MS, HA_RECONNECT_BASE_MS * 2 ** this.attempts);
    this.attempts = Math.min(this.attempts + 1, 8);
    const delay = base + Math.floor(this.jitter() * 1000);
    this.cancelReconnect = this.schedule(() => {
      this.cancelReconnect = null;
      void this.connect();
    }, delay);
  }
}

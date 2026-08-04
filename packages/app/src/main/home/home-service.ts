/**
 * home.assistant 的域服务（智能家居 Phase B）：把配置、授权、REST/WS 原语、
 * 实体缓存、工具执行装配成按 workspaceId 分区的一台机器。
 *
 * ## 依赖全部注入
 *
 * 配置读取、token 读取、授权依赖（isDeclared/evaluate）、快照读写、WS 时序
 * 参数都从构造参数进来——E2E（test/home-assistant-e2e.spec.ts）用一个假 HA
 * server + 注入的 evaluate 走完整链，不需要 electron，也不需要打桩权限引擎。
 * 生产接线在 home-ipc.ts。
 *
 * ## 出站只有两个原语
 *
 * REST 恒经 safeLocalFetch、WS 恒经 openLocalWebSocket（间接经 HaWsSession）
 * ——本域没有第三条出站路径，import census（local-outbound-boundary.spec）
 * 钉着这一点。每一次请求前都要过 authorizeLocalEndpoint 三道关的前两道，
 * 第三道（私网地址断言）在原语内部重跑。
 */
import {
  HOME_ASSISTANT_CAPABILITY_ID,
  HOME_TOOL_CALL_SERVICE,
  HOME_TOOL_GET_STATE,
  HOME_TOOL_LIST_ENTITIES,
  homeCallServiceArgsSchema,
  homeGetStateArgsSchema,
  homeListEntitiesArgsSchema,
} from "@pibuddy/contract";

import {
  authorizeLocalEndpoint,
  safeLocalFetch,
  type AuthorizeLocalEndpointDeps,
  type AuthorizedLocalEndpoint,
} from "../net/outbound-local-guard.js";
import { EntityCache, type RawHaState } from "./entity-cache.js";
import { HaWsSession, type HaWsSessionDeps } from "./ha-ws-session.js";

export interface HomeServiceDeps {
  /** 某工作区的端点配置；未配置返回 null。 */
  config(workspaceId: string): { host: string; port: number } | null;
  /** 某工作区的 long-lived token 明文（仅本模块内部消费，不外发）。 */
  token(workspaceId: string): string | null;
  /** 授权依赖（生产 = PermissionEngine 按 workspaceId 闭包；E2E 注入）。 */
  authDeps(workspaceId: string): AuthorizeLocalEndpointDeps;
  /** 实体注册表快照（生产 = ha-store sqlite）。 */
  loadSnapshot(workspaceId: string): {
    entityId: string;
    name: string;
    domain: string;
    area: string | null;
  }[];
  saveSnapshot(
    workspaceId: string,
    rows: { entityId: string; name: string; domain: string; area: string | null }[]
  ): void;
  now?(): number;
  schedule?(fn: () => void, ms: number): () => void;
  /** WS 会话时序注入（E2E 用它压缩退避等待）。 */
  wsTuning?: Pick<HaWsSessionDeps, "schedule" | "jitter" | "open">;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export class HomeAssistantService {
  private readonly caches = new Map<string, EntityCache>();

  constructor(private readonly deps: HomeServiceDeps) {}

  /** 三道关的前两道；未配置 / 未授权抛错（OutboundBlockedError，可读中文）。 */
  authorize(workspaceId: string): AuthorizedLocalEndpoint {
    const config = this.deps.config(workspaceId);
    if (config === null) {
      throw new Error("HA_NOT_CONFIGURED: 尚未配置 Home Assistant 地址，请到设置面填写");
    }
    return authorizeLocalEndpoint(
      HOME_ASSISTANT_CAPABILITY_ID,
      config.host,
      config.port,
      this.deps.authDeps(workspaceId)
    );
  }

  /** 授权态（不抛错版本，供状态展示）。 */
  isAuthorized(workspaceId: string): boolean {
    try {
      this.authorize(workspaceId);
      return true;
    } catch {
      return false;
    }
  }

  private authHeaders(workspaceId: string): Record<string, string> {
    const token = this.deps.token(workspaceId);
    if (token === null) {
      throw new Error("HA_NO_TOKEN: 尚未配置访问令牌（long-lived access token）");
    }
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  /**
   * 测试连接：GET /api/。HA 鉴权通过时返回 `{"message":"API running."}`。
   * 结果恒为一句给人看的话——底层错误已被 safeLocalFetch 脱敏。
   */
  async testConnection(workspaceId: string): Promise<{ ok: boolean; message: string }> {
    let endpoint: AuthorizedLocalEndpoint;
    let headers: Record<string, string>;
    try {
      endpoint = this.authorize(workspaceId);
      headers = this.authHeaders(workspaceId);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    try {
      const result = await safeLocalFetch(endpoint, "/api/", { headers });
      if (result.status === 401 || result.status === 403) {
        return { ok: false, message: `令牌被拒绝（HTTP ${result.status}），请检查 token` };
      }
      if (!result.ok) {
        return { ok: false, message: `连接失败（HTTP ${result.status}）` };
      }
      const body = JSON.parse(result.bodyText) as { message?: string };
      return { ok: true, message: body.message ?? "API running." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ------------------------------------------------------------ 实体缓存

  private cacheFor(workspaceId: string): EntityCache {
    const existing = this.caches.get(workspaceId);
    if (existing) return existing;
    const now = this.deps.now ?? Date.now;
    const schedule = this.deps.schedule ?? defaultSchedule;
    const cache = new EntityCache({
      now,
      schedule,
      fetchStates: async (): Promise<RawHaState[]> => {
        const endpoint = this.authorize(workspaceId);
        const headers = this.authHeaders(workspaceId);
        const result = await safeLocalFetch(endpoint, "/api/states", { headers });
        if (!result.ok) throw new Error(`HA_STATES_FAILED: HTTP ${result.status}`);
        const parsed = JSON.parse(result.bodyText) as unknown;
        return Array.isArray(parsed) ? (parsed as RawHaState[]) : [];
      },
      createSession: () => {
        // 工厂本身先过一遍授权：未配置 / 未授权在这里抛，缓存退回纯 REST。
        this.authorize(workspaceId);
        return new HaWsSession({
          authorize: () => this.authorize(workspaceId),
          token: () => this.deps.token(workspaceId),
          ...this.deps.wsTuning,
        });
      },
      loadSnapshot: () => this.deps.loadSnapshot(workspaceId),
      saveSnapshot: (rows) => this.deps.saveSnapshot(workspaceId, rows),
    });
    this.caches.set(workspaceId, cache);
    return cache;
  }

  /** 面板快照（ha:entities）。 */
  async entities(
    workspaceId: string,
    limit: number
  ): Promise<{
    entities: { id: string; name: string; domain: string; state: string | null; area: string | null }[];
    total: number;
    stale: boolean;
    source: "live" | "snapshot";
  }> {
    return this.cacheFor(workspaceId).listEntities({ limit });
  }

  status(workspaceId: string): {
    wsStatus: "idle" | "connecting" | "connected" | "stale";
    consumers: number;
    entityCount: number;
    lastEventAt: number | null;
  } {
    const cache = this.caches.get(workspaceId);
    if (!cache) return { wsStatus: "idle", consumers: 0, entityCount: 0, lastEventAt: null };
    const s = cache.status();
    return {
      wsStatus: s.wsStatus,
      consumers: s.consumers,
      entityCount: s.entityCount,
      lastEventAt: s.lastEventAt,
    };
  }

  /** 供单测 / automation 将来直取某工作区缓存（登记消费者用）。 */
  cache(workspaceId: string): EntityCache {
    return this.cacheFor(workspaceId);
  }

  // ------------------------------------------------------------ 工具执行

  /**
   * tool bridge 的执行面。入参先过 zod（bridge 收到的是 pi 子进程发来的任意
   * JSON），再走与面板同一套缓存 / 出站原语。返回值是给 LLM 看的紧凑结构。
   */
  async executeTool(tool: string, args: unknown, workspaceId: string): Promise<unknown> {
    switch (tool) {
      case HOME_TOOL_LIST_ENTITIES: {
        const parsed = homeListEntitiesArgsSchema.parse(args ?? {});
        const cache = this.cacheFor(workspaceId);
        cache.noteToolUse();
        const result = await cache.listEntities(parsed);
        // 紧凑行：id | name | state | area——每行一个实体，token 成本最低。
        return {
          total: result.total,
          stale: result.stale,
          entities: result.entities.map(
            (e) => `${e.id} | ${e.name} | ${e.state ?? "?"}${e.area ? ` | ${e.area}` : ""}`
          ),
        };
      }
      case HOME_TOOL_GET_STATE: {
        const parsed = homeGetStateArgsSchema.parse(args ?? {});
        const cache = this.cacheFor(workspaceId);
        cache.noteToolUse();
        const states = await cache.getStates(parsed.entity_ids);
        return {
          states: states.map((e) => ({ id: e.id, name: e.name, state: e.state, area: e.area })),
        };
      }
      case HOME_TOOL_CALL_SERVICE: {
        const parsed = homeCallServiceArgsSchema.parse(args ?? {});
        const endpoint = this.authorize(workspaceId);
        const headers = this.authHeaders(workspaceId);
        const body: Record<string, unknown> = { ...(parsed.data ?? {}) };
        if (parsed.entity_id !== undefined) body.entity_id = parsed.entity_id;
        // domain / service 的形态已被 HA_SERVICE_IDENT_RE 钉死（小写字母数字
        // 下划线），拼进路径不构成注入面。
        const result = await safeLocalFetch(
          endpoint,
          `/api/services/${parsed.domain}/${parsed.service}`,
          { method: "POST", headers, body: JSON.stringify(body) }
        );
        if (!result.ok) {
          throw new Error(`HA_CALL_SERVICE_FAILED: HTTP ${result.status}`);
        }
        this.cacheFor(workspaceId).noteToolUse();
        return { ok: true, changed: JSON.parse(result.bodyText) as unknown };
      }
      default:
        throw new Error(`HA_UNKNOWN_TOOL: ${tool}`);
    }
  }

  /** 全量拆卸（disposeHomeResources / E2E 收尾）。 */
  dispose(): void {
    for (const cache of this.caches.values()) cache.dispose();
    this.caches.clear();
  }
}

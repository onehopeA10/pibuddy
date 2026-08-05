/**
 * 实体缓存（home.assistant / 智能家居 Phase B）——**纯逻辑，可直接对拍**。
 *
 * ## 引用计数消费者模型（不卡的关键：默认无常驻连接）
 *
 *   - 消费者计数 > 0（面板订阅 / 近 60s 有工具调用 / 将来 automation 的状态
 *     触发规则）→ 维持一条 WS 订阅，state_changed 增量维护；
 *   - 归零 → 5 分钟后拆线（linger：用户来回切面板不该造成连接抖动）；
 *   - 无 WS 时按需 REST 拉：状态 TTL 5s、注册表 TTL 60s、首次全量
 *     GET /api/states（两个 TTL 共享同一次全量拉取，只是过期口径不同）。
 *
 * ## stale 语义
 *
 * WS 断线 → 标 stale（数据可能已过期，面板如实显示）；重连成功（subscribed）
 * → 全量 resync 后清除。冷启动只有 sqlite 快照（有名单无状态）时 source 为
 * snapshot、恒 stale。
 *
 * ## 为什么不 import net/ 与 electron
 *
 * REST 拉取、WS 会话工厂、时钟、定时器、快照读写全部注入——缓存的全部行为
 * （TTL、计数、linger、resync、stale）因此可以在单测里用假时钟走真，不需要
 * 起任何网络。接线在 home-service.ts。
 */

/** 无 WS 时状态的新鲜度上界。 */
export const HA_STATE_TTL_MS = 5000;
/** 无 WS 时注册表（名单）的新鲜度上界。 */
export const HA_REGISTRY_TTL_MS = 60000;
/** 消费者归零后到拆线的 linger。 */
export const HA_WS_LINGER_MS = 5 * 60 * 1000;
/** 一次工具调用维持消费者身份的滑动窗口。 */
export const HA_TOOL_CONSUMER_MS = 60 * 1000;

/** GET /api/states 单条的原始形态（只取用得到的字段）。 */
export interface RawHaState {
  entity_id: string;
  state: string;
  attributes?: { friendly_name?: string };
}

/** 缓存对外的实体行。 */
export interface CachedEntity {
  id: string;
  name: string;
  domain: string;
  state: string | null;
  area: string | null;
}

/**
 * 缓存的变更通知（home.dashboard 增量推送的数据源；最小追加，不改既有行为）。
 *
 *   - state：一条实体状态增量（state=null 表示实体被移除）；
 *   - link：链路状态翻转。stale=true 断线；stale=false 表示一次全量 resync
 *     完成——断线窗口内丢失的增量只能靠全量补，订阅方收到后应重拉快照。
 */
export type EntityCacheChange =
  | { kind: "state"; entityId: string; state: string | null; name: string | null }
  | { kind: "link"; stale: boolean };

/** WS 会话的窄视图（生产 = HaWsSession；单测给假实现）。 */
export interface EntityCacheSession {
  start(): void;
  stop(): void;
  on(event: "subscribed", handler: () => void): void;
  on(event: "down", handler: () => void): void;
  on(
    event: "state_changed",
    handler: (e: { entityId: string; state: string | null; name: string | null }) => void
  ): void;
  on(
    event: "registry",
    handler: (rows: { entityId: string; name: string | null; area: string | null }[]) => void
  ): void;
}

export interface EntityCacheDeps {
  now(): number;
  /** 定时器注入（返回取消函数）。 */
  schedule(fn: () => void, ms: number): () => void;
  /** REST 全量拉取（生产 = safeLocalFetch GET /api/states + Bearer）。 */
  fetchStates(): Promise<RawHaState[]>;
  /** WS 会话工厂；授权不在 / 未配置时抛错 → 缓存退回纯 REST。 */
  createSession(): EntityCacheSession;
  /** sqlite 冷启动快照。 */
  loadSnapshot(): { entityId: string; name: string; domain: string; area: string | null }[];
  saveSnapshot(rows: { entityId: string; name: string; domain: string; area: string | null }[]): void;
}

interface EntityRecord {
  name: string;
  state: string | null;
  area: string | null;
  /** registry（WS）里用户改过的名字，优先级高于 friendly_name */
  registryName: string | null;
}

function domainOf(entityId: string): string {
  const dot = entityId.indexOf(".");
  return dot > 0 ? entityId.slice(0, dot) : entityId;
}

export class EntityCache {
  private readonly entities = new Map<string, EntityRecord>();
  private stale = true;
  private fromSnapshotOnly: boolean;
  private lastPullAt = 0;
  private lastEventAt: number | null = null;
  private pulling: Promise<void> | null = null;

  private consumers = 0;
  private session: EntityCacheSession | null = null;
  private wsSubscribed = false;
  private cancelLinger: (() => void) | null = null;
  private cancelToolWindow: (() => void) | null = null;
  private toolConsumerHeld = false;
  private disposed = false;

  constructor(private readonly deps: EntityCacheDeps) {
    let snapshot: ReturnType<EntityCacheDeps["loadSnapshot"]> = [];
    try {
      snapshot = deps.loadSnapshot();
    } catch {
      /* 快照读不出就当没有：它只是冷启动加速 */
    }
    for (const row of snapshot) {
      this.entities.set(row.entityId, {
        name: row.name,
        state: null,
        area: row.area,
        registryName: null,
      });
    }
    this.fromSnapshotOnly = snapshot.length > 0;
  }

  // ------------------------------------------------------------ 消费者计数

  /** 登记一个消费者；返回幂等的释放函数。计数 > 0 期间维持 WS 订阅。 */
  acquire(): () => void {
    this.consumers++;
    if (this.cancelLinger) {
      this.cancelLinger();
      this.cancelLinger = null;
    }
    this.ensureSession();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.consumers--;
      if (this.consumers <= 0) this.scheduleLinger();
    };
  }

  /** 一次工具调用 = 滑动 60s 的消费者身份（窗口内反复调用只顺延，不叠加）。 */
  noteToolUse(): void {
    if (this.disposed) return;
    if (this.cancelToolWindow) this.cancelToolWindow();
    if (!this.toolConsumerHeld) {
      this.toolConsumerHeld = true;
      this.releaseToolConsumer = this.acquire();
    }
    this.cancelToolWindow = this.deps.schedule(() => {
      this.cancelToolWindow = null;
      this.toolConsumerHeld = false;
      this.releaseToolConsumer?.();
      this.releaseToolConsumer = null;
    }, HA_TOOL_CONSUMER_MS);
  }

  private releaseToolConsumer: (() => void) | null = null;

  // ------------------------------------------------------------ 变更通知

  private readonly changeListeners = new Set<(e: EntityCacheChange) => void>();

  /** 登记一个变更监听（home.dashboard 增量推送用）；返回幂等的摘除函数。 */
  onChange(listener: (e: EntityCacheChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(e: EntityCacheChange): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener(e);
      } catch {
        /* 监听方的错误不反噬缓存 */
      }
    }
  }

  private scheduleLinger(): void {
    if (this.cancelLinger || this.session === null) return;
    this.cancelLinger = this.deps.schedule(() => {
      this.cancelLinger = null;
      if (this.consumers <= 0) this.teardownSession();
    }, HA_WS_LINGER_MS);
  }

  // ------------------------------------------------------------ WS 会话

  private ensureSession(): void {
    if (this.disposed || this.session !== null) return;
    let session: EntityCacheSession;
    try {
      session = this.deps.createSession();
    } catch {
      return; // 未配置 / 未授权：退回纯 REST，不算错误
    }
    this.session = session;
    session.on("subscribed", () => {
      this.wsSubscribed = true;
      // 重连全量 resync：增量流恢复了，但断线窗口里丢的事件只能靠全量补。
      void this.pullAll().catch(() => undefined);
    });
    session.on("down", () => {
      this.wsSubscribed = false;
      // 断线标 stale：面板与工具都能看到「这份数据可能过期」。
      this.stale = true;
      this.emitChange({ kind: "link", stale: true });
    });
    session.on("state_changed", (e) => {
      this.lastEventAt = this.deps.now();
      // 【追加（home.automation）】先增量维护缓存（既有逻辑），两个出口各补一次
      // notifyStateListeners——订阅者读到的缓存因此恒为已更新的。
      if (e.state === null) {
        this.entities.delete(e.entityId);
        this.emitChange({ kind: "state", entityId: e.entityId, state: null, name: e.name });
        this.notifyStateListeners(e);
        return;
      }
      const existing = this.entities.get(e.entityId);
      if (existing) {
        existing.state = e.state;
        if (e.name !== null) existing.name = e.name;
      } else {
        this.entities.set(e.entityId, {
          name: e.name ?? e.entityId,
          state: e.state,
          area: null,
          registryName: null,
        });
      }
      this.emitChange({ kind: "state", entityId: e.entityId, state: e.state, name: e.name });
      this.notifyStateListeners(e);
    });
    session.on("registry", (rows) => {
      for (const row of rows) {
        const existing = this.entities.get(row.entityId);
        if (!existing) continue;
        existing.registryName = row.name;
        existing.area = row.area;
      }
      this.persistSnapshot();
    });
    session.start();
  }

  // ------------------------------------------------ 状态事件订阅（追加）

  // 【追加（home.automation）】状态触发源的订阅口：把会话的 state_changed 转发
  // 给进程内订阅者（home.automation 的规则引擎挂在这里）。只在 WS 会话活着时
  // 有事件——订阅者若要保证会话活着，用 acquire() 登记消费者（引用计数模型
  // 不变，本段不开旁路）。listener 抛错不打断缓存维护。
  private readonly stateListeners = new Set<
    (e: { entityId: string; state: string | null; name: string | null }) => void
  >();

  /** 订阅 state_changed（返回退订函数）。 */
  onStateChanged(
    fn: (e: { entityId: string; state: string | null; name: string | null }) => void
  ): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private notifyStateListeners(e: {
    entityId: string;
    state: string | null;
    name: string | null;
  }): void {
    for (const fn of this.stateListeners) {
      try {
        fn(e);
      } catch {
        /* 订阅者的错误不反噬缓存 */
      }
    }
  }

  private teardownSession(): void {
    if (this.session === null) return;
    const session = this.session;
    this.session = null;
    this.wsSubscribed = false;
    session.stop();
  }

  // ------------------------------------------------------------ REST 拉取

  private async ensureFresh(ttlMs: number): Promise<void> {
    // WS 活着且没标 stale：增量流就是新鲜度，REST 不必打扰设备。
    if (this.wsSubscribed && !this.stale) return;
    if (!this.fromSnapshotOnly && this.deps.now() - this.lastPullAt < ttlMs) return;
    await this.pullAll();
  }

  /** 全量拉取（并发合流：同一时刻只有一次真拉取）。 */
  private pullAll(): Promise<void> {
    if (this.pulling) return this.pulling;
    this.pulling = (async () => {
      const states = await this.deps.fetchStates();
      const seen = new Set<string>();
      for (const raw of states) {
        if (typeof raw?.entity_id !== "string" || raw.entity_id === "") continue;
        seen.add(raw.entity_id);
        const existing = this.entities.get(raw.entity_id);
        const friendly =
          typeof raw.attributes?.friendly_name === "string" ? raw.attributes.friendly_name : null;
        if (existing) {
          existing.state = typeof raw.state === "string" ? raw.state : null;
          if (friendly !== null) existing.name = friendly;
        } else {
          this.entities.set(raw.entity_id, {
            name: friendly ?? raw.entity_id,
            state: typeof raw.state === "string" ? raw.state : null,
            area: null,
            registryName: null,
          });
        }
      }
      // 全量语义：这次没出现的实体已经不在了（快照遗留的也在此收敛）。
      for (const id of [...this.entities.keys()]) {
        if (!seen.has(id)) this.entities.delete(id);
      }
      this.lastPullAt = this.deps.now();
      const wasStale = this.stale;
      this.stale = false;
      this.fromSnapshotOnly = false;
      this.persistSnapshot();
      // stale → 清除的那一次全量（重连 resync）要通知订阅方：断线窗口内丢的
      // 增量只能靠全量补，面板收到 link stale=false 后重拉快照。
      if (wasStale) this.emitChange({ kind: "link", stale: false });
    })().finally(() => {
      this.pulling = null;
    });
    return this.pulling;
  }

  private persistSnapshot(): void {
    try {
      this.deps.saveSnapshot(this.list());
    } catch {
      /* 快照写失败不影响在线功能 */
    }
  }

  private list(): { entityId: string; name: string; domain: string; area: string | null }[] {
    return [...this.entities.entries()].map(([id, rec]) => ({
      entityId: id,
      name: rec.registryName ?? rec.name,
      domain: domainOf(id),
      area: rec.area,
    }));
  }

  // ------------------------------------------------------------ 查询面

  /**
   * 实体列表（面板快照与 list_entities 工具共用）。REST 失败时不抛：退回
   * 当前缓存（可能是冷启动快照），stale 如实标出。
   */
  async listEntities(filter: {
    domain?: string;
    area?: string;
    query?: string;
    limit: number;
  }): Promise<{ entities: CachedEntity[]; total: number; stale: boolean; source: "live" | "snapshot" }> {
    try {
      await this.ensureFresh(HA_REGISTRY_TTL_MS);
    } catch {
      this.stale = true;
    }
    const query = filter.query?.trim().toLowerCase();
    const rows: CachedEntity[] = [];
    for (const [id, rec] of this.entities) {
      const name = rec.registryName ?? rec.name;
      const domain = domainOf(id);
      if (filter.domain !== undefined && domain !== filter.domain) continue;
      if (filter.area !== undefined && (rec.area ?? "").toLowerCase() !== filter.area.toLowerCase()) {
        continue;
      }
      if (query !== undefined && query !== "") {
        const hay = `${id} ${name}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      rows.push({ id, name, domain, state: rec.state, area: rec.area });
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      entities: rows.slice(0, filter.limit),
      total: rows.length,
      stale: this.stale,
      source: this.fromSnapshotOnly ? "snapshot" : "live",
    };
  }

  /** 按 id 取状态（get_state 工具）。未知 id 以 state null 如实返回。 */
  async getStates(entityIds: readonly string[]): Promise<CachedEntity[]> {
    try {
      await this.ensureFresh(HA_STATE_TTL_MS);
    } catch {
      this.stale = true;
    }
    return entityIds.map((id) => {
      const rec = this.entities.get(id);
      if (!rec) return { id, name: id, domain: domainOf(id), state: null, area: null };
      return {
        id,
        name: rec.registryName ?? rec.name,
        domain: domainOf(id),
        state: rec.state,
        area: rec.area,
      };
    });
  }

  status(): {
    wsStatus: "idle" | "connecting" | "connected" | "stale";
    consumers: number;
    entityCount: number;
    lastEventAt: number | null;
    stale: boolean;
  } {
    const wsStatus =
      this.session === null
        ? this.stale && !this.fromSnapshotOnly && this.lastPullAt > 0
          ? "stale"
          : "idle"
        : this.wsSubscribed
          ? this.stale
            ? "stale"
            : "connected"
          : this.stale && this.lastPullAt > 0
            ? "stale"
            : "connecting";
    return {
      wsStatus,
      consumers: this.consumers,
      entityCount: this.entities.size,
      lastEventAt: this.lastEventAt,
      stale: this.stale,
    };
  }

  /** 全量拆卸（disposeHomeResources）。 */
  dispose(): void {
    this.disposed = true;
    if (this.cancelLinger) this.cancelLinger();
    if (this.cancelToolWindow) this.cancelToolWindow();
    this.cancelLinger = null;
    this.cancelToolWindow = null;
    this.changeListeners.clear();
    this.teardownSession();
  }
}

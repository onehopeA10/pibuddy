/**
 * home.dashboard 的域服务——**纯逻辑，可直接对拍**。
 *
 * ## 它做的唯一一件事：面板消费者信令（基座诚实遗留 #7 的落点）
 *
 * subscribe = 向基座实体缓存登记一个引用计数消费者（cache.acquire，计数 > 0
 * 期间基座维持 WS 实时订阅）+ 挂一个变更监听（cache.onChange → 包信封广播）；
 * unsubscribe = 释放消费者 + 摘监听（归零后基座按 5min linger 拆线）。
 *
 * ## 按 workspaceId 幂等（reload 不泄漏计数）
 *
 * 窗口 reload 后渲染进程内存全没，主进程侧的登记还在。每次 subscribe 都新开
 * 一个消费者的话，一次 reload 就泄漏一个计数、WS 永不拆线。因此每 workspace
 * 至多一个面板消费者：已登记时只刷新快照、沿用当前代际。
 *
 * ## 为什么不 import electron 与 ../home 的装配件
 *
 * 缓存视图与广播函数全部注入——信令的全部行为（计数联动、代际、序号、幂等）
 * 因此可以在单测里用假缓存/假时钟走真。接线在 home-dashboard-ipc.ts。
 */
import {
  createEnvelopeSequencer,
  type DashboardEventPayload,
  type DashboardSnapshot,
  type DashboardSubscribeResult,
  type PiEnvelope,
} from "@pibuddy/contract";

import type { CachedEntity, EntityCacheChange } from "../home/entity-cache.js";

/** 基座实体缓存的窄视图（生产 = EntityCache；单测给假实现）。 */
export interface DashboardCacheView {
  /** 登记一个消费者；返回幂等的释放函数（语义见 entity-cache.acquire） */
  acquire(): () => void;
  /** 登记变更监听；返回幂等的摘除函数 */
  onChange(listener: (e: EntityCacheChange) => void): () => void;
  listEntities(filter: {
    limit: number;
  }): Promise<{ entities: CachedEntity[]; total: number; stale: boolean; source: "live" | "snapshot" }>;
}

export interface HomeDashboardDeps {
  /** 某工作区的基座实体缓存（生产 = homeAssistantService().cache(id)）。 */
  cache(workspaceId: string): DashboardCacheView;
  /** 把一个增量信封广播给全部窗口（生产 = webContents.send）。 */
  broadcast(envelope: PiEnvelope<DashboardEventPayload>): void;
}

interface PanelSubscription {
  cache: DashboardCacheView;
  release: () => void;
  unhook: () => void;
  generation: number;
}

export class HomeDashboardService {
  private readonly subs = new Map<string, PanelSubscription>();
  /** 每 workspace 的历史订阅次数：代际只涨不落，跨订阅仍能丢弃迟到帧。 */
  private readonly generations = new Map<string, number>();

  constructor(private readonly deps: HomeDashboardDeps) {}

  /** 登记面板消费者（幂等）并返回当前快照 + 推送代际。 */
  async subscribe(workspaceId: string, limit: number): Promise<DashboardSubscribeResult> {
    let sub = this.subs.get(workspaceId);
    if (!sub) {
      const cache = this.deps.cache(workspaceId);
      const generation = (this.generations.get(workspaceId) ?? 0) + 1;
      this.generations.set(workspaceId, generation);
      // 信封形状与 terminal:event 同口径：sessionId/runtimeId 借位填 workspace
      // 与包名——面板不是 pi 会话，借用的只是代际 + 序号丢弃规则。
      const sequencer = createEnvelopeSequencer({
        workspaceId,
        sessionId: workspaceId,
        runtimeId: "home.dashboard",
        generation,
      });
      const release = cache.acquire();
      const unhook = cache.onChange((change) => {
        this.deps.broadcast(sequencer.next(toPayload(change)));
      });
      sub = { cache, release, unhook, generation };
      this.subs.set(workspaceId, sub);
    }
    return { generation: sub.generation, snapshot: await this.snapshotOf(sub.cache, limit) };
  }

  /** 释放面板消费者。released=false 表示本来就没有（重复释放幂等）。 */
  unsubscribe(workspaceId: string): { released: boolean } {
    const sub = this.subs.get(workspaceId);
    if (!sub) return { released: false };
    this.subs.delete(workspaceId);
    sub.unhook();
    sub.release();
    return { released: true };
  }

  /** 只读快照（不登记消费者；resync 后面板重拉全量用）。 */
  async snapshot(workspaceId: string, limit: number): Promise<DashboardSnapshot> {
    const held = this.subs.get(workspaceId);
    return this.snapshotOf(held?.cache ?? this.deps.cache(workspaceId), limit);
  }

  /** 当前登记的面板消费者数（单测对账用）。 */
  subscriptionCount(): number {
    return this.subs.size;
  }

  /** 全量拆卸（deactivate / 进程退出）：释放全部面板消费者。 */
  dispose(): void {
    for (const sub of this.subs.values()) {
      sub.unhook();
      sub.release();
    }
    this.subs.clear();
  }

  private async snapshotOf(cache: DashboardCacheView, limit: number): Promise<DashboardSnapshot> {
    const result = await cache.listEntities({ limit });
    return {
      entities: result.entities,
      total: result.total,
      stale: result.stale,
      source: result.source,
    };
  }
}

function toPayload(change: EntityCacheChange): DashboardEventPayload {
  return change.kind === "state"
    ? { type: "state-changed", entityId: change.entityId, state: change.state, name: change.name }
    : { type: "link", stale: change.stale };
}

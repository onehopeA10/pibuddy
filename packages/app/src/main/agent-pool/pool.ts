/**
 * 后台会话池的**主进程接线层**（AGT-101）。
 *
 * 把纯内核 `AgentPoolCore` 接到三样有副作用的东西上：
 *   - **进程启停**：`PoolRuntimeHost` 派生真实后台 runtime。池统一处理准入、
 *     回收与资源上界；崩溃重试按 session origin 留给对应生命周期所有者。
 *   - **观测**：`agentPoolObserver()` 返回一个 `PoolObserver`，由 **pi 域**
 *     （pi-ipc.ts）挂到 supervisor 上，把当前会话的握手 / 事件流 / 退出喂进
 *     内核。**本文件不 import pi 域**——依赖方向必须是 pi → kernel，反过来
 *     就把「pi runtime 可替换」这个前提破坏了（kernel-boundary.spec）。
 *   - **广播**：内核每次变更 → 一份 `PiEnvelope<PoolSnapshot>` 推给全部窗口
 *     （snapshot + sequence，任一窗口据此对齐）。
 *
 * 单例、无 electron 之外的重依赖。IPC handler 在 `agent-pool-ipc.ts`。
 */
import { PUSH_CHANNELS, type PoolCaps, type PoolSnapshot } from "@pibuddy/contract";
import { fanoutToSubscribed } from "../window-fanout.js";

import { log } from "../log.js";
import {
  decidePermission,
  setPermissionInboxHooks,
  setSessionGrantPolicyResolver,
  type PermissionInboxNeed,
} from "../permission/permission-store.js";
import { AgentPoolCore, type PoolObserver } from "./pool-core.js";
import { PoolRuntimeHostImpl } from "./pool-runtime-host.js";
import { readProcessRssMb, type RssReader } from "./process-rss.js";

let instance: AgentPoolCore | null = null;
let tickTimer: NodeJS.Timeout | null = null;

/** 周期性维护节拍（空闲回收 / 权限超时 / 准入排队 / RSS 采样）。分钟级足够，不必密。 */
const TICK_INTERVAL_MS = 15_000;

/** RSS 读取器（单测可替换；生产恒为按平台的真读取）。 */
let rssReader: RssReader = readProcessRssMb;
/** 上一拍采样还没回来就跳过这一拍，绝不让采样堆积。 */
let samplingInFlight = false;

/**
 * 一拍 RSS 采样：把每个在跑会话的常驻内存回填进池的 memoryMb。
 *
 * 这是 `memoryCeilingMb` 真正被对照的那一侧——此前 memoryMb 恒为 0，上界
 * 形同虚设。采样失败只记日志、保留旧值；进程刚退出的 pid 在读取结果里缺席，
 * 由 stopRecord / onCrash 负责清零，这里不猜。
 */
export async function sampleRuntimeMemory(pool: AgentPoolCore = agentPool()): Promise<void> {
  if (samplingInFlight) return;
  const live = pool.livePids();
  if (live.length === 0) return;
  samplingInFlight = true;
  try {
    const rss = await rssReader(live.map((l) => l.pid));
    const samples: Array<{ sessionId: string; memoryMb: number }> = [];
    for (const { sessionId, pid } of live) {
      const mb = rss.get(pid);
      if (mb !== undefined) samples.push({ sessionId, memoryMb: mb });
    }
    pool.recordMemoryBatch(samples);
  } catch (err) {
    log().warn("agent_pool_memory_sample_failed", {
      pids: live.length,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    samplingInFlight = false;
  }
}

function broadcastSnapshot(_snapshot: PoolSnapshot): void {
  // 从内核取一份带信封的快照（sequence 单调、generation 固定）。
  const envelope = agentPool().snapshotEnvelope();
  fanoutToSubscribed(PUSH_CHANNELS.agentPoolEvent, envelope);
}

/**
 * 真实后台派生 host（AGT-101 §7 第一个接线点落地）。
 *
 * `bind` 把池内核的三个回调接上——放在这里而不是构造函数里，是为了打破
 * host ↔ pool 的构造期循环：回调体在**事件到达时**才调 `agentPool()`，那时
 * 单例早已就绪。后台会话事件因此直接喂进池内核的列表态 / 成本 / 生命周期判定，
 * 与前台 supervisor 那条路各喂各的、互不串台。
 */
const runtimeHost = new PoolRuntimeHostImpl();
runtimeHost.bind({
  onReady: (sessionId, info) => agentPool().onRuntimeReady(sessionId, info, Date.now()),
  onEvent: (envelope) => agentPool().observeEnvelope(envelope),
  onExit: (sessionId, reason) => agentPool().handleExit(sessionId, reason, Date.now()),
});

/** 供 child 编排接线（注册结构化事件汇聚 / 下发提示词）。 */
export function poolRuntimeHost(): PoolRuntimeHostImpl {
  return runtimeHost;
}

export function agentPool(): AgentPoolCore {
  if (!instance) {
    instance = new AgentPoolCore({ host: runtimeHost, onChange: broadcastSnapshot });
    setSessionGrantPolicyResolver((sessionId) => instance!.sessionGrantPolicy(sessionId));
    setPermissionInboxHooks({
      onBlocked: (need) => reportPoolPermissionNeed(need),
      onDecided: (need) =>
        instance?.resolveMatchingInbox({
          capabilityId: need.capabilityId,
          permission: need.permission,
          resource: need.resource,
          workspaceId: need.workspaceId,
          sessionId: need.sessionId,
        }),
    });
  }
  return instance;
}

/**
 * 后台 / 子 / task 会话缺权限时的唯一入队口（COR-009）。
 *
 * 前台 focused user 会话仍走渲染层弹窗，不进 inbox。
 */
export function reportPoolPermissionNeed(
  need: PermissionInboxNeed & { now?: number; id?: string }
): void {
  const sessionId = need.sessionId;
  if (!sessionId) return;
  const pool = agentPool();
  if (!pool.isInboxCandidate(sessionId)) return;
  pool.enqueuePermission({
    id: need.id ?? `perm:${sessionId}:${need.capabilityId}:${need.permission}:${need.resource ?? ""}`,
    sessionId,
    capabilityId: need.capabilityId,
    permission: need.permission,
    resource: need.resource,
    now: need.now ?? Date.now(),
  });
}

/**
 * 池的观测者（供 pi 域的 supervisor 挂上）。
 *
 * 三个回调都在池内核里做幂等/防御处理：会话未登记时 observeEnvelope /
 * handleExit 直接早退，因此「事件先于 adopt 到达」不会出错。**本文件不 import
 * pi 域**——由 pi-ipc.ts 调 `supervisor().setPoolObserver(agentPoolObserver())`
 * 完成挂接（依赖方向 pi → kernel）。
 */
export function agentPoolObserver(): PoolObserver {
  const pool = agentPool();
  return {
    onAdopt: (info) => pool.adoptRunning(info, Date.now()),
    onEvent: (envelope) => pool.observeEnvelope(envelope),
    onExit: (info) => pool.handleExit(info.sessionId, info.reason, Date.now()),
  };
}

/**
 * 起周期性维护节拍（空闲回收 / 权限超时 / 准入排队）。装配期调一次。
 */
export function startPoolMaintenance(): void {
  const pool = agentPool();
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      void sampleRuntimeMemory(pool);
      const expired = pool.tick(Date.now());
      // 超时的权限待办（AGT-101 §7 第二个接线点落地）：经 `decidePermission(deny)`
      // 把超时收口到权限引擎——不再只记审计。**绝不自动允许**：这里恒传
      // `disposition:"deny"`，核心根本没有 allow 路径，超时唯一的去向就是拒绝。
      for (const item of expired) {
        log().warn("agent_pool_permission_timeout_denied", {
          sessionId: item.sessionId,
          capabilityId: item.capabilityId,
          permission: item.permission,
        });
        void decidePermission({
          capabilityId: item.capabilityId,
          permission: item.permission,
          resource: item.resource,
          disposition: "deny",
          workspaceId: item.workspaceId,
        }).catch((err) => {
          log().warn("agent_pool_permission_deny_failed", {
            sessionId: item.sessionId,
            detail: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }, TICK_INTERVAL_MS);
    // 维护节拍不该拖住进程退出。
    if (typeof tickTimer.unref === "function") tickTimer.unref();
  }
}

/** 用户设置资源上界。 */
export function setPoolCaps(caps: PoolCaps): void {
  agentPool().setCaps(caps);
}

/** 仅供单测：替换 RSS 读取器（传 null 恢复真读取）。 */
export function __setRssReader(reader: RssReader | null): void {
  rssReader = reader ?? readProcessRssMb;
}

/** 仅供单测：拆掉单例与节拍。 */
export function __resetAgentPool(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  samplingInFlight = false;
  rssReader = readProcessRssMb;
  instance = null;
  setSessionGrantPolicyResolver(null);
  setPermissionInboxHooks(null);
}

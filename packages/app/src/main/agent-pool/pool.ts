/**
 * 后台会话池的**主进程接线层**（AGT-101）。
 *
 * 把纯内核 `AgentPoolCore` 接到三样有副作用的东西上：
 *   - **进程启停**：`PoolRuntimeHost`。本批后台派生尚未落地（child 编排本批
 *     不做），launch 走一条记账占位——真实的后台进程派生在此 host 里补齐即可，
 *     池的准入/回收/崩溃预算无需再改。
 *   - **观测**：`agentPoolObserver()` 返回一个 `PoolObserver`，由 **pi 域**
 *     （pi-ipc.ts）挂到 supervisor 上，把当前会话的握手 / 事件流 / 退出喂进
 *     内核。**本文件不 import pi 域**——依赖方向必须是 pi → kernel，反过来
 *     就把「pi runtime 可替换」这个前提破坏了（kernel-boundary.spec）。
 *   - **广播**：内核每次变更 → 一份 `PiEnvelope<PoolSnapshot>` 推给全部窗口
 *     （snapshot + sequence，任一窗口据此对齐）。
 *
 * 单例、无 electron 之外的重依赖。IPC handler 在 `agent-pool-ipc.ts`。
 */
import { BrowserWindow } from "electron";
import { PUSH_CHANNELS, type PoolCaps, type PoolSnapshot } from "@pibuddy/contract";

import { log } from "../log.js";
import { decidePermission } from "../permission/permission-store.js";
import { AgentPoolCore, type PoolObserver } from "./pool-core.js";
import { PoolRuntimeHostImpl } from "./pool-runtime-host.js";

let instance: AgentPoolCore | null = null;
let tickTimer: NodeJS.Timeout | null = null;

/** 周期性维护节拍（空闲回收 / 权限超时 / 准入排队）。分钟级足够，不必密。 */
const TICK_INTERVAL_MS = 15_000;

function broadcastSnapshot(_snapshot: PoolSnapshot): void {
  // 从内核取一份带信封的快照（sequence 单调、generation 固定）。
  const envelope = agentPool().snapshotEnvelope();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(PUSH_CHANNELS.agentPoolEvent, envelope);
  }
}

/**
 * 真实后台派生 host（AGT-101 §7 第一个接线点落地）。
 *
 * `bind` 把池内核的三个回调接上——放在这里而不是构造函数里，是为了打破
 * host ↔ pool 的构造期循环：回调体在**事件到达时**才调 `agentPool()`，那时
 * 单例早已就绪。后台会话事件因此直接喂进池内核的列表态 / 成本 / 崩溃预算，
 * 与前台 supervisor 那条路各喂各的、互不串台。
 */
const runtimeHost = new PoolRuntimeHostImpl();
runtimeHost.bind({
  onReady: (sessionId, info) => agentPool().onRuntimeReady(sessionId, info),
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
  }
  return instance;
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

/** 仅供单测：拆掉单例与节拍。 */
export function __resetAgentPool(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  instance = null;
}

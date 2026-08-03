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
import { AgentPoolCore, type PoolObserver, type PoolRuntimeHost } from "./pool-core.js";

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

const host: PoolRuntimeHost = {
  launch(req) {
    // 本批：前台会话由既有 pi:start 启动，池经 adoptRunning 纳入，不从这里派生。
    // 后台派生 / child 编排落地时在此调 supervisor.launch(...)。记一条账便于追踪。
    log().info("agent_pool_launch_requested", {
      sessionId: req.sessionId,
      workspaceId: req.workspaceId,
      origin: req.origin,
    });
  },
  stop(sessionId) {
    // 停一个会话进程。当前 supervisor 按 runtimeId / webContents 索引，按 sessionId
    // 的直接停法随后台派生一起落地。这里记账，真实 stop 由接线在后台派生落地时补。
    log().info("agent_pool_stop_requested", { sessionId });
  },
};

export function agentPool(): AgentPoolCore {
  if (!instance) {
    instance = new AgentPoolCore({ host, onChange: broadcastSnapshot });
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
      // 超时的权限待办：本批只记审计（绝不自动允许）。真实 deny 落库在 Git 包 /
      // 连接器带来真实副作用时经 decidePermission(deny) 收口。
      for (const item of expired) {
        log().warn("agent_pool_permission_timeout_denied", {
          sessionId: item.sessionId,
          capabilityId: item.capabilityId,
          permission: item.permission,
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

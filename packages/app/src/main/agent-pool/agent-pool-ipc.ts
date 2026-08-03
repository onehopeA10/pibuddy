/**
 * 后台会话池的 IPC handler（AGT-101）——**恰 4 条通道**。
 *
 * 池是**平台内核**设施（ADR-0002 四层边界表第一行「会话 / runtime」，不可关闭），
 * 四条恒注册、不受任何能力开关影响：把能力全关掉不该连带关掉会话监督面。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 * 观测挂接（supervisor.setPoolObserver）在 pi-ipc.ts 完成（依赖方向 pi → kernel）；
 * 本文件只注册通道并起维护节拍。
 */
import {
  CHANNELS,
  poolDescribeRequestSchema,
  poolFocusRequestSchema,
  poolSetCapsRequestSchema,
  poolStopRequestSchema,
  type InvokeChannel,
  type PoolCaps,
  type PoolDescribeRequest,
  type PoolFocusRequest,
  type PoolSnapshot,
  type PoolStopRequest,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { agentPool, setPoolCaps, startPoolMaintenance } from "./pool.js";

/** 本域注册的全部通道。单测据它断言逐一出现在 ipc-guard 的注册表里。 */
export const AGENT_POOL_CHANNELS: InvokeChannel[] = [
  CHANNELS.agentPoolDescribe,
  CHANNELS.agentPoolFocus,
  CHANNELS.agentPoolStop,
  CHANNELS.agentPoolSetCaps,
];

export function registerAgentPoolIpc(): void {
  startPoolMaintenance();

  registerHandler<PoolDescribeRequest, PoolSnapshot>(
    CHANNELS.agentPoolDescribe,
    poolDescribeRequestSchema,
    () => agentPool().snapshot()
  );

  registerHandler<PoolFocusRequest, PoolSnapshot>(
    CHANNELS.agentPoolFocus,
    poolFocusRequestSchema,
    (payload) => {
      agentPool().setFocused(payload.sessionId);
      return agentPool().snapshot();
    }
  );

  registerHandler<PoolStopRequest, PoolSnapshot>(
    CHANNELS.agentPoolStop,
    poolStopRequestSchema,
    (payload) => {
      agentPool().stopSession(payload.sessionId);
      return agentPool().snapshot();
    }
  );

  registerHandler<PoolCaps, PoolSnapshot>(
    CHANNELS.agentPoolSetCaps,
    poolSetCapsRequestSchema,
    (payload) => {
      setPoolCaps(payload);
      return agentPool().snapshot();
    }
  );
}

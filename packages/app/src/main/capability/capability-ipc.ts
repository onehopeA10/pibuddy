/**
 * 能力与 Profile 的 IPC handler（ADR-0002 第一阶段）——**恰 3 条通道**。
 *
 * 三条都属**平台内核**，因此恒注册、不受任何能力开关影响。反过来做的话，
 * 「把能力全关掉」会连带关掉那个用来把它们打开的入口，而那种状态在界面上
 * 只表现为一个再也点不开的开关。
 *
 * 三条通道的入参里**没有 manifest**：能力集合由 CapabilityRegistry 在装配期
 * 封口，渲染进程只能在已注册的集合里挑一个 id，既塞不进新能力，也改不了
 * 任何一条 manifest 的权限申请（ADR-0002 D3：能力只能申请，不能自行授予；
 * 而渲染进程连申请都改不了）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 */
import {
  CHANNELS,
  capabilityProfileRequestSchema,
  capabilityToggleRequestSchema,
  voidRequestSchema,
  type CapabilityProfileRequest,
  type CapabilityState,
  type CapabilityToggleRequest,
  type InvokeChannel,
} from "@pibuddy/contract";
import { registerHandler } from "../ipc-guard.js";
import {
  describeCapabilities,
  setActiveProfile,
  setCapabilityEnabled,
} from "./capability-catalog.js";

/** 本域注册的全部通道。单测据它断言逐一出现在 ipc-guard 的注册表里。 */
export const CAPABILITY_CHANNELS: InvokeChannel[] = [
  CHANNELS.capabilitiesDescribe,
  CHANNELS.capabilitiesSetProfile,
  CHANNELS.capabilitiesSetEnabled,
];

export function registerCapabilityIpc(): void {
  registerHandler<void, CapabilityState>(
    CHANNELS.capabilitiesDescribe,
    voidRequestSchema,
    () => describeCapabilities()
  );

  registerHandler<CapabilityProfileRequest, CapabilityState>(
    CHANNELS.capabilitiesSetProfile,
    capabilityProfileRequestSchema,
    (payload) => setActiveProfile(payload.profileId)
  );

  registerHandler<CapabilityToggleRequest, CapabilityState>(
    CHANNELS.capabilitiesSetEnabled,
    capabilityToggleRequestSchema,
    (payload) => setCapabilityEnabled(payload.capabilityId, payload.enabled)
  );
}

/**
 * 权限决策的 IPC handler（ADR-0002 D3 / SEC-003）——**恰 4 条通道**。
 *
 * 四条都属**平台内核**（不可关闭），因此恒注册、不受任何能力开关影响：
 * 否则「把能力全关掉」会连带关掉那个用来管理与撤销授权的入口。
 *
 * 本文件同时**装上第五道闸**：`setPermissionGate(gateForChannel)`。这一步之前，
 * ipc-guard 的四道闸一字不变；装上之后，只有权限需求表里的通道才会被决策，
 * 其余一律放行（向后兼容）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 */
import {
  CHANNELS,
  permissionDecideRequestSchema,
  permissionDescribeRequestSchema,
  permissionProbeRequestSchema,
  permissionRevokeRequestSchema,
  type InvokeChannel,
  type PermissionDecideRequest,
  type PermissionDescribeRequest,
  type PermissionProbeRequest,
  type PermissionProbeResponse,
  type PermissionRevokeRequest,
  type PermissionState,
} from "@pibuddy/contract";

import { registerHandler, setPermissionGate } from "../ipc-guard.js";
import {
  decidePermission,
  describePermissions,
  gateForChannel,
  revokePermission,
} from "./permission-store.js";

/** 本域注册的全部通道。单测据它断言逐一出现在 ipc-guard 的注册表里。 */
export const PERMISSION_CHANNELS: InvokeChannel[] = [
  CHANNELS.permissionDescribe,
  CHANNELS.permissionDecide,
  CHANNELS.permissionRevoke,
  CHANNELS.permissionProbe,
];

export function registerPermissionIpc(): void {
  // 装第五道闸。放在 handler 注册前后都可以——它只影响 registerHandler 之后
  // 每一次 invoke 的判定，不影响注册本身。
  setPermissionGate(gateForChannel);

  registerHandler<PermissionDescribeRequest, PermissionState>(
    CHANNELS.permissionDescribe,
    permissionDescribeRequestSchema,
    (payload) => describePermissions(payload.workspaceId)
  );

  registerHandler<PermissionDecideRequest, PermissionState>(
    CHANNELS.permissionDecide,
    permissionDecideRequestSchema,
    (payload) => decidePermission(payload)
  );

  registerHandler<PermissionRevokeRequest, PermissionState>(
    CHANNELS.permissionRevoke,
    permissionRevokeRequestSchema,
    (payload) => revokePermission(payload)
  );

  // 探针：走完前五道闸才会被调到。未授权时第五道闸在这之前就抛错了，
  // 因此这个 handler 被调到本身就是「放行」的证据。
  registerHandler<PermissionProbeRequest, PermissionProbeResponse>(
    CHANNELS.permissionProbe,
    permissionProbeRequestSchema,
    () => ({ ok: true })
  );
}

/**
 * 远程能力主机侧管理面的 IPC handler（connector.remote / REM-101）。
 *
 * 本文件不出现 `ipcMain.handle`：注册一律经 ipc-guard 的 registerHandler（四道闸
 * 写死在那里）。它是能力 manifest 的 `exposure.module`——drift test 据它数「注册
 * 函数体里 registerHandler 了哪几条通道」再与 manifest.channels 对账。
 *
 * **这八条只是主机侧管理面**（开关 / 配对 / 撤销…），走本机主窗口的 IPC。远程
 * 设备的入口是另一套（main/remote 的 HTTP/WS 服务，统一鉴权中间件），二者无任何
 * 共享放行路径。
 */
import {
  CHANNELS,
  remoteDeviceIdRequestSchema,
  remoteSetBindScopeRequestSchema,
  remoteSetDeviceScopeRequestSchema,
  remoteSetEnabledRequestSchema,
  voidRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import {
  cancelPairing,
  createPairingAction,
  describe,
  disposeRemoteResources as disposeRemote,
  revokeDevice,
  rotateDevice,
  setBindScope,
  setDeviceScope,
  setEnabled,
} from "./remote-manager.js";

/** 本域注册的全部通道（导出供单测断言注册面）。 */
export const REMOTE_CHANNELS: InvokeChannel[] = [
  CHANNELS.remoteDescribe,
  CHANNELS.remoteSetEnabled,
  CHANNELS.remoteSetBindScope,
  CHANNELS.remoteCreatePairing,
  CHANNELS.remoteCancelPairing,
  CHANNELS.remoteRevokeDevice,
  CHANNELS.remoteRotateDevice,
  CHANNELS.remoteSetDeviceScope,
];

export function registerRemoteIpc(): void {
  registerHandler(CHANNELS.remoteDescribe, voidRequestSchema, () => describe());
  registerHandler(CHANNELS.remoteSetEnabled, remoteSetEnabledRequestSchema, (payload) =>
    setEnabled(payload.enabled)
  );
  registerHandler(CHANNELS.remoteSetBindScope, remoteSetBindScopeRequestSchema, (payload) =>
    setBindScope(payload.scope)
  );
  registerHandler(CHANNELS.remoteCreatePairing, voidRequestSchema, () => createPairingAction());
  registerHandler(CHANNELS.remoteCancelPairing, voidRequestSchema, () => cancelPairing());
  registerHandler(CHANNELS.remoteRevokeDevice, remoteDeviceIdRequestSchema, (payload) =>
    revokeDevice(payload.deviceId)
  );
  registerHandler(CHANNELS.remoteRotateDevice, remoteDeviceIdRequestSchema, (payload) =>
    rotateDevice(payload.deviceId)
  );
  registerHandler(CHANNELS.remoteSetDeviceScope, remoteSetDeviceScopeRequestSchema, (payload) =>
    setDeviceScope(payload.deviceId, payload.scope, payload.granted)
  );
}

/**
 * 禁用能力 / 退出时的拆卸（D4 规则 4 / manifest teardown: ["listener"]）：停 HTTP/WS
 * 监听 + 断全部活跃连接 + 关 sqlite 句柄。**remote.db 里的设备与配置一个字节都不
 * 动**（D4 规则 5：卸载与删数据是两个动作）。
 */
export function disposeRemoteResources(): Promise<void> {
  return disposeRemote();
}

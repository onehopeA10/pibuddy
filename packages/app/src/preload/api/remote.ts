/**
 * `window.piBuddy.remote`（connector.remote / REM-101）—— 主机侧管理面。
 *
 * 八个方法、八条窄通道。渲染进程能表达的极限是「看状态 / 开关服务 / 切监听范围
 * / 生成配对 / 取消配对 / 撤销 / 轮换 / 授危险 scope」——**没有任何能承载「监听
 * 某个我指定的地址」或「取回某设备 token」的形参**。远程设备的长期 token 只在
 * 配对那一刻经网络发给设备本身，主进程只存 hash，本面拿到的设备视图里一个
 * token 字段都没有。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { RemoteBindScope, RemoteDangerousScope, RemoteState } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const remote = {
  /** 当前远程服务态（开关 / 监听范围 / 地址 / 设备 / 审计）。 */
  describe: () => invoke<RemoteState>(CHANNELS.remoteDescribe),

  /** 开 / 关远程服务（关 = 停监听 + 断全部活跃连接）。 */
  setEnabled: (enabled: boolean) => invoke<RemoteState>(CHANNELS.remoteSetEnabled, { enabled }),

  /** 切换监听范围：loopback（默认，对外零暴露）/ lan（主动开启）。 */
  setBindScope: (scope: RemoteBindScope) =>
    invoke<RemoteState>(CHANNELS.remoteSetBindScope, { scope }),

  /** 生成一次配对（返回的 state.pairing 带一次性 url/code，用一次即失效）。 */
  createPairing: () => invoke<RemoteState>(CHANNELS.remoteCreatePairing),

  /** 取消当前未消费的配对。 */
  cancelPairing: () => invoke<RemoteState>(CHANNELS.remoteCancelPairing),

  /** 撤销一台设备（删 token hash + 立即断其连接）。 */
  revokeDevice: (deviceId: string) =>
    invoke<RemoteState>(CHANNELS.remoteRevokeDevice, { deviceId }),

  /** 轮换一台设备的凭证（旧 token 失效，生成新配对供其重新取 token）。 */
  rotateDevice: (deviceId: string) =>
    invoke<RemoteState>(CHANNELS.remoteRotateDevice, { deviceId }),

  /** 按设备授予 / 收回一个危险 scope（owner 显式操作，默认全关）。 */
  setDeviceScope: (deviceId: string, scope: RemoteDangerousScope, granted: boolean) =>
    invoke<RemoteState>(CHANNELS.remoteSetDeviceScope, { deviceId, scope, granted }),
};

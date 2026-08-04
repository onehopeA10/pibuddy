/**
 * 能力清单：Remote / PWA 远程访问（connector.remote / REM-101）。
 *
 * 四层边界里**唯一会开一个对外网络监听**的能力，因此也是唯一「安全设计的疏忽 =
 * 真实远程攻击面」的能力。它默认对外零暴露（服务默认不监听，开启后默认只绑
 * loopback），LAN 由用户主动开启。
 *
 * ## 为什么 permissions 为空
 *
 * 本能力**不直接**碰工作区 / 子进程 / 出站 / 密钥：它的顶层实现（main/remote）只用
 * node 内置 http/ws/crypto/sqlite 起服务、存设备 hash，看会话 / 发 prompt / 停止 /
 * 读权限一律**复用既有内核设施**（会话中心、pi runtime、后台池、权限引擎），经
 * remote-backend 的接口调用——这些调用没有一处命中 drift 的权限标记
 * （readFile/writeFile/spawn/safeFetch/runGit/shell.open/secret），因此 CapabilityPermission
 * 一条都不需要申请。真正的风险面是那个网络 listener，它由 `runtime.teardown:
 * ["listener"]` + `exposure.dispose` 强制可拆卸，而不是一条权限原子能表达的东西。
 * 长期 token 只存 hash（device-registry），不经 secret-store，故亦无 `secret:` 申请。
 *
 * ## 静态壳的 readFile 不在对账面上
 *
 * PWA 应用壳内嵌为字符串常量（pwa-assets/pwa-content.ts），服务时零 fs 读；且
 * `pwa-assets/` 是子目录，drift 的 capabilitySource 只扫 main/remote 顶层、不递归，
 * 因此服务静态壳这件事与本能力的权限对账互不牵连。
 *
 * 纯数据文件：不 import electron / handler，drift test 直接 import 做对账。
 */
import { CHANNELS, defineCapability, REMOTE_CAPABILITY_ID } from "@pibuddy/contract";

export const remoteCapability = defineCapability({
  manifestVersion: 1,
  id: REMOTE_CAPABILITY_ID,
  version: "1.0.0",
  tier: "connector",
  displayName: "远程访问 (PWA)",
  description:
    "在本机开一个默认只绑 loopback 的 HTTP/WS 服务，配一台设备（QR 一次性 challenge）后即可用手机 / 浏览器 PWA 远程看会话、收实时消息、发 prompt、停止、看后台状态与权限 inbox。默认对外零暴露，LAN 需主动开启；每个入口（HTTP/WS/SSE/file/upload）都过同一套 token + origin/CSRF + 限速 + 尺寸 + 审计；长期 token 只存 hash，可逐台撤销 / 轮换；terminal / 写工作区 / 批权限 / admin 等危险 scope 默认全关，须 owner 在主机上显式授予。",
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  permissions: [],
  channels: [
    CHANNELS.remoteDescribe,
    CHANNELS.remoteSetEnabled,
    CHANNELS.remoteSetBindScope,
    CHANNELS.remoteCreatePairing,
    CHANNELS.remoteCancelPairing,
    CHANNELS.remoteRevokeDevice,
    CHANNELS.remoteRotateDevice,
    CHANNELS.remoteSetDeviceScope,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "connector.remote.panel",
      title: "远程访问",
      module: "renderer/src/components/RemotePanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  // 网络 listener 是本能力唯一的运行期资源，禁用 / 退出必须拆掉（停监听 + 断连接）。
  runtime: { loading: "inline", heavyDependencies: [], teardown: ["listener"] },
  exposure: {
    module: "main/remote/remote-ipc.ts",
    register: "registerRemoteIpc",
    dispose: "disposeRemoteResources",
  },
});

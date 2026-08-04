/**
 * 远程能力的主机侧管理门面（REM-101）。
 *
 * 八条管理 IPC 的实现都收敛在这里：读状态、开关服务、切监听范围、配对、撤销 /
 * 轮换设备、按设备授危险 scope。它持有全进程唯一的 `RemoteServer`，把「配置落库
 * （device-registry）」与「运行期监听（RemoteServer）」两件事拼成一个对渲染进程
 * 呈现的权威快照 `RemoteState`。
 *
 * 安全不变量在这里落地：
 *   - 危险 scope 只能经 `setDeviceScope` 现开现关（schema 已把 scope 限死在危险集）；
 *   - 撤销设备 = 删 token hash **且立即断其活跃连接**（token 在连接层当场失效）；
 *   - 关服务 = 停监听 + 断全部连接。
 */
import { networkInterfaces } from "node:os";

import {
  isDangerousRemoteScope,
  REMOTE_CAPABILITY_ID,
  REMOTE_SAFE_SCOPES,
  type RemoteBindScope,
  type RemoteDangerousScope,
  type RemoteDeviceView,
  type RemoteScope,
  type RemoteState,
} from "@pibuddy/contract";

import { log } from "../log.js";
import { isCapabilityEnabled } from "../capability/capability-state.js";
import {
  closeRemoteRegistry,
  remoteRegistry,
  remoteRegistryExists,
  type RemoteRegistry,
} from "./device-registry.js";
import { productionBackend } from "./remote-backend.js";
import { createPairing } from "./remote-pairing.js";
import { RemoteServer } from "./remote-server.js";

let server: RemoteServer | null = null;

function registry(): RemoteRegistry {
  return remoteRegistry();
}

function ensureServer(): RemoteServer {
  if (!server) {
    server = new RemoteServer(registry(), productionBackend(), {
      info: (event, fields) => log().info(event, fields),
      warn: (event, fields) => log().warn(event, fields),
    });
  }
  return server;
}

/** 该设备当前是否有活跃 WS 连接。 */
function isOnline(deviceId: string): boolean {
  return server?.wsHub().hasDevice(deviceId) ?? false;
}

function deviceViews(reg: RemoteRegistry): RemoteDeviceView[] {
  return reg.listDevices().map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    scopes: d.scopes,
    online: isOnline(d.id),
  }));
}

/**
 * 组装权威快照。配对信息**不含 token**，只含 challenge 承载的 url/code（一次性）。
 * 这里不持久化 pairing（challenge 存 hash 在库里，url/code 只在生成那一刻存在于
 * 内存），因此 describe 时若有活跃 challenge 只报「存在一个未消费配对」而不重发
 * url/code——真正的 url/code 由 `createPairing` 的返回一次性给出。
 */
function buildState(reg: RemoteRegistry, freshPairing: RemoteState["pairing"] = null): RemoteState {
  const srv = server;
  return {
    enabled: reg.isEnabled(),
    bindScope: reg.bindScope(),
    listening: srv?.isListening() ?? false,
    address: srv?.address() ?? null,
    port: srv?.port() ?? null,
    devices: deviceViews(reg),
    pairing: freshPairing,
    audit: reg.recentAudit(30),
  };
}

/** 服务器对外可达的 base URL（loopback 用 127.0.0.1，lan 取第一个非内网 IPv4）。 */
function baseUrl(reg: RemoteRegistry): string | null {
  const srv = server;
  if (!srv || !srv.isListening()) return null;
  const port = srv.port();
  if (reg.bindScope() === "lan") {
    // 从 os 拿一个 LAN 地址，供设备实际可达
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) return `http://${ni.address}:${port}`;
      }
    }
  }
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------- 八条动作

export function describe(): RemoteState {
  return buildState(registry());
}

export async function setEnabled(enabled: boolean): Promise<RemoteState> {
  const reg = registry();
  reg.setEnabled(enabled);
  if (enabled) {
    await ensureServer().start(reg.bindScope());
  } else {
    await server?.stop();
  }
  return buildState(reg);
}

export async function setBindScope(scope: RemoteBindScope): Promise<RemoteState> {
  const reg = registry();
  reg.setBindScope(scope);
  reg.audit("bind_scope_changed", scope, Date.now());
  // 若正在监听，按新范围重启（一键切换范围对用户是一个动作）
  if (server?.isListening()) {
    await ensureServer().start(scope);
  }
  return buildState(reg);
}

export async function createPairingAction(): Promise<RemoteState> {
  const reg = registry();
  // 没有可达的监听就无从配对：顺手把服务按持久范围打开（配对本就意味着开远程）
  if (!server?.isListening()) {
    reg.setEnabled(true);
    await ensureServer().start(reg.bindScope());
  }
  const base = baseUrl(reg);
  if (!base) return buildState(reg);
  const pairing = createPairing(reg, base, Date.now(), null);
  return buildState(reg, pairing);
}

export function cancelPairing(): RemoteState {
  const reg = registry();
  reg.cancelChallenges();
  reg.audit("pairing_cancelled", "", Date.now());
  return buildState(reg);
}

export function revokeDevice(deviceId: string): RemoteState {
  const reg = registry();
  reg.deleteDevice(deviceId);
  reg.audit("device_revoked", deviceId, Date.now());
  // 立即断开该设备的活跃连接（token 在连接层当场失效）
  server?.dropDevice(deviceId);
  return buildState(reg);
}

export async function rotateDevice(deviceId: string): Promise<RemoteState> {
  const reg = registry();
  const device = reg.deviceById(deviceId);
  if (!device) return buildState(reg);
  if (!server?.isListening()) {
    reg.setEnabled(true);
    await ensureServer().start(reg.bindScope());
  }
  const base = baseUrl(reg);
  if (!base) return buildState(reg);
  const pairing = createPairing(reg, base, Date.now(), deviceId);
  return buildState(reg, pairing);
}

export function setDeviceScope(
  deviceId: string,
  scope: RemoteDangerousScope,
  granted: boolean
): RemoteState {
  const reg = registry();
  const device = reg.deviceById(deviceId);
  if (!device) return buildState(reg);
  // 只处理危险 scope（安全 scope 配对时已给）。schema 已限死，这里再兜一层。
  if (!isDangerousRemoteScope(scope)) return buildState(reg);
  const set = new Set<RemoteScope>(device.scopes);
  if (granted) set.add(scope);
  else set.delete(scope);
  // 安全 scope 恒保留（不因误操作丢掉基础能力）
  for (const s of REMOTE_SAFE_SCOPES) set.add(s);
  reg.setDeviceScopes(deviceId, [...set]);
  reg.audit("device_scope_changed", `${deviceId} ${scope}=${granted}`, Date.now());
  return buildState(reg);
}

/**
 * 启动时按持久配置恢复服务（若上次开着）。
 *
 * `remoteRegistryExists()` 先挡一道：从没配过远程的用户，本函数一个字节都不碰
 * （不建 remote.db、不监听），默认对外零暴露。只有确实开过远程的用户，其上次的
 * 选择（含监听范围）才在重启后自动恢复。
 */
export async function restoreRemoteServerIfEnabled(): Promise<void> {
  if (!isCapabilityEnabled(REMOTE_CAPABILITY_ID)) return;
  if (!remoteRegistryExists()) return;
  const reg = registry();
  if (!reg.isEnabled()) return;
  try {
    await ensureServer().start(reg.bindScope());
  } catch (err) {
    log().warn("remote_restore_failed", { error: String(err) });
  }
}

/** 能力禁用 / 应用退出时的拆卸：停监听 + 断连接 + 关库句柄。 */
export async function disposeRemoteResources(): Promise<void> {
  await server?.stop();
  server = null;
  closeRemoteRegistry();
}

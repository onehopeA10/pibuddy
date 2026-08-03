/**
 * 连接器 v1 的 IPC handler（connector.webhook / CON-101）。
 *
 * 本文件不出现 `ipcMain.handle`：注册一律经 ipc-guard 的 registerHandler（四道闸
 * 写死在那里）。它是能力 manifest 的 `exposure.module`——drift test 据它数「注册
 * 函数体里 registerHandler 了哪几条通道」再与 manifest.channels 对账。
 *
 * ## 「经引擎授权」这段接线在这里
 *
 * 出站的第二道关（workspace 是否授权访问该域名）由这里注入给 outbound：默认
 * 实现调用核心 PermissionEngine 的 `evaluate`——**只调用，不改**权限域的任何
 * 逻辑。连接器 manifest 声明 `network:<domain>`，引擎的上界校验（isDeclared）
 * 与授权判定据此对这个 capabilityId 自动生效，无需在 permission 域加任何一行。
 *
 * ## 凭证永不出主进程
 *
 * create / update 携带的完整 URL 经 manager 落进 secret-store；test / send 时
 * 由 outbound 从 secret-store 取出直接喂给 safeFetch。没有任何一条通道能把它
 * 送回渲染进程——connector:list 返回的只有 {domain, configured, last4}。
 */
import {
  CHANNELS,
  connectorCreateRequestSchema,
  connectorIdRequestSchema,
  connectorSendRequestSchema,
  connectorSetEnabledRequestSchema,
  connectorTestRequestSchema,
  connectorUpdateRequestSchema,
  voidRequestSchema,
  type ConnectorResult,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { createLogger, type Logger } from "../logger.js";
import { permissionEngine } from "../permission/permission-store.js";
import { loadConnectorUrl } from "./connector-secret.js";
import {
  createConnector,
  ingestGuard,
  listConnectors,
  removeConnector,
  setConnectorEnabled,
  updateConnector,
} from "./connector-manager.js";
import {
  networkPermissionOf,
  sendThroughConnector,
  type ConnectorOutboundDeps,
} from "./connector-outbound.js";
import { closeConnectorStore, connectorStore } from "./connector-store.js";

/** 本域注册的全部通道（导出供单测断言注册面）。 */
export const CONNECTOR_CHANNELS: InvokeChannel[] = [
  CHANNELS.connectorList,
  CHANNELS.connectorCreate,
  CHANNELS.connectorUpdate,
  CHANNELS.connectorRemove,
  CHANNELS.connectorSetEnabled,
  CHANNELS.connectorTest,
  CHANNELS.connectorSend,
];

let connectorLogger: Logger | null = null;
function log(): Logger {
  if (!connectorLogger) connectorLogger = createLogger("connector");
  return connectorLogger;
}

/**
 * 出站的授权判定：问核心 PermissionEngine「这个 workspace 授权访问该域名了吗」。
 * capabilityId + `network:<domain>` 的上界由连接器 manifest 声明，引擎据此判。
 */
function authorizeNetwork(domain: string, workspaceId: string): boolean {
  const { capabilityId, permission } = networkPermissionOf(domain);
  return permissionEngine().evaluate({ capabilityId, permission, resource: null, workspaceId })
    .allowed;
}

const outboundDeps: ConnectorOutboundDeps = {
  authorizeNetwork,
  loadUrl: loadConnectorUrl,
};

/** 连接自检 / 推送共用的出站入口。永不抛，审计脱敏。 */
async function deliver(
  connectorId: string,
  workspaceId: string,
  text: string,
  kind: "test" | "send"
): Promise<ConnectorResult> {
  const record = connectorStore().get(connectorId);
  if (!record) {
    return {
      ok: false,
      status: null,
      errorCode: "config",
      redactedMessage: "连接器不存在",
      latencyMs: 0,
    };
  }
  if (kind === "send" && !record.enabled) {
    return {
      ok: false,
      status: null,
      errorCode: "config",
      redactedMessage: "连接器已停用",
      latencyMs: 0,
    };
  }
  const result = await sendThroughConnector(record, workspaceId, text, outboundDeps);
  // 审计：只记 connectorId / 域名 / 结果码 / 状态 / 延迟——绝不记 URL 与凭证。
  log().info(`connector_${kind}`, {
    connectorId: record.id,
    domain: record.domain,
    ok: result.ok,
    errorCode: result.errorCode,
    status: result.status,
    latencyMs: result.latencyMs,
  });
  return result;
}

export function registerConnectorIpc(): void {
  registerHandler(CHANNELS.connectorList, voidRequestSchema, () => listConnectors());

  registerHandler(CHANNELS.connectorCreate, connectorCreateRequestSchema, (payload) =>
    createConnector({ kind: payload.kind, displayName: payload.displayName, url: payload.url })
  );

  registerHandler(CHANNELS.connectorUpdate, connectorUpdateRequestSchema, (payload) =>
    updateConnector(payload)
  );

  registerHandler(CHANNELS.connectorRemove, connectorIdRequestSchema, (payload) =>
    removeConnector(payload.connectorId)
  );

  registerHandler(CHANNELS.connectorSetEnabled, connectorSetEnabledRequestSchema, (payload) =>
    setConnectorEnabled(payload.connectorId, payload.enabled)
  );

  registerHandler(CHANNELS.connectorTest, connectorTestRequestSchema, (payload) =>
    deliver(payload.connectorId, payload.workspaceId, "PiBuddy 连接自检 ✅", "test")
  );

  registerHandler(CHANNELS.connectorSend, connectorSendRequestSchema, (payload) =>
    deliver(payload.connectorId, payload.workspaceId, payload.text, "send")
  );
}

/**
 * 禁用能力 / 退出时的拆卸（D4 规则 4）。
 *
 * 关掉 sqlite 句柄（Windows 上 WAL 文件在句柄关掉前删不掉）+ 清空入站守卫的
 * 内存状态（去重环 / 限速窗口）。**connectors.db 与 secret-store 里的凭证一个
 * 字节都不动**（D4 规则 5：卸载与删数据是两个动作）。
 */
export function disposeConnectorResources(): void {
  ingestGuard().reset();
  closeConnectorStore();
}

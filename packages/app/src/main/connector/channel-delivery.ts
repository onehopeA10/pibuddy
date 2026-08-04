/**
 * 渠道收发的共享执行体（基座 connector:* 与三个真实渠道 <平台>:send/receive 共用）。
 *
 * 把「出站怎么穿三关、入站怎么走守卫」收成两个函数，让基座 ipc 与三个平台 ipc
 * 都只做「取 payload → 调这里 → 回结果」，不各自重抄一遍出站 / 入站编排。
 *
 * ## 出站授权按连接器的适配器 capabilityId 判
 *
 * `outboundDepsFor(capabilityId)` 把「问哪个能力的 network 上界」绑进注入的
 * `authorizeNetwork`：基座 connector:send 用连接器自身 kind 的适配器 capabilityId
 * （webhook→connector.webhook、feishu→connector.feishu…），平台 <平台>:send 用本
 * 平台的 capabilityId。两条路径因此对同一个连接器给出一致的授权判定，grant 也落在
 * 同一个 capabilityId 名下，不会出现「基座发按 A 授权、平台发按 B 授权」的分裂。
 *
 * ## 凭证永不出主进程
 *
 * loadUrl 从 secret-store 取完整 URL，只在出站原语内部喂给 safeFetch；审计只记
 * connectorId / kind / 域名 / 结果码，绝不记 URL 与凭证。
 */
import {
  type ConnectorInboundResult,
  type ConnectorResult,
} from "@pibuddy/contract";

import { createLogger, type Logger } from "../logger.js";
import { permissionEngine } from "../permission/permission-store.js";
import { resolveAdapter } from "./adapters/index.js";
import { loadConnectorUrl } from "./connector-secret.js";
import { ingestGuard } from "./connector-manager.js";
import {
  networkPermissionOf,
  sendThroughConnector,
  type ConnectorOutboundDeps,
} from "./connector-outbound.js";
import { connectorStore } from "./connector-store.js";

let connectorLogger: Logger | null = null;
function log(): Logger {
  if (!connectorLogger) connectorLogger = createLogger("connector");
  return connectorLogger;
}

/** 出站依赖：授权判定绑到指定 capabilityId 的 network 上界，凭证从 secret-store 取。 */
export function outboundDepsFor(capabilityId: string): ConnectorOutboundDeps {
  return {
    authorizeNetwork: (domain, workspaceId) => {
      const { permission } = networkPermissionOf(domain);
      return permissionEngine().evaluate({ capabilityId, permission, resource: null, workspaceId })
        .allowed;
    },
    loadUrl: loadConnectorUrl,
  };
}

/**
 * 连接自检 / 主动推送的共享出站。**永不抛**，审计脱敏。
 *
 * `mode`：test 允许对已停用的连接器也发（自检本就是启用前的验证）；send 要求启用。
 */
export async function deliverThrough(
  connectorId: string,
  workspaceId: string,
  text: string,
  mode: "test" | "send"
): Promise<ConnectorResult> {
  const record = connectorStore().get(connectorId);
  if (!record) {
    return { ok: false, status: null, errorCode: "config", redactedMessage: "连接器不存在", latencyMs: 0 };
  }
  if (mode === "send" && !record.enabled) {
    return { ok: false, status: null, errorCode: "config", redactedMessage: "连接器已停用", latencyMs: 0 };
  }
  const capabilityId = resolveAdapter(record.kind).capabilityId;
  const result = await sendThroughConnector(
    record,
    workspaceId,
    text,
    outboundDepsFor(capabilityId)
  );
  log().info(`connector_${mode}`, {
    connectorId: record.id,
    kind: record.kind,
    domain: record.domain,
    ok: result.ok,
    errorCode: result.errorCode,
    status: result.status,
    latencyMs: result.latencyMs,
  });
  return result;
}

/**
 * 一条平台入站事件的准入。**永不抛**。
 *
 * 适配器先按平台结构解析（识别 url_verification 握手、识别「这是不是我们自己发的」
 * 以防回环），再走共享入站守卫的去重 / 限速 / 尺寸判定。
 *
 * v1 的边界：**接受之后不在这里触发 Agent**。真实的入站是「平台把事件 POST 到一个
 * 常驻回调端口」，而 v1 刻意不开这个常驻监听端口（避免引入一个常驻入站攻击面，
 * 见 connector-webhook.manifest 说明）。这条通道让「入站解析 + 四道守卫」这段纯逻辑
 * 可被喂事件跑通；把 accepted 的消息交给 Agent（走 pi:prompt / 后台池）的那一步，
 * 与真实入站端口（含平台签名校验、回调 URL 的 SSRF 防护）一起在后续落地——此处
 * 正是那个触发点会挂上来的位置（如实标注：v1 未接 Agent 触发）。
 */
export function receiveThrough(
  connectorId: string,
  workspaceId: string,
  event: unknown
): ConnectorInboundResult {
  const record = connectorStore().get(connectorId);
  if (!record) {
    return { outcome: "rejected", challenge: null, reason: "malformed", detail: "连接器不存在" };
  }
  const adapter = resolveAdapter(record.kind);
  const parsed = adapter.parseInbound(event);

  if (parsed.type === "challenge") {
    log().info("connector_receive", { connectorId, kind: record.kind, outcome: "challenge" });
    return { outcome: "challenge", challenge: parsed.challenge, reason: null, detail: "url_verification 握手，回声 challenge" };
  }
  if (parsed.type === "malformed") {
    return { outcome: "rejected", challenge: null, reason: "malformed", detail: parsed.detail };
  }

  const verdict = ingestGuard().accept({
    connectorId,
    messageId: parsed.messageId,
    workspaceId,
    fromSelf: parsed.fromSelf,
    text: parsed.text,
    attachmentCount: parsed.attachmentCount,
    attachmentBytes: parsed.attachmentBytes,
    at: Date.now(),
  });
  log().info("connector_receive", {
    connectorId,
    kind: record.kind,
    outcome: verdict.accepted ? "accepted" : "rejected",
    reason: verdict.reason,
  });
  if (verdict.accepted) {
    return { outcome: "accepted", challenge: null, reason: null, detail: "已通过准入，待交给 Agent（v1 未接触发）" };
  }
  return { outcome: "rejected", challenge: null, reason: verdict.reason, detail: verdict.detail };
}

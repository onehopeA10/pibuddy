/**
 * 连接器的编排层（连接器 v1 / CON-101）。
 *
 * 把 connector-store（非敏感配置）与 connector-secret（凭证）缝成一套对上层
 * （IPC）友好的动作：列举 / 创建 / 更新 / 删除 / 启停，返回的一律是**权威快照**
 * （ConnectorView[]）——渲染进程做完任何一个动作立刻拿到全量状态。
 *
 * ## 创建 / 轮换时的域名校验就是 manifest 上界的第一道落地
 *
 * 用户给的 URL 一进来就被拆成「域名 + 完整 URL」。域名若不在
 * `CONNECTOR_SUPPORTED_DOMAINS`（= manifest 声明的 `network:` 白名单）里，创建 /
 * 轮换**当场被拒**（`CONNECTOR_DOMAIN_UNSUPPORTED`）——「未授权域名被拒」在配置
 * 这一步就已经生效，不必等到出站。
 *
 * ## 视图里没有凭证
 *
 * `toView` 逐字段挑：id / kind / 显示名 / 域名 / 启停 / configured / last4。完整
 * URL 一个字符都不出现——它只在 `sendThroughConnector` 里从 secret-store 取出、
 * 直接喂给 safeFetch。
 */
import {
  CONNECTOR_SUPPORTED_DOMAINS,
  type ConnectorView,
} from "@pibuddy/contract";

import {
  clearConnectorUrl,
  describeConnectorUrl,
  saveConnectorUrl,
} from "./connector-secret.js";
import { IngestGuard } from "./connector-ingest.js";
import { hostOf } from "./connector-outbound.js";
import { connectorStore, type ConnectorRecord } from "./connector-store.js";
import { normalizeEndpointUrl } from "../net/outbound-guard.js";

/** 全进程唯一的入站守卫（去重 / 限速 / 防回环状态都在它内存里）。 */
let sharedIngest: IngestGuard | null = null;
export function ingestGuard(): IngestGuard {
  if (!sharedIngest) sharedIngest = new IngestGuard();
  return sharedIngest;
}

/** 把 URL 拆成受支持的域名；不合法 / 不受支持时抛错。 */
function domainFromUrl(url: string): string {
  let host: string;
  try {
    host = hostOf(normalizeEndpointUrl(url));
  } catch {
    throw new Error("CONNECTOR_URL_INVALID: webhook 地址必须是合法的 https:// URL");
  }
  if (!(CONNECTOR_SUPPORTED_DOMAINS as readonly string[]).includes(host)) {
    throw new Error(
      `CONNECTOR_DOMAIN_UNSUPPORTED: ${host} 不在受支持的平台白名单内` +
        `（${CONNECTOR_SUPPORTED_DOMAINS.join(" / ")}）`
    );
  }
  return host;
}

function toView(record: ConnectorRecord): ConnectorView {
  const secret = describeConnectorUrl(record.id);
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    domain: record.domain,
    enabled: record.enabled,
    configured: secret.configured,
    last4: secret.last4,
    createdAt: record.createdAt,
  };
}

/** 全部连接器的权威快照（无凭证）。 */
export function listConnectors(): ConnectorView[] {
  return connectorStore().list().map(toView);
}

/** 创建一个 webhook 连接器：拆域名 → 落配置 → 存凭证。 */
export function createConnector(input: {
  kind: "webhook";
  displayName: string;
  url: string;
}): ConnectorView[] {
  const domain = domainFromUrl(input.url);
  const now = Date.now();
  const record = connectorStore().create(
    { kind: input.kind, displayName: input.displayName, domain },
    now
  );
  // 凭证最后写：写失败（如系统无安全存储）时抛错，连接器记录也一并回滚，
  // 免得留下一条「有配置没凭证」的半截实例。
  try {
    saveConnectorUrl(record.id, input.url);
  } catch (err) {
    connectorStore().delete(record.id);
    throw err;
  }
  return listConnectors();
}

/** 更新一个连接器：改名与 / 或轮换凭证。 */
export function updateConnector(input: {
  connectorId: string;
  displayName?: string;
  url?: string;
}): ConnectorView[] {
  const current = connectorStore().require(input.connectorId);
  const patch: Partial<Pick<ConnectorRecord, "displayName" | "domain">> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.url !== undefined) {
    patch.domain = domainFromUrl(input.url); // 轮换可能换平台，域名随之更新
  }
  if (Object.keys(patch).length > 0) {
    connectorStore().update(current.id, patch, Date.now());
  }
  if (input.url !== undefined) {
    saveConnectorUrl(current.id, input.url);
  }
  return listConnectors();
}

/** 删除一个连接器：清凭证 + 删配置 + 清入站状态。 */
export function removeConnector(connectorId: string): ConnectorView[] {
  connectorStore().require(connectorId);
  clearConnectorUrl(connectorId);
  ingestGuard().forget(connectorId);
  connectorStore().delete(connectorId);
  return listConnectors();
}

/** 启停一个连接器。 */
export function setConnectorEnabled(connectorId: string, enabled: boolean): ConnectorView[] {
  connectorStore().require(connectorId);
  connectorStore().update(connectorId, { enabled }, Date.now());
  return listConnectors();
}

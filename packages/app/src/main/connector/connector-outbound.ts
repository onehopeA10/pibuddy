/**
 * 连接器的出站原语（连接器 v1 / CON-101）。
 *
 * ## 一次出站要连过三道关，缺一不可
 *
 *   1. **域名上界**：目标 host 必须在 manifest 声明的 `network:<domain>` 白名单
 *      里（`CONNECTOR_SUPPORTED_DOMAINS`）。不在 → `domain`，当场拒，连问都不问。
 *   2. **workspace 授权**：该 workspace 必须已经授权访问这个域名。判定交给注入的
 *      `authorizeNetwork`，生产路径上它就是核心 PermissionEngine 的 `evaluate`
 *      （见 `connector-ipc.ts` 的接线）。未授权 → `permission`。**这一关是
 *      「连接器 = 声明 network:<domain> → 经引擎授权」这条链路里「经引擎授权」
 *      的那一段**：拆掉它，未授权的连接器也能往外发，可证伪判据据此成立。
 *   3. **出站守卫**：真正的 HTTP 只走 `net/outbound-guard.ts` 的 safeFetch。它
 *      手动跟随重定向、每一跳都重解析、拦内网 / 环回 / 云元数据地址（SSRF），
 *      并把凭证头在跨源时摘掉。连接器**绝不**自己起一个裸出站调用——`main`
 *      下守卫外的裸出站命中数被结构性断言钉死为 0。
 *
 * ## 为什么依赖是注入的
 *
 * `authorizeNetwork` / `loadUrl` 生产实现分别拖着 electron（PermissionEngine）
 * 与 safeStorage（secret-store）。把它们注入进来，这条出站逻辑本身就能被单测
 * 直接对拍：「有授权 → 发；无授权 → 拒」两个方向都能在不碰 electron 的前提下
 * 跑出来，而需要给 electron 打桩才能跑的判据最后都会变成没人跑的判据。
 *
 * ## 凭证绝不进日志、绝不进返回值
 *
 * `loadUrl` 取回的完整 URL（含密令）只在本文件里直接喂给 safeFetch。safeFetch
 * 抛出的错误不含 URL、不含请求头；这里再兜一层，把任何错误折成一句已脱敏的话。
 */
import {
  CONNECTOR_CAPABILITY_ID,
  CONNECTOR_SUPPORTED_DOMAINS,
  connectorNetworkPermission,
  type ConnectorResult,
} from "@pibuddy/contract";

import {
  OutboundBlockedError,
  OutboundDnsError,
  normalizeEndpointUrl,
  safeFetch,
  type SafeFetchInit,
  type SafeFetchResult,
} from "../net/outbound-guard.js";
import { redactSecrets } from "../logger-redact.js";
import type { ConnectorRecord } from "./connector-store.js";

/** safeFetch 的形状（供依赖注入）。 */
export type ConnectorFetch = (url: string, init?: SafeFetchInit) => Promise<SafeFetchResult>;

export interface ConnectorOutboundDeps {
  /** 该 workspace 是否已被授权访问这个域名（生产路径 = PermissionEngine.evaluate）。 */
  authorizeNetwork(domain: string, workspaceId: string): boolean;
  /** 取回完整 webhook URL（仅主进程内部）。未配置返回 null。 */
  loadUrl(connectorId: string): string | null;
  /** 出站请求原语，默认 safeFetch；单测可注入。 */
  fetch?: ConnectorFetch;
  now?: () => number;
}

/** 单次出站文本的上限：webhook 消息就该短，超了多半是把文件往里塞。 */
export const MAX_OUTBOUND_TEXT = 16 * 1024;

/** 把任意错误折成一句**已脱敏**的话（不含 URL / 凭证）。 */
function redactMessage(input: unknown): string {
  const text =
    input instanceof Error ? input.message : typeof input === "string" ? input : String(input);
  return String(redactSecrets(text));
}

/** 从一条已规范化的 URL 里取 host（小写）。 */
export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** host 是否在 manifest 声明的白名单里。 */
export function isSupportedDomain(host: string): boolean {
  return (CONNECTOR_SUPPORTED_DOMAINS as readonly string[]).includes(host);
}

/**
 * 向一个连接器推送一段文本（自检 / 主动推送共用）。**永不抛**。
 *
 * 返回 `ConnectorResult`，`errorCode` 精确区分被哪一道关挡下，界面据此给出
 * 不同的下一步指引。
 */
export async function sendThroughConnector(
  connector: ConnectorRecord,
  workspaceId: string,
  text: string,
  deps: ConnectorOutboundDeps
): Promise<ConnectorResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  // 默认出站原语写成一次真实的 safeFetch 调用（而不是 `?? safeFetch` 的裸
  // 引用）：连接器的出站必须经守卫，这一点是 drift 权限对账（network → 一次
  // safeFetch 调用）的 grep 目标，也是「守卫外裸出站命中数为 0」的落地。
  const fetchImpl: ConnectorFetch = deps.fetch ?? ((url, init) => safeFetch(url, init));

  const fail = (
    errorCode: ConnectorResult["errorCode"],
    redactedMessage: string,
    status: number | null = null
  ): ConnectorResult => ({
    ok: false,
    status,
    errorCode,
    redactedMessage,
    latencyMs: Math.max(0, now() - started),
  });

  if (text.length > MAX_OUTBOUND_TEXT) {
    return fail("config", `消息过长（上限 ${MAX_OUTBOUND_TEXT} 字）`);
  }

  // 凭证：完整 URL 只从 secret-store 取，绝不来自渲染进程本次调用。
  const url = deps.loadUrl(connector.id);
  if (!url) {
    return fail("config", "还没为这个连接器配置 webhook 地址");
  }

  // 规范化（协议必须 https、剥用户名密码、host 归一化）。这一步的抛错说明
  // 落盘的 URL 本身就不合法，属配置问题。
  let normalized: string;
  let host: string;
  try {
    normalized = normalizeEndpointUrl(url);
    host = hostOf(normalized);
  } catch (err) {
    return fail("config", redactMessage(err));
  }

  // 关 1：域名上界。不在 manifest 白名单 → 直接拒（未授权域名被拒）。
  if (!isSupportedDomain(host)) {
    return fail("domain", `目标域名 ${host} 不在受支持的平台白名单内`);
  }

  // 关 2：workspace 授权（经引擎授权那一段）。
  if (!deps.authorizeNetwork(host, workspaceId)) {
    return fail(
      "permission",
      `当前工作区还没授权访问 ${host}，请先在权限中允许 ${connectorNetworkPermission(host)}`
    );
  }

  // 关 3：safeFetch 出站（SSRF / 内网 / 重定向全在它里面）。
  try {
    const resp = await fetchImpl(normalized, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 防回环标记：我们发出的消息带上它，入站侧据此认出「这是我自己发的」，
        // 不再回灌给 Agent（见 connector-ingest.ts）。
        "x-pibuddy-connector": connector.id,
      },
      body: JSON.stringify({ text }),
    });
    const latencyMs = Math.max(0, now() - started);
    if (resp.ok) {
      return { ok: true, status: resp.status, errorCode: "ok", redactedMessage: "已送达", latencyMs };
    }
    const detail = redactMessage(resp.bodyText).slice(0, 200);
    return {
      ok: false,
      status: resp.status,
      errorCode: "network",
      redactedMessage: `HTTP ${resp.status}${detail ? ` · ${detail}` : ""}`,
      latencyMs,
    };
  } catch (err) {
    // 被出站守卫挡下（内网 / 环回 / 元数据）与「连不上」是两件事：前者是配置
    // 有误或有人拿连接器打内网（SSRF），后者是网络 / 对方服务问题。
    if (err instanceof OutboundBlockedError) {
      return fail("ssrf", redactMessage(err));
    }
    if (err instanceof OutboundDnsError) {
      return fail("network", redactMessage(err));
    }
    return fail("network", redactMessage(err));
  }
}

/**
 * 生产路径的默认授权实现的**接口**：给 connector-ipc 用。
 *
 * 单独声明是为了让「连接器怎么问引擎」这件事有一个可被引用的名字，而不是在
 * ipc 层里内联一段 evaluate 调用。真正的 evaluate 在 connector-ipc 里接
 * （那里才够得着 PermissionEngine 单例）。
 */
export function networkPermissionOf(host: string): {
  capabilityId: string;
  permission: string;
} {
  return {
    capabilityId: CONNECTOR_CAPABILITY_ID,
    permission: connectorNetworkPermission(host),
  };
}

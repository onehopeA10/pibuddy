/**
 * local-network 受控出站车道（SEC-004 的扩展，不是绕过）。
 *
 * ## 与 outbound-guard.ts 的关系：并列车道，公网路径零弱化
 *
 * SEC-004 原文：「若产品允许本地模型，必须让用户显式授予 local-network scope，
 * 不能默认放开」「允许本地网络时也应绑定用户确认的 host/port，而不是放开整个
 * 内网」。本文件就是那两句话的实现：
 *
 *   - 公网车道（outbound-guard.ts / safeFetch）**一个字节不弱化**：它继续拦下
 *     全部私网 / 环回 / 元数据地址；
 *   - 本车道只对「manifest 声明了 `network.local` + 用户对具体 host:port 授权
 *     + 地址确实落在私网段」的目标放行，且目标**只能**是私网——公网地址在
 *     这条车道上反而被拒。两条车道的放行集合不相交，谁也不是谁的旁路。
 *
 * ## 三道关（次序照抄 connector-outbound.ts）
 *
 *   1. **manifest 上界**：能力必须声明过 `network.local`（`deps.isDeclared`）。
 *   2. **授权**：PermissionEngine 对 `host:port` 资源判定（`deps.evaluate`）。
 *      grant 的资源形态由 contract 的 LOCAL_ENDPOINT_RESOURCE_RE 强制，
 *      null-resource 通配在 decidePermission 落库前就被拒——见 permission-store.ts。
 *   3. **地址断言 + 受控请求**：每次请求都重新做 assertLocalPrivateAddress，
 *      端点逐字比对、重定向零容忍、JSON-only、截断、双超时、错误脱敏。
 *
 * 前两关收在唯一构造入口 `authorizeLocalEndpoint`：`AuthorizedLocalEndpoint`
 * 是 brand type，模块外拼不出来，于是「没过三道关就发请求」在类型层就写不出。
 * 依赖注入而不 import electron，与 permission-engine.ts 同理：需要给 electron
 * 打桩才能跑的判据最后都会变成没人跑的判据。
 *
 * ## v1 刻意缩面
 *
 *   - 放行段只有 10/8、172.16/12、192.168/16、127/8。链路本地 169.254/16
 *     （含云元数据）、0.0.0.0/8、CGNAT 100.64/10、224.0.0.0/3（组播+保留+广播）
 *     显式拒绝；**IPv6 全部拒绝**（含 IPv4-mapped）——HA 本地部署以 v4 为绝对
 *     主流，先把可判定的面缩到最小，v6 等有真实需求再单独论证。
 *   - http 明文仅对已授权 host:port 放行（HA 本地无 TLS 是常态）；https 走
 *     系统信任链，不做自签证书例外。
 *
 * ## 结构性断言（test/local-outbound-boundary.spec.ts）
 *
 * 本文件在 outbound-guard.ts 头注释的 rg 排除表里有一行——它是第二个获准
 * 调用 fetch 的文件；守卫外 fetch( 命中数仍恒为 0。import 本文件的模块必须
 * ⊆ {声明 network.local 的能力目录} ∪ {net/ 自身}。
 *
 * ## 残余风险
 *
 * 与 outbound-guard.ts 相同的「解析后校验、再交给 fetch 自己解析一次」TOCTOU
 * 窗口（DNS rebinding 第二跳）。本车道的暴露面比公网车道更小：目标本来就在
 * 私网，rebind 能做到的只是「换到另一个私网地址」，而端点逐字比对钉死了
 * host:port——攻击者控制的 DNS 记录必须先全部落在私网段才能过第一次断言。
 */
import dns from "node:dns";

import { parseLocalEndpointResource } from "@pibuddy/contract";

import {
  MAX_RESPONSE_BYTES,
  OVERALL_TIMEOUT_MS,
  REQUIRED_CONTENT_TYPE,
  OutboundBlockedError,
  OutboundDnsError,
  parseNumericIpForms,
  type FetchFn,
  type LookupFn,
  type ResolvedAddress,
  type SafeFetchInit,
  type SafeFetchResult,
} from "./outbound-guard.js";

/** 本车道的权限原子。 */
export const NETWORK_LOCAL_PERMISSION = "network.local";

/** 私网设备普遍在同一链路上，连不上不该等 5 秒——比公网车道再紧一档。 */
export const LOCAL_CONNECT_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------- 类型层闸门

declare const AUTHORIZED_LOCAL_ENDPOINT_BRAND: unique symbol;

/**
 * 已过前两道关的端点。brand symbol 不导出，模块外写不出这个类型的值——
 * `safeLocalFetch` / `openLocalWebSocket` 的第一个参数因此**只能**来自
 * `authorizeLocalEndpoint`。
 */
export interface AuthorizedLocalEndpoint {
  readonly capabilityId: string;
  /** 小写化后的 host（IPv4 点分或主机名） */
  readonly host: string;
  /** 1-65535 */
  readonly port: number;
  readonly [AUTHORIZED_LOCAL_ENDPOINT_BRAND]: true;
}

/** 授权判定的外部依赖（注入而非 import electron，可直接对拍）。 */
export interface AuthorizeLocalEndpointDeps {
  /** 关 1：该能力的 manifest 是否声明过这条权限（上界，生产路径 = engine.isDeclared）。 */
  isDeclared(capabilityId: string, permission: string): boolean;
  /** 关 2：授权判定（生产路径 = PermissionEngine.evaluate，workspace 上下文由接线层闭包进来）。 */
  evaluate(query: { capabilityId: string; permission: string; resource: string }): {
    allowed: boolean;
    reason: string | null;
  };
}

/**
 * 唯一构造入口：三道关的前两道。
 *
 * 次序与 connector-outbound.ts 一致——上界在授权之前，因此渲染进程即便造出
 * 一条 grant，也越不过 manifest 没声明这一关。
 */
export function authorizeLocalEndpoint(
  capabilityId: string,
  host: string,
  port: number,
  deps: AuthorizeLocalEndpointDeps
): AuthorizedLocalEndpoint {
  const normalizedHost = host.trim().toLowerCase();
  const resource = `${normalizedHost}:${port}`;
  const parsed = parseLocalEndpointResource(resource);
  if (parsed === null) {
    throw new OutboundBlockedError("本地端点不是合法的 host:port");
  }

  // 关 1：manifest 上界。
  if (!deps.isDeclared(capabilityId, NETWORK_LOCAL_PERMISSION)) {
    throw new OutboundBlockedError(
      `能力 "${capabilityId}" 未声明 ${NETWORK_LOCAL_PERMISSION}，拒绝本地出站`
    );
  }

  // 关 2：经引擎授权（对具体 host:port 资源）。
  const decision = deps.evaluate({
    capabilityId,
    permission: NETWORK_LOCAL_PERMISSION,
    resource,
  });
  if (!decision.allowed) {
    throw new OutboundBlockedError(
      `本地端点 ${resource} 未获授权${decision.reason ? `（${decision.reason}）` : ""}`
    );
  }

  return Object.freeze({
    capabilityId,
    host: parsed.host,
    port: parsed.port,
  }) as AuthorizedLocalEndpoint;
}

// ------------------------------------------------------------ 可注入的依赖

const realLookup: LookupFn = async (hostname) => {
  const result = await dns.promises.lookup(hostname, { all: true });
  return result.map((r) => ({ address: r.address, family: r.family }));
};

let lookupImpl: LookupFn = realLookup;
let fetchImpl: FetchFn = (url, init) => fetch(url, init);

/** 仅供单测：替换 DNS 解析与底层 fetch。传 null 恢复真实实现。 */
export function __setLocalOutboundDeps(deps: {
  lookup?: LookupFn | null;
  fetch?: FetchFn | null;
}): void {
  if (deps.lookup !== undefined) lookupImpl = deps.lookup ?? realLookup;
  if (deps.fetch !== undefined) {
    fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  }
}

// ------------------------------------------------------------------ 地址判定

/**
 * 这个 IPv4 地址是否落在本车道的**放行段**里：10/8、172.16/12、192.168/16、127/8。
 *
 * 判定方向与 outbound-guard 的 isBlockedAddress 相反：那边是「不在黑段就放」，
 * 这边是「不在白段就拒」——169.254/16（云元数据）、0.0.0.0/8、100.64/10（CGNAT）、
 * 224.0.0.0/3（组播 + 保留 + 广播）以及一切公网段都因此自然落在拒绝侧，
 * 不需要逐段点名，也就没有「漏点了一段」这种失效方式。
 */
export function isPrivateLocalIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number.parseInt(p, 10);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * host 必须解析到本车道的放行段。
 *
 * 数字 IP 直接判定（不查 DNS）；域名走 lookup(all) 并对**每一条**记录判定——
 * 与 assertPublicAddress 同一手法，只看第一条的话，一个同时返回私网与公网
 * A 记录的域名就能把请求引到公网上去。IPv6（含字面、含解析记录、含
 * IPv4-mapped）在 v1 一律拒绝（见文件头「刻意缩面」）。
 */
export async function assertLocalPrivateAddress(hostname: string): Promise<void> {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "") throw new OutboundBlockedError("本地端点缺少主机名");

  if (host.includes(":")) {
    throw new OutboundBlockedError(`本地车道 v1 不支持 IPv6（${host}）`);
  }

  const numeric = parseNumericIpForms(host);
  if (numeric !== null) {
    if (!isPrivateLocalIpv4(numeric)) {
      throw new OutboundBlockedError(`地址不在本地私网段（10/8、172.16/12、192.168/16、127/8）内（${host}）`);
    }
    return;
  }

  let resolved: ResolvedAddress[];
  try {
    resolved = await lookupImpl(host);
  } catch {
    throw new OutboundDnsError(host);
  }
  if (resolved.length === 0) throw new OutboundDnsError(host);

  for (const record of resolved) {
    if (record.family !== 4 || !isPrivateLocalIpv4(record.address)) {
      throw new OutboundBlockedError(
        `域名解析结果不全在本地私网段内，拒绝本地出站（${host}）`
      );
    }
  }
}

// -------------------------------------------------------------- safeLocalFetch

/**
 * local 车道的唯一 HTTP 原语。
 *
 * 判定链（每次调用完整走一遍）：
 *   ① `path` 相对已授权端点解析成 URL：协议只认 http:/https:，剥掉用户名密码
 *      （URL 凭据会被 fetch 折成 Authorization: Basic，等于第二条凭据通道）；
 *   ② host:port 与授权端点**逐字相等**（缺省端口按协议补 80/443）——`path`
 *      写成完整 URL 也逃不出端点，这一条就是「绑定用户确认的 host/port」；
 *   ③ assertLocalPrivateAddress：字面 IP 或 DNS 解出的每条记录都必须在私网段；
 *   ④ redirect:"manual" 且任何 3xx 直接拒——本车道**零重定向**。公网车道还肯
 *      逐跳重验，这里连一跳都不给：私网设备把你重定向到别处，本身就是异常；
 *   ⑤ JSON-only、2MB 截断、connect 3s / overall 60s、错误脱敏。
 *
 * http 明文仅因端点已被用户逐一确认才可接受（HA 本地无 TLS 是常态）；
 * https 走系统信任链，不做自签证书例外。
 */
export async function safeLocalFetch(
  endpoint: AuthorizedLocalEndpoint,
  path: string,
  init: SafeFetchInit = {}
): Promise<SafeFetchResult> {
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), OVERALL_TIMEOUT_MS);

  try {
    // ① URL 合法性 + 协议 + 剥凭据。
    let url: URL;
    try {
      url = new URL(path, `http://${endpoint.host}:${endpoint.port}/`);
    } catch {
      throw new OutboundBlockedError("本地请求路径不是合法的 URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new OutboundBlockedError(`本地车道只允许 http/https（实际 ${url.protocol}）`);
    }
    url.username = "";
    url.password = "";
    url.hash = "";

    // ② 端点逐字比对（缺省端口按协议补齐）。
    const effectivePort = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
    if (url.hostname !== endpoint.host || effectivePort !== String(endpoint.port)) {
      throw new OutboundBlockedError(
        `目标 ${url.hostname}:${effectivePort} 与授权端点 ${endpoint.host}:${endpoint.port} 不符`
      );
    }

    // ③ 地址断言（每次请求重跑，授权早于请求可能已隔了很久）。
    await assertLocalPrivateAddress(endpoint.host);

    // ④⑤ 单跳请求。
    const response = await fetchOnce(url.href, init, overall.signal);
    if (response.status >= 300 && response.status < 400) {
      throw new OutboundBlockedError(
        `本地车道不跟随任何重定向（HTTP ${response.status}）`
      );
    }
    return await finish(response);
  } catch (err) {
    throw sanitize(err);
  } finally {
    clearTimeout(overallTimer);
  }
}

/** 单跳请求：connect 级超时独立 controller，与 overall 组合（同 outbound-guard.fetchOnce）。 */
async function fetchOnce(
  url: string,
  init: SafeFetchInit,
  overallSignal: AbortSignal
): Promise<Response> {
  const connect = new AbortController();
  const connectTimer = setTimeout(() => connect.abort(), LOCAL_CONNECT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: init.method ?? "GET",
      headers: { ...(init.headers ?? {}) },
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.any([connect.signal, overallSignal]),
    });
  } finally {
    // fetch 在收到响应头时 resolve，这个定时器天然是「连接 + 首字节」的上限。
    clearTimeout(connectTimer);
  }
}

/** 校验 content-type、按上限读 body（判定与公网车道完全一致）。 */
async function finish(response: Response): Promise<SafeFetchResult> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith(REQUIRED_CONTENT_TYPE)) {
    throw new OutboundBlockedError(
      `响应类型不受支持（期望 ${REQUIRED_CONTENT_TYPE}，实际 ${contentType || "(空)"}）`
    );
  }

  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new OutboundBlockedError("响应体超过上限");
  }

  const bodyText = await readCapped(response);
  return { status: response.status, ok: response.ok, bodyText };
}

/**
 * 流式累计到上限就断开。
 *
 * 自持实现：outbound-guard.ts 的 readCapped 未导出（它是公网车道的私有工具，
 * 导出会扩大那份「一个字节不动」文件的公共面）。逻辑与其逐行同构——先
 * `await resp.text()` 再判长度的话，几百 MB 已经在内存里了。
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new OutboundBlockedError("响应体超过上限");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已经断了就算了 */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * 统一脱敏（同 outbound-guard.sanitize）：非本模块自己抛的错误一律换成一句
 * 不含 URL / 请求头的话——本地端点地址同样会进日志与界面提示。
 */
function sanitize(err: unknown): Error {
  if (err instanceof OutboundBlockedError || err instanceof OutboundDnsError) {
    return err;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error("OUTBOUND_TIMEOUT: 本地请求超时");
  }
  return new Error("OUTBOUND_FAILED: 本地出站请求失败（详情已脱敏）");
}

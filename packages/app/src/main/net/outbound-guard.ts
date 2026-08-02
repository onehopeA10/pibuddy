/**
 * 全仓唯一的出站 HTTP 原语（CT-08 / SEC-004）。
 *
 * ## 为什么必须唯一
 *
 * 收敛前 `ipc.ts` 里那一行 `await fetch(\`${base}/audio/transcriptions\`, …)`
 * 的 `base` 完全来自渲染进程，除了去掉尾斜杠零处理：没有协议校验、没有主机
 * 判定、不拦 `169.254.169.254`，而且把 `Authorization: Bearer <key>` 一并送
 * 过去。渲染进程里任意一段被注入的 JS 都能借它读云元数据、扫内网、顺手偷走
 * 用户的 API key。
 *
 * 只要仓库里存在第二条出站路径，这里的所有判定就都是可绕过的。因此结构性
 * 断言写死为：
 *
 *     rg --no-filename -c '\bfetch\(' packages/app/src/main \
 *        -g '*.ts' -g '!net/outbound-guard.ts' | awk '{s+=$1} END{print s+0}'   # 必须为 0
 *
 * ## 判定链
 *
 *   normalizeEndpointUrl —— 协议必须 https、剥掉 URL 里的用户名密码、host
 *                           转小写与 punycode、数字形态 IP 归一化
 *   assertPublicAddress  —— 数字 IP 直接判定；域名先 dns.lookup(all) 再逐个
 *                           判定（这才拦得住 DNS rebinding 的第一跳）
 *   safeFetch            —— redirect:"manual" 手动跳，**每跳重跑上面两步**；
 *                           connect/overall 两级超时；响应体按上限截断；
 *                           content-type 必须是 JSON；错误一律脱敏
 *
 * ## 残余风险（记在 doc/threat-model.md）
 *
 * 本实现是「解析后校验、再交给 fetch 自己解析一次」，两次解析之间存在
 * TOCTOU 窗口 —— 恶意 DNS 可以在第二次解析时返回内网地址（经典 DNS
 * rebinding）。彻底封死需要用自定义 lookup 把已校验的 IP 钉死给连接层，
 * 那是后续改进方向；当前实现拦得住「域名本身就解析到内网」与「重定向到
 * 内网」这两类现实攻击面。
 */
import dns from "node:dns";

/** 单次响应体上限：2MB。转写结果撑死几 KB，多出来的只可能是打内存。 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** 连接 + 收到响应头的上限（ms）。内网扫描靠的就是「连不上会挂很久」。 */
export const CONNECT_TIMEOUT_MS = 5000;
/** 整个请求（含收完 body）的上限（ms）。 */
export const OVERALL_TIMEOUT_MS = 60000;
/** 最多跟随的重定向跳数。 */
export const MAX_REDIRECTS = 3;
/** 唯一接受的响应类型前缀。 */
export const REQUIRED_CONTENT_TYPE = "application/json";

/** 云厂商元数据端点。放成具名常量是为了让「有没有拦它」这件事可被 grep。 */
export const CLOUD_METADATA_IPV4 = "169.254.169.254";

/** 统一的拒绝码。界面文案与日志都认这一个前缀。 */
export const OUTBOUND_BLOCKED = "OUTBOUND_BLOCKED";

export class OutboundBlockedError extends Error {
  constructor(reason: string) {
    super(`${OUTBOUND_BLOCKED}: ${reason}`);
    this.name = "OutboundBlockedError";
  }
}

/**
 * 解析失败与「地址被拦」必须可区分（否则离线时用户会以为自己被安全策略挡了）。
 * 它刻意**不**继承 OutboundBlockedError。
 */
export class OutboundDnsError extends Error {
  constructor(hostname: string) {
    super(`OUTBOUND_DNS_FAILED: 无法解析主机名 ${hostname}`);
    this.name = "OutboundDnsError";
  }
}

// ------------------------------------------------------------ 可注入的依赖

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const realLookup: LookupFn = async (hostname) => {
  const result = await dns.promises.lookup(hostname, { all: true });
  return result.map((r) => ({ address: r.address, family: r.family }));
};

let lookupImpl: LookupFn = realLookup;
let fetchImpl: FetchFn = (url, init) => fetch(url, init);

/** 仅供单测：替换 DNS 解析与底层 fetch。传 null 恢复真实实现。 */
export function __setOutboundDeps(deps: {
  lookup?: LookupFn | null;
  fetch?: FetchFn | null;
}): void {
  if (deps.lookup !== undefined) lookupImpl = deps.lookup ?? realLookup;
  if (deps.fetch !== undefined) {
    fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  }
}

// -------------------------------------------------------- 数字形态 IP 归一化

/**
 * 把 inet_aton 家族的各种写法折成点分十进制，非数字形态返回 null。
 *
 * 需要覆盖的四类（全部等于 127.0.0.1）：
 *   2130706433    32 位十进制
 *   0x7f000001    十六进制
 *   0177.0.0.1    八进制分段
 *   127.1         省略中间段（最后一段吃掉剩余字节）
 *
 * WHATWG URL 自己也做这套归一化，所以正常路径上这个函数多半是幂等的；
 * 但 assertPublicAddress 会被 endpoints.ts 拿裸主机名直接调用，那条路上
 * 没有 URL 解析器兜底，这里就是唯一的一道。
 */
export function parseNumericIpForms(host: string): string | null {
  const raw = host.trim();
  if (raw === "" || raw.includes(":")) return null;

  const parts = raw.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    const value = parseIntegerPart(part);
    if (value === null) return null;
    values.push(value);
  }

  // 前 n-1 段各占一个字节，最后一段吃掉剩下的字节数
  const tailBytes = 4 - (values.length - 1);
  const tailMax = tailBytes >= 4 ? 0xffffffff : 256 ** tailBytes - 1;
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i]! > 0xff) return null;
  }
  const tail = values[values.length - 1]!;
  if (tail > tailMax) return null;

  let numeric = tail;
  for (let i = 0; i < values.length - 1; i++) {
    numeric += values[i]! * 256 ** (3 - i);
  }
  if (numeric > 0xffffffff) return null;

  return [
    (numeric >>> 24) & 0xff,
    (numeric >>> 16) & 0xff,
    (numeric >>> 8) & 0xff,
    numeric & 0xff,
  ].join(".");
}

/** 单段：0x 前缀按十六进制、0 前缀按八进制、其余十进制。非法返回 null。 */
function parseIntegerPart(part: string): number | null {
  if (part === "") return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
  if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
  return null;
}

// ------------------------------------------------------------------ 地址判定

/** IPv4 点分十进制 → 四个字节，失败返回 null。 */
function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * 这个地址是否落在「不许出站」的段里。
 *
 * IPv4：0.0.0.0/8、10.0.0.0/8、100.64.0.0/10（CGNAT）、127.0.0.0/8、
 *       169.254.0.0/16（含 169.254.169.254 云元数据）、172.16.0.0/12、
 *       192.168.0.0/16、224.0.0.0/4 组播、240.0.0.0/4 保留
 * IPv6：::1 环回、:: 未指定、fc00::/7 ULA、fe80::/10 链路本地；
 *       ::ffff: 前缀的 IPv4-mapped 地址**先解包再按 IPv4 重判**（否则
 *       `[::ffff:127.0.0.1]` 会当成一个普通的公网 v6 地址放过去）
 */
export function isBlockedAddress(address: string): boolean {
  let addr = address.trim().toLowerCase();
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  // 去掉 IPv6 的 zone id（fe80::1%eth0）
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);

  if (addr.includes(":")) {
    // IPv4-mapped / IPv4-compatible：解包成 IPv4 后重新判定
    const mapped = /^::ffff:(?:0:)?([0-9a-f.:]+)$/.exec(addr);
    if (mapped) {
      const inner = mapped[1]!;
      if (inner.includes(".")) return isBlockedAddress(inner);
      // ::ffff:7f00:1 这种十六进制写法
      const hex = inner.split(":");
      if (hex.length === 2) {
        const hi = Number.parseInt(hex[0]!, 16);
        const lo = Number.parseInt(hex[1]!, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isBlockedAddress(
            [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".")
          );
        }
      }
      return true; // 解不动的 mapped 地址一律拦
    }
    if (addr === "::1" || addr === "::") return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]?:/.test(addr)) return true; // fe80::/10
    return false;
  }

  const octets = ipv4Octets(addr);
  if (!octets) return true; // 既不是合法 v4 也不是 v6：不认识的一律拦
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // 组播 + 保留
  return false;
}

/**
 * 主机名必须解析到公网地址。
 *
 * 数字 IP 直接判定（不查 DNS）；域名走 `dns.promises.lookup(host,{all:true})`
 * 并对**每一条**记录判定 —— 只看第一条的话，一个同时返回公网与内网 A 记录
 * 的域名就能穿过去。
 */
export async function assertPublicAddress(hostname: string): Promise<void> {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") throw new OutboundBlockedError("端点缺少主机名");

  const numeric = parseNumericIpForms(host);
  const literal = numeric ?? (host.includes(":") ? host : null);
  if (literal !== null) {
    if (isBlockedAddress(literal)) {
      throw new OutboundBlockedError(`不允许访问内网 / 环回 / 元数据地址（${host}）`);
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
    if (isBlockedAddress(record.address)) {
      throw new OutboundBlockedError(`不允许访问内网 / 环回 / 元数据地址（${host}）`);
    }
  }
}

// ------------------------------------------------------------------ URL 规范化

/**
 * 规范化并校验一个端点 URL，返回可直接交给 fetch 的字符串。
 *
 * 只做「结构」层面的判定（不查 DNS），因此可以在 UI 的即时校验里同步调用。
 * 地址层面的判定归 assertPublicAddress。
 */
export function normalizeEndpointUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OutboundBlockedError("端点地址不是合法的 URL");
  }

  if (url.protocol !== "https:") {
    throw new OutboundBlockedError("只允许 HTTPS 端点，请把地址改成 https:// 开头");
  }
  // URL 里的用户名密码会被 fetch 转成 Authorization: Basic，等于第二条凭据
  // 通道；一律剥掉而不是报错（用户多半是从别处粘来的）。
  url.username = "";
  url.password = "";
  // hostname 的小写与 punycode 由 WHATWG URL 自己完成；数字形态 IP 再折一次，
  // 保证下游拿到的永远是点分十进制。
  const numeric = parseNumericIpForms(url.hostname);
  if (numeric) url.hostname = numeric;
  url.hash = "";
  return url.href;
}

// ------------------------------------------------------------------- safeFetch

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit["body"];
}

export interface SafeFetchResult {
  status: number;
  ok: boolean;
  /** 已按 MAX_RESPONSE_BYTES 截断校验过的响应正文 */
  bodyText: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** 跨源重定向时必须丢掉的请求头。 */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * 全仓唯一的出站请求。
 *
 * 抛出的错误**不含完整 URL、不含任何请求头**：出站失败的报错会一路冒泡到
 * 界面提示与日志，把 `https://host/v1/…?key=…` 或 `Authorization` 原样带进去
 * 就等于自己把凭据写到了两个地方。
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchInit = {}
): Promise<SafeFetchResult> {
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), OVERALL_TIMEOUT_MS);

  try {
    let currentUrl = normalizeEndpointUrl(rawUrl);
    await assertPublicAddress(new URL(currentUrl).hostname);
    let origin = new URL(currentUrl).origin;
    let headers = { ...(init.headers ?? {}) };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetchOnce(currentUrl, init, headers, overall.signal);

      if (!REDIRECT_STATUS.has(response.status)) {
        return await finish(response);
      }

      const location = response.headers.get("location");
      if (!location) throw new OutboundBlockedError("重定向响应缺少 Location");

      // 每一跳都必须重新走完整条判定链：只在第一跳校验，等于给
      // 「先应答 302，再指向 169.254.169.254」留了一条直通车。
      const next = new URL(location, currentUrl).href;
      currentUrl = normalizeEndpointUrl(next);
      await assertPublicAddress(new URL(currentUrl).hostname);

      const nextOrigin = new URL(currentUrl).origin;
      if (nextOrigin !== origin) {
        // 换源了就把凭据头摘掉：跟着跳过去等于把密钥交给下一台主机
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([k]) => !CREDENTIAL_HEADERS.includes(k.toLowerCase())
          )
        );
        origin = nextOrigin;
      }
    }

    throw new OutboundBlockedError(`重定向超过 ${MAX_REDIRECTS} 跳`);
  } catch (err) {
    throw sanitize(err);
  } finally {
    clearTimeout(overallTimer);
  }
}

/** 单跳请求：connect 级超时用一个独立的 controller 与 overall 组合。 */
async function fetchOnce(
  url: string,
  init: SafeFetchInit,
  headers: Record<string, string>,
  overallSignal: AbortSignal
): Promise<Response> {
  const connect = new AbortController();
  const connectTimer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.any([connect.signal, overallSignal]),
    });
  } finally {
    // fetch 在收到**响应头**时就 resolve，因此这个定时器天然是
    // 「连接 + 首字节」的上限；body 的读取由 overall 兜底。
    clearTimeout(connectTimer);
  }
}

/** 校验 content-type、按上限读 body。 */
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
 * 不能先 `await resp.text()` 再判长度 —— 那时候几百 MB 已经在内存里了，
 * 上限就成了事后诸葛。
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
 * 统一脱敏：非本模块自己抛的错误一律换成一句不含任何上下文的话。
 *
 * undici 的原始错误消息里会带完整 URL（`fetch failed … https://host/path?…`），
 * 直接冒泡等于把端点与查询串写进日志和界面。
 */
function sanitize(err: unknown): Error {
  if (err instanceof OutboundBlockedError || err instanceof OutboundDnsError) {
    return err;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error("OUTBOUND_TIMEOUT: 请求超时");
  }
  return new Error("OUTBOUND_FAILED: 出站请求失败（详情已脱敏）");
}

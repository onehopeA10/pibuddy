/**
 * 远程访问的**统一鉴权中间件** —— 纯逻辑，不 import electron / http / sqlite。
 *
 * ## 为什么必须是「一个函数、所有入口都过」
 *
 * 审计明确点名的坑是「只保护 WS 而漏了 HTTP」。防它的唯一结构性手段是：让
 * HTTP 路由 / WS 升级 / SSE / raw file / upload **每一个入口**都调用同一个
 * `authorize()`，而不是各自手写一段校验。哪个入口漏调它，对账（remote-auth.spec）
 * 就红——判据钉在「每个入口的 handler 第一步都是 authorize(」上，而不是钉在
 * 某一条路径的行为上。
 *
 * ## 五件事，顺序写死
 *
 *   1. **尺寸**：bodyBytes 超上限直接 413，先于一切——大体先挡，省得后面白算。
 *   2. **限流**：按来源地址滑动窗口，防被攻陷设备无限刷。
 *   3. **origin/CSRF**：带 Origin 头时必须在允许集合内（同源的 PWA 天然通过）；
 *      不带 Origin（curl / 原生客户端）放行——CSRF 只存在于浏览器，浏览器必带
 *      Origin。且鉴权用 **bearer token**（非 cookie），攻击站点读不到 token，
 *      CSRF 在「无环境凭据」这一点上结构性不成立，origin 校验是第二重防御。
 *   4. **token**：Authorization: Bearer（HTTP）或 Sec-WebSocket-Protocol 副协议
 *      （WS，浏览器唯一能在握手里带的自定义值）。hash 后按设备表 O(1) 查；
 *      查不到 = 未配对，拒。token 原文既不进日志，也不进任何返回。
 *   5. **scope**：该入口要求的 scope 必须在设备持有集合里。危险 scope 默认不在，
 *      故未经 owner 授予的设备访问危险入口一律被这一步挡下。
 *
 * 任一步失败即返回 `{ ok:false, status, reason }`，调用方据此回状态码并审计；
 * **绝不 fail-open**：没有「先放过去再说」。
 */
import type { RemoteScope } from "@pibuddy/contract";

/** 鉴权成功后交给上层的设备。 */
export interface AuthDevice {
  id: string;
  name: string;
  scopes: RemoteScope[];
}

/** 每一个入口构造的鉴权输入。 */
export interface AuthInput {
  /** 入口种类（审计 / 排障用） */
  entry: "http" | "ws" | "sse" | "file" | "upload";
  method: string;
  /** 请求 Origin 头；不带为 null */
  origin: string | null;
  /** 已从 Authorization / Sec-WebSocket-Protocol 解析出的原始 token；不带为 null */
  token: string | null;
  /** 来源地址（限流键） */
  remoteAddr: string;
  /** 该入口要求的 scope；null 表示只需已配对（不校验具体 scope） */
  requiredScope: RemoteScope | null;
  /** 请求体字节数（尺寸闸） */
  bodyBytes: number;
  /** 该入口的体积上限 */
  maxBytes: number;
}

export interface AuthDeps {
  pepper(): string;
  /** 按 tokenHash 查设备；未配对返回 null */
  deviceByTokenHash(tokenHash: string): AuthDevice | null;
  /** 允许的 Origin 集合（随监听地址 / 端口而变） */
  allowedOrigins(): readonly string[];
  /** 限流判定（true=放行并记一次） */
  rateAllow(key: string, now: number): boolean;
  /** 生成 tokenHash（与 device-registry.hashSecret 同实现，经 DI 传入以保持本文件纯净） */
  hashToken(pepper: string, token: string): string;
  now(): number;
}

export interface AuthResult {
  ok: boolean;
  status: number;
  reason: string;
  device: AuthDevice | null;
}

const OK = (device: AuthDevice): AuthResult => ({ ok: true, status: 200, reason: "ok", device });
const DENY = (status: number, reason: string): AuthResult => ({ ok: false, status, reason, device: null });

/**
 * 从一次 HTTP 请求头里解析 bearer token。
 *
 * WS 握手走 `Sec-WebSocket-Protocol`（约定第一个副协议是 "pibuddy.remote"，第二个
 * 是 token）：这是浏览器 WebSocket API 唯一能在握手阶段携带的自定义值。用它而不是
 * URL query 承载 token，是因为 query 会进各种访问日志——token 绝不进日志。
 */
export function parseBearer(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : null;
}

export const WS_SUBPROTOCOL = "pibuddy.remote";

/** 从 Sec-WebSocket-Protocol 头里取 token（第二个副协议）。 */
export function parseWsToken(secWebSocketProtocol: string | null | undefined): string | null {
  if (!secWebSocketProtocol) return null;
  const parts = secWebSocketProtocol.split(",").map((s) => s.trim());
  const idx = parts.indexOf(WS_SUBPROTOCOL);
  if (idx < 0) return null;
  // 约定 token 紧跟在 subprotocol 之后
  const token = parts[idx + 1];
  return token && token.length > 0 ? token : null;
}

/**
 * 统一鉴权。五道闸顺序写死，任一失败即拒（默认拒绝，绝不 fail-open）。
 */
export function authorize(input: AuthInput, deps: AuthDeps): AuthResult {
  const now = deps.now();

  // 闸 1：尺寸
  if (input.bodyBytes > input.maxBytes) {
    return DENY(413, `payload too large (${input.bodyBytes} > ${input.maxBytes})`);
  }

  // 闸 2：限流（按来源地址 + 入口）
  if (!deps.rateAllow(`${input.remoteAddr}#${input.entry}`, now)) {
    return DENY(429, "rate limited");
  }

  // 闸 3：origin / CSRF
  if (input.origin !== null && input.origin !== "null") {
    const allowed = deps.allowedOrigins();
    if (!allowed.includes(input.origin)) {
      return DENY(403, `origin not allowed: ${input.origin}`);
    }
  }

  // 闸 4：token → 设备
  if (!input.token) {
    return DENY(401, "missing token");
  }
  const tokenHash = deps.hashToken(deps.pepper(), input.token);
  const device = deps.deviceByTokenHash(tokenHash);
  if (!device) {
    return DENY(401, "unpaired or revoked device");
  }

  // 闸 5：scope
  if (input.requiredScope !== null && !device.scopes.includes(input.requiredScope)) {
    return DENY(403, `missing scope: ${input.requiredScope}`);
  }

  return OK(device);
}

// ---------------------------------------------------------------- 限流器

/**
 * 按 key 计数的滑动窗口限流器（与 ipc-guard 的 RateLimiter 同型，但独立实例：
 * 远程入口的额度与本机 IPC 的额度是两件事，不该共享一个计数表）。
 */
export class RemoteRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number = 10_000,
    private readonly limit: number = 120
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  reset(): void {
    this.hits.clear();
  }
}

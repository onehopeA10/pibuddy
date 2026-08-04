/**
 * 渠道适配器抽象（connector.feishu / connector.slack / connector.telegram）。
 *
 * ## 一个适配器 = 一层平台差异，别的全共享
 *
 * 通用 webhook 基座（connector-store / connector-secret / connector-outbound /
 * connector-ingest）已经把「凭证只进不出、出站穿三关、入站四道守卫」这套机制做好。
 * 三个真实渠道与基座唯一的不同只有三处，全部收在一个适配器描述符里：
 *
 *   1. **域名上界**（`domains`）：这个渠道允许出站到哪个 host。飞书越不过
 *      `open.feishu.cn`，Slack 越不过 `hooks.slack.com`，Telegram 越不过
 *      `api.telegram.org`——跨平台发送在出站第一关当场被拒。
 *   2. **出站消息体**（`formatBody`）+ **响应判读**（`checkResponse`）：各平台
 *      按各自文档拼 body，且 HTTP 200 不等于业务成功（飞书看 `code`、Telegram 看
 *      `ok`），响应判读因此也归适配器。
 *   3. **入站解析**（`parseInbound`）：把平台原样投递的事件解析成一条可交给守卫
 *      的规范消息，并**识别「这是不是我们自己发的」以防回环**（飞书 sender_type、
 *      Slack bot_id、Telegram from.is_bot），或识别出平台的 url_verification 握手。
 *
 * ## 为什么适配器是纯逻辑（不 import electron）
 *
 * 与 connector-outbound / connector-ingest 同一理由：出站与入站的判定必须能被单测
 * 直接对拍（「飞书体拼对没有」「Slack 自己的消息被认成回环没有」），需要给 electron
 * 打桩才能跑的判据最后都会变成没人跑的判据。适配器只吃 / 吐纯数据。
 */
import type { ConnectorKind } from "@pibuddy/contract";

import type { SafeFetchResult } from "../../net/outbound-guard.js";

/** 出站响应判读结果：HTTP 200 之外，还要看平台的业务状态字段。 */
export interface OutboundVerdict {
  ok: boolean;
  /** 失败时的一句可读原因（未脱敏——由出站层统一脱敏后再出返回值）；成功为 null */
  detail: string | null;
}

/** 一条平台入站事件解析后的形态。 */
export type InboundParse =
  | { type: "challenge"; challenge: string }
  | {
      type: "message";
      messageId: string;
      text: string;
      /** 这条消息是不是我们自己 / 机器人发出去的（防回环判据，由适配器按平台字段判） */
      fromSelf: boolean;
      attachmentCount: number;
      attachmentBytes: number;
    }
  | { type: "malformed"; detail: string };

/** 一个渠道适配器。 */
export interface ChannelAdapter {
  kind: ConnectorKind;
  /** 出站授权按这个 capabilityId 问权限引擎（各渠道自己的 network:<domain> 上界）。 */
  capabilityId: string;
  /** 该渠道允许出站到的 host（域名上界，出站第一关）。 */
  domains: readonly string[];
  /** 拼平台出站消息体（JSON.stringify 前的对象）。 */
  formatBody(text: string): unknown;
  /** 判读平台出站响应（业务成功 / 失败）。 */
  checkResponse(resp: SafeFetchResult): OutboundVerdict;
  /** 解析一条平台入站事件（含 url_verification 握手与防回环判定）。 */
  parseInbound(event: unknown): InboundParse;
}

const REGISTRY = new Map<ConnectorKind, ChannelAdapter>();

/** 注册一个适配器（模块加载期，见 adapters/index.ts）。重复 kind 抛错，不静默覆盖。 */
export function registerAdapter(adapter: ChannelAdapter): void {
  if (REGISTRY.has(adapter.kind)) {
    throw new Error(`CONNECTOR_ADAPTER_DUPLICATE: ${adapter.kind}`);
  }
  REGISTRY.set(adapter.kind, adapter);
}

/** 取某 kind 的适配器；未知 kind 抛错（不静默回落到 webhook）。 */
export function resolveAdapter(kind: ConnectorKind): ChannelAdapter {
  const adapter = REGISTRY.get(kind);
  if (!adapter) throw new Error(`CONNECTOR_ADAPTER_UNKNOWN: ${kind}`);
  return adapter;
}

// ---------------------------------------------------------------- 解析小工具

/** 把 unknown 收成一个可按键取值的对象；非对象返回 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从记录里取一个非空字符串；缺失 / 类型不符返回 null。 */
export function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const v = record[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 判读一个「HTTP 200 且响应体带成功状态字段」的平台响应。 */
export function verdictFromJsonField(
  resp: SafeFetchResult,
  isBusinessOk: (body: Record<string, unknown>) => boolean,
  describe: (body: Record<string, unknown>) => string
): OutboundVerdict {
  if (!resp.ok) return { ok: false, detail: `HTTP ${resp.status}` };
  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(JSON.parse(resp.bodyText));
  } catch {
    body = null;
  }
  // 解不出 JSON 就以 HTTP 状态为准（有些平台成功时回极简文本）。
  if (!body) return { ok: true, detail: null };
  return isBusinessOk(body) ? { ok: true, detail: null } : { ok: false, detail: describe(body) };
}

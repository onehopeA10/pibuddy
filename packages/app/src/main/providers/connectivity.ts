/**
 * Provider 连通性探测（PROV-101）。
 *
 * 用户在 Provider 中心点「测试连接」时，要能立刻知道**是哪一步不对**：
 * key 填错了、地址打不通、还是模型名不存在。这三种情况的下一步动作完全
 * 不同，一句「连接失败」等于什么都没说。
 *
 * ## 三条纪律
 *
 *   1. **出站只走 safeFetch** —— 与语音转写、更新检查同一条原语。这里另起
 *      一个裸的平台请求原语就等于给 SSRF 判定开了一个后门；`main/` 下除
 *      net/outbound-guard.ts 之外的调用点数被结构性断言钉死为 0。
 *   2. **返回前脱敏** —— redactSecrets 从 logger-redact.ts 导入，不自己写
 *      第二份。上游 401 的响应正文里经常原样回显你发过去的 Authorization。
 *   3. **日志同样脱敏** —— 只脱敏返回给渲染进程的字段是不够的：密钥仍会
 *      经日志落盘，而那是一条不报错的静默泄漏。本文件里凡是进 logger 的
 *      字段一律先过 redactSecrets。
 *
 * ## 分类判据不在这里（MDL-101 接线）
 *
 * 从前 classifyStatus / classifyError 各写一小段 if：401/403→auth、404→model、
 * 5xx→network，**其余一律 unknown** —— 429、402、413 因此全落 unknown。而本文件
 * 是全仓唯一手握**显式 statusCode 与响应正文**的调用点，正是 `model-errors/`
 * 那批判据最该发挥的地方：它不必走「从消息里认前缀」那条窄路，可以直接把状态码
 * 与正文交给分类器（正文里的 `context_length_exceeded` 一类结构化 code 是上下文
 * 溢出唯一无条件的证据，代理把它包成 503 时也认得出来）。
 */
import type { ModelErrorKind, ProviderTestResult } from "@pibuddy/contract";

import { redactSecrets } from "../logger-redact.js";
import {
  classifyError as classifyProviderError,
  modelFailureKind,
  normalizeModelFailure,
} from "../model-errors/index.js";
import {
  OutboundBlockedError,
  OutboundDnsError,
  safeFetch,
} from "../net/outbound-guard.js";
import { last4Of, providerLogger, readAuthFile } from "./auth-store.js";
import { listCustomProviders } from "./models-store.js";
import { KNOWN_PROVIDER_BASE_URLS } from "./provider-catalog.js";

/** 探测请求的路径：OpenAI 兼容与 Anthropic 都提供 `GET {base}/models`。 */
const PROBE_PATH = "/models";

/** 把任意错误折成一句**已脱敏**的话。 */
function redactMessage(input: unknown): string {
  const text =
    input instanceof Error ? input.message : typeof input === "string" ? input : String(input);
  return String(redactSecrets(text));
}

type ProviderTestErrorCode = NonNullable<ProviderTestResult["errorCode"]>;

/**
 * 归一化 kind → 测试结果的 errorCode。
 *
 * 只有一处不是恒等：`abort` 在探测路径上不可能是真的「用户中止」（这条请求
 * 没有取消入口），若真被分出来那说明证据被误读了，落 unknown 而不是编一个
 * 更像样的类别。这个 return 同时是**编译期的词汇同源断言** —— 契约里的
 * errorCode 少了任何一个 ModelErrorKind，这一行就红。
 */
function errorCodeFromKind(kind: ModelErrorKind): ProviderTestErrorCode {
  return kind === "abort" ? "unknown" : kind;
}

/**
 * 按状态码 + 响应正文分类。
 *
 * 404 必须在分类器**之前**拦下：`GET {base}/models` 不存在说的是端点路径或
 * 模型名不对，这是探测路径特有的结论，通用的模型错误词汇里没有它。
 *
 * 其余交给 `model-errors` 的分类器。这里刻意造一个带 `statusCode` /
 * `responseBody` 字段的 Error：那正是分类器为 AI SDK 的 `APICallError` 设计的
 * 证据形状 —— statusCode 取**显式字段**（绝不从正文里认「413」这三个字符），
 * 正文既进结构化 code 的解析，也进自由文本证据。
 */
export function classifyStatus(status: number, bodyText = ""): ProviderTestErrorCode {
  if (status === 404) return "model";
  const evidence = Object.assign(new Error(`HTTP ${status}`), {
    statusCode: status,
    responseBody: bodyText,
  });
  return errorCodeFromKind(modelFailureKind(classifyProviderError(evidence)));
}

/**
 * 按抛出的错误分类。
 *
 * 出站原语自己的两类错误与已知 errno 保持原判（network）—— 它们是「本机到
 * provider 这一跳不通」的确凿证据，比任何文本启发式都强，不该再交给分类器
 * 复议。**变的是从前那句 `return "unknown"`**：走到这里说明不是出站层的问题，
 * 那就把错误交给 model-errors 归一，而不是一律说「未知」。
 */
export function classifyError(err: unknown): ProviderTestErrorCode {
  if (err instanceof OutboundBlockedError || err instanceof OutboundDnsError) return "network";
  const message = err instanceof Error ? err.message : String(err);
  if (/OUTBOUND_TIMEOUT|OUTBOUND_FAILED|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message)) {
    return "network";
  }
  return errorCodeFromKind(normalizeModelFailure(err).kind);
}

/** 该 provider 的探测地址：自定义端点用它自己的 baseUrl，内置的查目录。 */
export function probeBaseUrlFor(providerId: string): string | null {
  const custom = listCustomProviders()[providerId];
  if (custom) return custom.baseUrl;
  return KNOWN_PROVIDER_BASE_URLS[providerId] ?? null;
}

/**
 * 发一次最小请求测连通。
 *
 * **永不抛**：这是一个「测试」动作，任何失败都是它的正常结果，抛出去只会
 * 让界面上的按钮变成一个转完圈就没下文的东西。所有信息都在返回值里。
 */
export async function testProvider(providerId: string): Promise<ProviderTestResult> {
  const started = Date.now();
  const cred = readAuthFile()[providerId];

  if (!cred) {
    return {
      ok: false,
      latencyMs: 0,
      errorCode: "auth",
      redactedMessage: "还没为这个服务商填写 API Key",
    };
  }
  if (cred.type !== "api_key") {
    // OAuth 条目的 token 由 pi 自己刷新，PiBuddy 拿它发探测请求既不合适
    // 也测不出什么。如实说明，而不是假装测过了。
    return {
      ok: false,
      latencyMs: 0,
      errorCode: "auth",
      redactedMessage:
        "这是通过 /login 登录的订阅账号，需要在终端里用 pi 管理，PiBuddy 无法代为测试",
    };
  }

  const base = probeBaseUrlFor(providerId);
  if (!base) {
    return {
      ok: false,
      latencyMs: 0,
      errorCode: "unknown",
      redactedMessage: `暂不支持自动测试 ${providerId}，可以直接发一条消息试试`,
    };
  }

  const key = typeof cred.key === "string" ? cred.key : "";
  if (key.startsWith("$") || key.startsWith("!")) {
    return {
      ok: false,
      latencyMs: 0,
      errorCode: "auth",
      redactedMessage:
        "这条凭据用的是环境变量或命令取值（$ / ! 形态），由 pi 在运行时解析，PiBuddy 不代为求值",
    };
  }

  try {
    const resp = await safeFetch(`${base.replace(/\/+$/, "")}${PROBE_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        // Anthropic 认 x-api-key，OpenAI 兼容认 Authorization；两个都带上，
        // 多一个头不会让任何一方报错，少一个会让 Anthropic 恒回 401。
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
    const latencyMs = Date.now() - started;
    if (resp.ok) {
      providerLogger().info("provider_test_ok", { providerId, latencyMs });
      return { ok: true, latencyMs };
    }
    // 正文进分类器（结构化 code 与 provider 措辞都在里面），但只在**函数内部**
    // 被读；出去的仍然只有脱敏后的 detail。
    const errorCode = classifyStatus(resp.status, resp.bodyText);
    // bodyText 里可能带着回显的请求头，必须脱敏后才允许出现在返回值与日志里
    const detail = redactMessage(resp.bodyText).slice(0, 240);
    providerLogger().warn("provider_test_failed", {
      providerId,
      status: resp.status,
      errorCode,
      detail,
    });
    return {
      ok: false,
      latencyMs,
      errorCode,
      // 状态码必须出现在文案里：用户报「连不上」时，401 和 404 是两件事
      redactedMessage: `HTTP ${resp.status}${detail ? ` · ${detail}` : ""}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const errorCode = classifyError(err);
    const redactedMessage = redactMessage(err);
    providerLogger().warn("provider_test_error", { providerId, errorCode, redactedMessage });
    return { ok: false, latencyMs, errorCode, redactedMessage };
  }
}

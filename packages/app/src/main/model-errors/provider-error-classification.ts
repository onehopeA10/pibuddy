/**
 * provider 错误分类（MDL-101）。
 *
 * 移植自 `source/maka-agent/packages/runtime/src/provider-error-classification.ts`
 * （只读参考树）。两处替换，其余**逐字照抄**：
 *   - 参考实现从 `ai` 包引 `RetryError` 做实例判定；本仓不依赖 `ai`，改成
 *     结构判定（`name` 含 RetryError 且带 `lastError`）。零新增运行时依赖。
 *   - `isAuthenticationErrorText` 原在 `@maka/core/redaction`，这里内联那两行。
 *
 * **两张正则表整体照抄，不精简。** 每一条后面的 provider 名不是注释性装饰：
 * 它是这条正则的出处与可维护性来源，删掉之后没人能判断某一条还该不该在。
 *
 * ## 这个文件在解决什么
 *
 * 收敛前 pi 的报错原样透传给用户。而「输入超了窗口」和「输出超了 max_tokens」
 * 在 provider 的措辞里长得几乎一样，前者压缩会话能修，后者压缩了也白搭。
 * 判错方向的代价不是「提示不准」，是**把用户引去做一件根本没用的事**。
 *
 * ## 三条不能改的设计
 *
 * 1. **输入域不只是 Error**。三类来源先经 `normalizeErrorEvidence` 归一成
 *    `{text, statusCode, code, structuredCodes}`：API 调用错误的 `data` /
 *    `responseBody`、流内 error part 的各家形状、以及裸字符串。
 *    `statusCode` / `code` 一律取**显式字段**，绝不从子串里猜 —— 「413」这
 *    三个字符出现在正文里的次数远多于它真是状态码的次数。
 *    provider JSON 没过 schema 时 `data` 恰好缺失，此时 `responseBody` 是
 *    唯一携带原文措辞的载体，因此它必须也进 text 证据。
 * 2. **按证据强度降序分类**，不是 if-else 堆砌。具体的溢出证据要压过泛型
 *    5xx —— LiteLLM 一类代理会把 provider 的 overflow 包成 503。弱词启发式
 *    排在最后，且用词边界（`\brate\b` 防 generate / separate 误命中）。
 * 3. **双层否决式的上下文溢出检测**。先用否决表排掉 rate-limit / quota /
 *    throttle 与 output-cap 的全部语序排列，再匹配各家溢出文案。
 */

/** 溢出的**结构化** provider 标识 —— 唯一无条件的证据，自由文本都可被否决。 */
const CONTEXT_OVERFLOW_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "context_length_exceeded", // OpenAI & OpenAI-compatible: error.code
  "model_context_window_exceeded", // z.ai: error.code
  "request_too_large", // Anthropic byte-size overflow (HTTP 413): error.type
]);

/**
 * 归一化后的分类证据。
 *
 * classifyError 的真实输入域**不只是 Error**：请求级失败是 AI SDK 的
 * `APICallError`（provider JSON 解析在 `data`、原文在 `responseBody`，没有
 * 顶层 `.code`）；流内 error part 携带的是 provider 解析后的**值** ——
 * OpenAI Chat 给内层 `{message, type?, code?}`，OpenAI Responses 给整个
 * `{type:'error', error:{type, code, message}}`，Anthropic 给内层
 * `{type, message}`，openai-compatible 给一个裸字符串。形状全部读自 provider
 * 源码，没有一个是编出来的。
 */
interface ProviderErrorEvidence {
  /** 各文本字段的小写合成串，供模式证据使用 */
  text: string;
  /** 来自字段的显式 HTTP 状态（缺席为 ''）—— 绝不是子串 */
  statusCode: string;
  /** 顶层 code 字段的字符串形式（缺席为 ''） */
  code: string;
  /** 结构化 provider 标识（code / type），小写 */
  structuredCodes: string[];
}

export interface ProviderRetryMetadata {
  retryable: boolean;
  retryAfterMs?: number;
}

const MAX_SAFE_TIMER_DELAY_MS = 2_147_483_647;

/**
 * AI SDK 的 `RetryError` 形状判定。
 *
 * 参考实现用 `RetryError.isInstance(error)`；本仓不依赖 `ai` 包，改判结构：
 * 带 `lastError` 字段且 `name` 里出现 RetryError（SDK 实际写的是
 * `AI_RetryError`）。判不出来就当普通错误处理 —— 退化路径是「少剥一层包装」，
 * 不是误分类。
 */
interface RetryErrorLike {
  name?: unknown;
  reason?: unknown;
  lastError?: unknown;
}

function asRetryErrorLike(error: unknown): RetryErrorLike | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as RetryErrorLike;
  if (!("lastError" in candidate)) return undefined;
  const name = typeof candidate.name === "string" ? candidate.name : "";
  return /retryerror/i.test(name) ? candidate : undefined;
}

function providerErrorTarget(error: unknown): unknown {
  const retryError = asRetryErrorLike(error);
  return retryError && retryError.lastError !== undefined && retryError.lastError !== error
    ? retryError.lastError
    : error;
}

function responseHeadersFromError(error: unknown): Record<string, string> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { responseHeaders?: unknown }).responseHeaders;
  if (typeof value !== "object" || value === null) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header === "string") headers[key.toLowerCase()] = header;
  }
  return headers;
}

/**
 * 解析 retry-after 三种形态：`retry-after-ms`（毫秒）、`retry-after` 的秒数、
 * `retry-after` 的 HTTP-date。
 *
 * 返回值有三态，缺一不可：
 *   - `undefined` 两个头都不存在 —— 走本地退避；
 *   - `number`    解析成功；
 *   - `null`      **头在但不可解析 / 越界**（负数、NaN、超过 timer 上限）——
 *                 调用方据此把整条错误降级为**不可重试**。这一条是刻意的：
 *                 服务端明确说了「等一下」而我们读不懂它说的是多久，此时
 *                 立刻重试是在无视一个已经明说的约束。
 */
function parseRetryAfterMs(headers: Record<string, string>): number | null | undefined {
  const rawMilliseconds = headers["retry-after-ms"];
  const rawRetryAfter = headers["retry-after"];
  if (rawMilliseconds === undefined && rawRetryAfter === undefined) return undefined;

  let delayMs: number;
  if (rawMilliseconds !== undefined) {
    delayMs = Number(rawMilliseconds);
  } else {
    const seconds = Number(rawRetryAfter);
    delayMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(rawRetryAfter!) - Date.now();
  }
  if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > MAX_SAFE_TIMER_DELAY_MS) return null;
  return Math.ceil(delayMs);
}

/**
 * 归一化 provider 的重试事实，**不把 SDK 错误对象或原始响应头泄漏出去**。
 *
 * 返回的是两个标量：能不能重试、要等多久。上层因此不可能顺着这个返回值
 * 摸回 SDK 内部结构（那正是「归一化」在实现上唯一说得清的判据）。
 */
export function providerRetryMetadata(error: unknown): ProviderRetryMetadata {
  const target = providerErrorTarget(error);
  const evidence = normalizeErrorEvidence(target);
  if (!evidence) return { retryable: false };

  const status = Number(evidence.statusCode || evidence.code);
  const errorClass = classifyError(target);
  const retryable =
    errorClass === "Network" ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status >= 500 && status <= 599);
  if (!retryable) return { retryable: false };

  const retryAfterMs = parseRetryAfterMs(responseHeadersFromError(target) ?? {});
  if (retryAfterMs === null) return { retryable: false };
  return {
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** 从 payload 及其 `error` 包装里收集 `code` / `type` 字符串。 */
function collectStructuredCodes(payload: unknown, out: string[]): void {
  const fromRecord = (record: unknown): void => {
    if (typeof record !== "object" || record === null) return;
    for (const key of ["code", "type"] as const) {
      const value = (record as Record<string, unknown>)[key];
      if (typeof value === "string" && value) out.push(value.toLowerCase());
    }
  };
  fromRecord(payload);
  if (typeof payload === "object" && payload !== null) {
    fromRecord((payload as { error?: unknown }).error);
  }
}

function normalizeErrorEvidence(error: unknown): ProviderErrorEvidence | undefined {
  if (error instanceof Error) {
    const code = "code" in error ? String((error as { code?: unknown }).code) : "";
    const statusCode =
      "statusCode" in error
        ? String((error as { statusCode?: unknown }).statusCode)
        : "status" in error
          ? String((error as { status?: unknown }).status)
          : "";
    const rawBody = (error as { responseBody?: unknown }).responseBody;
    const body = typeof rawBody === "string" ? rawBody : "";
    const structuredCodes: string[] = [];
    collectStructuredCodes((error as { data?: unknown }).data, structuredCodes);
    if (structuredCodes.length === 0 && body) {
      // 失败响应处理器即使在 provider JSON 没过 schema 时也保留原始 body
      //（而那正是 `data` 缺席的时候）。
      try {
        collectStructuredCodes(JSON.parse(body), structuredCodes);
      } catch {
        // 不是 JSON —— 没有结构化证据。
      }
    }
    return {
      // 原始 body 也进 text 证据：provider JSON 没过 error schema 时，
      // `message` 退化成 statusText，body 是**唯一**携带 provider 措辞的载体
      //（例如一个 OpenAI-compatible 的 `{error: string}` 溢出）。正例与否决
      // 跑在同一份全文上。
      text: `${error.name} ${code} ${statusCode} ${error.message}${body ? ` ${body}` : ""}`.toLowerCase(),
      statusCode,
      code,
      structuredCodes,
    };
  }
  if (typeof error === "string") {
    const structuredCodes: string[] = [];
    try {
      collectStructuredCodes(JSON.parse(error), structuredCodes);
    } catch {
      // 普通消息串 —— 只有文本证据。
    }
    return { text: error.toLowerCase(), statusCode: "", code: "", structuredCodes };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const field = (key: string): string => {
      const value = record[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    };
    const structuredCodes: string[] = [];
    collectStructuredCodes(record, structuredCodes);
    let text: string;
    try {
      // 整值序列化：无论 message / code 文本被哪一种已知 provider 形状携带，
      // 它都会进证据。
      text = JSON.stringify(error).toLowerCase();
    } catch {
      text = String(error).toLowerCase();
    }
    return {
      text,
      statusCode: field("statusCode") || field("status"),
      code: field("code"),
      structuredCodes,
    };
  }
  return undefined;
}

/**
 * provider 的上下文溢出签名表。
 *
 * 全部是**自由文本证据**，可被 NON_CONTEXT_OVERFLOW_PATTERNS 否决：一句
 * 容量陈述被引用在限流 / 配额错误里时不得触发压缩，只有结构化 provider code
 * 才是无条件的。
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))?/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  // GitHub Copilot: "prompt token count of X exceeds the limit of Y". The INPUT
  // subject is required — a bare "token count of N exceeds the limit of M" also
  // matches output/completion caps, and a bare "exceeds the limit of N" matches
  // file-size and other quota errors; neither is fixable by history compaction.
  /(?:prompt|input|context|message)[^.]{0,80}token count of [\d,]+ exceeds the limit of [\d,]+/i,
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /context[_ ]length[_ ]exceeded/i, // OpenAI structured error code (also generic)
  // Ambiguous token-limit wording that is an input overflow only when an
  // input-like word is the subject. `request` is deliberately NOT in the
  // subject list: it appears in generic prefixes ("Invalid request: ...")
  // without saying anything about which side of the token budget overflowed.
  /(?:prompt|input|context|message)[^.]{0,80}too many tokens/i,
  /(?:prompt|input|context|message)[^.]{0,80}token limit exceeded/i,
];

/**
 * 看起来像 token 问题、但**不是**输入溢出的措辞：限流 / 配额 / 节流，以及
 * OUTPUT 上限关系的**全部已观测语序排列** —— 主语在前（"completion has too
 * many tokens"、"max_tokens token limit exceeded"）、谓语在前（"too many
 * tokens were requested for the completion"）、count-of 形（"output token
 * count of N exceeds"）、角色词嵌在短语中（"too many completion tokens were
 * requested"）、以及 role-tokens-exceed 形（"Maximum completion tokens
 * exceeded"）。
 *
 * 单纯的名词短语（如 "completion token count"）**不排除**：它也会作为用量
 * 明细出现在真实的输入溢出消息里；而 "(prompt + completion) exceed" 这类
 * 合计预算措辞仍可分类，因为角色词与 "tokens" 不相邻。
 */
const NON_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /rate limit/i,
  /too many requests/i,
  /throttl/i,
  /quota/i,
  /(?:output|completion|max_tokens)\b[^.]{0,60}(?:too many tokens|token limit exceeded)/i,
  /(?:too many tokens|token limit exceeded)[^.]{0,60}\b(?:output|completion|max_tokens)/i,
  /(?:output|completion)\s+token\s+(?:count|limit)[^.]{0,40}exceed/i,
  /too many (?:output|completion|max_tokens)[^.]{0,20}tokens/i,
  /\b(?:output|completion|max_tokens)\s+tokens?\b[^.]{0,20}exceed/i,
];

/**
 * 双层否决式的溢出检测（整个移植里最值钱的一段）。
 *
 * 触发恢复要求的是**输入**溢出的正面证据 —— 那是压缩历史唯一能修的一类：
 *  1. **先否决**：节流 / 配额措辞与完整的 output-cap 关系一票否决全部自由
 *     文本信号。自由文本永不无条件成立。
 *  2. 没有否决时才数正面的溢出关系。结构化 provider code（无条件证据）是
 *     classifyError 的事，在这一层之前就查过了。
 */
export function isContextOverflowErrorText(text: string): boolean {
  if (!text) return false;
  if (NON_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/** `authority` 一类词不算鉴权证据（原 `@maka/core/redaction` 的两行）。 */
export function isAuthenticationErrorText(message: string): boolean {
  return message.replace(/\bauthorit\w*/g, "").includes("auth");
}

/**
 * 按**证据强度降序**对 provider 错误分类（输入可以是 Error、字符串、或流内
 * error part 的裸对象）：
 *
 *   abort → 402 → 429 → 401/403（数值字段，绝不是子串）→ provider 的结构化
 *   溢出 code → 裸 413（HTTP：请求实体过大，本身就是输入侧证据，Cerebras 发
 *   它时连 body 都没有）→ 可被否决的自由文本溢出关系 → 泛型 5xx → 弱词启发式。
 *
 * 具体溢出证据压过泛型 5xx，因为代理（LiteLLM）会把 provider 的溢出包成
 * 503；弱词启发式排最后，于是 "generate" 永远不可能变成一次 rate limit。
 */
export function classifyError(error: unknown): string {
  const retryError = asRetryErrorLike(error);
  if (retryError && retryError.reason === "abort") return "Abort";
  const classificationTarget = providerErrorTarget(error);
  const evidence = normalizeErrorEvidence(classificationTarget);
  if (!evidence) return "Other";
  const { text, statusCode, code, structuredCodes } = evidence;
  if (text.includes("abort")) return "Abort";
  if (statusCode === "402" || code === "402") return "ProviderBilling";
  if (statusCode === "429" || code === "429") return "RateLimit";
  if (statusCode === "401" || statusCode === "403" || code === "401" || code === "403")
    return "Auth";
  // 结构化 provider 证据：解析后的错误 JSON 的 code / type 是上下文溢出唯一
  // 无条件的信号。
  if (structuredCodes.some((c) => CONTEXT_OVERFLOW_PROVIDER_CODES.has(c))) return "ContextLength";
  if (statusCode === "413" || code === "413") return "ContextLength";
  // 合成文本上的自由文本溢出关系，内部先否决。
  if (isContextOverflowErrorText(text)) return "ContextLength";
  if (/^5\d\d$/.test(statusCode) || /^5\d\d$/.test(code)) return "ProviderUnavailable";
  // 弱词启发式，排最后：它们只兜住那些对任何其它类别都没有更强证据的错误。
  // `rate` 必须是词形（"generate" / "separate" 不是限流），同时仍能匹配
  // rate_limit / RateLimitError 这两种标识拼写。
  if (/\brate\b|rate[_-]?limit/.test(text)) return "RateLimit";
  if (isAuthenticationErrorText(text)) return "Auth";
  if (text.includes("timeout")) return "Timeout";
  if (
    text.includes("network") ||
    text.includes("fetch") ||
    /\btypeerror\b.*\bterminated\b/.test(text)
  )
    return "Network";
  return classificationTarget instanceof Error ? classificationTarget.name || "Other" : "Other";
}

export function errorPresentationFromClass(errorClass: string): {
  reason?: string;
  message?: string;
} {
  switch (errorClass) {
    case "ContextLength":
      return { reason: "context_overflow", message: "Context window exceeded" };
    case "Timeout":
      return { reason: "timeout", message: "Request timed out" };
    case "Auth":
      return { reason: "auth", message: "Authentication failed" };
    case "ProviderBilling":
      return { reason: "provider_billing", message: "Provider billing required" };
    case "ProviderUnavailable":
      return { reason: "provider_unavailable", message: "Provider returned an error" };
    case "RateLimit":
      return { reason: "rate_limit", message: "Rate limit exceeded" };
    case "Network":
      return { reason: "network", message: "Network error" };
    default:
      return {};
  }
}

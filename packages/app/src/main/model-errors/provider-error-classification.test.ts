import { describe, expect, it } from "vitest";

import {
  classifyError,
  isContextOverflowErrorText,
  providerRetryMetadata,
} from "./provider-error-classification.js";

/**
 * 每一条样本都是**真实 provider 文案**（取自参考实现正则表里的出处注释与
 * pi 自己那张 OVERFLOW_PATTERNS 表的示例）。用编出来的字符串测这套表毫无
 * 意义：这些正则唯一的价值就是它们对得上真实报文。
 */

/** 造一个带显式字段的 API 调用错误（AI SDK APICallError 的形状）。 */
function apiError(init: {
  message: string;
  statusCode?: number;
  data?: unknown;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
}): Error {
  const error = new Error(init.message);
  return Object.assign(error, {
    ...(init.statusCode !== undefined ? { statusCode: init.statusCode } : {}),
    ...(init.data !== undefined ? { data: init.data } : {}),
    ...(init.responseBody !== undefined ? { responseBody: init.responseBody } : {}),
    ...(init.responseHeaders !== undefined ? { responseHeaders: init.responseHeaders } : {}),
  });
}

describe("上下文溢出：各家真实文案逐条命中", () => {
  const OVERFLOW_SAMPLES: [provider: string, text: string][] = [
    ["Anthropic", "prompt is too long: 213462 tokens > 200000 maximum"],
    [
      "Anthropic 413",
      '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    ],
    ["Amazon Bedrock", "Input is too long for requested model."],
    ["OpenAI", "Your input exceeds the context window of this model"],
    [
      "OpenAI/LiteLLM",
      "Requested token count exceeds the model's maximum context length of 131072 tokens",
    ],
    [
      "OpenAI-compatible",
      "Input length (265330) exceeds model's maximum context length (262144).",
    ],
    [
      "Google Gemini",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
    ],
    [
      "xAI Grok",
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
    ],
    ["Groq", "Please reduce the length of the messages or completion"],
    [
      "OpenRouter",
      "This endpoint's maximum context length is 131072 tokens. However, you requested about 200000 tokens",
    ],
    [
      "OpenRouter/Poolside",
      "Input length 300000 exceeds the maximum allowed input length of 262144 tokens.",
    ],
    [
      "Together AI",
      "The input (300000 tokens) is longer than the model's context length (131072 tokens).",
    ],
    ["GitHub Copilot", "prompt token count of 200000 exceeds the limit of 128000"],
    ["llama.cpp", "the request exceeds the available context size, try increasing it"],
    ["LM Studio", "tokens to keep from the initial prompt is greater than the context length"],
    ["MiniMax", "invalid params, context window exceeds limit"],
    ["Kimi For Coding", "Your request exceeded model token limit: 131072 (requested: 200000)"],
    [
      "Mistral",
      "Prompt contains 300000 tokens, too large for model with 131072 maximum context length",
    ],
    ["DS4", "Prompt has 300000 tokens, but the configured context size is 131072 tokens"],
    ["z.ai", "model_context_window_exceeded"],
    ["Ollama", "prompt too long; exceeded max context length by 12000 tokens"],
    ["OpenAI code", "context_length_exceeded"],
    ["带主语的歧义措辞（too many tokens）", "The prompt contains too many tokens for this model"],
    ["带主语的歧义措辞（token limit）", "Your input has token limit exceeded for this request"],
  ];

  it.each(OVERFLOW_SAMPLES)("%s 的报文被判为上下文溢出", (_provider, text) => {
    expect(isContextOverflowErrorText(text.toLowerCase())).toBe(true);
    expect(classifyError(text)).toBe("ContextLength");
  });
});

/**
 * 否决表这一组是整个移植里最值钱的部分。
 *
 * 每条样本都**同时命中一条正例正则与一条否决正则** —— 只有这样，「拆掉否决
 * 表就变红」才是真的。只命中否决表的样本证明不了否决表在工作（它本来就不会
 * 被判成溢出）。
 */
describe("否决表：output-cap 与限流/配额措辞不得被判成上下文溢出", () => {
  const VETOED: [name: string, text: string][] = [
    [
      "output-cap：max_tokens 的 token limit（主语在前、角色词在中）",
      "Invalid input: max_tokens token limit exceeded (requested 8192, max 4096)",
    ],
    [
      "output-cap：谓语在前、角色词在后",
      "The message requested too many tokens for the completion",
    ],
    [
      "output-cap：count-of 形",
      "Prompt + completion token count of 9000 exceeds the limit of 8192",
    ],
    [
      "限流里引用了容量陈述（代理常见）",
      "Rate limit exceeded: the prompt is too long for your current tier",
    ],
    [
      "配额里引用了容量陈述",
      "Quota exceeded - your input token count (120000) exceeds the maximum for this plan",
    ],
  ];

  it.each(VETOED)("%s → 不是 context_overflow", (_name, text) => {
    expect(isContextOverflowErrorText(text.toLowerCase())).toBe(false);
    expect(classifyError(text)).not.toBe("ContextLength");
  });

  it("每条否决样本都真的命中了某条正例正则（否则这组测试证明不了否决表在工作）", () => {
    // 把否决表短路掉之后，这些样本必须全部翻成「是溢出」——
    // 这正是对拍实验里「拆掉否决表 → 变红」的那条判据。
    const POSITIVE_ONLY = [
      /prompt is too long/i,
      /input token count.*exceeds the maximum/i,
      /(?:prompt|input|context|message)[^.]{0,80}token count of [\d,]+ exceeds the limit of [\d,]+/i,
      /(?:prompt|input|context|message)[^.]{0,80}too many tokens/i,
      /(?:prompt|input|context|message)[^.]{0,80}token limit exceeded/i,
    ];
    for (const [name, text] of VETOED) {
      expect(
        POSITIVE_ONLY.some((pattern) => pattern.test(text)),
        `${name} 没有命中任何正例正则，这条样本无法检验否决表`
      ).toBe(true);
    }
  });

  it("裸的 output-cap 关系靠**主语要求**挡住，与否决表无关", () => {
    // Copilot 那条正则特意要求主语是 prompt/input/context/message：
    // 裸的 "token count of X exceeds the limit of Y" 也匹配输出上限与文件配额，
    // 那些不是压缩能修的。
    expect(isContextOverflowErrorText("token count of 9000 exceeds the limit of 8192")).toBe(
      false
    );
    expect(isContextOverflowErrorText("maximum completion tokens exceeded")).toBe(false);
  });
});

describe("按证据强度降序分类", () => {
  it("显式 402 → ProviderBilling", () => {
    expect(classifyError(apiError({ message: "Payment Required", statusCode: 402 }))).toBe(
      "ProviderBilling"
    );
  });

  it("显式 429 → RateLimit", () => {
    expect(classifyError(apiError({ message: "Too Many Requests", statusCode: 429 }))).toBe(
      "RateLimit"
    );
  });

  it("显式 401 / 403 → Auth", () => {
    expect(classifyError(apiError({ message: "Unauthorized", statusCode: 401 }))).toBe("Auth");
    expect(classifyError(apiError({ message: "Forbidden", statusCode: 403 }))).toBe("Auth");
  });

  it("结构化 provider code 是无条件证据", () => {
    const error = apiError({
      message: "Bad Request",
      statusCode: 400,
      data: { error: { code: "context_length_exceeded", message: "…" } },
    });
    expect(classifyError(error)).toBe("ContextLength");
  });

  it("裸 413（Cerebras 无 body）→ ContextLength", () => {
    expect(classifyError(apiError({ message: "Payload Too Large", statusCode: 413 }))).toBe(
      "ContextLength"
    );
  });

  it("具体溢出证据压过泛型 5xx（LiteLLM 把 provider 溢出包成 503）", () => {
    const error = apiError({
      message: "prompt is too long: 213462 tokens > 200000 maximum",
      statusCode: 503,
    });
    expect(classifyError(error)).toBe("ContextLength");
  });

  it("没有溢出证据的 5xx 才是 ProviderUnavailable", () => {
    expect(classifyError(apiError({ message: "Bad Gateway", statusCode: 502 }))).toBe(
      "ProviderUnavailable"
    );
  });

  it("弱词启发式排最后：generate / separate 不是限流", () => {
    expect(classifyError("Failed to generate a response")).toBe("Other");
    expect(classifyError("rate_limit")).toBe("RateLimit");
    expect(classifyError("RateLimitError")).toBe("RateLimit");
  });

  it("authority 一类词不算鉴权证据", () => {
    expect(classifyError("The certificate authority is unknown")).not.toBe("Auth");
    expect(classifyError("authentication failed")).toBe("Auth");
  });

  it("timeout / network 兜底", () => {
    expect(classifyError("Request timeout after 60s")).toBe("Timeout");
    expect(classifyError("TypeError: fetch failed")).toBe("Network");
  });
});

describe("输入域不只是 Error", () => {
  it("provider JSON 没过 schema 时，responseBody 是唯一的措辞载体", () => {
    // 此时 `data` 恰好缺失，message 退化成 statusText。
    const error = apiError({
      message: "Bad Request",
      statusCode: 400,
      responseBody: '{"error":"Input length (265330) exceeds model\'s maximum context length (262144)."}',
    });
    expect(classifyError(error)).toBe("ContextLength");
  });

  it("流内 error part 的裸对象（OpenAI Responses 形状）", () => {
    const part = {
      type: "error",
      error: { type: "request_too_large", message: "Request exceeds the maximum size" },
    };
    expect(classifyError(part)).toBe("ContextLength");
  });

  it("裸字符串（openai-compatible 的 error part）", () => {
    expect(classifyError("prompt is too long: 213462 tokens > 200000 maximum")).toBe(
      "ContextLength"
    );
  });

  it("statusCode 只认显式字段，绝不从子串猜", () => {
    // 正文里出现 402/413 这三个字符的次数，远多于它们真是状态码的次数。
    // Error 实例分不出类时退到 `name`（这里是 "Error"），裸字符串退到 "Other"；
    // 两条路径都必须**不是** ProviderBilling / ContextLength。
    expect(classifyError(new Error("upstream returned error 402 while proxying"))).toBe("Error");
    expect(classifyError("upstream returned error 402 while proxying")).toBe("Other");
    expect(classifyError("job 413 failed")).toBe("Other");
  });

  it("RetryError 形状：reason=abort 直接判 Abort，否则剥到 lastError", () => {
    const aborted = Object.assign(new Error("retry gave up"), {
      name: "AI_RetryError",
      reason: "abort",
      lastError: new Error("whatever"),
    });
    expect(classifyError(aborted)).toBe("Abort");

    const wrapped = Object.assign(new Error("retry gave up"), {
      name: "AI_RetryError",
      reason: "maxRetriesExceeded",
      lastError: apiError({ message: "Too Many Requests", statusCode: 429 }),
    });
    expect(classifyError(wrapped)).toBe("RateLimit");
  });
});

describe("重试元数据：不泄漏 SDK 对象，retry-after 三种形态", () => {
  it("没有 retry-after 头 → 可重试但不给时长（交给本地退避）", () => {
    const meta = providerRetryMetadata(apiError({ message: "Too Many", statusCode: 429 }));
    expect(meta).toEqual({ retryable: true });
  });

  it("retry-after-ms（毫秒）", () => {
    const meta = providerRetryMetadata(
      apiError({
        message: "Too Many",
        statusCode: 429,
        responseHeaders: { "retry-after-ms": "1500" },
      })
    );
    expect(meta).toEqual({ retryable: true, retryAfterMs: 1500 });
  });

  it("retry-after（秒数）", () => {
    const meta = providerRetryMetadata(
      apiError({ message: "Too Many", statusCode: 429, responseHeaders: { "retry-after": "30" } })
    );
    expect(meta).toEqual({ retryable: true, retryAfterMs: 30_000 });
  });

  it("retry-after（HTTP-date）", () => {
    const meta = providerRetryMetadata(
      apiError({
        message: "Too Many",
        statusCode: 429,
        // HTTP-date 的精度只到秒，因此实际时长会略小于 5000ms
        responseHeaders: { "retry-after": new Date(Date.now() + 5_000).toUTCString() },
      })
    );
    expect(meta.retryable).toBe(true);
    expect(meta.retryAfterMs).toBeGreaterThan(3_000);
    expect(meta.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it("头存在但不可解析 → 降级为**不可重试**", () => {
    // 服务端明说了「等一下」而我们读不懂它说的是多久，此时立刻重试是在
    // 无视一个已经明说的约束。
    const meta = providerRetryMetadata(
      apiError({
        message: "Too Many",
        statusCode: 429,
        responseHeaders: { "retry-after": "sometime soon" },
      })
    );
    expect(meta).toEqual({ retryable: false });
  });

  it("超出 timer 上限同样降级为不可重试", () => {
    const meta = providerRetryMetadata(
      apiError({
        message: "Too Many",
        statusCode: 429,
        responseHeaders: { "retry-after-ms": "9999999999999" },
      })
    );
    expect(meta).toEqual({ retryable: false });
  });

  it("不可重试的类别（鉴权 / 溢出）不给重试元数据", () => {
    expect(providerRetryMetadata(apiError({ message: "Unauthorized", statusCode: 401 }))).toEqual({
      retryable: false,
    });
    expect(
      providerRetryMetadata(apiError({ message: "prompt is too long", statusCode: 400 }))
    ).toEqual({ retryable: false });
  });

  it("408 / 409 / 5xx / 网络类可重试", () => {
    for (const status of [408, 409, 500, 503, 599]) {
      expect(providerRetryMetadata(apiError({ message: "x", statusCode: status })).retryable).toBe(
        true
      );
    }
    expect(providerRetryMetadata(new Error("TypeError: fetch failed")).retryable).toBe(true);
  });

  it("返回值里只有标量，摸不回响应头", () => {
    const meta = providerRetryMetadata(
      apiError({
        message: "Too Many",
        statusCode: 429,
        responseHeaders: { "retry-after-ms": "1000", "x-request-id": "abc" },
      })
    );
    expect(Object.keys(meta).sort()).toEqual(["retryAfterMs", "retryable"]);
  });
});

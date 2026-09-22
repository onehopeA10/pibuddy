import { describe, expect, it } from "vitest";

import {
  APP_SETTINGS_PUBLIC_KEYS,
  MAX_ATTACHMENT_TOKEN_CHARS,
  MAX_PROMPT_ATTACHMENT_TOKENS,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BASE64_CHARS,
  MAX_PROMPT_MESSAGE_BYTES,
  appSettingsSchema,
  piMessageRequestSchema,
  piPromptRequestSchema,
  rendererSettingsPatchSchema,
  sttTranscribeRequestSchema,
} from "../src/index.js";

/**
 * CT-07 / CT-09：跨进程契约的形状断言。
 *
 * 这些不是「测实现」，而是把计划里的文字条款钉成机器判据 —— 谁把
 * baseUrl / apiKey 加回 stt 请求，或者把密钥字段塞回可下发的设置里，
 * 都会在这里立刻红掉。
 */
describe("CT-07 stt:transcribe 的请求形状唯一", () => {
  it("字段恰为 endpointId / audio / mimeType 三个", () => {
    const keys = Object.keys(sttTranscribeRequestSchema.shape).sort();
    expect(keys).toEqual(["audio", "endpointId", "mimeType"]);
  });
});

describe("prompt 目标绑定", () => {
  it("保留目标字段并兼容没有目标的旧调用方", () => {
    const scoped = { message: "你好", workspaceId: "w1", sessionId: "a" };
    expect(piPromptRequestSchema.parse(scoped)).toEqual(scoped);
    expect(piPromptRequestSchema.parse({ message: "你好" })).toEqual({ message: "你好" });
    expect(piPromptRequestSchema.safeParse({ ...scoped, sessionId: "" }).success).toBe(false);
    expect(piPromptRequestSchema.safeParse({ ...scoped, workspaceId: "" }).success).toBe(false);
  });
});

describe("SEC-005 prompt 资源 schema 上限", () => {
  const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" as const };

  it("prompt / steer / follow-up 都限制消息长度与图片数量", () => {
    expect(
      piPromptRequestSchema.safeParse({ message: "x", images: Array(MAX_PROMPT_IMAGES).fill(image) })
        .success
    ).toBe(true);
    expect(
      piPromptRequestSchema.safeParse({
        message: "x",
        images: Array(MAX_PROMPT_IMAGES + 1).fill(image),
      }).success
    ).toBe(false);
    expect(
      piMessageRequestSchema.safeParse({
        message: "x",
        images: Array(MAX_PROMPT_IMAGES + 1).fill(image),
      }).success
    ).toBe(false);
    expect(
      piMessageRequestSchema.safeParse({ message: "x".repeat(MAX_PROMPT_MESSAGE_BYTES + 1) })
        .success
    ).toBe(false);
  });

  it("消息长度按共享 UTF-8 字节单位校验，Unicode 在边界内不会被 guard 二次误拒", () => {
    const unicodeAtLimit = "你".repeat(Math.floor(MAX_PROMPT_MESSAGE_BYTES / 3)) + "x";
    expect(new TextEncoder().encode(unicodeAtLimit)).toHaveLength(MAX_PROMPT_MESSAGE_BYTES);
    expect(piPromptRequestSchema.safeParse({ message: unicodeAtLimit }).success).toBe(true);
    expect(piMessageRequestSchema.safeParse({ message: `${unicodeAtLimit}x` }).success).toBe(false);
  });

  it("attachment token 数量/长度与单张图片 base64 字符串都有界", () => {
    expect(
      piPromptRequestSchema.safeParse({
        message: "x",
        attachmentTokens: Array(MAX_PROMPT_ATTACHMENT_TOKENS).fill("token"),
      }).success
    ).toBe(true);
    expect(
      piPromptRequestSchema.safeParse({
        message: "x",
        attachmentTokens: Array(MAX_PROMPT_ATTACHMENT_TOKENS + 1).fill("token"),
      }).success
    ).toBe(false);
    expect(
      piPromptRequestSchema.safeParse({
        message: "x",
        attachmentTokens: ["t".repeat(MAX_ATTACHMENT_TOKEN_CHARS + 1)],
      }).success
    ).toBe(false);
    expect(
      piPromptRequestSchema.safeParse({
        message: "x",
        images: [{ ...image, data: "A".repeat(MAX_PROMPT_IMAGE_BASE64_CHARS + 1) }],
      }).success
    ).toBe(false);
  });
});

describe("CT-09 设置里不再有任何密钥字段", () => {
  it("AppSettings 的键里没有可取回明文的密钥位", () => {
    const keys = Object.keys(appSettingsSchema.shape);
    expect(keys).not.toContain("sttApiKey");
    expect(keys).toContain("sttApiKeyConfigured");
    expect(keys).toContain("sttApiKeyLast4");
  });

  it("可下发白名单里不含任何密钥本体", () => {
    expect(APP_SETTINGS_PUBLIC_KEYS).not.toContain("sttApiKey");
    // 白名单必须是 schema 键的子集，否则挑字段时会静默漏掉
    const schemaKeys = new Set(Object.keys(appSettingsSchema.shape));
    for (const key of APP_SETTINGS_PUBLIC_KEYS) {
      expect(schemaKeys.has(key)).toBe(true);
    }
  });

  it("渲染进程不能写主进程单向下发的派生字段", () => {
    const writable = Object.keys(rendererSettingsPatchSchema.shape);
    for (const forbidden of [
      "workspace",
      "schemaVersion",
      "sttEndpointId",
      "sttApiKeyConfigured",
      "sttApiKeyLast4",
      // SEC-005：这两项最终是 spawn 的 argv[0]，只能经 settings:set-pi-runtime
      "piRuntimeMode",
      "piExternalCommand",
    ]) {
      expect(writable).not.toContain(forbidden);
    }
    // 但地址与模型仍然可写（否则用户改不了端点）
    expect(writable).toContain("sttBaseUrl");
    expect(writable).toContain("sttModel");
    expect(writable).toContain("closeAction");
  });
});

import { describe, expect, it } from "vitest";

import {
  APP_SETTINGS_PUBLIC_KEYS,
  appSettingsSchema,
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
    ]) {
      expect(writable).not.toContain(forbidden);
    }
    // 但地址与模型仍然可写（否则用户改不了端点）
    expect(writable).toContain("sttBaseUrl");
    expect(writable).toContain("sttModel");
  });
});

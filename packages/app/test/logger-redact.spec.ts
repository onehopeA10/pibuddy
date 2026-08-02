import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SECRET_KEY_RE,
  __resetEnvSecretCache,
  redactSecrets,
  redactText,
} from "../src/main/logger-redact.js";

/**
 * 脱敏规则的两面（OBS-101）：
 *
 *   正面 —— 四类敏感样本一个都不许留下；
 *   反面 —— 不含密钥的诊断信息必须**逐字保留**。
 *
 * 只测正面是不够的：把所有字符串一律替换成 [redacted] 也能让正面全绿，
 * 而那样产出的日志无法定位任何问题。反面那几条才是「脱敏没做过头」的判据。
 */

afterEach(() => {
  __resetEnvSecretCache();
});

describe("四类敏感样本全部不可见", () => {
  it("sk- 裸密钥 / Bearer / \"key\" JSON 值 / home 绝对路径", () => {
    const home = os.homedir();
    const homeFile = path.join(home, "Documents", "a.txt");
    const sample = [
      "sk-ant-abcdefghijklmnop1234",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      '{"key": "secret-value"}',
      homeFile,
      // 判据原文里的那个字面量：即使本机 homedir 不是它，也必须被归一。
      "C:\\Users\\yehh\\Documents\\a.txt",
    ].join("\n");

    const out = redactText(sample);

    expect(out).not.toContain("sk-ant-abcdefghijklmnop1234");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).not.toContain("secret-value");
    expect(out).not.toContain(homeFile);
    expect(out).not.toContain("C:\\Users\\yehh");

    // home 路径归一为 ~，而不是整段抹掉：文件名本身是有诊断价值的。
    expect(out).toContain("~");
    expect(out).toContain("a.txt");
    // 键名保留，只抹值 —— 否则「哪个字段泄了」这条信息也一起没了。
    expect(out).toContain('"key"');
  });

  it("Bearer 替换不吃掉结尾引号（诊断包里的 JSON 不该被脱敏搞成语法错误）", () => {
    const out = redactText('{"authorization":"Bearer abc.def.ghi","n":1}');
    expect(out).not.toContain("abc.def.ghi");
    expect(() => JSON.parse(out) as unknown).not.toThrow();
  });

  it("process.env 里名字像密钥的值会被抹掉", () => {
    process.env.PIBUDDY_TEST_TOKEN = "env-secret-value-1234";
    __resetEnvSecretCache();
    try {
      const out = redactText("outbound failed with env-secret-value-1234");
      expect(out).not.toContain("env-secret-value-1234");
      expect(out).toContain("outbound failed with");
    } finally {
      delete process.env.PIBUDDY_TEST_TOKEN;
      __resetEnvSecretCache();
    }
  });
});

describe("脱敏不误伤诊断价值", () => {
  // 过度脱敏会把日志变成无法定位问题的马赛克。这三个样本不含任何密钥，
  // 必须逐字符相等地原样返回。
  it.each([
    "packages/app/src/main/index.ts",
    "session-abc123",
    "runtimeId=7f3a",
  ])("%s 原样保留", (sample) => {
    expect(redactText(sample)).toBe(sample);
    expect(redactSecrets(sample)).toBe(sample);
  });

  it("键名精确匹配：keyboardLayout 这类不被误判为密钥", () => {
    expect(SECRET_KEY_RE.test("keyboardLayout")).toBe(false);
    expect(SECRET_KEY_RE.test("monkeyBusiness")).toBe(false);
    expect(SECRET_KEY_RE.test("key")).toBe(true);
    expect(SECRET_KEY_RE.test("apiKey")).toBe(true);
  });
});

describe("结构：全仓只有一份 redactSecrets", () => {
  it("对象路径与字符串路径走同一套规则", () => {
    const out = redactSecrets({ note: "sk-ant-abcdefghijklmnop1234" }) as Record<string, string>;
    expect(out.note).toBe("[redacted]");
  });
});

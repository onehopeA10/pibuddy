/**
 * `settings:get` 的公开键集合与迁移（CT-09 / PROV-101）。
 *
 * 两件事在这里被钉死：
 *
 *   1. **键集合可机械判定** —— `Object.keys(publicSettings(...))` 与契约包的
 *      `APP_SETTINGS_PUBLIC_KEYS` 排序后逐项相等（长度也相等）。写成「有值
 *      才放进去」时这个集合会随用户设了哪几项而飘，断言就没法机械判定了。
 *   2. **没有任何密钥字段** —— 白名单里 includes sttApiKeyConfigured /
 *      sttApiKeyLast4，且 **不含** sttApiKey，也不含 sttApiKeySet
 *      （TASK-008 已定名两个字段，不得引入第三种拼写）。
 *
 * 另外覆盖 v1 → v2 迁移：加了 provider / onboarding 相关字段，旧文件必须
 * 逐项保留原有值、新字段取默认值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_SETTINGS_PUBLIC_KEYS } from "@pibuddy/contract";

let userDataDir = "";
vi.mock("electron", () => ({ app: { getPath: () => userDataDir } }));

let tmpRoot = "";

type Settings = typeof import("../src/main/settings.js");

async function freshSettings(): Promise<Settings> {
  vi.resetModules();
  const mod = await import("../src/main/settings.js");
  mod.__setSettingsDataDir(userDataDir);
  return mod;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pibuddy-settings-"));
  userDataDir = path.join(tmpRoot, "userData");
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("[CT-09] 公开键集合", () => {
  it("publicSettings 的键集合与 APP_SETTINGS_PUBLIC_KEYS 逐项相等（含长度）", async () => {
    const settings = await freshSettings();
    const keys = Object.keys(settings.publicSettings(settings.loadSettings())).sort();
    const expected = [...APP_SETTINGS_PUBLIC_KEYS].sort();
    expect(keys).toHaveLength(expected.length);
    expect(keys).toEqual(expected);
  });

  it("设了一堆可选字段之后，键集合依然与白名单等长（不随取值飘）", async () => {
    const settings = await freshSettings();
    settings.saveSettings({
      workspace: "D:/work",
      provider: "anthropic",
      modelId: "some-model",
      thinkingLevel: "high",
      sttBaseUrl: "https://api.example.com/v1",
      sttModel: "whisper-1",
      piExternalCommand: "pi",
      onboardingCompletedAt: 123,
    });
    const keys = Object.keys(settings.publicSettings(settings.loadSettings())).sort();
    expect(keys).toEqual([...APP_SETTINGS_PUBLIC_KEYS].sort());
  });

  it("白名单含两个密钥展示位，不含明文字段，也没有第三种拼写", () => {
    const keys: readonly string[] = APP_SETTINGS_PUBLIC_KEYS;
    expect(keys).toContain("sttApiKeyConfigured");
    expect(keys).toContain("sttApiKeyLast4");
    expect(keys).not.toContain("sttApiKey");
    // TASK-008 已把字段定名为上面两个；再冒出一种拼写就是漂移的开始
    expect(keys).not.toContain("sttApiKeySet");
  });

  it("publicSettings 的返回值里不含任何明文密钥", async () => {
    const settings = await freshSettings();
    settings.saveSettings({ sttApiKeyConfigured: true, sttApiKeyLast4: "abcd" });
    const publicView = settings.publicSettings(settings.loadSettings()) as Record<
      string,
      unknown
    >;
    expect(publicView.sttApiKeyConfigured).toBe(true);
    expect(publicView.sttApiKeyLast4).toBe("abcd");
    expect("sttApiKey" in publicView).toBe(false);
  });
});

describe("[near-miss] schema 扩字段必须升版", () => {
  it("SETTINGS_SCHEMA_VERSION 已升到 2", async () => {
    const settings = await freshSettings();
    expect(settings.SETTINGS_SCHEMA_VERSION).toBe(2);
  });

  it("v1 旧文件经 migrate 后新字段取默认值，原有字段逐项保留", async () => {
    const settings = await freshSettings();
    const old = {
      schemaVersion: 1,
      workspace: "D:/old-work",
      sessionDir: "D:/old-sessions",
      provider: "openai",
      modelId: "old-model",
      thinkingLevel: "medium",
      sttBaseUrl: "https://stt.example.com/v1",
      sttEndpointId: "endpoint-123",
      sttApiKeyConfigured: true,
      sttApiKeyLast4: "9999",
      sttModel: "whisper-1",
      piRuntimeMode: "external",
      piExternalCommand: "D:/tools/pi",
      crashDumpConsent: "deny",
    };
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      JSON.stringify(old, null, 2)
    );

    const loaded = settings.loadSettings();

    // 原有字段一项都不许丢
    for (const [key, value] of Object.entries(old)) {
      if (key === "schemaVersion") continue;
      expect(loaded[key as keyof typeof loaded]).toEqual(value);
    }
    // 代际已升
    expect(loaded.schemaVersion).toBe(2);
    // 新字段取默认值
    expect(loaded.workspaceDefaults).toEqual({});
    expect(loaded.notificationsEnabled).toBe(true);
    expect(loaded.voiceEnabled).toBe(false);
  });

  it("已经在用的老用户（v1 且有 workspace）不被弹回首启向导", async () => {
    const settings = await freshSettings();
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      JSON.stringify({ schemaVersion: 1, workspace: "D:/work" })
    );
    const loaded = settings.loadSettings();
    expect(loaded.onboardingCompletedAt).toBeTypeOf("number");
    expect(loaded.onboardingStep).toBe(6);
  });

  it("v0（无 schemaVersion）的旧文件里明文密钥字段被抹掉", async () => {
    const settings = await freshSettings();
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      JSON.stringify({ sttApiKey: "sk-plaintext-leak", workspace: "D:/w" })
    );
    const loaded = settings.loadSettings() as Record<string, unknown>;
    expect("sttApiKey" in loaded).toBe(false);
    expect(loaded.workspace).toBe("D:/w");
    expect(loaded.schemaVersion).toBe(2);
  });

  it("全新用户（没有设置文件）从第 0 步开始，且未标记为已完成", async () => {
    const settings = await freshSettings();
    const loaded = settings.loadSettings();
    expect(loaded.onboardingStep).toBe(0);
    expect(loaded.onboardingCompletedAt).toBeUndefined();
  });
});

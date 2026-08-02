import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
}));

import {
  SETTINGS_SCHEMA_VERSION,
  __setSettingsDataDir,
  loadSettings,
  saveSettings,
} from "../src/main/settings.js";

/**
 * SEC-004：设置的原子写与代际迁移。
 *
 * 两条关键路径各一条断言：
 *   (a) 崩在 rename 之前（tmp 在、主文件还是上一版）→ loadSettings 拿到的
 *       仍然逐字段等于上一版
 *   (b) 不含 schemaVersion 的旧文件 → migrate 后代际补齐、用户字段无损
 */

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-settings-"));
  __setSettingsDataDir(dir);
});

afterEach(() => {
  __setSettingsDataDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const settingsFile = (): string => path.join(dir, "settings.json");

describe("settings 原子写", () => {
  it("写 tmp 后崩溃（未 rename）时 loadSettings 返回的仍是上一版，逐字段相等", () => {
    const previous = saveSettings({
      workspace: "D:/work",
      provider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: "high",
      sttModel: "whisper-1",
    });

    // 模拟 rename 之前掉电：tmp 落在磁盘上，主文件保持上一版
    fs.writeFileSync(`${settingsFile()}.tmp`, '{"workspace":"D:/HALF', "utf8");
    expect(fs.existsSync(`${settingsFile()}.tmp`)).toBe(true);

    const loaded = loadSettings();
    assert.deepStrictEqual(loaded, previous);
  });

  it("rename 抛错时原文件字节未变，且不会写出半截设置", () => {
    saveSettings({ workspace: "D:/work", modelId: "m1" });
    const before = fs.readFileSync(settingsFile());

    const boom = new Error("simulated crash before rename");
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw boom;
    });
    expect(() => saveSettings({ workspace: "D:/other" })).toThrow(boom);
    spy.mockRestore();

    expect(fs.readFileSync(settingsFile()).equals(before)).toBe(true);
    expect(loadSettings().workspace).toBe("D:/work");
  });

  it("主文件被改坏时从 .bak 恢复，而不是静默清空", () => {
    saveSettings({ workspace: "D:/work", modelId: "m1" });
    // 第二次保存会先把上一版复制成 .bak
    saveSettings({ modelId: "m2" });
    fs.writeFileSync(settingsFile(), "{ 这不是 JSON", "utf8");

    const loaded = loadSettings();
    expect(loaded.workspace).toBe("D:/work");
    expect(loaded.modelId).toBe("m1");
  });
});

describe("settings 代际迁移", () => {
  it("旧文件（无 schemaVersion）迁移后代际补齐且用户字段逐项保留", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({
        workspace: "D:/legacy",
        provider: "openai",
        modelId: "gpt-x",
        thinkingLevel: "medium",
        sttBaseUrl: "https://api.openai.com/v1",
        sttModel: "whisper-1",
        piRuntimeMode: "external",
        piExternalCommand: "D:/tools/pi",
      }),
      "utf8"
    );

    const loaded = loadSettings();

    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(loaded.workspace).toBe("D:/legacy");
    expect(loaded.provider).toBe("openai");
    expect(loaded.modelId).toBe("gpt-x");
    expect(loaded.thinkingLevel).toBe("medium");
    expect(loaded.sttBaseUrl).toBe("https://api.openai.com/v1");
    expect(loaded.sttModel).toBe("whisper-1");
    expect(loaded.piRuntimeMode).toBe("external");
    expect(loaded.piExternalCommand).toBe("D:/tools/pi");
  });

  it("旧文件里的明文密钥字段在迁移后既不进内存也不再写回磁盘", () => {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ workspace: "D:/legacy", sttApiKey: "sk-live-LEGACY" }),
      "utf8"
    );

    const loaded = loadSettings() as Record<string, unknown>;
    expect(loaded.sttApiKey).toBeUndefined();
    expect(loaded.sttApiKeyConfigured).toBe(false);

    saveSettings({ modelId: "m1" });
    expect(fs.readFileSync(settingsFile(), "utf8")).not.toContain("sk-live-LEGACY");
  });
});

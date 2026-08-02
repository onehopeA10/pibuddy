import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { parseAppSettings, type AppSettings } from "@pibuddy/contract";

export type { AppSettings };

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): AppSettings {
  try {
    return parseAppSettings(JSON.parse(fs.readFileSync(settingsPath(), "utf8")));
  } catch {
    // 文件不存在 / 读不动：交给 schema 生成一份带默认值的设置
    return parseAppSettings({});
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

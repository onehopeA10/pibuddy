import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface AppSettings {
  workspace?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  sttBaseUrl?: string;
  sttApiKey?: string;
  sttModel?: string;
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as AppSettings;
  } catch {
    return {};
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

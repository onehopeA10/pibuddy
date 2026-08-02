/**
 * 设置文件的读写（SEC-004）。
 *
 * 三件事在这里同时成立，缺一件就有具体的坏结果：
 *
 *   1. **原子写** —— 早先是一次裸的 writeFileSync + JSON.stringify 直接覆盖
 *      目标文件：写到一半掉电，用户下次启动拿到半截 JSON，工作目录与模型
 *      选择一起丢。现在一律走 fs-atomic.ts 的 writeJsonAtomic
 *      （tmp → fsync → rename），本文件里没有第二份原子写实现。
 *   2. **备份** —— 覆盖前把上一版复制成 settings.json.bak；主文件被改坏时
 *      从 .bak 恢复，而不是静默地退回一份空设置（那等于清空用户配置）。
 *   3. **schema 代际 + migrate** —— 旧文件缺字段时补默认值，并把历史遗留的
 *      明文密钥字段从磁盘上抹掉（它现在归 secret-store 管）。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { parseAppSettings, type AppSettings } from "@pibuddy/contract";

import { writeJsonAtomic } from "./fs-atomic.js";

export type { AppSettings };

/**
 * 设置文件的当前代际。
 *
 * 迁移逻辑住在本文件，因此代际常量也归本文件持有；契约包只声明
 * `schemaVersion` 这个字段的存在。加字段或改语义时 +1，并在 migrate() 里
 * 补一段对应的折叠。
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** 测试注入用的数据目录；生产环境恒为 null。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把 settings.json 指向临时目录。 */
export function __setSettingsDataDir(dir: string | null): void {
  dataDirOverride = dir;
}

function settingsDir(): string {
  return dataDirOverride ?? app.getPath("userData");
}

function settingsPath(): string {
  return path.join(settingsDir(), "settings.json");
}

function backupPath(): string {
  return `${settingsPath()}.bak`;
}

/**
 * 把任意代际的磁盘内容折成当前代际。
 *
 * v0（无 schemaVersion）→ v1：
 *   - 补 schemaVersion
 *   - 删掉历史遗留的明文密钥字段。它不能「顺手迁进 secret-store」——
 *     safeStorage 未必可用，而一个「迁移时静默失败就把明文留着」的实现
 *     比直接删掉更糟。删掉之后用户在设置里重填一次，密钥就进加密存储了。
 *   - 其余用户字段（workspace / provider / modelId / thinkingLevel / …）
 *     逐项原样保留：迁移丢字段的表现是用户重启后工作目录没了。
 */
export function migrate(raw: unknown): Record<string, unknown> {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};

  if (typeof source.schemaVersion !== "number") {
    delete source["sttApiKey"];
    source.schemaVersion = SETTINGS_SCHEMA_VERSION;
  }

  return source;
}

/** 读一个 JSON 文件；不存在或坏掉返回 null。 */
function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 载入设置。
 *
 * 读取顺序：settings.json → settings.json.bak → 全默认值。
 * 刻意**不看** settings.json.tmp —— 那是一次没走完的写入，内容可能是半截的；
 * 崩在 rename 之前时 settings.json 里躺着的仍是完整的上一版，直接用它。
 */
export function loadSettings(): AppSettings {
  const primary = readJson(settingsPath());
  if (primary !== null) return parseAppSettings(migrate(primary));

  const backup = readJson(backupPath());
  if (backup !== null) return parseAppSettings(migrate(backup));

  return parseAppSettings(migrate({}));
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = {
    ...loadSettings(),
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };

  fs.mkdirSync(settingsDir(), { recursive: true });
  // 覆盖前留一份上一版：主文件被外部工具改坏时 loadSettings 还能捡回来
  try {
    if (fs.existsSync(settingsPath())) {
      fs.copyFileSync(settingsPath(), backupPath());
    }
  } catch {
    /* 备份失败不阻断保存：有备份是加分项，写不进去才是硬故障 */
  }

  writeJsonAtomic(settingsPath(), merged);
  return merged;
}

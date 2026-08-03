/**
 * 能力启用偏好的落盘（ADR-0002 D4 规则 3：数据按 capabilityId 分区）。
 *
 * ## 为什么不塞进 settings.json
 *
 * `AppSettings` 已经是一个同时装着内核字段（piRuntimeMode / provider）与
 * 偏好字段（notificationsEnabled / voiceEnabled）的扁平大对象。能力开关塞
 * 进去会有两个具体的坏处：
 *
 *   1. 它会自动落进 `settings:set` 的可写集合。渲染进程被攻陷后「把用户
 *      关掉的能力再打开」就变成一次普通的设置写入 —— 这与 SEC-005 把
 *      `piRuntimeMode` 移出可写集合的理由完全同构。
 *   2. 能力偏好的键是 capabilityId，是一个**随能力包增删而变**的集合；
 *      把它放进一个有穷举校验与代际迁移的 schema 里，等于每装一个能力包
 *      就要动一次 settings 的 migrate。
 *
 * 独立文件的先例是 `update/update-ipc.ts:72` 的 update-prefs.json。
 *
 * ## profileId 与 overrides 分开存
 *
 * 换 Profile 不该抹掉用户对某个能力的明确意见。合并成一个集合存的话，
 * 换一次 Profile 就把那些意见全丢了，用户看到的是「我明明关过的东西又
 * 自己回来了」。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "../fs-atomic.js";

export const CAPABILITY_PREFS_SCHEMA_VERSION = 1;
export const CAPABILITY_PREFS_FILENAME = "capability-prefs.json";

export interface CapabilityPrefs {
  schemaVersion: number;
  /** 当前 Profile id */
  profileId: string;
  /** Profile 之上的逐个开关；键是 capabilityId */
  overrides: Record<string, boolean>;
}

/** 测试注入用；生产环境恒为 null。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把偏好文件指向临时目录。 */
export function __setCapabilityPrefsDir(dir: string | null): void {
  dataDirOverride = dir;
}

function prefsPath(): string {
  return path.join(dataDirOverride ?? app.getPath("userData"), CAPABILITY_PREFS_FILENAME);
}

/**
 * 把任意磁盘内容折成一份可用的偏好。
 *
 * 文件被手改坏时回落到默认值而不是抛错：能力开关读不出来就让应用起不来，
 * 是一次远比「回到默认 Profile」严重得多的失败。
 */
export function normalizeCapabilityPrefs(raw: unknown, defaultProfileId: string): CapabilityPrefs {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const profileId = typeof source.profileId === "string" && source.profileId !== ""
    ? source.profileId
    : defaultProfileId;
  const overrides: Record<string, boolean> = {};
  const rawOverrides = source.overrides;
  if (rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)) {
    for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (typeof value === "boolean") overrides[key] = value;
    }
  }
  return { schemaVersion: CAPABILITY_PREFS_SCHEMA_VERSION, profileId, overrides };
}

export function loadCapabilityPrefs(defaultProfileId: string): CapabilityPrefs {
  try {
    return normalizeCapabilityPrefs(JSON.parse(fs.readFileSync(prefsPath(), "utf8")), defaultProfileId);
  } catch {
    return normalizeCapabilityPrefs(null, defaultProfileId);
  }
}

export function saveCapabilityPrefs(prefs: CapabilityPrefs): void {
  writeJsonAtomic(prefsPath(), { ...prefs, schemaVersion: CAPABILITY_PREFS_SCHEMA_VERSION });
}

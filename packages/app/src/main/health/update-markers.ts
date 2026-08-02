/**
 * 更新交接 marker 与健康记录的落盘（UPD-006 / OBS-101）。
 *
 * 三个文件都住在 `<userData>/update-state/`：
 *
 *   pending-update.json    installAndRestart 之前写；它存在 = 上一次启动是
 *                          一次更新之后的**第一次**启动，必须跑健康检查。
 *   last-known-good.json   健康启动之后写；它是「下载上一稳定版本」入口的
 *                          唯一版本来源。
 *   health.json            连续失败计数与最近一次检查结果（safe mode 的判据）。
 *
 * ## 一律经 fs-atomic 的 writeJsonAtomic
 *
 * 本目录**不重写第三份原子写**。marker 半写的后果特别脏：下次启动读到损坏
 * JSON → 判定"上一次更新失败" → 直接进安全模式，而实际上什么都没坏，
 * 只是写文件时用户按了电源键。
 *
 * 刻意不 import electron：目录由调用方传入，这样整套逻辑能在纯 node 的
 * vitest 里跑，而不是跑一个给 electron 打的桩。
 */
import fs from "node:fs";
import path from "node:path";

import type {
  HealthCheckResult,
  LastKnownGoodMarker,
  PendingUpdateMarker,
} from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";

export const PENDING_UPDATE_FILE = "pending-update.json";
export const LAST_KNOWN_GOOD_FILE = "last-known-good.json";
export const HEALTH_FILE = "health.json";

/** 健康记录。safeMode 是**派生量**，但一起落盘，免得启动时还要再算一次。 */
export interface HealthRecord {
  consecutiveFailures: number;
  safeMode: boolean;
  lastResult: HealthCheckResult | null;
  updatedAt: number;
}

export const EMPTY_HEALTH: HealthRecord = {
  consecutiveFailures: 0,
  safeMode: false,
  lastResult: null,
  updatedAt: 0,
};

export function markerDir(userDataDir: string): string {
  return path.join(userDataDir, "update-state");
}

/**
 * 读一个 JSON marker。**读坏了一律当成不存在**（返回 null），不抛。
 *
 * 抛出去的话，调用链上任何一处没接住，用户就会看到一个起不来的应用，
 * 而根因只是一个可以直接删掉的缓存文件。
 */
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pending

export function writePendingUpdate(dir: string, marker: PendingUpdateMarker): void {
  writeJsonAtomic(path.join(dir, PENDING_UPDATE_FILE), marker);
}

export function readPendingUpdate(dir: string): PendingUpdateMarker | null {
  return readJson<PendingUpdateMarker>(path.join(dir, PENDING_UPDATE_FILE));
}

export function clearPendingUpdate(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, PENDING_UPDATE_FILE));
  } catch {
    /* 本来就没有 */
  }
}

// ---------------------------------------------------------------- LKG

export function writeLastKnownGood(dir: string, marker: LastKnownGoodMarker): void {
  writeJsonAtomic(path.join(dir, LAST_KNOWN_GOOD_FILE), marker);
}

export function readLastKnownGood(dir: string): LastKnownGoodMarker | null {
  return readJson<LastKnownGoodMarker>(path.join(dir, LAST_KNOWN_GOOD_FILE));
}

// ---------------------------------------------------------------- health

export function readHealth(dir: string): HealthRecord {
  return readJson<HealthRecord>(path.join(dir, HEALTH_FILE)) ?? { ...EMPTY_HEALTH };
}

export function writeHealth(dir: string, record: HealthRecord): void {
  writeJsonAtomic(path.join(dir, HEALTH_FILE), record);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HealthCheckResult } from "@pibuddy/contract";

import {
  HEALTH_CHECK_TIMEOUT_MS,
  runStartupHealthCheck,
  type HealthProbes,
} from "./health-check.js";
import {
  SAFE_MODE_FAILURE_THRESHOLD,
  recordHealthResult,
  safeModeState,
} from "./safe-mode.js";
import {
  clearPendingUpdate,
  markerDir,
  readLastKnownGood,
  readPendingUpdate,
  writeLastKnownGood,
  writePendingUpdate,
} from "./update-markers.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-health-"));
  dirs.push(dir);
  return markerDir(dir);
}

function probes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  return {
    dbMigration: async () => undefined,
    rendererReady: async () => undefined,
    piHandshake: async () => undefined,
    ...overrides,
  };
}

function failing(names: Array<keyof HealthProbes>): HealthProbes {
  const base = probes();
  for (const n of names) base[n] = async () => Promise.reject(new Error(`${n} failed`));
  return base;
}

afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("runStartupHealthCheck", () => {
  it("三项都过时 ok=true，failed 为空", async () => {
    const result = await runStartupHealthCheck(probes());
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
  });

  it("探针抛错的那一项进 failed", async () => {
    const result = await runStartupHealthCheck(failing(["piHandshake"]));
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(["pi-handshake"]);
  });

  it("任一项永不 resolve 时仍在 5000ms 内 settle，且该项出现在 failed 里", async () => {
    // 没有超时的表现是：更新后应用永远停在启动画面，日志里什么都没有。
    vi.useFakeTimers();

    const never = new Promise<never>(() => {
      /* 故意不 resolve */
    });
    const pending = runStartupHealthCheck(probes({ rendererReady: () => never }));

    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(settled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failed).toContain("renderer-ready");
    expect(result.failed).not.toContain("db-migration");
  });
});

describe("safe mode", () => {
  function fail(): HealthCheckResult {
    return { ok: false, failed: ["db-migration"], checkedAt: 1 };
  }
  function pass(): HealthCheckResult {
    return { ok: true, failed: [], checkedAt: 2 };
  }

  it("连续两次失败进安全模式；一次成功启动之后计数归零且退出安全模式", () => {
    const dir = tmpDir();

    expect(recordHealthResult(dir, fail()).active).toBe(false);
    const second = recordHealthResult(dir, fail());
    expect(second.consecutiveFailures).toBe(SAFE_MODE_FAILURE_THRESHOLD);
    expect(second.active).toBe(true);
    expect(second.disabled.length).toBeGreaterThan(0);

    // 不复位的话，用户第一次进安全模式就永远出不来。
    const recovered = recordHealthResult(dir, pass());
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.active).toBe(false);
    expect(safeModeState(dir).active).toBe(false);
  });

  it("安全模式里能拿到上一稳定版本号（「下载上一稳定版本」入口要显示它）", () => {
    const dir = tmpDir();
    writeLastKnownGood(dir, { version: "1.2.3", verifiedAt: 1 });
    recordHealthResult(dir, fail());
    expect(recordHealthResult(dir, fail()).previousVersion).toBe("1.2.3");
  });
});

describe("marker 原子写", () => {
  it("pending-update 写入 → 读回 → 清除", () => {
    const dir = tmpDir();
    expect(readPendingUpdate(dir)).toBeNull();

    writePendingUpdate(dir, { fromVersion: "1.0.0", toVersion: "1.1.0", startedAt: 42 });
    expect(readPendingUpdate(dir)?.toVersion).toBe("1.1.0");

    clearPendingUpdate(dir);
    expect(readPendingUpdate(dir)).toBeNull();
  });

  it("写入过程中抛错时，原 marker 文件的字节未变", () => {
    const dir = tmpDir();
    const file = path.join(dir, "last-known-good.json");
    writeLastKnownGood(dir, { version: "1.0.0", verifiedAt: 1 });
    const before = fs.readFileSync(file);

    // 循环引用会让序列化抛错。marker 半写会让下次启动读到损坏 JSON
    // 并直接进安全模式 —— 而实际上什么都没坏。
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      writeLastKnownGood(dir, circular as unknown as { version: string; verifiedAt: number })
    ).toThrow();

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(readLastKnownGood(dir)?.version).toBe("1.0.0");
    // 半截的 .tmp 不许留在盘上
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("marker 读坏了当成不存在，而不是把应用搞挂", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pending-update.json"), "{ 半截", "utf8");
    expect(readPendingUpdate(dir)).toBeNull();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BundleEntry } from "@pibuddy/contract";

import { exportBundle, previewBundle, type BundleSources } from "./support-bundle.js";

/**
 * 诊断包（OBS-101）的三条硬要求：
 *   1. 预览与实际导出的内容一致（两边各算一次必然漂移）
 *   2. 文本条目里不许出现预置的假密钥
 *   3. crash dump 只在明确同意之后才进包
 */

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-bundle-"));
  roots.push(dir);
  return dir;
}

const FAKE_KEY = "sk-ant-deadbeefdeadbeef0123";

function fixture(consent: "unset" | "allow" | "deny" = "unset"): {
  root: string;
  sources: BundleSources;
} {
  const root = tmpRoot();
  const logDir = path.join(root, "logs");
  const stateDir = path.join(root, "update-state");
  const crashDir = path.join(root, "crash");
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(crashDir, { recursive: true });

  const logFile = path.join(logDir, "pibuddy-20260803.log");
  fs.writeFileSync(
    logFile,
    `{"event":"stt","apiKey":"${FAKE_KEY}","note":"Bearer ${FAKE_KEY}"}\n`,
    "utf8"
  );
  const settingsFile = path.join(root, "settings.json");
  fs.writeFileSync(settingsFile, `{"sttBaseUrl":"https://x/v1","key":"${FAKE_KEY}"}`, "utf8");
  fs.writeFileSync(path.join(stateDir, "health.json"), '{"consecutiveFailures":0}', "utf8");
  fs.writeFileSync(path.join(crashDir, "dump-1.dmp"), Buffer.from([0, 1, 2, 3]));

  return {
    root,
    sources: {
      logFiles: [logFile],
      settingsFile,
      updateStateDir: stateDir,
      crashDumpDir: crashDir,
      crashDumpConsent: consent,
      systemInfo: { appVersion: "0.1.0", apiKey: FAKE_KEY },
    },
  };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("previewBundle", () => {
  it("返回清单但**不写任何文件**，每项都带 path / sizeBytes / redacted", () => {
    const { root, sources } = fixture();
    const before = fs.readdirSync(root).sort();

    const entries: BundleEntry[] = previewBundle(sources);

    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.path).toBe("string");
      expect(typeof e.sizeBytes).toBe("number");
      expect(typeof e.redacted).toBe("boolean");
    }
    expect(entries.map((e) => e.path)).toContain("system-info.json");
    expect(entries.some((e) => e.path.startsWith("logs/"))).toBe(true);
  });

  it("未同意时清单里没有 crash dump；同意后才出现，且明写 redacted: false", () => {
    expect(previewBundle(fixture("unset").sources).some((e) => e.path.startsWith("crash-dumps/")))
      .toBe(false);
    expect(previewBundle(fixture("deny").sources).some((e) => e.path.startsWith("crash-dumps/")))
      .toBe(false);

    const allowed = previewBundle(fixture("allow").sources).filter((e) =>
      e.path.startsWith("crash-dumps/")
    );
    expect(allowed).toHaveLength(1);
    // 二进制转储脱不了敏，清单里必须如实说，不能混进「已脱敏」那一栏。
    expect(allowed[0].redacted).toBe(false);
  });
});

describe("exportBundle", () => {
  it("写出的 zip 字节流里不含预置的假密钥", () => {
    const { root, sources } = fixture();
    const target = path.join(root, "out", "bundle.zip");

    const result = exportBundle(target, sources);

    expect(fs.existsSync(target)).toBe(true);
    expect(result.entryCount).toBeGreaterThan(0);

    // STORE（不压缩）是刻意的：这条断言才有意义。deflate 之后搜不到
    // 只能证明"压过了"，证明不了"没写进去"。
    const raw = fs.readFileSync(target);
    expect(raw.includes(FAKE_KEY)).toBe(false);
    expect(raw.subarray(0, 4).toString("hex")).toBe("504b0304");
    // 脱敏没把有诊断价值的内容一起抹掉
    expect(raw.includes("sttBaseUrl")).toBe(true);
    expect(raw.includes("system-info.json")).toBe(true);
  });

  it("预览清单与实际导出的条目一一对应", () => {
    const { root, sources } = fixture("allow");
    const entries = previewBundle(sources);
    const result = exportBundle(path.join(root, "b.zip"), sources);
    expect(result.entryCount).toBe(entries.length);
  });
});

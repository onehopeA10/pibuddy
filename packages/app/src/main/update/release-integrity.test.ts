/**
 * 安装前完整性校验。
 *
 * 这是本子系统里唯一一处「返回 false 就能避免真实数据损失」的判据：
 * 降级安装会让用户的数据被旧版本的迁移逻辑处理。
 */
import { describe, expect, it } from "vitest";

import { compareSemver, verifyBeforeInstall } from "./release-integrity.js";

describe("compareSemver", () => {
  it("按主次修订号比较", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("prerelease 小于同主体的正式版", () => {
    expect(compareSemver("1.2.0-beta.1", "1.2.0")).toBeLessThan(0);
    expect(compareSemver("1.2.0", "1.2.0-beta.1")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0-beta.2", "1.2.0-beta.1")).toBeGreaterThan(0);
  });

  it("解析不了的版本号返回 NaN，而不是假装相等", () => {
    expect(Number.isNaN(compareSemver("不是版本号", "1.0.0"))).toBe(true);
  });
});

describe("verifyBeforeInstall", () => {
  it("(a) 候选版本不严格大于当前版本 → ok:false, metadata", () => {
    for (const version of ["1.0.0", "0.9.9", "1.0.0-beta.1"]) {
      const r = verifyBeforeInstall({ version, currentVersion: "1.0.0" });
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("metadata");
    }
  });

  it("(b) sha512 与清单不符 → ok:false, signature", () => {
    const r = verifyBeforeInstall(
      {
        version: "2.0.0",
        currentVersion: "1.0.0",
        filePath: "/tmp/PiBuddy-Setup-2.0.0.exe",
        expectedSha512: "EXPECTED",
      },
      { exists: () => true, readSha512: () => "ACTUAL" }
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("signature");
  });

  it("版本更新 + sha512 一致 → ok:true", () => {
    const r = verifyBeforeInstall(
      {
        version: "2.0.0",
        currentVersion: "1.0.0",
        filePath: "/tmp/PiBuddy-Setup-2.0.0.exe",
        expectedSha512: "SAME",
      },
      { exists: () => true, readSha512: () => "SAME" }
    );
    expect(r.ok).toBe(true);
  });

  it("下载好的文件不见了 → ok:false, disk", () => {
    const r = verifyBeforeInstall(
      { version: "2.0.0", currentVersion: "1.0.0", filePath: "/tmp/gone.exe" },
      { exists: () => false }
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("disk");
  });

  it("没有候选版本 → ok:false, metadata", () => {
    const r = verifyBeforeInstall({ version: null, currentVersion: "1.0.0" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("metadata");
  });

  it("没给文件路径时只做版本单调校验（fake feed / 部分平台不下发路径）", () => {
    expect(verifyBeforeInstall({ version: "2.0.0", currentVersion: "1.0.0" }).ok).toBe(true);
  });
});

/**
 * 安装前完整性校验。
 *
 * 这是本子系统里唯一一处「返回 false 就能避免真实数据损失」的判据：
 * 降级安装会让用户的数据被旧版本的迁移逻辑处理。
 */
import { describe, expect, it } from "vitest";

import { compareSemver, isPrerelease, verifyBeforeInstall } from "./release-integrity.js";

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

  /**
   * 按字符串比 prerelease 时 "10" < "2"，于是 beta.10 被判成比 beta.2 旧。
   * 后果是第 10 个 beta 发出去之后，所有 beta 用户再也收不到更新，
   * 日志里只有一句"候选版本不高于当前版本"。
   */
  it("prerelease 里的纯数字段按数值比较（beta.10 > beta.2）", () => {
    expect(compareSemver("1.2.0-beta.10", "1.2.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0-beta.2", "1.2.0-beta.10")).toBeLessThan(0);
    expect(compareSemver("1.2.0-rc.9", "1.2.0-rc.11")).toBeLessThan(0);
  });

  it("数字标识符低于字母数字标识符，字段多的更大（semver.org §11）", () => {
    // 规范给出的优先级链，逐对断言严格递增
    const ascending = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i + 1 < ascending.length; i++) {
      expect(compareSemver(ascending[i], ascending[i + 1])).toBeLessThan(0);
      expect(compareSemver(ascending[i + 1], ascending[i])).toBeGreaterThan(0);
    }
  });

  it("尾部有垃圾字符的版本号被拒绝，而不是前缀匹配成 1.2.3", () => {
    for (const bad of ["1.2.3junk", "1.2.3.4", "1.2", "1.2.3-", "01.0.0", "1.2.3 4"]) {
      expect(Number.isNaN(compareSemver(bad, "1.0.0"))).toBe(true);
      expect(Number.isNaN(compareSemver("1.0.0", bad))).toBe(true);
    }
  });

  it("build metadata 不参与优先级比较，v 前缀被接受", () => {
    expect(compareSemver("1.2.3+build.7", "1.2.3")).toBe(0);
    expect(compareSemver("v1.2.4", "1.2.3")).toBeGreaterThan(0);
  });
});

describe("isPrerelease", () => {
  it("带 prerelease 标记为 true，正式版为 false", () => {
    expect(isPrerelease("1.2.0-beta.1")).toBe(true);
    expect(isPrerelease("1.2.0")).toBe(false);
    expect(isPrerelease("1.2.0+build.1")).toBe(false);
  });

  it("畸形版本号当作 prerelease —— 它绝不该进 stable 通道", () => {
    expect(isPrerelease("1.2.3junk")).toBe(true);
    expect(isPrerelease("")).toBe(true);
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

  it("候选版本畸形 → ok:false, metadata（绝不前缀匹配后放行）", () => {
    const r = verifyBeforeInstall({ version: "1.2.3junk", currentVersion: "1.0.0" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("metadata");
  });

  it("beta.10 相对 beta.2 是升级，不能被当成降级拒掉", () => {
    const r = verifyBeforeInstall({
      version: "1.2.0-beta.10",
      currentVersion: "1.2.0-beta.2",
    });
    expect(r.ok).toBe(true);
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

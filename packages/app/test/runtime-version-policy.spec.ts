import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PI_COMPAT_MIN,
  assertNoRuntimeNpmUpdate,
  checkExternalPiVersion,
  usesBundledRuntime,
} from "../src/main/update/runtime-version-policy.js";

/**
 * UPD-007：内置 pi 的版本跟随应用发布，**不在用户机器上做运行期自升级**；
 * external pi 只检测不擅自改。
 */

const SRC = path.resolve(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|cts|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("运行期自升级在代码库里不存在", () => {
  it("packages/app/src 下没有任何 `npm update` / `npm i -g` / `npm install -g` 调用", () => {
    // 运行期装进来的 pi 没有经过发布签名，等于绕开整条供应链验证；
    // 而且 macOS hardened runtime 与 Windows per-user 安装目录都不保证可写。
    const re = /npm\s+(update|i\s+-g|install\s+-g)/;
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      // 本策略文件自己会以字符串形式提到这几条命令（那正是它存在的理由）
      if (file.endsWith("runtime-version-policy.ts")) continue;
      const text = fs.readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        if (re.test(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
    expect(() => assertNoRuntimeNpmUpdate()).not.toThrow();
  });
});

describe("external pi 版本兼容判定", () => {
  it("低于下限时判不兼容，且提示语明说不会替用户改动系统上的 pi", () => {
    const verdict = checkExternalPiVersion("0.50.0");
    expect(verdict.compatible).toBe(false);
    expect(verdict.message).toContain(PI_COMPAT_MIN);
    expect(verdict.message).toContain("不会替你改动");
  });

  it("范围内判兼容", () => {
    expect(checkExternalPiVersion("0.83.0").compatible).toBe(true);
    expect(checkExternalPiVersion("v0.85.2").compatible).toBe(true);
  });

  it("认不出的版本号按兼容处理，而不是把用户自编译的 pi 一律挡在门外", () => {
    expect(checkExternalPiVersion("nightly-build").compatible).toBe(true);
    expect(checkExternalPiVersion(null).compatible).toBe(true);
  });

  it("默认用内置运行时", () => {
    expect(usesBundledRuntime({ piRuntimeMode: "bundled" })).toBe(true);
    expect(usesBundledRuntime({ piRuntimeMode: "external" })).toBe(false);
  });
});

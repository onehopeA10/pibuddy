/**
 * 把两个校验脚本接进测试流程。
 *
 * 「版本要锁死」如果只写在文档里，某次 `pnpm up` 就会把它悄悄改回浮动版本，
 * 而所有测试照样全绿。放进单测之后，这件事变成机器判定的。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..", "..");

function run(script: string): string {
  return execFileSync(process.execPath, [resolve(ROOT, script)], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

describe("更新依赖版本一致性", () => {
  it("check-update-deps.mjs 退出码 0", () => {
    const out = run("packages/app/scripts/check-update-deps.mjs");
    expect(out).toContain("electron-updater");
    expect(out).toContain("electron-log");
    expect(out).toContain("electron-builder");
  });

  it("三个版本在 package.json 里是精确值", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "packages/app/package.json"), "utf8")
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["electron-updater"]).toBe("6.8.9");
    expect(pkg.dependencies["electron-log"]).toBe("5.4.4");
    expect(pkg.devDependencies["electron-builder"]).toBe("26.15.3");
  });
});

describe("CancellationToken 能力探针", () => {
  it("check-updater-capability.mjs 输出可解析的能力位", () => {
    const out = run("packages/app/scripts/check-updater-capability.mjs");
    const parsed = JSON.parse(out.trim()) as { cancelSupported: boolean };
    expect(typeof parsed.cancelSupported).toBe("boolean");
    // 本仓锁定的 electron-updater 6.8.9 导出 CancellationToken 且
    // downloadUpdate 接受它 —— 因此界面上那个「取消下载」按钮是有效的。
    expect(parsed.cancelSupported).toBe(true);
  });
});

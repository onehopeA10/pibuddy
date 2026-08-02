import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 发布流水线的结构断言（UPD-005）。
 *
 * 这些是「看起来对了但用户机器上更新静默失效」那一类问题的唯一机器判据：
 *   - 清单必须在**最后**发布（先发清单 = 客户端指向还没上传完的文件）
 *   - 缺签名凭据必须失败关闭（不静默产出未签名正式包）
 *   - 正式发布不得走第三方 Electron 镜像
 *   - 第三方 action 必须 SHA 固定
 *
 * 用行扫描而不是 YAML 解析器：仓库里没有 yaml 依赖，而为了断言四条结构
 * 规则引一个依赖，会立刻撞上 check-pure-js-deps 的闸门。这份文件是我们
 * 自己写的，格式可控。
 */

const REPO = path.resolve(__dirname, "..", "..", "..");
const RELEASE = path.join(REPO, ".github", "workflows", "release.yml");
const CI = path.join(REPO, ".github", "workflows", "ci.yml");

function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

/** 取某个 job 块里的全部 `- name:` 步骤，按出现顺序。 */
function stepsOf(file: string, job: string): string[] {
  const all = lines(file);
  const start = all.findIndex((l) => l.trimEnd() === `  ${job}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const steps: string[] = [];
  for (let i = start + 1; i < all.length; i++) {
    const line = all[i];
    if (/^ {2}\S/.test(line)) break; // 下一个 job 开始
    const m = /^ {6}- name:\s*(.+)$/.exec(line);
    if (m) steps.push(m[1].trim());
  }
  return steps;
}

describe("release.yml 结构", () => {
  it("build 与 publish 分离为 upload-artifacts / publish-manifest 两个 job，且用 needs 声明依赖", () => {
    const text = fs.readFileSync(RELEASE, "utf8");
    expect(text).toContain("  upload-artifacts:");
    expect(text).toContain("  publish-manifest:");
    expect(text).toContain("needs: upload-artifacts");
  });

  it("latest*.yml 的上传是 publish-manifest 的**最后一个** step", () => {
    const steps = stepsOf(RELEASE, "publish-manifest");
    expect(steps.length).toBeGreaterThan(1);
    // 先发不可变产物，最后才发清单。顺序反了的表现是客户端在那几十秒里
    // 读到一个指向不存在文件的清单，报「下载更新失败」而服务端一切正常。
    expect(steps[steps.length - 1]).toBe("Publish channel manifests last");
    expect(steps).toContain("Publish immutable payloads first");
    expect(steps.indexOf("Publish immutable payloads first")).toBeLessThan(steps.length - 1);
  });

  it("缺签名凭据时显式失败关闭（不静默产出未签名正式包）", () => {
    const text = fs.readFileSync(RELEASE, "utf8");
    expect(text).toContain('if [ -z "${WIN_CSC_LINK}" ]');
    expect(text).toContain("release blocked");
    expect(text).toMatch(/exit 1/);
    for (const secret of [
      "WIN_CSC_LINK",
      "WIN_CSC_KEY_PASSWORD",
      "APPLE_TEAM_ID",
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "PIBUDDY_UPDATE_FEED_URL",
    ]) {
      expect(text).toContain(secret);
    }
  });

  it("正式发布不引用任何第三方 Electron 镜像开关", () => {
    const text = fs.readFileSync(RELEASE, "utf8");
    expect(text).not.toMatch(/PIBUDDY_USE_CN_MIRROR|NPM_CONFIG_REGISTRY|npmmirror/);
  });
});

describe("workflow action 固定", () => {
  it("release.yml 与 ci.yml 里所有第三方 action 都以 40 位 SHA 固定", () => {
    for (const file of [RELEASE, CI]) {
      const bad = lines(file)
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /^\s*-?\s*uses:/.test(l))
        .filter(({ l }) => !/@[0-9a-f]{40}\s*$/.test(l));
      expect(bad.map((b) => `${path.basename(file)}:${b.i + 1} ${b.l.trim()}`)).toEqual([]);
    }
  });

  it("ci.yml 是在 TASK-001 的闸门上追加，而不是被重建覆盖", () => {
    const text = fs.readFileSync(CI, "utf8");
    for (const gate of [
      "pnpm build",
      "node scripts/check-test-discovery.mjs",
      "node scripts/check-contract-uniqueness.mjs",
      "node scripts/check-workflow-pins.mjs",
    ]) {
      expect(text).toContain(gate);
    }
  });
});

describe("electron-builder.yml", () => {
  const yml = fs.readFileSync(path.join(REPO, "packages", "app", "electron-builder.yml"), "utf8");

  it("mac 同时产出 dmg 与 zip（缺 zip 时 macOS 自动更新整体不工作）", () => {
    const mac = yml.slice(yml.indexOf("\nmac:"), yml.indexOf("\nlinux:"));
    expect(mac).toMatch(/-\s*dmg/);
    expect(mac).toMatch(/-\s*zip/);
    expect(mac).toContain("hardenedRuntime: true");
    expect(mac).toContain("entitlements: build/entitlements.mac.plist");
    expect(mac).toContain("NSMicrophoneUsageDescription");
  });

  it("win 保持 per-user NSIS，linux 补 deb", () => {
    expect(yml).toContain("perMachine: false");
    expect(yml).toMatch(/-\s*nsis/);
    expect(yml).toMatch(/-\s*AppImage/);
    expect(yml).toMatch(/-\s*deb/);
  });

  it("镜像不在配置里，asar 保持 true，publish 指向 generic feed", () => {
    expect(yml).not.toContain("npmmirror");
    expect(yml).not.toContain("asar: false");
    expect(yml).toContain("asar: true");
    expect(yml).toContain("provider: generic");
    expect(yml).toContain("${env.PIBUDDY_UPDATE_FEED_URL}");
    // afterPack 丢了的话，打包后 pi 启动即 ERR_MODULE_NOT_FOUND
    expect(yml).toContain("afterPack: scripts/after-pack.cjs");
  });
});

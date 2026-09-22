import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateReleaseTarget } from "../scripts/validate-release-target.mjs";

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
const RELEASE_GITHUB = path.join(REPO, ".github", "workflows", "release-github.yml");
const CI = path.join(REPO, ".github", "workflows", "ci.yml");
const SETUP_DOC = path.join(REPO, "docs", "product", "RELEASE_SETUP.md");

function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/);
}

/** 取某个 job 块的原始文本（到下一个顶层 job 为止）。 */
function jobBlock(file: string, job: string): string {
  const all = lines(file);
  const start = all.findIndex((l) => l.trimEnd() === `  ${job}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < all.length; i++) {
    if (/^ {2}\S/.test(all[i])) break;
    out.push(all[i]);
  }
  return out.join("\n");
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
    const publish = jobBlock(RELEASE, "publish-manifest");
    expect(publish).toContain("      - preflight");
    expect(publish).toContain("      - upload-artifacts");
  });

  it("正式发布在打包之前跑自动化回归，且回归不消费 secrets", () => {
    const text = fs.readFileSync(RELEASE, "utf8");
    expect(text).toContain("  regression:");
    expect(jobBlock(RELEASE, "regression")).toContain("scripts/release-regression.mjs");
    // 回归读不到任何凭据，声明 environment 只会多一次人工审批。
    expect(jobBlock(RELEASE, "regression")).not.toMatch(/^\s{4}environment:/m);
    const upload = jobBlock(RELEASE, "upload-artifacts");
    expect(upload).toMatch(/needs:/);
    expect(upload).toContain("preflight");
    expect(upload).toContain("regression");
  });

  it("打包后启动一次解包产物，且清单发布仍是最后一步", () => {
    expect(stepsOf(RELEASE, "upload-artifacts")).toContain("Smoke packaged app");
    expect(jobBlock(RELEASE, "upload-artifacts")).toContain(
      "node packages/app/scripts/smoke-packaged-app.mjs",
    );
    const steps = stepsOf(RELEASE, "publish-manifest");
    expect(steps[steps.length - 1]).toBe("Publish channel manifests last");
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
      "MAC_CSC_LINK",
      "MAC_CSC_KEY_PASSWORD",
      "APPLE_TEAM_ID",
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "PIBUDDY_UPDATE_FEED_URL",
    ]) {
      expect(text).toContain(secret);
    }
  });

  /**
   * 文档要求把 secrets 放在 `release` environment，但 workflow 里只要有一个
   * 消费 secrets 的 job 漏了 `environment:`，那个 job 读到的就全是空串 ——
   * 用户照文档配完，preflight 却报「每一项都 missing」，同时还悄悄失去了
   * environment 的审批门禁。这条断言把文档与 workflow 钉在一起。
   */
  it("每个消费 secrets 的 job 都声明 environment: release，且与文档一致", () => {
    for (const job of ["preflight", "upload-artifacts", "publish-manifest"]) {
      expect(jobBlock(RELEASE, job)).toMatch(/^\s{4}environment:\s*release\s*$/m);
    }
    // 文档侧必须写着同一个 environment 名，否则用户会配到别的地方去
    expect(fs.readFileSync(SETUP_DOC, "utf8")).toContain("environment: release");
  });

  it("正式发布不引用任何第三方 Electron 镜像开关", () => {
    const text = fs.readFileSync(RELEASE, "utf8");
    expect(text).not.toMatch(/PIBUDDY_USE_CN_MIRROR|NPM_CONFIG_REGISTRY|npmmirror/);
  });
});

describe("手动发布可达性与版本来源", () => {
  it.each([
    ["workflow_dispatch", "stable", "true", true],
    ["workflow_dispatch", "stable", "false", false],
    ["workflow_dispatch", "stable", "", false],
    ["workflow_dispatch", "beta", "true", false],
    ["workflow_dispatch", "nightly", "true", false],
    ["push", "stable", "true", false],
  ])("event=%s channel=%s signed=%s → publish=%s", (event, channel, signed, allowed) => {
    const text = fs.readFileSync(RELEASE, "utf8");
    expect(text).toMatch(/^  workflow_dispatch:/m);
    const condition = /^    if: (.+)$/m.exec(jobBlock(RELEASE, "publish-manifest"))?.[1];
    expect(condition).toBeTruthy();
    const context: Record<string, string> = {
      "github.event_name": event,
      "inputs.channel": channel,
      "needs.preflight.outputs.signed": signed,
    };
    const terms = condition!.split(/\s*&&\s*/).map((term) => {
      const comparison = /^([\w.]+) == '([^']*)'$/.exec(term);
      expect(comparison, `未覆盖的发布条件：${term}`).not.toBeNull();
      expect(Object.keys(context)).toContain(comparison![1]);
      return context[comparison![1]] === comparison![2];
    });
    expect(terms.every(Boolean)).toBe(allowed);
  });

  it("所有发布阶段 checkout 指定 tag；版本验证在回归前，发布不用触发分支名", () => {
    for (const job of ["regression", "upload-artifacts", "publish-manifest"]) {
      expect(jobBlock(RELEASE, job)).toContain("ref: ${{ (inputs.channel == 'stable' || inputs.tag) && format('refs/tags/{0}', inputs.tag || github.ref_name) || github.ref }}");
    }
    const steps = stepsOf(RELEASE, "regression");
    expect(steps).toContain("Validate release target");
    expect(steps.indexOf("Validate release target")).toBeLessThan(steps.indexOf("Full automated regression"));
    const publish = jobBlock(RELEASE, "publish-manifest");
    expect(publish).not.toContain("GITHUB_REF_NAME");
    expect(publish).toContain('gh release upload "${RELEASE_TAG}"');
    expect(publish).toContain("--verify-tag");
    expect(publish).toContain("--prerelease=false --latest");
  });

  it.each(["", "main", "v1.2.3-beta.1", "v1.2.4"])("stable 拒绝不匹配的版本来源 %s", (tag) => {
    expect(() => validateReleaseTarget({ channel: "stable", tag, version: "1.2.3" })).toThrow();
  });

  it("stable 接受匹配正式版本；测试渠道可构建分支", () => {
    expect(() => validateReleaseTarget({ channel: "stable", tag: "v1.2.3", version: "1.2.3" })).not.toThrow();
    expect(() => validateReleaseTarget({ channel: "beta", tag: "main", version: "1.2.3-beta.1" })).not.toThrow();
  });

  it.each([
    ["stable", "v1.2.3", "", 0, "signed=true"],
    ["stable", "main", "", 1, ""],
    ["stable", "v1.2.3", "MAC_CSC_LINK", 1, "signed=false"],
    ["stable", "v1.2.3", "WIN_CSC_KEY_PASSWORD", 1, "signed=false"],
    ["beta", "main", "MAC_CSC_LINK", 0, "signed=false"],
  ])("实际 preflight 脚本：%s/%s 缺 %s", (channel, tag, missing, status, expectedOutput) => {
    const block = jobBlock(RELEASE, "preflight");
    const script = block.slice(block.indexOf("        run: |") + "        run: |".length)
      .split("\n").map((line) => line.slice(10)).join("\n");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-release-gate-"));
    const output = path.join(dir, "output");
    const credentials = Object.fromEntries([
      "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD",
      "APPLE_TEAM_ID", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "PIBUDDY_UPDATE_FEED_URL",
    ].map((name) => [name, name === missing ? "" : "synthetic"]));
    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...credentials,
          RELEASE_CHANNEL: channel, RELEASE_TAG: tag, GITHUB_OUTPUT: output.replace(/\\/g, "/") },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
      const actual = fs.existsSync(output) ? fs.readFileSync(output, "utf8").trim() : "";
      expect(actual).toBe(expectedOutput);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workflow action 固定", () => {
  it("release.yml / release-github.yml / ci.yml 里所有第三方 action 都以 40 位 SHA 固定", () => {
    for (const file of [RELEASE, RELEASE_GITHUB, CI]) {
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

/**
 * 常规 CI 必须覆盖真正的打包链路。
 *
 * 只跑 `electron-vite build` 时，extraResources / afterPack / asarUnpack
 * 一个都没被触发 —— 而本仓两个致命缺陷全都住在那一段，且构建退出码是 0。
 * 它们此前要等到打 tag 才暴露。
 */
describe("ci.yml 覆盖打包链路", () => {
  const steps = stepsOf(CI, "package");
  const block = jobBlock(CI, "package");

  it("package job 依次跑 prepare:runtime → build → electron-builder → 产物校验", () => {
    for (const name of [
      "Prepare pi runtime",
      "Build renderer and main",
      "Package (--dir, no installer)",
      "Verify packaged artifacts",
    ]) {
      expect(steps).toContain(name);
    }
    // 顺序不能乱：afterPack 拿 prepare:runtime 的产物当复制源
    expect(steps.indexOf("Prepare pi runtime")).toBeLessThan(
      steps.indexOf("Package (--dir, no installer)")
    );
    expect(steps.indexOf("Package (--dir, no installer)")).toBeLessThan(
      steps.indexOf("Verify packaged artifacts")
    );
  });

  it("真的调用 electron-builder，并把校验交给 verify-packaged-app.mjs", () => {
    expect(block).toContain("electron-builder --dir");
    expect(block).toContain("node packages/app/scripts/verify-packaged-app.mjs");
    // CI 绝不能碰真实 feed 地址
    expect(block).toContain("https://example.invalid/");
  });

  it("release.yml 的构建 job 用同一个脚本校验打包目录", () => {
    expect(stepsOf(RELEASE, "upload-artifacts")).toContain("Verify packaged artifacts");
  });

  it("package job 在结构校验之后启动一次解包产物", () => {
    const steps = stepsOf(CI, "package");
    expect(steps).toContain("Verify packaged artifacts");
    expect(steps).toContain("Smoke packaged app");
    expect(steps.indexOf("Verify packaged artifacts")).toBeLessThan(
      steps.indexOf("Smoke packaged app"),
    );
    expect(jobBlock(CI, "package")).toContain("node packages/app/scripts/smoke-packaged-app.mjs");
  });
});

describe("ci.yml 上传各系统构建物", () => {
  const text = fs.readFileSync(CI, "utf8");
  const block = jobBlock(CI, "artifacts");
  const steps = stepsOf(CI, "artifacts");

  it("artifacts job 覆盖 Windows / macOS / Linux，并打出对应安装包", () => {
    expect(text).toContain("  artifacts:");
    expect(block).toContain("windows-latest");
    expect(block).toContain("macos-latest");
    expect(block).toContain("ubuntu-latest");
    expect(block).toContain("--win nsis zip --x64");
    expect(block).toContain("--mac dmg zip");
    expect(block).toContain("--linux AppImage deb --x64");
  });

  it("CI 构建物未签名，不进正式 feed；挂 Release 是 release-github.yml 的事", () => {
    expect(block).toContain("UNSIGNED");
    expect(block).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(block).toContain("--config.mac.notarize=false");
    expect(block).toContain("https://example.invalid/");
    expect(block).not.toMatch(/secrets\./);
    expect(block).not.toMatch(/environment:\s*release/);
    expect(block).not.toContain("gh release");
  });

  it("校验通过后才上传，且 upload-artifact 以 SHA 固定", () => {
    expect(steps).toContain("Verify packaged artifacts");
    expect(steps).toContain("Smoke packaged app");
    expect(steps).toContain("Upload unsigned installers");
    expect(steps.indexOf("Smoke packaged app")).toBeLessThan(
      steps.indexOf("Upload unsigned installers"),
    );
    expect(block).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
  });
});

describe("release-github.yml 未签名安装包挂到 GitHub Release", () => {
  const text = fs.readFileSync(RELEASE_GITHUB, "utf8");
  const pack = jobBlock(RELEASE_GITHUB, "package");
  const packSteps = stepsOf(RELEASE_GITHUB, "package");
  const publish = jobBlock(RELEASE_GITHUB, "publish");
  const publishSteps = stepsOf(RELEASE_GITHUB, "publish");

  it("分平台原生打包：Win nsis+zip x64、Linux AppImage+deb x64、mac 本机 dmg+zip", () => {
    expect(pack).toContain("windows-latest");
    expect(pack).toContain("macos-latest");
    expect(pack).toContain("ubuntu-latest");
    expect(pack).toContain("--win nsis zip --x64");
    expect(pack).toContain("--mac dmg zip");
    expect(pack).toContain("--linux AppImage deb --x64");
    expect(pack).toContain("--config.mac.notarize=false");
    expect(pack).toContain("--publish never");
  });

  it("打包 job 只出包、不挂 Release；publish job 再上传", () => {
    expect(text).toContain("needs: package");
    expect(pack).not.toContain("gh release");
    expect(packSteps).toContain("Upload unsigned installers");
    expect(publishSteps).toContain("Download unsigned installers");
    expect(publishSteps).toContain("Attach installers to GitHub Release");
    expect(publish).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(publish).toContain("gh release upload");
    expect(publish).toMatch(/for attempt in 1 2 3/);
  });

  it("未签名、不读 release secrets，也不上传 latest.yml", () => {
    expect(pack).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(pack).toContain("https://example.invalid/");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/environment:\s*release/);
    expect(text).not.toContain("latest.yml");
    expect(text).toContain("contents: write");
  });

  it("校验并冒烟之后才暂存构建物", () => {
    expect(packSteps).toContain("Verify packaged artifacts");
    expect(packSteps).toContain("Smoke packaged app");
    expect(packSteps).toContain("Upload unsigned installers");
    expect(packSteps.indexOf("Smoke packaged app")).toBeLessThan(
      packSteps.indexOf("Upload unsigned installers"),
    );
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
    const win = yml.slice(yml.indexOf("\nwin:"), yml.indexOf("\nnsis:"));
    expect(win).toMatch(/-\s*zip/);
    expect(yml).toMatch(/-\s*AppImage/);
    expect(yml).toMatch(/-\s*deb/);
    // AppImage 拒绝包名里的 @，必须显式给出安全的可执行文件名
    expect(yml).toMatch(/^executableName:\s*PiBuddy\s*$/m);
    // deb 缺 homepage 会直接失败；artifactName 避免 @pibuddy/app_*.deb
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO, "packages", "app", "package.json"), "utf8"),
    ) as { homepage?: string };
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\/onehopeA10\/pibuddy\/?$/);
    expect(yml).toContain("artifactName: ${productName}-${version}-${arch}.${ext}");
    expect(yml).toMatch(/maintainer:\s*PiBuddy\s*<[^>]+@[^>]+>/);
    // 否则 mac 冒烟会 spawn PiBuddy.app 目录，立刻 EACCES
    const smoke = fs.readFileSync(
      path.join(REPO, "packages", "app", "scripts", "smoke-packaged-app.mjs"),
      "utf8",
    );
    expect(smoke).toContain('if (name.endsWith(".app")) return false');
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

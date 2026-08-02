#!/usr/bin/env node
/**
 * 发布产物完整性校验（UPD-005）。
 *
 * ## 为什么这件事必须是机器判据
 *
 * 「更新清单齐不齐」在人眼里是一句「看着挺全的」，在 electron-updater 眼里
 * 是三个具体文件：
 *
 *   win    latest.yml       + *.exe        + *.exe.blockmap
 *   mac    latest-mac.yml   + *.dmg        + *.zip
 *   linux  latest-linux.yml + *.AppImage
 *
 * 少一个的表现都不是「构建失败」，而是**用户机器上更新静默不工作**：
 *   - 缺 blockmap  → 差分更新退化成整包重下（还不至于坏，但没人会发现）
 *   - 缺 mac zip   → latest-mac.yml 压根不会生成，macOS 自动更新整体失效
 *   - 缺 latest*.yml → 客户端每次检查都 404，日志里只有一句 ERR_NOT_FOUND
 *
 * 因此这里逐平台断言必需文件集合，缺任一即退出码 1。
 *
 * 另外两条断言：
 *   - 产物版本必须与 package.json 的 version 一致（防止 release 目录里
 *     残留上一次构建的包，把旧版本当新版本发出去）
 *   - stable 渠道禁止 prerelease 标记（1.2.0-beta.1 不得进 latest.yml）
 *
 * 用法：
 *   node scripts/verify-release-artifacts.mjs win [--dir release] [--channel stable]
 *   node scripts/verify-release-artifacts.mjs all
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

/**
 * 每个平台的必需产物。`manifest` 是更新清单，`required` 是至少各命中一个的
 * 文件模式，缺任一即失败。
 */
export const PLATFORM_REQUIREMENTS = {
  win: {
    manifest: "latest.yml",
    required: [
      { label: "NSIS installer", test: (n) => /^PiBuddy-Setup-.*\.exe$/.test(n) },
      { label: "blockmap", test: (n) => /^PiBuddy-Setup-.*\.exe\.blockmap$/.test(n) },
    ],
  },
  mac: {
    manifest: "latest-mac.yml",
    required: [
      { label: "dmg", test: (n) => n.endsWith(".dmg") },
      // ZIP 不是可选项：MacUpdater 只认 latest-mac.yml 里的 ZIP payload。
      { label: "zip (updater payload)", test: (n) => n.endsWith(".zip") },
    ],
  },
  linux: {
    manifest: "latest-linux.yml",
    required: [{ label: "AppImage", test: (n) => n.endsWith(".AppImage") }],
  },
};

export const PLATFORMS = Object.keys(PLATFORM_REQUIREMENTS);

function appVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
  return pkg.version;
}

/**
 * 校验一个平台。返回 problems 数组（空数组 = 通过）。
 *
 * 导出是为了单测能直接喂一个假目录，而不必真跑一次 electron-builder。
 */
export function verifyPlatform(platform, dir, version, channel = "stable") {
  const spec = PLATFORM_REQUIREMENTS[platform];
  if (!spec) return [`未知平台 ${platform}（可选：${PLATFORMS.join(" / ")}）`];

  const problems = [];
  if (!fs.existsSync(dir)) return [`产物目录不存在：${dir}`];

  const names = fs.readdirSync(dir);

  if (!names.includes(spec.manifest)) {
    problems.push(
      `[${platform}] 缺更新清单 ${spec.manifest} —— 客户端每次检查更新都会 404`
    );
  }

  for (const req of spec.required) {
    const hit = names.filter((n) => req.test(n));
    if (hit.length === 0) problems.push(`[${platform}] 缺 ${req.label}`);
  }

  // 版本一致性：release/ 目录不会自动清空，上一轮的包留在里面就会被一起发出去。
  const versioned = names.filter((n) => /\d+\.\d+\.\d+/.test(n));
  const stale = versioned.filter((n) => !n.includes(version));
  if (stale.length > 0) {
    problems.push(
      `[${platform}] 产物目录里有非本版本（${version}）的残留文件：${stale.join(", ")}`
    );
  }

  // stable 渠道不接受预发布标记。
  if (channel === "stable" && /-(?:alpha|beta|rc)\b/i.test(version)) {
    problems.push(`[${platform}] stable 渠道不允许 prerelease 版本号：${version}`);
  }

  // 清单里的文件必须真的在目录里（先发清单后传包是 UPD-005 明令禁止的顺序）。
  const manifestPath = path.join(dir, spec.manifest);
  if (fs.existsSync(manifestPath)) {
    const text = fs.readFileSync(manifestPath, "utf8");
    for (const m of text.matchAll(/^\s*(?:-\s*)?url:\s*(\S+)\s*$/gm)) {
      const referenced = decodeURIComponent(m[1].replace(/^["']|["']$/g, ""));
      if (!names.includes(referenced)) {
        problems.push(
          `[${platform}] ${spec.manifest} 指向不存在的文件 ${referenced} —— 客户端会下到一半 404`
        );
      }
    }
  }

  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const targets = argv.filter((a) => !a.startsWith("--"));
  const dirAt = argv.indexOf("--dir");
  const chAt = argv.indexOf("--channel");
  const dir = dirAt === -1 ? path.join(APP_ROOT, "release") : path.resolve(argv[dirAt + 1]);
  const channel = chAt === -1 ? "stable" : argv[chAt + 1];

  const platforms =
    targets.length === 0 || targets[0] === "all"
      ? PLATFORMS
      : targets.filter((t) => PLATFORMS.includes(t));

  if (platforms.length === 0) {
    process.stderr.write(`用法：verify-release-artifacts.mjs <${PLATFORMS.join("|")}|all>\n`);
    process.exit(2);
  }

  const version = appVersion();
  const problems = platforms.flatMap((p) => verifyPlatform(p, dir, version, channel));

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`${p}\n`);
    process.stderr.write(`\nverify-release-artifacts: FAIL（${problems.length} 项），目录 ${dir}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `verify-release-artifacts: OK  平台=${platforms.join(",")} 版本=${version} 目录=${dir}\n`
  );
  process.exit(0);
}

if (
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-release-artifacts.mjs")
) {
  main();
}

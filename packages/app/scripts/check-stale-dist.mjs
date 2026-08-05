#!/usr/bin/env node
/**
 * 陈旧产物闸门。
 *
 * 本仓真实事故：`pnpm build` 那一步没成，但 `packages/app/out` 与
 * `release/*-unpacked/resources/app.asar` 还留着上一次的旧产物；打包与安装
 * 照常走完、退出码全是 0，真机上跑的却是旧包。当时是靠人肉比对 app.asar
 * 的时间戳才发现的 —— 这个脚本就是把那次人肉比对固化下来。
 *
 * 判定规则（纯 mtime 比较）：某个目标的**源文件最新 mtime** > 该目标
 * **产物最新 mtime** ⇒ 产物陈旧。
 *
 * 刻意不启动 TypeScript program、不解析 import 图：只 stat 文件。代价是
 * 粒度粗（改一行注释也算源变更），换来的是这道闸便宜到可以挂在任何一步
 * 之前，而不必担心它自己变成构建瓶颈。
 *
 * 按目标拆开独立比较 —— 改 renderer 不该把 main 判成陈旧。electron-vite
 * 的三个产物目录各自对应一组源路径：
 *   out/main      ← src/main + contract/src + pi-sdk/src（两者都 bundle 进主进程）
 *   out/preload   ← src/preload + contract/src（preload 只 bundle 契约包）
 *   out/renderer  ← src/renderer + contract/src + pi-sdk/src（@contract / @sdk 别名）
 *   app.asar      ← out/（asar 打的就是 out，asar 比 out 旧 = 那次事故本身）
 *
 * `packages/contract` 与 `packages/pi-sdk` **没有自己的 dist**：两者的
 * package.json 里 main/types 直接指向 `./src/index.ts`，由消费方（app 的
 * electron-vite）编译。所以它们不是独立目标，而是以「源」的身份进入上面
 * 三个 app 目标 —— 契约改了而 out 没重建，同样算陈旧。
 *
 * 「产物不存在」不算陈旧，算**未构建**：本闸防的是「悄悄复用了旧产物」，
 * 而一个根本不存在的产物没法被悄悄复用（Electron 找不到 out/main/index.js
 * 会当场报错，不会静默降级）。CI 的 verify job 在 build 之前就跑测试，
 * 那时 out/ 本来就不存在，把它判红只会让这道闸永远是噪音。
 *
 * 用法：
 *   node packages/app/scripts/check-stale-dist.mjs           # 人看的报告，恒 0
 *   node packages/app/scripts/check-stale-dist.mjs --check   # CI 用，有陈旧则 1
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..", "..");

/** 源侧：进得了产物的文件类型。测试文件不进 bundle，见 SKIP_FILE_RE。 */
const SOURCE_EXT = new Set([".ts", ".tsx", ".vue", ".css", ".html", ".json", ".mjs", ".cjs"]);
/** 产物侧：electron-vite / vite 摆出来的东西。 */
const OUTPUT_EXT = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".map"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git", "__tests__"]);
const SKIP_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;

/**
 * `release/` 下的目录名带平台后缀（win-unpacked / linux-unpacked /
 * mac-arm64）。CI 的 package job 在 ubuntu 上跑，本地在 Windows 上跑，
 * 硬编码任一个都会让另一边静默跳过 —— 所以按后缀扫。
 */
function findUnpackedAsars() {
  const releaseDir = join(APP_ROOT, "release");
  if (!existsSync(releaseDir)) return [];
  const found = [];
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith("-unpacked")) continue;
    const asar = join(releaseDir, entry.name, "resources", "app.asar");
    if (existsSync(asar)) found.push({ label: entry.name, path: asar });
  }
  return found;
}

function target(name, sources, output) {
  return { name, sources, output };
}

const TARGETS = [
  target(
    "app:main",
    [
      "packages/app/src/main",
      "packages/contract/src",
      "packages/pi-sdk/src",
      "packages/app/electron.vite.config.ts",
    ],
    "packages/app/out/main"
  ),
  target(
    "app:preload",
    ["packages/app/src/preload", "packages/contract/src", "packages/app/electron.vite.config.ts"],
    "packages/app/out/preload"
  ),
  target(
    "app:renderer",
    [
      "packages/app/src/renderer",
      "packages/contract/src",
      "packages/pi-sdk/src",
      "packages/app/electron.vite.config.ts",
    ],
    "packages/app/out/renderer"
  ),
];

/** 遍历目录（或单文件），返回 { mtime, file } 里 mtime 最大的那条。 */
function newestUnder(absPath, extAllowlist) {
  if (!existsSync(absPath)) return null;
  const rootStat = statSync(absPath);
  if (rootStat.isFile()) return { mtime: rootStat.mtimeMs, file: absPath };

  let best = null;
  const stack = [absPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILE_RE.test(entry.name)) continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (!extAllowlist.has(ext)) continue;
      let mtime;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { mtime, file: full };
    }
  }
  return best;
}

function newestAcross(relPaths, extAllowlist) {
  let best = null;
  for (const rel of relPaths) {
    const hit = newestUnder(join(REPO_ROOT, rel), extAllowlist);
    if (hit && (!best || hit.mtime > best.mtime)) best = hit;
  }
  return best;
}

function rel(p) {
  return relative(REPO_ROOT, p).split("\\").join("/");
}

function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}min`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function evaluate() {
  const targets = [...TARGETS];
  // asar 目标：源就是 out/ 本身 —— asar 比 out 旧，正是那次事故的形状。
  for (const asar of findUnpackedAsars()) {
    targets.push({
      name: `app:asar(${asar.label})`,
      sources: ["packages/app/out"],
      output: rel(asar.path),
    });
  }

  const results = [];
  for (const t of targets) {
    const src = newestAcross(t.sources, SOURCE_EXT);
    if (!src) {
      results.push({ name: t.name, status: "no-source", detail: "源路径不存在或为空" });
      continue;
    }
    const outAbs = join(REPO_ROOT, t.output);
    // asar 目标的 output 是单个文件，newestUnder 在 isFile 分支就返回，
    // 扩展名白名单对它不起作用。
    const out = newestUnder(outAbs, OUTPUT_EXT);
    if (!out) {
      results.push({
        name: t.name,
        status: "absent",
        detail: `产物不存在：${t.output}`,
      });
      continue;
    }
    if (src.mtime > out.mtime) {
      results.push({
        name: t.name,
        status: "stale",
        detail: `产物落后 ${fmtAge(src.mtime - out.mtime)}`,
        newestSource: rel(src.file),
        newestOutput: rel(out.file),
      });
      continue;
    }
    results.push({
      name: t.name,
      status: "fresh",
      detail: `领先源 ${fmtAge(out.mtime - src.mtime)}`,
      newestSource: rel(src.file),
      newestOutput: rel(out.file),
    });
  }
  return results;
}

function main() {
  const checkMode = process.argv.includes("--check");
  const results = evaluate();
  const stale = results.filter((r) => r.status === "stale");
  const absent = results.filter((r) => r.status === "absent");

  const lines = [];
  for (const r of results) {
    const mark = { fresh: "OK  ", stale: "STALE", absent: "----", "no-source": "----" }[r.status];
    lines.push(`  ${mark} ${r.name.padEnd(26)} ${r.detail}`);
    if (r.status === "stale") {
      lines.push(`         最新源  ${r.newestSource}`);
      lines.push(`         最新产物 ${r.newestOutput}`);
    }
  }

  if (stale.length === 0) {
    process.stdout.write(`check-stale-dist: OK（${results.length} 个目标，无陈旧产物）\n`);
    process.stdout.write(`${lines.join("\n")}\n`);
    if (absent.length > 0) {
      process.stdout.write(
        `\n注：${absent.length} 个目标尚未构建 —— 不存在的产物无法被悄悄复用，不判红。\n`
      );
    }
    process.exit(0);
  }

  process.stderr.write(`check-stale-dist: 检出 ${stale.length} 个陈旧产物\n`);
  process.stderr.write(`${lines.join("\n")}\n`);
  process.stderr.write(
    "\n源比产物新 = 你手上跑的可能是上一次的构建结果。" +
      "重新执行 `pnpm build`（打包链路再补 `pnpm --filter @pibuddy/app dist`）后重试。\n"
  );
  process.exit(checkMode ? 1 : 0);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-stale-dist.mjs")) {
  main();
}

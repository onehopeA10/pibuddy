#!/usr/bin/env node
/**
 * CancellationToken 能力探针。
 *
 * 输出一行 JSON：`{ "cancelSupported": true|false }`。
 *
 * ## 为什么要有这个脚本
 *
 * 「下载中要不要有取消按钮」不能靠人拍脑袋 —— 不同 electron-updater 版本
 * 对取消的支持不一样，而放一个**点了没反应的取消按钮**比不放更糟：用户会
 * 一直点，然后认定这软件坏了。因此能力位必须由 node_modules 里实际装上的
 * 那份 d.ts 决定，界面按能力位渲染。
 *
 * ## 为什么是静态检测
 *
 * `import("electron-updater")` 会连带 require electron，在纯 node 下直接
 * 崩掉。这里只读类型声明文件，判据是两条同时成立：
 *   1. 包对外导出了 CancellationToken
 *   2. downloadUpdate 接受一个 cancellationToken 形参
 * 只满足第一条不算数：导出了但 downloadUpdate 不收，等于取消不了。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = resolve(APP_DIR, "..", "..");

function pkgDir() {
  for (const base of [join(APP_DIR, "node_modules"), join(ROOT, "node_modules")]) {
    const dir = join(base, "electron-updater");
    if (existsSync(dir)) return dir;
  }
  return null;
}

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const dir = pkgDir();
let exportsToken = false;
let downloadAcceptsToken = false;

if (dir) {
  const types = read(join(dir, "out", "types.d.ts"));
  const main = read(join(dir, "out", "main.d.ts"));
  const appUpdater = read(join(dir, "out", "AppUpdater.d.ts"));

  // main.d.ts 里 `export * from "./types"`，因此 types.d.ts 的具名再导出
  // 等价于包级导出。
  exportsToken =
    /export\s*\{[^}]*\bCancellationToken\b[^}]*\}/.test(types) ||
    /export\s*\{[^}]*\bCancellationToken\b[^}]*\}/.test(main);
  if (exportsToken && !/export\s+\*\s+from\s+"\.\/types"/.test(main)) {
    // types.d.ts 没被主入口再导出的话，包级其实拿不到
    exportsToken = /export\s*\{[^}]*\bCancellationToken\b[^}]*\}/.test(main);
  }

  downloadAcceptsToken = /downloadUpdate\s*\(\s*cancellationToken\??\s*:/.test(appUpdater);
}

const cancelSupported = exportsToken && downloadAcceptsToken;

console.log(JSON.stringify({ cancelSupported }));
if (!dir) {
  console.error("check-updater-capability: 找不到 electron-updater（先跑 pnpm install）");
  process.exit(1);
}

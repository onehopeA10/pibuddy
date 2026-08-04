#!/usr/bin/env node
/**
 * node-pty 打包修复（coding.terminal / ADR-0002 方案 B）——postinstall 跑。
 *
 * node-pty 有一个已知的打包 bug：`lib/unixTerminal.js` 里把 spawn-helper 的路径
 * **无条件**地 `.replace('app.asar', 'app.asar.unpacked')`。当路径里已经含
 * `app.asar.unpacked`（asarUnpack 之后正是如此）时，这次无条件替换会把它变成
 * `app.asar.unpacked.unpacked` —— 一个不存在的目录，mac/linux 上开终端时
 * spawn-helper 找不到、PTY 起不来。修复是把它改成**带条件**的替换（已含
 * `app.asar.unpacked` 就不再替换），并给 spawn-helper 补上可执行权限。
 *
 * Windows 首发走 ConPTY、不走 unixTerminal，因此这个修复对 Windows 是 no-op；
 * 但为 mac/linux 稳妥，postinstall 无条件跑一遍。**本脚本任何情况下都不抛错、
 * 恒 exit 0**：它是 install 钩子，一旦抛错会让整个 `pnpm install` 失败，而它要
 * 修的问题在找不到目标文件时本就不存在。幂等：已打过补丁就跳过。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");

/** pnpm 落盘位置可能在 app/node_modules 或仓库根。找到就返回 node-pty 目录。 */
function findNodePty() {
  const candidates = [
    path.join(APP_ROOT, "node_modules", "node-pty"),
    path.join(REPO_ROOT, "node_modules", "node-pty"),
    // pnpm 的实际实现常在 .pnpm 里，node_modules/node-pty 是软链——realpath 一下。
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "package.json"))) return fs.realpathSync(dir);
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 把无条件的 helperPath.replace 改成带条件的（幂等）。 */
function patchUnixTerminal(nodePtyDir) {
  const file = path.join(nodePtyDir, "lib", "unixTerminal.js");
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return false; // 该平台的产物里没有 unixTerminal.js（纯 Windows 包），跳过
  }
  if (src.includes("app.asar.unpacked') !== -1")) return false; // 已打过补丁
  // 匹配单/双引号两种写法的无条件替换。
  const patterns = [
    {
      re: /helperPath = helperPath\.replace\('app\.asar', 'app\.asar\.unpacked'\);/,
      to: "helperPath = helperPath.indexOf('app.asar.unpacked') !== -1 ? helperPath : helperPath.replace('app.asar', 'app.asar.unpacked');",
    },
    {
      re: /helperPath = helperPath\.replace\("app\.asar", "app\.asar\.unpacked"\);/,
      to: 'helperPath = helperPath.indexOf("app.asar.unpacked") !== -1 ? helperPath : helperPath.replace("app.asar", "app.asar.unpacked");',
    },
  ];
  let patched = src;
  let changed = false;
  for (const p of patterns) {
    if (p.re.test(patched)) {
      patched = patched.replace(p.re, p.to);
      changed = true;
    }
  }
  if (!changed) return false;
  try {
    fs.writeFileSync(file, patched, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 给 spawn-helper 补可执行权限（mac/linux 的 prebuilt 二进制解压后可能丢了 x 位）。 */
function fixSpawnHelperPerms(dir, depth = 0) {
  if (depth > 6) return 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let fixed = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) fixed += fixSpawnHelperPerms(full, depth + 1);
    } else if (e.isFile() && e.name === "spawn-helper") {
      try {
        fs.chmodSync(full, 0o755);
        fixed++;
      } catch {
        /* 忽略 */
      }
    }
  }
  return fixed;
}

function main() {
  const dir = findNodePty();
  if (!dir) {
    process.stdout.write("fix-pty-permissions: node-pty 未安装，跳过\n");
    return;
  }
  const patched = patchUnixTerminal(dir);
  const permsFixed = process.platform === "win32" ? 0 : fixSpawnHelperPerms(dir);
  process.stdout.write(
    `fix-pty-permissions: unixTerminal ${patched ? "已修复" : "无需修复"}，spawn-helper 修权 ${permsFixed} 个\n`
  );
}

try {
  main();
} catch (err) {
  // 恒 exit 0：install 钩子抛错会让整个 pnpm install 失败。
  process.stdout.write(`fix-pty-permissions: 跳过（${err instanceof Error ? err.message : String(err)}）\n`);
}

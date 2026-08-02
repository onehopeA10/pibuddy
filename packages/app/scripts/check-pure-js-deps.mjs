#!/usr/bin/env node
/**
 * 纯 JS 依赖闸门。
 *
 * `npmRebuild: false` 是本产物成立的前提之一：一旦某个依赖带原生扩展
 * （node-gyp / prebuild-install / .node 二进制），它在打包机上编出来的 ABI
 * 和用户机器上的 Electron 对不上，**表现不是构建失败，而是用户启动时一句
 * `Module did not self-register`**，而 CI 全绿。
 *
 * 因此这里在依赖进来的那一刻就拦：遍历 packages/app 的已安装依赖闭包，
 * 命中以下任一即退出码 1：
 *   - 包内有 binding.gyp
 *   - package.json 里 gypfile: true
 *   - install / preinstall / postinstall 脚本里出现
 *     node-gyp | prebuild-install | node-pre-gyp | cmake-js | neon
 *   - 包内存在 .node 文件
 *
 * **刻意不硬编码任何包名**：w10 时后续任务的解析库还没引进来，闸门对空集合
 * 必须返回 0，之后随依赖增长自动生效。硬编码白名单等于把闸门写成一次性的。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");

const NATIVE_SCRIPT_RE = /node-gyp|prebuild-install|node-pre-gyp|cmake-js|neon\b/i;
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

/**
 * `dependencies` 才算数，`devDependencies` 不算 —— 后者不进产物。
 * electron-builder 自己就依赖一堆带二进制的工具，把它算进来这个闸门永远红。
 */
function directRuntimeDeps() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
  return Object.entries(pkg.dependencies ?? {})
    .filter(([, spec]) => !String(spec).startsWith("workspace:"))
    .map(([name]) => name);
}

/** pnpm 的实际落盘位置可能在 app/node_modules 也可能在仓库根。 */
function resolvePackageDir(name) {
  for (const base of [path.join(APP_ROOT, "node_modules"), path.join(REPO_ROOT, "node_modules")]) {
    const dir = path.join(base, ...name.split("/"));
    if (fs.existsSync(path.join(dir, "package.json"))) return fs.realpathSync(dir);
  }
  return null;
}

function hasDotNode(dir, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".node")) return path.join(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
      const hit = hasDotNode(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function scanDependencyClosure() {
  const problems = [];
  const seen = new Set();
  const queue = [...directRuntimeDeps()];

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const dir = resolvePackageDir(name);
    if (!dir) continue; // 未安装（可选依赖 / 平台不匹配）——不是本闸门要管的事

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }

    if (fs.existsSync(path.join(dir, "binding.gyp"))) {
      problems.push(`${name}: 含 binding.gyp（node-gyp 原生扩展）`);
    }
    if (meta.gypfile === true) {
      problems.push(`${name}: package.json 声明 gypfile: true`);
    }
    for (const hook of INSTALL_HOOKS) {
      const script = meta.scripts?.[hook];
      if (script && NATIVE_SCRIPT_RE.test(script)) {
        problems.push(`${name}: ${hook} 脚本触发原生构建 -> ${script}`);
      }
    }
    const dotNode = hasDotNode(dir);
    if (dotNode) {
      problems.push(`${name}: 含预编译原生模块 ${path.relative(dir, dotNode)}`);
    }

    for (const child of Object.keys(meta.dependencies ?? {})) queue.push(child);
  }

  return { problems, scanned: seen.size };
}

function main() {
  const { problems, scanned } = scanDependencyClosure();
  if (problems.length === 0) {
    process.stdout.write(
      `check-pure-js-deps: OK（扫描 ${scanned} 个包，无原生扩展；npmRebuild: false 成立）\n`
    );
    process.exit(0);
  }
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.stderr.write(
    "\ncheck-pure-js-deps: FAIL。原生扩展在 npmRebuild: false 下会以 " +
      "`Module did not self-register` 的形式在用户机器上崩溃，而 CI 全绿。" +
      "请换纯 JS 实现，或先把 npmRebuild / 多平台预编译方案补齐再解除本闸门。\n"
  );
  process.exit(1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-pure-js-deps.mjs")) {
  main();
}

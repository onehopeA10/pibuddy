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
 * **检测逻辑刻意不硬编码任何包名**：w10 时后续任务的解析库还没引进来，闸门对
 * 空集合必须返回 0，之后随依赖增长自动生效。唯一的包名例外是下方的
 * `NATIVE_ALLOWLIST`——那不是检测规则的一部分，而是逐条说理的显式破例
 * （见其注释的三条硬前提），破例只豁免包自身，其依赖闭包照扫。
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
 * 原生模块白名单（ADR-0002 方案 B）。
 *
 * 这道闸的默认立场仍是「能力包必须纯 JS」——它保护的是「装卸无需编译、
 * 不锁 ABI、跨平台无差别」这条承诺。白名单是**显式的破例**,不是把闸门
 * 关掉:只有列在这里、且逐条写明理由的包才放行,其余照旧拦。
 *
 * 放行的硬前提(每个候选都要满足,否则不该进白名单):
 *   1. 用 **N-API**(node-addon-api),而非 nan —— N-API 二进制 ABI 跨
 *      Node/Electron 版本稳定,同一个 .node 直接能用,不需要为 Electron
 *      rebuild,因此 `npmRebuild: false` 不必动、pi runtime 布局不受扰动。
 *   2. 自带**多平台 prebuilds**,`npm install` 自动就位,不在用户机器上编译。
 *   3. 打包时其 .node/.dll/.exe 已由 electron-builder.yml 的 asarUnpack 外置
 *      (prebuilt 二进制不能从 asar 虚拟路径执行)。
 *
 * 每加一个都要在 review 里能回答「它满足上面三条吗、为什么非它不可」。
 */
const NATIVE_ALLOWLIST = new Set([
  // 终端能力包(coding.terminal)。node-pty@1.1.0 用 node-addon-api@7,
  // 自带 win32-x64/arm64 + darwin-x64/arm64 prebuilds,实测我们的
  // Electron 43.2.0 直接 require + spawn 成功、无需 rebuild。
  // 参考实现 hermes-studio / PiDeck-maestro 同样在 npmRebuild:false 下用它。
  "node-pty",
]);

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

    // 显式破例:白名单里的原生包不检测原生特征,但**仍继续遍历它的依赖**——
    // 破例只覆盖这个包自己,不覆盖它意外拖进来的其它原生模块。
    if (NATIVE_ALLOWLIST.has(name)) {
      const wl = resolvePackageDir(name);
      if (wl) {
        try {
          const wlMeta = JSON.parse(fs.readFileSync(path.join(wl, "package.json"), "utf8"));
          for (const child of Object.keys(wlMeta.dependencies ?? {})) queue.push(child);
        } catch {
          /* 读不到就不展开,不影响主流程 */
        }
      }
      continue;
    }

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

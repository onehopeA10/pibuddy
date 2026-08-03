#!/usr/bin/env node
/**
 * 打包产物结构校验（CI 的打包链路闸门）。
 *
 * ## 为什么必须有这一层
 *
 * `verify-release-artifacts.mjs` 校验的是**安装包**（exe / dmg / latest.yml），
 * 它只有在完整发布构建里才拿得到，跑一次要十几分钟。但本仓历史上那两个
 * 致命缺陷全都发生在**更早**的一步 —— electron-builder 把文件摆进
 * `*-unpacked/` 的那一刻，用 `--dir` 就能复现：
 *
 *  1. `extraResources` 静默跳过被复制目录里的 node_modules（显式 filter 也
 *     无效）：pi-runtime 从 19371 个文件只剩 885 个，启动 pi 直接
 *     `ERR_MODULE_NOT_FOUND: Cannot find package 'cross-spawn'`。
 *     由 `scripts/after-pack.cjs` 手动补齐 —— 那个钩子一旦被摘掉或改坏，
 *     构建**照样成功**。
 *  2. 六个解析库留成 external：`convert-worker.js` 被 asarUnpack 外置到
 *     `app.asar.unpacked/out/main/` 之后，它的模块解析从那个目录往上找
 *     node_modules，而依赖躺在 `app.asar/node_modules` 里，两条路径不相交。
 *     表现是装完之后每一次预览都 `ERR_MODULE_NOT_FOUND`，而 dev、单测、
 *     三大门禁全绿。
 *
 * 两者的共同点：**构建退出码是 0**。因此判据只能是「打完之后去数文件」。
 *
 * 用法：
 *   node scripts/verify-packaged-app.mjs [--dir release]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

/** afterPack 复制的源目录，产物必须与它逐文件对齐。 */
const RUNTIME_SRC = path.join(APP_ROOT, "resources", "pi-runtime", "node_modules");

/**
 * 只认这六个 —— 它们是 electron.vite.config.ts 里 `externalizeDepsPlugin`
 * 的 exclude 名单，也就是「必须被打进产物、绝不能留成 external」的那批。
 */
const MUST_BE_BUNDLED = ["mammoth", "exceljs", "unpdf", "papaparse", "jszip", "fast-xml-parser"];

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

/**
 * 定位 electron-builder `--dir` 产出的 resources 目录。
 *
 * win/linux 是 `<out>/<platform>-unpacked/resources`，
 * mac 是 `<out>/mac<arch>/PiBuddy.app/Contents/Resources`。
 */
function findResourceDirs(outDir) {
  const found = [];
  if (!fs.existsSync(outDir)) return found;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(outDir, entry.name);
    const flat = path.join(base, "resources");
    if (fs.existsSync(flat)) {
      found.push({ label: entry.name, dir: flat });
      continue;
    }
    // macOS：再往下一层找 .app bundle
    for (const inner of fs.readdirSync(base, { withFileTypes: true })) {
      if (!inner.isDirectory() || !inner.name.endsWith(".app")) continue;
      const macRes = path.join(base, inner.name, "Contents", "Resources");
      if (fs.existsSync(macRes)) found.push({ label: `${entry.name}/${inner.name}`, dir: macRes });
    }
  }
  return found;
}

/**
 * 抓出一个 JS 产物里所有 **bare specifier** 的静态/动态 import。
 *
 * 相对路径（`./chunks/x.js`）与 node 内建（`node:fs`）是正常的；
 * 出现 `mammoth` 这种裸名字就说明它被留成了 external。
 */
function bareImports(code) {
  const hits = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (spec.startsWith("node:")) continue;
      hits.add(spec);
    }
  }
  return hits;
}

function verifyResources(label, resDir, problems) {
  const say = (msg) => problems.push(`[${label}] ${msg}`);

  // ---- 1. asar 仍然开着（关掉 asar 会让整个产物失去完整性保护）
  if (!fs.existsSync(path.join(resDir, "app.asar"))) {
    say("缺 app.asar —— asar 被关掉了？");
  }

  // ---- 2. pi 运行时依赖逐文件对齐（afterPack 真的跑了且复制完整）
  const runtimeDeps = path.join(resDir, "pi-runtime", "node_modules");
  if (!fs.existsSync(runtimeDeps)) {
    say("缺 pi-runtime/node_modules —— afterPack 没跑，或 extraResources 又把它吞了");
  } else if (fs.existsSync(RUNTIME_SRC)) {
    const src = countFiles(RUNTIME_SRC);
    const dest = countFiles(runtimeDeps);
    if (src !== dest) say(`pi-runtime 依赖不完整：源 ${src} 个文件，产物 ${dest} 个`);
    else console.log(`  ✓ [${label}] pi-runtime 依赖 ${dest} 个文件，与源一致`);
  } else {
    say(`源目录 ${RUNTIME_SRC} 不存在 —— 先跑 scripts/prepare-pi-runtime.mjs`);
  }

  // ---- 3. 运行时入口与清单（主进程只按 runtime-manifest.json 定位 pi）
  for (const rel of ["pi-runtime/dist/cli.js", "pi-runtime/runtime-manifest.json"]) {
    if (!fs.existsSync(path.join(resDir, ...rel.split("/")))) say(`缺 ${rel}`);
  }

  // ---- 4. convert-worker 与它的 chunks 必须一起被 asarUnpack 外置
  const unpacked = path.join(resDir, "app.asar.unpacked", "out", "main");
  const worker = path.join(unpacked, "convert-worker.js");
  if (!fs.existsSync(worker)) {
    say("缺 app.asar.unpacked/out/main/convert-worker.js —— utilityProcess.fork 打不开 asar 内的路径");
    return;
  }
  const chunkDir = path.join(unpacked, "chunks");
  if (!fs.existsSync(chunkDir) || fs.readdirSync(chunkDir).length === 0) {
    say("app.asar.unpacked/out/main/chunks/ 为空 —— worker 起得来，第一次解析文档时 ERR_MODULE_NOT_FOUND");
  }

  // ---- 5. 六个解析库必须已被打进产物，而不是留成 external
  const scan = [worker];
  if (fs.existsSync(chunkDir)) {
    for (const f of fs.readdirSync(chunkDir)) {
      if (f.endsWith(".js")) scan.push(path.join(chunkDir, f));
    }
  }
  for (const file of scan) {
    const specs = bareImports(fs.readFileSync(file, "utf8"));
    for (const lib of MUST_BE_BUNDLED) {
      if (specs.has(lib) || [...specs].some((s) => s.startsWith(`${lib}/`))) {
        say(`${path.relative(resDir, file)} 仍以 external 方式 import "${lib}"`);
      }
    }
  }
  console.log(`  ✓ [${label}] convert-worker 与 ${scan.length - 1} 个 chunk 已外置且无 external 解析库`);
}

function main() {
  const argv = process.argv.slice(2);
  const dirAt = argv.indexOf("--dir");
  const outDir =
    dirAt === -1 ? path.join(APP_ROOT, "release") : path.resolve(argv[dirAt + 1]);

  const targets = findResourceDirs(outDir);
  if (targets.length === 0) {
    console.error(`verify-packaged-app: 在 ${outDir} 下找不到任何 *-unpacked 产物`);
    console.error("先跑 electron-builder --dir（CI 的 package job 就是这么做的）");
    process.exit(2);
  }

  const problems = [];
  for (const { label, dir } of targets) verifyResources(label, dir, problems);

  if (problems.length > 0) {
    console.error("\nverify-packaged-app: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\n以上每一条的表现都是「构建成功、装完之后用户机器上报错」，" +
        "不会在 typecheck / test / build 里暴露。"
    );
    process.exit(1);
  }
  console.log(`\nverify-packaged-app: OK（校验 ${targets.length} 个产物目录）`);
  process.exit(0);
}

if (
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-packaged-app.mjs")
) {
  main();
}

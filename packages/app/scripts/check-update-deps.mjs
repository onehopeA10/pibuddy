#!/usr/bin/env node
/**
 * 更新依赖的版本一致性闸门（UPD-001）。
 *
 * 三件事：
 *   A. package.json 里 electron-updater / electron-log / electron-builder
 *      必须是**精确版本**，不含 ^ 或 ~
 *   B. pnpm-lock.yaml 里 packages/app 这个 importer 解析到的版本，必须与
 *      package.json 写的那个字面量一一相等
 *   C. node_modules 里实际装上的版本也必须相等
 *
 * ## 为什么不用浮动版本
 *
 * 自动更新的正确性依赖于「用户装的这个包，和我们发布时验证过的那个包，
 * 是同一份字节」。`^6.8.9` 意味着某天 6.9.0 发布之后，下一次 CI 构建出来
 * 的安装器里跑的是一份没人验证过的 updater —— 而它出问题的表现是
 * 「一部分用户再也收不到更新」，没有任何报错，也没有人会去看。
 *
 * 退出码 0 = 一致；1 = 有偏差，逐条打印。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = resolve(APP_DIR, "..", "..");

/**
 * 必须锁死的包，以及它们各自住在 package.json 的哪个字段里。
 *
 * 前三个是自更新链路（UPD-001）；后四个是 CodeMirror（FS-101）——
 * 编辑器是唯一直接往用户源文件里写字节的东西，一次 patch 版本里的
 * 换行/编码行为变化就足以在用户不知情的情况下改坏文件，而浮动版本
 * 意味着那份代码从来没有人验证过。
 */
const PINNED = [
  { name: "electron-updater", field: "dependencies" },
  { name: "electron-log", field: "dependencies" },
  { name: "electron-builder", field: "devDependencies" },
  { name: "codemirror", field: "dependencies" },
  { name: "@codemirror/state", field: "dependencies" },
  { name: "@codemirror/view", field: "dependencies" },
  { name: "@codemirror/commands", field: "dependencies" },
];

const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8"));
const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split(/\r?\n/);

/**
 * 从 lockfile 的 importers 段里取某个包的 specifier / version。
 *
 * 不引 yaml 解析器：这里只需要认「缩进 6 空格的键 + 紧跟的两行」，
 * 为一个校验脚本引一个依赖不划算。
 */
function lockEntry(name) {
  // 作用域包在 lockfile 里带单引号（'@codemirror/state':），非作用域的不带。
  // 两种都要认，否则新增一个 @scope/pkg 会被报成「lockfile 里找不到」，
  // 而那时人的第一反应是去跑 pnpm install —— 跑完还是同样的错。
  const heads = [`      ${name}:`, `      '${name}':`];
  for (let i = 0; i < lock.length; i++) {
    if (!heads.includes(lock[i])) continue;
    const spec = /^\s*specifier:\s*(.+)$/.exec(lock[i + 1] ?? "");
    const ver = /^\s*version:\s*(.+)$/.exec(lock[i + 2] ?? "");
    if (spec && ver) {
      // electron-builder 的解析结果带 peer 后缀：26.15.3(foo@26.15.3)
      return { specifier: spec[1].trim(), version: ver[1].trim().split("(")[0] };
    }
  }
  return null;
}

function installedVersion(name) {
  for (const base of [join(APP_DIR, "node_modules"), join(ROOT, "node_modules")]) {
    try {
      return JSON.parse(readFileSync(join(base, name, "package.json"), "utf8")).version;
    } catch {
      /* 换下一个位置 */
    }
  }
  return null;
}

const problems = [];
const report = [];

for (const { name, field } of PINNED) {
  const declared = pkg[field]?.[name];
  if (!declared) {
    problems.push(`${name}: package.json 的 ${field} 里没有这一项`);
    continue;
  }
  if (/[\^~><*x]|\s-\s/.test(declared)) {
    problems.push(`${name}: 版本 "${declared}" 不是精确值（禁止 ^ / ~ / 范围）`);
  }

  const entry = lockEntry(name);
  if (!entry) {
    problems.push(`${name}: pnpm-lock.yaml 里找不到对应条目（先跑 pnpm install）`);
  } else {
    if (entry.specifier !== declared) {
      problems.push(
        `${name}: lockfile specifier "${entry.specifier}" ≠ package.json "${declared}"`
      );
    }
    if (entry.version !== declared) {
      problems.push(
        `${name}: lockfile 解析到 "${entry.version}"，package.json 写的是 "${declared}"`
      );
    }
  }

  const installed = installedVersion(name);
  if (installed && installed !== declared) {
    problems.push(`${name}: node_modules 里装的是 ${installed}，不是 ${declared}`);
  }

  report.push(
    `${name.padEnd(18)} declared=${declared} lock=${entry?.version ?? "-"} installed=${installed ?? "-"}`
  );
}

for (const line of report) console.log(line);

if (problems.length > 0) {
  console.error("更新依赖版本不一致：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log("OK: 三个更新相关依赖的版本在 package.json / lockfile / node_modules 三处一致");

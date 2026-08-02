#!/usr/bin/env node
/**
 * 测试发现范围闸门（CT-21）。
 *
 * 磁盘上真实存在的 spec 集合 D 必须被 vitest 实际发现的集合 F 完全覆盖。
 * D ⊄ F 说明有人改窄了 include / 加了 exclude / 新建了第二份 vitest 配置，
 * 于是一批测试被静默注销 —— 这类改动不会让任何命令报错，只会让回归悄悄消失。
 *
 * 退出码 0：D ⊆ F；退出码 1：有遗漏，并列出遗漏文件。
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SPEC_RE = /\.(spec|test)\.ts$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git"]);

/** 枚举磁盘上的 spec 文件集合 D。 */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), acc);
    } else if (SPEC_RE.test(entry.name)) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function norm(p) {
  return relative(ROOT, p).split("\\").join("/");
}

const packagesDir = join(ROOT, "packages");
let onDisk = [];
try {
  if (statSync(packagesDir).isDirectory()) onDisk = walk(packagesDir);
} catch {
  console.error("check-test-discovery: packages/ 不存在");
  process.exit(1);
}
const D = new Set(onDisk.map(norm));

/** 问 vitest 它到底发现了哪些文件，得到集合 F。 */
let raw;
try {
  raw = execFileSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly", "--json"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
} catch (err) {
  console.error("check-test-discovery: 无法执行 vitest list");
  console.error(err.stdout ?? "", err.stderr ?? "");
  process.exit(1);
}

const start = raw.indexOf("[");
if (start === -1) {
  console.error("check-test-discovery: vitest list 未返回 JSON");
  console.error(raw);
  process.exit(1);
}

let listed;
try {
  listed = JSON.parse(raw.slice(start));
} catch {
  console.error("check-test-discovery: vitest list 输出不是合法 JSON");
  console.error(raw);
  process.exit(1);
}

const F = new Set(listed.map((item) => norm(resolve(ROOT, item.file))));

const missing = [...D].filter((f) => !F.has(f)).sort();

console.log(`discovered ${F.size}`);
console.log(`onDisk ${D.size}`);

if (missing.length > 0) {
  console.error("以下 spec 存在于磁盘但未被 vitest 发现：");
  for (const f of missing) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("OK: 磁盘上的全部 spec 都在 vitest 的发现范围内");

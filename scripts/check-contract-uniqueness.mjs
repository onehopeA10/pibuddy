#!/usr/bin/env node
/**
 * 契约唯一性闸门（裁定6）。
 *
 * 计划里散落着 8 处「契约必须唯一」的文字条款，没有一条是机器可判定的。
 * 这个脚本把它们变成三个可执行断言：
 *
 *   A. 名字碰撞     —— packages/contract/src 导出的名字，不得在
 *                      packages/app/src 或 packages/pi-sdk/src 里被再次 export
 *   B. 第二套契约包 —— packages/ 下不得出现第二个自称 contract 的包
 *   C. 跨层引用     —— 任何源码不得 import "…/preload/index.d"
 *                      （渲染进程曾用 '../../../preload/index.d' 硬编码跨层拿类型）
 *
 * 退出码 0 = 全部通过；1 = 有违规，逐条打印 文件:行号。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git", "test"]);
const SOURCE_RE = /\.(ts|tsx|vue|mts|cts)$/;

/** `export interface X` / `export type X =` / `export const X` / `export function X` / `export class X` */
const EXPORT_RE = /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(interface|type|const|let|function|class|enum)\s+([A-Za-z_$][\w$]*)/;
const CROSS_LAYER_RE = /from\s+["'][^"']*preload\/index\.d["']/;

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), acc);
    } else if (SOURCE_RE.test(entry.name)) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

const rel = (p) => relative(ROOT, p).split("\\").join("/");

/** file → [{ name, line }] */
function exportsOf(files) {
  const out = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      const m = EXPORT_RE.exec(text);
      if (m) out.push({ name: m[2], kind: m[1], file, line: i + 1 });
    });
  }
  return out;
}

const violations = [];

// ---- A. 名字碰撞 ----------------------------------------------------------
const contractDir = join(ROOT, "packages", "contract", "src");
const contractExports = exportsOf(walk(contractDir));
const contractNames = new Map();
for (const e of contractExports) {
  if (!contractNames.has(e.name)) contractNames.set(e.name, []);
  contractNames.get(e.name).push(e);
}

// 契约包内部自己重复定义同一个名字，同样是漂移源
for (const [name, list] of contractNames) {
  if (list.length > 1) {
    violations.push(
      `契约包内重复导出 "${name}"：\n` +
        list.map((e) => `    ${rel(e.file)}:${e.line}`).join("\n")
    );
  }
}

const consumerDirs = [
  join(ROOT, "packages", "app", "src"),
  join(ROOT, "packages", "pi-sdk", "src"),
];
for (const dir of consumerDirs) {
  for (const e of exportsOf(walk(dir))) {
    const owner = contractNames.get(e.name);
    if (!owner) continue;
    violations.push(
      `"${e.name}" 已由契约包定义于 ${rel(owner[0].file)}:${owner[0].line}，` +
        `不得在 ${rel(e.file)}:${e.line} 再次 export（改为 import type）`
    );
  }
}

// ---- B. 第二套契约包 ------------------------------------------------------
const packagesDir = join(ROOT, "packages");
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "contract") continue;
  const pkgJson = join(packagesDir, entry.name, "package.json");
  try {
    if (!statSync(pkgJson).isFile()) continue;
    const name = JSON.parse(readFileSync(pkgJson, "utf8")).name ?? "";
    if (/contract|schema|types?$/i.test(name)) {
      violations.push(`疑似第二套契约包：${rel(pkgJson)} 声明 name "${name}"`);
    }
  } catch {
    /* 没有 package.json 就跳过 */
  }
}

// ---- C. 跨层 preload/index.d 引用 -----------------------------------------
for (const dir of [...consumerDirs, contractDir]) {
  for (const file of walk(dir)) {
    if (rel(file).endsWith("src/preload/index.d.ts")) continue;
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((text, i) => {
        if (CROSS_LAYER_RE.test(text)) {
          violations.push(
            `跨层类型引用：${rel(file)}:${i + 1} 直接 import preload/index.d，` +
              `应改为 @contract / @pibuddy/contract`
          );
        }
      });
  }
}

// ---- 汇报 -----------------------------------------------------------------
console.log(`contract exports ${contractExports.length}`);

if (violations.length > 0) {
  console.error("契约唯一性检查失败：");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log("OK: 契约名字唯一、无第二套契约包、无跨层 preload/index.d 引用");

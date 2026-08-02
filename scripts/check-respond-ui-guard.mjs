#!/usr/bin/env node
/**
 * respondUi 的返回值必须被检查（TASK-012 c[13]）。
 *
 * 判据：定位每个 `respondUi(` **调用**所在行 L，断言 (L, L+5] 行区间内存在
 * `if (!` / `=== false` / `.ok` 三者之一。区间宽度明定为 5 行。
 *
 * 「调用」的判定是 `.respondUi(`（成员调用）：接口里的方法声明
 * （`respondUi(response): boolean;`，无前置点）与注释里提到这个名字的行
 * 都不是调用点，把它们算进去会让判据变成「源码里不许写这个词」。
 * 注释行（以 * 或 // 开头）一律跳过。
 *
 * 改造前 pi-ipc.ts 是 `clientFor(id).respondUi(response)` 一行：返回值不存在，
 * 失败被静默吞掉 —— 用户点了确定、弹窗关了，助手那边什么都没收到。
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WINDOW = 5;
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git"]);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), acc);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

const targets = walk(join(ROOT, "packages", "app", "src", "main"));
const violations = [];
let sites = 0;

for (const file of targets) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((text, i) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
    if (!/\.respondUi\(/.test(text)) return;
    sites++;
    const window = lines.slice(i + 1, i + 1 + WINDOW).join("\n");
    const guarded =
      window.includes("if (!") || window.includes("=== false") || window.includes(".ok");
    if (!guarded) {
      violations.push(`${relative(ROOT, file).split("\\").join("/")}:${i + 1}`);
    }
  });
}

console.log(`respondUi 调用点 ${sites} 处，未在其后 ${WINDOW} 行内检查返回值的 ${violations.length} 处`);
if (violations.length > 0) {
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("OK");

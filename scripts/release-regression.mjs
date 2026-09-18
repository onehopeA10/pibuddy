#!/usr/bin/env node
/**
 * 发布前全量自动化回归。
 *
 * 一条命令对齐 CI `verify` job：typecheck → 静态闸门 → vitest。
 * `--with-package` 再接上 CI `package` job：prepare:runtime → build →
 * electron-builder --dir → 产物结构校验 → 解包二进制启动冒烟。
 *
 * 机器判不了的（签名、SmartScreen、真模型、干净机 N→N+1）写在
 * docs/product/RELEASE_SETUP.md §9，脚本跑完会再印一遍，避免「绿了就当发过」。
 *
 *   node scripts/release-regression.mjs
 *   node scripts/release-regression.mjs --with-package
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const withPackage = process.argv.includes("--with-package");

/** @type {Array<[string, string, string[]]>} */
const steps = [
  ["Typecheck", "pnpm", ["typecheck"]],
  ["Check test discovery scope", "node", ["scripts/check-test-discovery.mjs"]],
  ["Check contract uniqueness", "node", ["scripts/check-contract-uniqueness.mjs"]],
  ["Check workflow action pins", "node", ["scripts/check-workflow-pins.mjs"]],
  ["Check pure-JS dependency closure", "node", ["packages/app/scripts/check-pure-js-deps.mjs"]],
  ["Check dead code against baseline", "node", ["scripts/check-dead-code.mjs", "--check"]],
  ["Check UI copy", "node", ["packages/app/scripts/check-copy.mjs", "--check"]],
  ["Test", "pnpm", ["test"]],
];

if (withPackage) {
  steps.push(
    ["Prepare pi runtime", "pnpm", ["--filter", "@pibuddy/app", "run", "prepare:runtime"]],
    ["Build renderer and main", "pnpm", ["--filter", "@pibuddy/app", "run", "build"]],
    [
      "Package (--dir, no installer)",
      "pnpm",
      ["--filter", "@pibuddy/app", "exec", "electron-builder", "--dir", "--publish", "never"],
    ],
    ["Check stale build output", "node", ["packages/app/scripts/check-stale-dist.mjs", "--check"]],
    ["Verify packaged artifacts", "node", ["packages/app/scripts/verify-packaged-app.mjs"]],
    ["Smoke packaged app", "node", ["packages/app/scripts/smoke-packaged-app.mjs"]],
  );
}

function run(label, command, args) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      // 打包步骤会解析 publish.url；本地 / CI 都不该去碰真实 feed。
      PIBUDDY_UPDATE_FEED_URL:
        process.env.PIBUDDY_UPDATE_FEED_URL || "https://example.invalid/pibuddy-ci",
    },
  });
  if (result.status !== 0) {
    console.error(`\nrelease-regression: FAIL at 「${label}」`);
    process.exit(result.status ?? 1);
  }
}

for (const [label, command, args] of steps) {
  run(label, command, args);
}

console.log(`\nrelease-regression: OK（${steps.length} 步${withPackage ? "，含打包冒烟" : ""}）`);
console.log(`
机器覆盖到此为止。发布前仍须人工过一遍（详见 docs/product/RELEASE_SETUP.md §9）：
  - 签名后的安装包在干净 Windows / macOS 上能装、不被 SmartScreen / Gatekeeper 永久拦
  - 真模型走完一轮对话（权限弹窗、中断后续、记忆注入）
  - 干净机 N→N+1 自动更新闭环
`);
process.exit(0);

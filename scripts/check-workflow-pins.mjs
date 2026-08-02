#!/usr/bin/env node
/**
 * 第三方 GitHub Action 必须以 40 位 commit SHA 固定（UPD-005 / 供应链）。
 *
 * `uses: actions/checkout@v4` 里的 v4 是一个**可移动的 tag**：上游仓库被
 * 攻陷时，攻击者只要把 v4 指向自己的 commit，所有引用它的流水线就会在下一
 * 次运行里执行任意代码 —— 而仓库这边的 diff 是空的。SHA 固定之后这条路
 * 直接不存在。
 *
 * ## 正则为什么是 `^\s*-?\s*uses:`
 *
 * 只写 `^\s*uses:` 会漏掉 `- uses: foo@v4` 这种**最常见**的紧凑写法。实测：
 * 三行样本（`- uses: actions/checkout@<40hex>` / `uses: actions/setup-node@<40hex>`
 * / `- uses: pnpm/action-setup@v4`）下，旧正则只命中 1 行，恰好漏掉唯一未
 * 固定的那一项 —— 闸门看起来是绿的，实际什么都没拦。
 *
 * ## 为什么不用 `rg -n "uses: (?!...)"`
 *
 * ripgrep 用的是 Rust regex，**不支持 look-around**，那条命令会以
 * `error: look-around ... is not supported` 退出码 2 终止 —— 既不 PASS 也不
 * FAIL，在 `set -e` 之外的上下文里会被当成通过。本脚本的退出码是主判据。
 *
 * 等价的 ripgrep 旁证（输出必须为 0）：
 *   rg -n '^\s*-?\s*uses:' <file> | rg -v '@[0-9a-f]{40}\s*$' | wc -l
 * 注意不要用 `rg -vc` 作为通过态判据：计数为 0 时它无输出且退出码为 1。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const WORKFLOW_DIR = path.join(process.cwd(), ".github", "workflows");

/** 同时匹配 `uses:` 与 `- uses:` 两种写法。 */
const USES_RE = /^\s*-?\s*uses:\s*(\S+)/;
/** 允许的固定形态：`owner/repo@<40 位小写 hex>`，可带 `path/`。 */
const PINNED_RE = /@[0-9a-f]{40}$/;

/**
 * 本仓库自己的 composite action / reusable workflow 不需要 SHA 固定 ——
 * 它们和调用方在同一次 checkout 里，没有「上游被换掉」这回事。
 */
function isLocal(ref) {
  return ref.startsWith("./") || ref.startsWith(".\\") || ref.startsWith("docker://");
}

function listWorkflows() {
  if (!fs.existsSync(WORKFLOW_DIR)) return [];
  return fs
    .readdirSync(WORKFLOW_DIR)
    .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
    .map((n) => path.join(WORKFLOW_DIR, n))
    .sort();
}

export function findUnpinned(files = listWorkflows()) {
  const bad = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = USES_RE.exec(line);
      if (!m) return;
      const ref = m[1].replace(/^["']|["']$/g, "");
      if (isLocal(ref)) return;
      if (PINNED_RE.test(ref)) return;
      bad.push({ file: path.relative(process.cwd(), file), line: i + 1, ref });
    });
  }
  return bad;
}

function main() {
  const files = listWorkflows();
  if (files.length === 0) {
    process.stdout.write("check-workflow-pins: 没有找到 .github/workflows/*.yml\n");
    process.exit(0);
  }
  const bad = findUnpinned(files);
  if (bad.length === 0) {
    process.stdout.write(
      `check-workflow-pins: OK（${files.length} 个 workflow，全部 action 已 SHA 固定）\n`
    );
    process.exit(0);
  }
  for (const b of bad) {
    process.stderr.write(
      `${b.file}:${b.line}: action 未以 40 位 commit SHA 固定 -> ${b.ref}\n`
    );
  }
  process.stderr.write(
    `\ncheck-workflow-pins: ${bad.length} 处未固定。用 \`gh api repos/<owner>/<repo>/commits/<tag> -q .sha\` 取 SHA 后替换，并在行尾注释保留人可读的版本号。\n`
  );
  process.exit(1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-workflow-pins.mjs")) {
  main();
}

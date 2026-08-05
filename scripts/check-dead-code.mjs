#!/usr/bin/env node
/**
 * 死代码闸门 —— knip 的基线包装。
 *
 * 立场（照搬 maka-agent `check-dead-css.mjs` 的那句）：**这是基线工具。CI
 * 该强制死代码数「不增长」，而不是要求归零。** 一次性清空存量是另一个任务，
 * 而且删错东西的代价远大于留着 —— 归零式闸门的真实下场是被 `--no-verify`
 * 绕过或者整条注释掉。所以这里只管一件事：新增的死代码进不来。
 *
 * 数据结构就是一张「类别 → 上限」的表（scripts/knip-baseline.json）。
 * `--check` 时逐类比对：任一类超过上限即退出 1，并打印超出的那一类。
 * 低于上限不报错，但会提示可以收紧基线 —— 收敛靠这个提示，不靠人记着。
 *
 * 用法：
 *   node scripts/check-dead-code.mjs             # 人看的报告，逐条列出，恒 0
 *   node scripts/check-dead-code.mjs --check     # CI 用，超基线则 1
 *   node scripts/check-dead-code.mjs --update    # 重写基线为当前实测值
 *
 * ── knip.json 的 `ignore` 为什么有那两条 ──────────────────────────────
 * `.claude/worktrees/**` 与 `source/**` **只存在于主 checkout**，git worktree
 * 里都没有。基线因此是在一个看不见它们的环境里生成的，主 checkout 上一跑就
 * 对不上：worktrees 里是本仓代码的副本，同一处死代码会按活跃 worktree 数量
 * 翻倍上报（实测 binaries 从 1 涨到 22）；`source/` 是外部参考项目（pi /
 * maka-agent / codex 等）的只读副本，压根不是本仓的评估对象。
 * 排除它们不是放宽判据，是把扫描面收回到「本仓自己的代码」。
 *
 * ── 基线里几条已知的 knip 误判（存量数字包含它们，刻意不加豁免）────────
 *   - 根 devDependencies 的 naive-ui / pinia：组件测试从仓库根跑（CT-21 的
 *     单一 vitest 配置），import 语句却写在 packages/app 的 spec 里。knip 按
 *     workspace 归属算依赖，看不到这条跨 workspace 的连线。
 *   - packages/app 的 electron-log：electron-updater 的 logger 形参要它，
 *     由 update-deps.test.ts 断言版本钉死；没有一处 import 语句。
 *   - `binaries: netstat`：remote-netstat.spec.ts 探测系统命令，
 *     本来就不该是 npm 依赖。
 *   - `unlisted: electron`（scripts/probe-node-sqlite.mjs）：根 workspace 没有
 *     electron 依赖，探针是拿 packages/app 装好的那份跑的。
 *   写在这里而不是写进 knip.json 的 ignore：豁免会让这些条目永远消失在报告
 *   外，而它们的成因将来可能变（比如根 devDeps 被清理）。留在数里、说清楚，
 *   比藏起来诚实。
 *
 * 唯一进了 knip.json ignoreDependencies 的是 packages/app 的 electron-builder：
 * 它是**经 scripts/build-config.mjs `--exec --` 转发**调起的二进制，knip 的
 * 静态扫描原理上看不见这条线，不是「暂时没接上消费者」，留在数里只会永远是
 * 一条噪音。其余几条误判都有将来自然消失的可能，所以留在数里。
 *
 * 真实存量里值得单说的两条（**不是**误判，刻意不在本任务里清理）：
 *   - `codemirror`：源码只 import `@codemirror/{state,view,commands}`，伞包
 *     本身没有一处引用。
 *   - `AgentPool.vue`：全仓没有任何地方渲染它。
 *
 * knip.json 里那几条 knip 自己提示「redundant」的 entry（src/main/index.ts
 * 等）刻意保留：它们冗余是因为 knip 的 electron-vite 插件当前能读
 * electron.vite.config.ts。哪天插件行为变了，显式 entry 是兜底；而删掉它们
 * 的失败形态是「扫描面静默变窄、报告依然全绿」—— 本仓有 check-test-discovery
 * 就是为了防同一类事。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = resolve(HERE, "..");
const BASELINE_PATH = join(HERE, "knip-baseline.json");

function runKnip() {
  const res = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "knip", "bin", "knip.js"), "--reporter", "json"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  // knip 有问题时退出码非 0 —— 那是它的正常输出方式，不是执行失败。
  // 真正的失败长成「stdout 里没有 JSON」。
  const start = res.stdout.indexOf("{");
  if (start === -1) {
    process.stderr.write("check-dead-code: knip 未输出 JSON\n");
    process.stderr.write(`${res.stdout}\n${res.stderr}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(res.stdout.slice(start));
  } catch (err) {
    process.stderr.write(`check-dead-code: knip 输出不是合法 JSON —— ${err.message}\n`);
    process.exit(1);
  }
}

/**
 * 把 knip 的 JSON 压成「类别 → 条目列表」。
 *
 * 类别**不硬编码**，直接取 `issues[]` 里所有数组字段的名字（files /
 * dependencies / exports / duplicates / …）。knip 升级后新增一类死代码时，
 * 它会自动出现在报告里，而基线查不到这个键 ⇒ 上限按 0 算 ⇒ 当场判红。
 * 硬编码一张表的失败形态相反：新类别被静默忽略，报告依然全绿。
 */
export function summarize(report) {
  const counts = {};
  const detail = {};

  for (const issue of report.issues ?? []) {
    const file = issue.file ?? "(unknown)";
    for (const [field, entries] of Object.entries(issue)) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      counts[field] ??= 0;
      detail[field] ??= [];
      for (const entry of entries) {
        counts[field] += 1;
        detail[field].push(`${describe(entry)}  ${file}`);
      }
    }
  }
  return { counts, detail };
}

/** 一个条目可能是字符串、{name,line}、或 duplicates 那样的数组。 */
function describe(entry) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) return entry.map(describe).join(" | ");
  const line = entry.line ? `:${entry.line}` : "";
  const ns = entry.namespace ? `${entry.namespace}.` : "";
  return `${ns}${entry.name ?? JSON.stringify(entry)}${line}`;
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (err) {
    process.stderr.write(`check-dead-code: 读不到基线 ${BASELINE_PATH} —— ${err.message}\n`);
    process.stderr.write("首次落地请先跑 `node scripts/check-dead-code.mjs --update`。\n");
    process.exit(1);
  }
}

function main() {
  const checkMode = process.argv.includes("--check");
  const updateMode = process.argv.includes("--update");
  const { counts, detail } = summarize(runKnip());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (updateMode) {
    const max = {};
    for (const key of Object.keys(counts).sort()) max[key] = counts[key];
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          $comment:
            "knip 死代码基线：CI 只保证各类不增长，不要求归零。" +
            "收敛后用 `node scripts/check-dead-code.mjs --update` 收紧。" +
            "已知误判见 scripts/check-dead-code.mjs 文件头。",
          version: 1,
          max,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    process.stdout.write(`check-dead-code: 基线已写入 ${BASELINE_PATH}（共 ${total} 条）\n`);
    process.exit(0);
  }

  if (!checkMode) {
    // 人看的报告：把每类逐条列出来。
    for (const key of Object.keys(counts).sort()) {
      process.stdout.write(`\n${key}（${counts[key]}）：\n`);
      for (const line of detail[key]) process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write(`\ncheck-dead-code: 共 ${total} 条。`);
    process.stdout.write("加 --check 与基线比对，加 --update 收紧基线。\n");
    process.exit(0);
  }

  const baseline = loadBaseline();
  const max = baseline?.max ?? {};
  const over = [];
  const under = [];
  // 实测里出现的类别 ∪ 基线里记着的类别 —— 前者保证新类别被算进来，
  // 后者保证归零的类别被提示收紧。
  for (const key of [...new Set([...Object.keys(counts), ...Object.keys(max)])].sort()) {
    const limit = Number(max[key] ?? 0);
    const count = counts[key] ?? 0;
    if (!Number.isFinite(limit) || limit < 0) {
      process.stderr.write(`check-dead-code: 基线的 max.${key} 必须是非负数字\n`);
      process.exit(1);
    }
    if (count > limit) over.push({ key, count, limit });
    else if (count < limit) under.push({ key, count, limit });
  }

  if (over.length > 0) {
    process.stderr.write(`check-dead-code: ${over.length} 类死代码超出基线\n`);
    for (const o of over) {
      process.stderr.write(`\n  ${o.key}: ${o.count} > 基线 ${o.limit}\n`);
      for (const line of detail[o.key]) process.stderr.write(`    ${line}\n`);
    }
    process.stderr.write(
      "\n新增的死代码要么接上消费者，要么删掉。" +
        "确属误判时改 knip.json，别直接抬基线。\n"
    );
    process.exit(1);
  }

  process.stdout.write(`check-dead-code: OK（共 ${total} 条，各类均未超基线）\n`);
  if (under.length > 0) {
    process.stdout.write("以下类别已低于基线，可以收紧（--update）：\n");
    for (const u of under) process.stdout.write(`  ${u.key}: ${u.count} < ${u.limit}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-dead-code.mjs")) {
  main();
}

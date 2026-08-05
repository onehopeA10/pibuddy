#!/usr/bin/env node
/**
 * 中文文案闸门 —— 只查**可机械判定**的部分。
 *
 * 扫描面：
 *   - `packages/app/src/renderer/**\/*.vue` 里的中文串（template 文本节点、
 *     属性值、script 里的中文字符串字面量）
 *   - `packages/app/resources/**\/*.md`（技能 SKILL.md / 提示词库正文）——
 *     这些是随包发出去的产品内容，和界面文案同一份标准。
 *
 * ── 留给人工评审的（本脚本刻意不查，因为机器判不了）─────────────────
 *   1. **同意图同措辞**：同一个动作在两处叫「导出诊断包」和「保存诊断信息」
 *      —— 需要知道两处指的是不是同一件事，这是语义判断。
 *   2. **AI 腔**：「让我们一起来…」「非常棒的选择！」「以下是为您精心准备的」
 *      —— 靠词表抓等于抓一部分漏一大半，还会误伤正常句子。
 *   3. **错误信息须含原因 + 修复路径**：「操作失败」是坏文案，
 *      「连接超时（30s），检查网络后重试」是好文案 —— 机器数不出「原因」
 *      在不在句子里。
 *   以上三条写进 review checklist，不写进这道闸。
 *
 * ── 规则分级 ─────────────────────────────────────────────────────
 * error（`--check` 判红）：
 *   [pressure-word]   营销压力词 轻松 / 极速 / 瞬间 / 只需 —— 它们承诺一种
 *                     用户不一定感受得到的轻松。改成描述实际动作。
 *                     这四个词在当前代码库的文案里出现 0 次，落地即绿。
 *   [ascii-ellipsis]  紧挨汉字的 ASCII `...` 应为省略号字符 `…`。存量 0 处。
 *   [cjk-latin-space] **仅 .vue**：中英文/数字之间缺空格
 *                     （CLAUDE.md：`使用 TypeScript 开发`）。实测界面文案侧
 *                     存量 0 处 —— 现有 .vue 已经全守这条，所以对新增文案
 *                     直接判红，不留欠账。
 *
 * warning（报告但不判红）：
 *   [soft-pressure]   一键 / 即可。实测当前文案里有既有用法：「一键出卷」是
 *                     edu.kids 的功能名（EduPanel.vue），「填好地址即可添加」
 *                     一类是陈述句而非承诺轻松。把它们判红等于要么逐条挂豁免、
 *                     要么改动八个产品组件的文案 —— 两者都超出「加一道闸」的
 *                     边界。先如实报数，收敛留给后续文案 review。
 *   [cjk-latin-space] **.md 侧**降级。存量 5 处，全在 resources 下的提示词与
 *                     技能正文里（`默认2`、`插座3`、`语气professional`）。
 *                     降级的理由不是误报多，而是这 5 处要归零就得改随包发出去
 *                     的提示词内容 —— 那是文案改动，不属于「加一道闸」。
 *                     如实报数，留给内容 review。
 *
 * 豁免语法：同一行加 `// copy-allow: <理由>`（.md 用 `<!-- copy-allow: 理由 -->`）。
 *
 * 用法：
 *   node packages/app/scripts/check-copy.mjs           # 人看的报告，恒 0
 *   node packages/app/scripts/check-copy.mjs --check   # CI 用，有 error 则 1
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..", "..");

const SCAN = [
  { root: join(APP_ROOT, "src", "renderer"), match: (n) => n.endsWith(".vue") },
  { root: join(APP_ROOT, "resources"), match: (n) => n.endsWith(".md") },
];
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git", "pi-runtime"]);

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/** 引号串：'…' / "…" / `…`，含转义。 */
const QUOTED = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;

const ERROR_PRESSURE = /轻松|极速|瞬间|只需/;
const SOFT_PRESSURE = /一键|即可/;
/** 汉字与 ASCII 字母/数字直接相邻。全角标点不算，故只取汉字区间。 */
const CJK_LATIN = /[\u4e00-\u9fff][A-Za-z0-9]|[A-Za-z0-9][\u4e00-\u9fff]/;

/**
 * ASCII `...` 必须**紧挨着汉字**才算。只要求「整行含汉字」的话，中文说明里
 * 引用的英文例句（`Please be advised that... / We would appreciate it if...`）
 * 会被一并打红 —— 那是英文省略号，本来就该写成 `...`。
 */
const ASCII_ELLIPSIS = /[㐀-䶿一-鿿]\.{3}|\.{3}[㐀-䶿一-鿿]/;

const RULES = [
  { id: "pressure-word", level: () => "error", test: (t) => ERROR_PRESSURE.test(t) },
  { id: "ascii-ellipsis", level: () => "error", test: (t) => ASCII_ELLIPSIS.test(t) },
  { id: "soft-pressure", level: () => "warning", test: (t) => SOFT_PRESSURE.test(t) },
  {
    id: "cjk-latin-space",
    // 界面文案（.vue）判红，提示词正文（.md）只报 warning —— 依据见脚本头。
    level: (kind) => (kind === "vue" ? "error" : "warning"),
    test: (t) => CJK_LATIN.test(t),
  },
];

function walk(dir, match, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), match, acc);
    } else if (entry.isFile() && match(entry.name)) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

/** 抽取一行里的引号串（只要含汉字的）。 */
function quotedTexts(line) {
  const out = [];
  for (const m of line.matchAll(QUOTED)) {
    if (HAN.test(m[2])) out.push(m[2]);
  }
  return out;
}

/**
 * .vue 的文案候选。按 template / script / style 三区分别处理：
 *   - style 整段跳过（CSS 不是文案，`content:` 里的中文极罕见，宁可漏不误报）
 *   - script 只看含汉字的字符串字面量
 *   - template 看属性串 + 去掉标签后剩下的文本节点
 */
function extractVue(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let region = "template";
  let inBlockComment = false;
  let inHtmlComment = false;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const lower = raw.toLowerCase();
    if (/<script[\s>]/.test(lower)) region = "script";
    else if (/<style[\s>]/.test(lower)) region = "style";
    else if (/<\/(script|style)>/.test(lower)) region = "template";

    if (raw.includes("copy-allow:")) return;
    if (region === "style") return;

    let line = raw;
    // 跨行 HTML 注释
    if (inHtmlComment) {
      const end = line.indexOf("-->");
      if (end === -1) return;
      line = line.slice(end + 3);
      inHtmlComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, "");
    if (line.includes("<!--")) {
      line = line.slice(0, line.indexOf("<!--"));
      inHtmlComment = true;
    }
    // 跨行块注释
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, "");
    if (line.includes("/*")) {
      line = line.slice(0, line.indexOf("/*"));
      inBlockComment = true;
    }
    // 行注释。URL 里的 `//` 会被误切，方向是漏报而非误报，可接受。
    line = line.replace(/\/\/.*$/, "");

    for (const text of quotedTexts(line)) out.push({ lineNo, text, raw });

    if (region === "template") {
      const textNode = line
        .replace(/<[^>]*>/g, " ")
        .replace(QUOTED, " ")
        .trim();
      if (HAN.test(textNode)) out.push({ lineNo, text: textNode, raw });
    }
  });
  return out;
}

/** .md 的文案候选：整行正文，去掉围栏代码块、行内代码、HTML 注释。 */
function extractMarkdown(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (raw.includes("copy-allow:")) return;
    const text = raw
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/`[^`]*`/g, " ")
      .trim();
    if (HAN.test(text)) out.push({ lineNo: i + 1, text, raw });
  });
  return out;
}

export function collectFindings() {
  const findings = [];
  for (const { root, match } of SCAN) {
    for (const file of walk(root, match)) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      const kind = file.endsWith(".vue") ? "vue" : "md";
      const candidates = kind === "vue" ? extractVue(source) : extractMarkdown(source);
      const seen = new Set();
      for (const c of candidates) {
        if (!HAN.test(c.text)) continue;
        for (const rule of RULES) {
          if (!rule.test(c.text)) continue;
          const key = `${c.lineNo}:${rule.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            rule: rule.id,
            level: rule.level(kind),
            file: rel,
            line: c.lineNo,
            excerpt: c.raw.trim().slice(0, 110),
          });
        }
      }
    }
  }
  return findings;
}

const FIX_HINT = {
  "pressure-word": "描述实际动作（「一条命令完成」而非「轻松完成」）",
  "ascii-ellipsis": "改用省略号字符 `…`（加载中… 而非 加载中...）",
  "soft-pressure": "陈述事实而非承诺轻松；功能名沿用既有叫法时可挂 copy-allow",
  "cjk-latin-space": "中英文/数字间加空格（`使用 TypeScript 开发`）",
};

function report(findings, level) {
  const hits = findings.filter((f) => f.level === level);
  if (hits.length === 0) return;
  const byRule = new Map();
  for (const f of hits) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  const sink = level === "error" ? process.stderr : process.stdout;
  sink.write(`\n${level.toUpperCase()}（${hits.length} 处）：\n`);
  for (const [rule, list] of byRule) {
    sink.write(`  [${rule}] ${list.length} 处 —— ${FIX_HINT[rule]}\n`);
    for (const f of list.slice(0, 40)) {
      sink.write(`    ${f.file}:${f.line}\n      ${f.excerpt}\n`);
    }
    if (list.length > 40) sink.write(`    …另有 ${list.length - 40} 处\n`);
  }
}

function main() {
  const checkMode = process.argv.includes("--check");
  const findings = collectFindings();
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warning");

  report(findings, "warning");
  report(findings, "error");

  if (errors.length === 0) {
    process.stdout.write(
      `\ncheck-copy: OK（error 0 处，warning ${warnings.length} 处）\n` +
        "warning 不判红：见脚本头「规则分级」一节的实测依据。\n"
    );
    process.exit(0);
  }

  process.stderr.write(
    `\ncheck-copy: FAIL —— ${errors.length} 处 error（另有 ${warnings.length} 处 warning）\n` +
      "确有例外时在同一行加 `// copy-allow: <理由>`（.md 用 `<!-- copy-allow: 理由 -->`）。\n"
  );
  process.exit(checkMode ? 1 : 0);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-copy.mjs")) {
  main();
}

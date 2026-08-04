#!/usr/bin/env node
/**
 * 零依赖 Markdown → HTML 转换（office-doc-convert 技能自带）。
 *
 * 用法：node md-to-html.mjs <输入.md> [输出.html] [--title 文档标题]
 *
 * 支持：ATX 标题、粗/斜体、行内代码、围栏代码块、无序/有序列表（一层嵌套）、
 * 表格、引用、分隔线、链接、图片。脚注 / 公式 / 任务列表不支持（原样保留文本）。
 * 输出内嵌中文友好的打印样式（A4），供浏览器 / Edge 无头打印直接出 PDF。
 * 输出文件已存在时自动加序号，绝不覆盖。
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const positional = [];
let title = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--title") title = args[++i] ?? "";
  else positional.push(args[i]);
}
const [inputFile, outArg] = positional;
if (!inputFile) {
  console.error("用法：node md-to-html.mjs <输入.md> [输出.html] [--title 文档标题]");
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error(`错误：找不到文件 ${inputFile}`);
  process.exit(1);
}

function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 行内语法：代码 → 图片 → 链接 → 粗体 → 斜体。先转义再替换，代码段内不再处理。 */
function inline(text) {
  const codeSlots = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codeSlots.push(`<code>${code}</code>`);
    return `\u0000${codeSlots.length - 1}\u0000`;
  });
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSlots[Number(i)]);
}

const lines = fs.readFileSync(inputFile, "utf8").replace(/^\ufeff/, "").split(/\r?\n/);
const out = [];
let i = 0;
let paragraph = [];

function flushParagraph() {
  if (paragraph.length > 0) {
    out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  }
}

/** 收一段列表（支持一层缩进嵌套）。返回消费到的行号。 */
function readList(start) {
  const items = []; // {text, children: [], ordered}
  let j = start;
  const topOrdered = /^\d+\.\s/.test(lines[j].trim());
  while (j < lines.length) {
    const raw = lines[j];
    const trimmed = raw.trim();
    const m = trimmed.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    if (!m) break;
    const indent = raw.length - raw.trimStart().length;
    if (indent >= 2 && items.length > 0) {
      items[items.length - 1].children.push({
        text: m[1],
        ordered: /^\d+\./.test(trimmed),
      });
    } else if (indent >= 2) {
      break;
    } else {
      items.push({ text: m[1], children: [], ordered: /^\d+\./.test(trimmed) });
    }
    j++;
  }
  const tag = topOrdered ? "ol" : "ul";
  const html = items
    .map((item) => {
      if (item.children.length === 0) return `<li>${inline(item.text)}</li>`;
      const childTag = item.children[0].ordered ? "ol" : "ul";
      const children = item.children.map((c) => `<li>${inline(c.text)}</li>`).join("");
      return `<li>${inline(item.text)}<${childTag}>${children}</${childTag}></li>`;
    })
    .join("");
  out.push(`<${tag}>${html}</${tag}>`);
  return j;
}

while (i < lines.length) {
  const line = lines[i];
  const trimmed = line.trim();

  if (trimmed === "") {
    flushParagraph();
    i++;
  } else if (trimmed.startsWith("```")) {
    flushParagraph();
    const code = [];
    i++;
    while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
    i++; // 收掉结尾 ```
    out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  } else if (/^#{1,6}\s/.test(trimmed)) {
    flushParagraph();
    const level = trimmed.match(/^#+/)[0].length;
    out.push(`<h${level}>${inline(trimmed.replace(/^#+\s*/, ""))}</h${level}>`);
    i++;
  } else if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
    flushParagraph();
    out.push("<hr>");
    i++;
  } else if (trimmed.startsWith(">")) {
    flushParagraph();
    const quote = [];
    while (i < lines.length && lines[i].trim().startsWith(">")) {
      quote.push(lines[i].trim().replace(/^>\s?/, ""));
      i++;
    }
    out.push(`<blockquote><p>${quote.map(inline).join("<br>")}</p></blockquote>`);
  } else if (/^(?:[-*+]|\d+\.)\s/.test(trimmed)) {
    flushParagraph();
    i = readList(i);
  } else if (trimmed.startsWith("|") && lines[i + 1]?.trim().match(/^\|?[\s:|-]+\|?$/)) {
    flushParagraph();
    const parseRow = (row) =>
      row
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
    const head = parseRow(trimmed);
    i += 2; // 表头 + 分隔行
    const body = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) body.push(parseRow(lines[i++]));
    const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody>`;
    out.push(`<table>${thead}${tbody}</table>`);
  } else {
    paragraph.push(trimmed);
    i++;
  }
}
flushParagraph();

const docTitle = title || path.basename(inputFile, path.extname(inputFile));
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(docTitle)}</title>
<style>
  @page { size: A4; margin: 22mm 18mm; }
  body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", sans-serif;
         font-size: 12pt; line-height: 1.7; color: #1a1a1a; max-width: 820px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 22pt; border-bottom: 2px solid #ddd; padding-bottom: 6px; }
  h2 { font-size: 17pt; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  h3 { font-size: 14pt; }
  pre { background: #f6f8fa; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; overflow-x: auto; }
  code { font-family: Consolas, "Courier New", monospace; font-size: 10.5pt; background: #f6f8fa; border-radius: 3px; padding: 1px 4px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #cbd5e1; margin: 8px 0; padding: 2px 14px; color: #475569; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; }
  th { background: #f1f5f9; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
</style>
</head>
<body>
${out.join("\n")}
</body>
</html>
`;

let target =
  outArg ??
  path.join(path.dirname(inputFile), `${path.basename(inputFile, path.extname(inputFile))}.html`);
{
  const dir = path.dirname(target);
  const base = path.basename(target, ".html");
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base}-${n}.html`);
}
fs.writeFileSync(target, html, "utf8");
console.log(`已写入：${target}`);

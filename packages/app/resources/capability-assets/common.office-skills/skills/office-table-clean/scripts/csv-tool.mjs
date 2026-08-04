#!/usr/bin/env node
/**
 * 零依赖 CSV 处理工具（office-table-clean 技能自带）。
 *
 * 用法：
 *   node csv-tool.mjs preview <文件.csv> [--rows N]
 *   node csv-tool.mjs dedupe  <文件.csv> --key 列名[,列名…] [--keep first|last] [--out 输出.csv]
 *   node csv-tool.mjs filter  <文件.csv> [--where 列=值 …] [--contains 列:子串 …] [--out 输出.csv]
 *   node csv-tool.mjs pivot   <文件.csv> --group 列名 [--count] [--sum 列名[,列名…]] [--out 输出.csv]
 *
 * 约定：
 *   - 输入只读；--out 省略时自动生成「<原名>-<动作>.csv」；目标已存在时加序号，绝不覆盖。
 *   - 自动识别并剥掉 UTF-8 BOM；输出带 BOM 的 UTF-8（Excel 双击打开中文不乱码）。
 *   - 标准 CSV 引号规则：含逗号 / 双引号 / 换行的单元格外层加引号，内部引号成对转义。
 */
import fs from "node:fs";
import path from "node:path";

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- CSV 读写

/** 标准状态机解析：正确处理引号内的逗号、双引号转义（""）与换行。 */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 去掉纯空行（全部单元格为空的行）
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function encodeCell(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(file, rows) {
  const text = "\ufeff" + rows.map((r) => r.map(encodeCell).join(",")).join("\r\n") + "\r\n";
  fs.writeFileSync(file, text, "utf8");
}

/** 输出路径：--out 优先；缺省 <原名>-<动作>.csv；已存在则 -2、-3… 绝不覆盖。 */
function outputPath(inputFile, action, out) {
  let target =
    out ??
    path.join(
      path.dirname(inputFile),
      `${path.basename(inputFile, path.extname(inputFile))}-${action}.csv`
    );
  if (path.resolve(target) === path.resolve(inputFile)) fail("输出文件不能与输入文件相同（原表只读）");
  const dir = path.dirname(target);
  const base = path.basename(target, ".csv");
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base}-${n}.csv`);
  return target;
}

// ---------------------------------------------------------------- 参数

const [, , command, inputFile, ...rest] = process.argv;
const USAGE = "用法见文件头注释：preview / dedupe / filter / pivot";
if (!command || !inputFile) fail(USAGE);
if (!fs.existsSync(inputFile)) fail(`找不到文件：${inputFile}`);

/** --key a --where x=y --contains a:b … 折成 {key:[…], where:[…], contains:[…], …} */
function parseFlags(args) {
  const flags = { where: [], contains: [] };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) fail(`看不懂的参数：${args[i]}`);
    const name = args[i].slice(2);
    const value = args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[++i] : true;
    if (name === "where" || name === "contains") flags[name].push(value);
    else flags[name] = value;
  }
  return flags;
}
const flags = parseFlags(rest);

const rows = parseCsv(fs.readFileSync(inputFile, "utf8"));
if (rows.length === 0) fail("这个文件是空的");
const header = rows[0];
const data = rows.slice(1);

function columnIndex(name) {
  const idx = header.indexOf(name);
  if (idx === -1) fail(`表里没有「${name}」这一列。现有列：${header.join("、")}`);
  return idx;
}

// ---------------------------------------------------------------- 子命令

if (command === "preview") {
  const n = Number(flags.rows ?? 5);
  console.log(`文件：${inputFile}`);
  console.log(`列（${header.length}）：${header.join("、")}`);
  console.log(`数据行数：${data.length}`);
  console.log(`前 ${Math.min(n, data.length)} 行：`);
  for (const row of data.slice(0, n)) {
    console.log("  " + header.map((h, i) => `${h}=${row[i] ?? ""}`).join(" | "));
  }
} else if (command === "dedupe") {
  if (!flags.key || flags.key === true) fail("dedupe 需要 --key 列名（多列用逗号分隔）");
  const keyIdx = String(flags.key).split(",").map((k) => columnIndex(k.trim()));
  const keep = flags.keep ?? "first";
  if (keep !== "first" && keep !== "last") fail("--keep 只能是 first 或 last");
  const seen = new Map();
  for (const row of data) {
    const key = keyIdx.map((i) => (row[i] ?? "").trim()).join("\u0000");
    if (keep === "first") {
      if (!seen.has(key)) seen.set(key, row);
    } else {
      seen.set(key, row);
    }
  }
  const result = [...seen.values()];
  const target = outputPath(inputFile, "去重", flags.out);
  writeCsv(target, [header, ...result]);
  console.log(`${data.length} 行 → ${result.length} 行（去掉 ${data.length - result.length} 条重复）`);
  console.log(`已写入：${target}`);
} else if (command === "filter") {
  if (flags.where.length === 0 && flags.contains.length === 0) {
    fail("filter 需要至少一个 --where 列=值 或 --contains 列:子串");
  }
  const eq = flags.where.map((w) => {
    const sep = String(w).indexOf("=");
    if (sep <= 0) fail(`--where 的形态是 列=值，收到：${w}`);
    return [columnIndex(String(w).slice(0, sep).trim()), String(w).slice(sep + 1)];
  });
  const has = flags.contains.map((c) => {
    const sep = String(c).indexOf(":");
    if (sep <= 0) fail(`--contains 的形态是 列:子串，收到：${c}`);
    return [columnIndex(String(c).slice(0, sep).trim()), String(c).slice(sep + 1)];
  });
  const result = data.filter(
    (row) =>
      eq.every(([i, v]) => (row[i] ?? "").trim() === v.trim()) &&
      has.every(([i, v]) => (row[i] ?? "").includes(v))
  );
  const target = outputPath(inputFile, "筛选", flags.out);
  writeCsv(target, [header, ...result]);
  console.log(`${data.length} 行 → ${result.length} 行`);
  console.log(`已写入：${target}`);
} else if (command === "pivot") {
  if (!flags.group || flags.group === true) fail("pivot 需要 --group 列名");
  const groupIdx = columnIndex(String(flags.group).trim());
  const sumCols =
    flags.sum && flags.sum !== true
      ? String(flags.sum).split(",").map((s) => ({ name: s.trim(), idx: columnIndex(s.trim()) }))
      : [];
  const wantCount = Boolean(flags.count) || sumCols.length === 0; // 什么都没指定时至少数行数
  const groups = new Map();
  let badNumbers = 0;
  for (const row of data) {
    const key = (row[groupIdx] ?? "").trim() || "（空）";
    let acc = groups.get(key);
    if (!acc) {
      acc = { count: 0, sums: sumCols.map(() => 0) };
      groups.set(key, acc);
    }
    acc.count++;
    sumCols.forEach((col, i) => {
      const raw = (row[col.idx] ?? "").replaceAll(",", "").trim(); // 千分位
      const num = raw === "" ? 0 : Number(raw);
      if (Number.isNaN(num)) badNumbers++;
      else acc.sums[i] += num;
    });
  }
  const outHeader = [
    String(flags.group).trim(),
    ...(wantCount ? ["行数"] : []),
    ...sumCols.map((c) => `${c.name}合计`),
  ];
  const outRows = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "zh"))
    .map(([key, acc]) => [
      key,
      ...(wantCount ? [String(acc.count)] : []),
      ...acc.sums.map((s) => String(Math.round(s * 1e6) / 1e6)),
    ]);
  const target = outputPath(inputFile, "汇总", flags.out);
  writeCsv(target, [outHeader, ...outRows]);
  console.log(`${data.length} 行 → ${outRows.length} 组`);
  if (badNumbers > 0) console.log(`注意：有 ${badNumbers} 个单元格不是数字，按 0 计入合计`);
  console.log(`已写入：${target}`);
} else {
  fail(`未知子命令：${command}。${USAGE}`);
}

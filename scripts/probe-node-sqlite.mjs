#!/usr/bin/env node
/**
 * Electron 运行时 node:sqlite 探针（CT-12）。
 *
 * 必须在 **Electron 自带的 Node** 里探测，不能拿宿主 node 代替 —— 两者的
 * Node 版本经常不同，而 node:sqlite 是随 Node 版本进入 stable 的内置模块。
 * TASK-009 的存储选型与 electron-builder.yml 的 npmRebuild 取值以本结果为准。
 *
 * 结果同时打印到 stdout 并写回 doc/baseline-2026-08-02.md 的「运行时能力」小节。
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(ROOT, "packages", "app", "package.json"));

const START = "<!-- probe:node-sqlite:start -->";
const END = "<!-- probe:node-sqlite:end -->";

let electronExe;
let electronVersion;
try {
  electronExe = require("electron");
  electronVersion = require("electron/package.json").version;
} catch (err) {
  console.error(`probe-node-sqlite: 找不到 electron —— ${err.message}`);
  process.exit(1);
}

if (typeof electronExe !== "string" || !existsSync(electronExe)) {
  console.error(`probe-node-sqlite: electron 可执行文件不存在: ${electronExe}`);
  process.exit(1);
}

/** 在 Electron 内以纯 Node 模式执行一段脚本，返回 stdout。 */
function runInElectron(code) {
  return execFileSync(electronExe, ["-e", code], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

let nodeVersion = "unknown";
let sqliteStatus = "FAIL";
let sqliteDetail = "";

try {
  nodeVersion = runInElectron("process.stdout.write(process.versions.node)");
} catch (err) {
  console.error(`probe-node-sqlite: 无法读取 Electron 内 Node 版本 —— ${err.message}`);
  process.exit(1);
}

try {
  const out = runInElectron(
    "try{const s=require('node:sqlite');process.stdout.write('OK:'+Object.keys(s).join(','))}catch(e){process.stdout.write('FAIL:'+e.message)}"
  );
  if (out.startsWith("OK:")) {
    sqliteStatus = "OK";
    sqliteDetail = out.slice(3);
  } else {
    sqliteDetail = out.slice(5);
  }
} catch (err) {
  sqliteDetail = err.message;
}

const lines = [
  `- electron 版本: ${electronVersion}`,
  `- Electron 内 process.versions.node: ${nodeVersion}`,
  `- \`require('node:sqlite')\`: ${sqliteStatus}${sqliteDetail ? ` (${sqliteDetail})` : ""}`,
];

for (const line of lines) console.log(line);

// 写回基线文档的「运行时能力」小节。
const docPath = join(ROOT, "doc", "baseline-2026-08-02.md");
if (existsSync(docPath)) {
  const doc = readFileSync(docPath, "utf8");
  const s = doc.indexOf(START);
  const e = doc.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    const next =
      doc.slice(0, s + START.length) +
      "\n" +
      lines.join("\n") +
      "\n" +
      doc.slice(e);
    if (next !== doc) writeFileSync(docPath, next, "utf8");
    console.log(`probe-node-sqlite: 已写入 ${join("doc", "baseline-2026-08-02.md")}`);
  } else {
    console.error("probe-node-sqlite: 基线文档缺少 probe:node-sqlite 标记块");
    process.exit(1);
  }
} else {
  console.error("probe-node-sqlite: doc/baseline-2026-08-02.md 不存在");
  process.exit(1);
}

process.exit(sqliteStatus === "OK" ? 0 : 1);

/**
 * TASK-003 验收探针（不属于产品代码，放在 scratch 下）。
 *
 * 用「打包产物里的 electron.exe + 打包产物里的 pi-runtime」跑一次真实问答，
 * 环境变量按 pi-launcher 的 ENV_ALLOWLIST 口径构造，PATH 里剔除全局 pi 所在目录。
 *
 * 用法：node probe-task003-rpc.mjs <electronExe> <cliJs> <cwd>
 */
import { spawn } from "node:child_process";
import path from "node:path";

const [electronExe, cliJs, cwd] = process.argv.slice(2);

const ALLOW = [
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP",
  "SystemRoot", "ComSpec", "LANG", "LC_ALL",
  "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
];
const PATTERNS = [
  /^PI_[A-Z0-9_]+$/,
  /^[A-Z0-9]+(?:_[A-Z0-9]+)*_API_KEY$/,
  /^[A-Z0-9]+(?:_[A-Z0-9]+)*_BASE_URL$/,
  /^ANTHROPIC_AUTH_TOKEN$/,
];

const env = {};
for (const k of ALLOW) if (typeof process.env[k] === "string") env[k] = process.env[k];
for (const k of Object.keys(process.env)) {
  if (k in env) continue;
  if (PATTERNS.some((re) => re.test(k)) && typeof process.env[k] === "string") env[k] = process.env[k];
}
env.ELECTRON_RUN_AS_NODE = "1";

// 把全局 pi 所在目录从 PATH 里摘掉，证明不依赖系统上已装的 pi
const before = (env.PATH ?? "").split(path.delimiter);
const after = before.filter((d) => !/nvm4w[\\/]nodejs/i.test(d));
env.PATH = after.join(path.delimiter);
console.log(`[probe] PATH 条目 ${before.length} -> ${after.length}（已剔除全局 pi 所在目录）`);

const proc = spawn(electronExe, [cliJs, "--mode", "rpc", "--no-session"], {
  cwd,
  env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buf = "";
let answered = false;
const started = Date.now();

proc.stderr.on("data", (c) => process.stderr.write(`[pi stderr] ${c}`));
proc.on("error", (e) => { console.error("[probe] spawn 失败:", e.message); process.exit(1); });
proc.on("exit", (code) => {
  if (!answered) { console.error(`[probe] pi 提前退出 code=${code}`); process.exit(1); }
});

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    handle(obj);
  }
});

function send(o) { proc.stdin.write(JSON.stringify(o) + "\n"); }

let assistantText = "";
function handle(o) {
  if (o.type === "response" && o.id === "s1") {
    console.log(`[probe] get_state 成功=${o.success} model=${o.data?.model?.id ?? "?"}`);
    if (!o.success) { console.error("[probe] get_state 失败"); proc.kill(); process.exit(1); }
    send({ id: "p1", type: "prompt", message: "只回复两个字：收到" });
    return;
  }
  if (o.type === "message_update" || o.type === "message_end") {
    const content = o.message?.content;
    if (Array.isArray(content)) {
      const t = content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (t) assistantText = t;
    }
    return;
  }
  if (o.type === "agent_end" || (o.type === "response" && o.id === "p1")) {
    if (assistantText.trim()) {
      answered = true;
      console.log(`[probe] 助手回复：${JSON.stringify(assistantText.slice(0, 120))}`);
      console.log(`[probe] 一次完整问答耗时 ${Date.now() - started}ms`);
      console.log("[probe] RESULT=PASS");
      proc.kill();
      setTimeout(() => process.exit(0), 300);
    }
  }
}

send({ id: "s1", type: "get_state" });

setTimeout(() => {
  if (!answered) {
    console.error(`[probe] 超时未拿到回复；已累计文本=${JSON.stringify(assistantText.slice(0, 200))}`);
    console.error("[probe] RESULT=FAIL");
    proc.kill();
    process.exit(1);
  }
}, 120000);

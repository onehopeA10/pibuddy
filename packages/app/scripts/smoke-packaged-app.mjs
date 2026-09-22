#!/usr/bin/env node
/**
 * 解包产物启动冒烟。
 *
 * verify-packaged-app.mjs 数的是文件；本脚本回答的是下一句：
 * 「Electron 能否加载打包页面、挂载 Vue，并暴露 preload 接口」。
 * 构建退出码 0 + 文件齐并不保证主进程或渲染进程能启动。
 *
 * 不替代安装包签名、SmartScreen、真模型对话。首启允许停在向导页，
 * 不在这里伪造 onboardingCompletedAt。
 *
 *   node packages/app/scripts/smoke-packaged-app.mjs [--dir release]
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { waitForApp, waitForChildCdp } from "./packaged-app-readiness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const CDP_WAIT_MS = 45_000;
const BIN_NAMES = ["PiBuddy.exe", "pibuddy.exe", "PiBuddy", "pibuddy", "app"];
const HELPER_BIN = /^(chrome-sandbox|chrome_crashpad_handler|lib.*|LICENSES\.chromium\.html)$/i;

function parseOutDir() {
  const argv = process.argv.slice(2);
  const dirAt = argv.indexOf("--dir");
  return dirAt === -1 ? path.join(APP_ROOT, "release") : path.resolve(argv[dirAt + 1]);
}

function isAppBinary(dir, name) {
  if (name.endsWith(".app")) return false;
  const full = path.join(dir, name);
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  if (BIN_NAMES.includes(name) || /pibuddy/i.test(name)) return true;
  if (HELPER_BIN.test(name)) return false;
  try {
    const st = fs.statSync(full);
    return (st.mode & 0o111) !== 0 && !name.includes(".");
  } catch {
    return false;
  }
}

function findExecutables(outDir) {
  const found = [];
  if (!fs.existsSync(outDir)) return found;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(outDir, entry.name);
    for (const name of fs.readdirSync(base)) {
      if (isAppBinary(base, name)) found.push(path.join(base, name));
    }
    for (const inner of fs.readdirSync(base, { withFileTypes: true })) {
      if (!inner.isDirectory()) continue;
      if (inner.name.endsWith(".app")) {
        const macBin = path.join(base, inner.name, "Contents", "MacOS", "PiBuddy");
        if (fs.existsSync(macBin)) found.push(macBin);
      }
    }
    if (entry.name.endsWith(".app")) {
      const macBin = path.join(base, "Contents", "MacOS", "PiBuddy");
      if (fs.existsSync(macBin)) found.push(macBin);
    }
  }
  return [...new Set(found)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已经自己退出 */
    }
  }
}

function reexecUnderXvfbIfNeeded() {
  if (process.platform !== "linux") return;
  if (process.env.DISPLAY) return;
  if (process.env.PIBUDDY_SMOKE_NESTED) return;
  const which = spawnSync("which", ["xvfb-run"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.error("smoke-packaged-app: Linux 无 DISPLAY，且找不到 xvfb-run");
    console.error("CI 里先 apt-get install xvfb，或导出 DISPLAY 后再跑");
    process.exit(1);
  }
  const nested = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, PIBUDDY_SMOKE_NESTED: "1" },
  });
  process.exit(nested.status ?? 1);
}

async function main() {
  reexecUnderXvfbIfNeeded();

  const outDir = parseOutDir();
  const executables = findExecutables(outDir);
  if (executables.length === 0) {
    console.error(`smoke-packaged-app: 在 ${outDir} 下找不到 PiBuddy 可执行文件`);
    console.error("先跑 electron-builder --dir（CI 的 package job 就是这么做的）");
    if (fs.existsSync(outDir)) {
      for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const base = path.join(outDir, entry.name);
        console.error(`  ${entry.name}/ ${fs.readdirSync(base).slice(0, 40).join(" ")}`);
      }
    }
    process.exit(2);
  }

  const exe = executables[0];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-smoke-"));
  const logs = { stdout: "", stderr: "", spawnError: null };

  console.log(`  启动 ${exe}`);
  console.log(`  CDP 使用本次子进程自动分配的端口，userData ${userData}`);

  const child = spawn(
    exe,
    [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userData}`,
      "--disable-gpu",
      "--no-sandbox",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    },
  );
  child.once("error", (error) => { logs.spawnError = error; });
  child.stdout?.on("data", (buf) => {
    logs.stdout += buf.toString();
  });
  child.stderr?.on("data", (buf) => {
    logs.stderr += buf.toString();
  });

  try {
    const deadline = Date.now() + CDP_WAIT_MS;
    const { version, port } = await waitForChildCdp(child, logs, CDP_WAIT_MS);
    const app = await waitForApp(port, Math.max(0, deadline - Date.now()), child);
    console.log(`  ✓ Browser ${version.Browser ?? "unknown"}，页面/Vue/preload 就绪：${app.url}`);
    console.log("\nsmoke-packaged-app: OK");
  } catch (err) {
    console.error("\nsmoke-packaged-app: FAIL");
    console.error(`  ${err instanceof Error ? err.message : err}`);
    if (logs.stderr.trim()) {
      console.error("\n--- stderr（截断）---");
      console.error(logs.stderr.slice(-4000));
    }
    process.exitCode = 1;
  } finally {
    killTree(child);
    await sleep(400);
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* tmp 清不掉不挡退出码 */
    }
  }
}

if (
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("smoke-packaged-app.mjs")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

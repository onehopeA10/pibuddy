import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { McpServerInput } from "@pibuddy/contract";
import { connectStdio } from "../src/main/mcp/mcp-client.js";

/**
 * MCP stdio 客户端的**真机握手**测试（FEAT-mcp.md 铁律 2：连接测试要真的连
 * 一次）。这里不打桩 spawn —— 用 `process.execPath`（node 自己）跑一个真实的
 * stub MCP 服务器脚本，走完整的 initialize → notifications/initialized →
 * tools/list JSON-RPC 握手。
 *
 * ## 可证伪
 *
 * 一个**不应答**的 stub 必须让 probe.ok 变成 false（超时），否则「连接成功」
 * 这个判据就是恒真的——它测不出「其实没连上」。见「不应答的服务器 → 失败」。
 */

const TMP = path.join(os.tmpdir(), `pibuddy-mcp-client-${process.pid}`);

/** 一个真实的 stub MCP 服务器：应答 initialize 与 tools/list。 */
const RESPONSIVE_STUB = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const t = line.trim(); if (!t) continue;
    let msg; try { msg = JSON.parse(t); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05", capabilities: {},
        serverInfo: { name: "stub-mcp", version: "9.9.9" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [ { name: "echo", description: "echo back" }, { name: "add", description: "add two numbers" } ] } }) + "\\n");
    }
  }
});
`;

/** 一个只启动、从不应答的 stub：用来证伪「连接成功」。 */
const SILENT_STUB = `setInterval(() => {}, 1000); process.stdin.resume();`;

/** 一个启动即崩溃的 stub。 */
const CRASH_STUB = `process.exit(3);`;

const responsivePath = path.join(TMP, "responsive.mjs");
const silentPath = path.join(TMP, "silent.mjs");
const crashPath = path.join(TMP, "crash.mjs");

function stdioConfig(scriptPath: string): McpServerInput {
  return {
    name: "stub",
    transport: "stdio",
    command: process.execPath, // node 自己，跨平台可直接 spawn（shell:false）
    args: [scriptPath],
    env: {},
    headers: {},
    oauth: false,
  };
}

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(responsivePath, RESPONSIVE_STUB);
  fs.writeFileSync(silentPath, SILENT_STUB);
  fs.writeFileSync(crashPath, CRASH_STUB);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("connectStdio 真机握手", () => {
  it("对应答的 stub：握手成功，拿到 serverInfo 与工具列表", async () => {
    const { child, probe } = await connectStdio(stdioConfig(responsivePath), {
      timeoutMs: 8000,
      keepAlive: false,
    });
    expect(probe.ok).toBe(true);
    expect(probe.serverInfo).toEqual({ name: "stub-mcp", version: "9.9.9" });
    expect(probe.protocolVersion).toBe("2024-11-05");
    expect(probe.tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);
    // keepAlive:false 时进程必须已被回收
    expect(child).toBeNull();
  });

  it("keepAlive:true 时保留活进程，可被显式 kill", async () => {
    const { child, probe } = await connectStdio(stdioConfig(responsivePath), {
      timeoutMs: 8000,
      keepAlive: true,
    });
    expect(probe.ok).toBe(true);
    expect(child).not.toBeNull();
    expect(child!.killed).toBe(false);
    child!.kill();
  });

  // ---- 可证伪对照组 ----

  it("不应答的服务器 → 失败（超时），而不是恒真的成功", async () => {
    const { child, probe } = await connectStdio(stdioConfig(silentPath), {
      timeoutMs: 600,
      keepAlive: false,
    });
    expect(probe.ok).toBe(false);
    expect(probe.serverInfo).toBeNull();
    expect(probe.diagnostics.some((d) => d.includes("超时"))).toBe(true);
    expect(child).toBeNull();
  });

  it("启动即崩溃的服务器 → 失败并带上退出信息", async () => {
    const { probe } = await connectStdio(stdioConfig(crashPath), {
      timeoutMs: 4000,
      keepAlive: false,
    });
    expect(probe.ok).toBe(false);
    expect(probe.diagnostics.some((d) => d.includes("退出") || d.includes("code=3"))).toBe(true);
  });

  it("命令为空 → 立即失败，不 spawn", async () => {
    const config = stdioConfig(responsivePath);
    config.command = "";
    const { child, probe } = await connectStdio(config, { timeoutMs: 2000 });
    expect(probe.ok).toBe(false);
    expect(child).toBeNull();
  });

  it("不存在的命令 → 失败（spawn error），不抛异常", async () => {
    const config = stdioConfig(responsivePath);
    config.command = path.join(TMP, "definitely-not-a-real-binary-xyz");
    const { probe } = await connectStdio(config, { timeoutMs: 4000 });
    expect(probe.ok).toBe(false);
  });
});

// 预检：确保 node 能被直接 spawn（这套测试的前提），失败时给一句明确的话。
describe("前置：node 可执行", () => {
  it("process.execPath 能直接跑", () => {
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" });
    expect(r.stdout).toBe("ok");
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { McpServerInput } from "@pibuddy/contract";
import { connectStdio, escapeCmdArg, planSpawn } from "../src/main/mcp/mcp-client.js";

/**
 * Windows 上 `.cmd` / `.bat` 批处理 shim（`npx.cmd` 是最典型的一例）在
 * `spawn(shell:false)` 下不可直接执行——FEAT-mcp.md §5 risks 3 记的坑。本片验证
 * `planSpawn` 把它解析成经 `cmd.exe /c` 执行、且**参数逐字保字面量、不重获注入
 * 能力**。
 *
 * ## 可证伪
 *
 *  - 真机整合：一个真实的 `.cmd` shim 转发到 node MCP stub，`connectStdio` 必须
 *    完成握手。拆掉 planSpawn 的 cmd 分支（直接 spawn .cmd）→ ENOENT/EINVAL → 红。
 *  - 注入不逃逸：参数里塞 `&` `|` `;` `()` 这些 cmd 元字符，子进程收到的必须是
 *    **原样一个参数**、且元字符没被当成命令分隔执行。转义写错 → 参数被拆 / 触发
 *    副作用 → 断言不等 → 红。
 */

const IS_WIN = process.platform === "win32";
const TMP = path.join(os.tmpdir(), `pibuddy-mcp-win-${process.pid}`);

/** 真实的 node MCP stub：应答 initialize / tools/list（与 mcp-client.spec 同构）。 */
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
        serverInfo: { name: "cmd-shim", version: "1.2.3" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [ { name: "ping", description: "pong" } ] } }) + "\\n");
    }
  }
});
`;

/** 打印收到的转发参数（JSON），供注入测试断言逐字保真。 */
const PRINT_ARGS = `process.stdout.write(JSON.stringify(process.argv.slice(2)));`;

const stubPath = path.join(TMP, "stub.mjs");
const printArgsPath = path.join(TMP, "print-args.mjs");
// node 路径可能含空格，.cmd 内用引号括住。%* 原样转发 cmd 收到的参数。
const handshakeCmd = path.join(TMP, "handshake.cmd");
const argsCmd = path.join(TMP, "args.cmd");

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(stubPath, RESPONSIVE_STUB);
  fs.writeFileSync(printArgsPath, PRINT_ARGS);
  fs.writeFileSync(handshakeCmd, `@echo off\r\nnode "${stubPath}" %*\r\n`);
  fs.writeFileSync(argsCmd, `@echo off\r\nnode "${printArgsPath}" %*\r\n`);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function stdioConfig(command: string, args: string[] = []): McpServerInput {
  return { name: "shim", transport: "stdio", command, args, env: {}, headers: {}, oauth: false };
}

describe("planSpawn：跨平台形态", () => {
  it("非 Windows：原样透传，不包 cmd", () => {
    if (IS_WIN) return; // 该断言只在非 win 有意义
    const plan = planSpawn("npx", ["-y", "pkg"]);
    expect(plan.file).toBe("npx");
    expect(plan.args).toEqual(["-y", "pkg"]);
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it("escapeCmdArg 把 shell 元字符括进引号并加 ^（不再是裸元字符）", () => {
    const out = escapeCmdArg("a&b|c");
    // 元字符前必有 ^；整体被双引号包裹。
    expect(out.startsWith('"') || out.includes('^&')).toBe(true);
    expect(out).toContain("^&");
    expect(out).toContain("^|");
  });
});

describe.skipIf(!IS_WIN)("Windows .cmd shim（真机）", () => {
  it("planSpawn 把 .cmd 解析成 cmd.exe /c + verbatim", () => {
    const plan = planSpawn(handshakeCmd, ["x"]);
    expect(plan.file.toLowerCase()).toContain("cmd");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it("经 .cmd shim 也能完成 MCP 握手（修复前 shell:false 直接 spawn .cmd 会失败）", async () => {
    const { probe, child } = await connectStdio(stdioConfig(handshakeCmd), {
      timeoutMs: 12_000,
      keepAlive: false,
    });
    expect(probe.ok).toBe(true);
    expect(probe.serverInfo).toEqual({ name: "cmd-shim", version: "1.2.3" });
    expect(probe.tools.map((t) => t.name)).toEqual(["ping"]);
    expect(child).toBeNull();
  });

  it("注入不逃逸：含 & | ; () 的参数逐字送达子进程，元字符不被执行", () => {
    // `& echo PWNED` 若逃逸，会作为独立命令执行 → stdout 多出一行 PWNED。
    const injectionArgs = ["hello world", "a&echo PWNED", "b|c", "(paren)", "q\\path"];
    const plan = planSpawn(argsCmd, injectionArgs);
    const r = spawnSync(plan.file, plan.args, {
      encoding: "utf8",
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
    });
    // 唯一输出必须是 print-args 打出的那一行 JSON——一个字节都不多。元字符逃逸
    // 会让 `echo PWNED` 单独执行、或参数被拆，两者都会让 stdout 不再精确相等。
    expect(r.stdout.trim()).toBe(JSON.stringify(injectionArgs));
    expect(r.stdout).not.toContain("PWNED\r");
  });
});

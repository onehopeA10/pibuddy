import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * MCP 编排层的生命周期测试（能力包 common.mcp）。
 *
 * 走真机路径：project 作用域配一台指向真实 node stub 的 stdio 服务器，经
 * service 的 list / test / start / stop / dispose 全链路。验证的是那几件只有
 * 端到端跑一遍才看得出的事：
 *  - test 是**瞬时**的（连完即回收，running 恒 false）；
 *  - start 之后 list 的 running 翻成 true，stop 之后翻回 false；
 *  - dispose 把活进程全 kill（teardown，D4 规则 4）；
 *  - http 服务器 test 返回「未实现」而不是假装连上。
 */

const ROOT = path.join(os.tmpdir(), `pibuddy-mcp-service-${process.pid}`);
const PROJECT_ROOT = path.join(ROOT, "project");

vi.mock("../src/main/workspace-registry.js", () => ({
  requireWorkspaceRoot: () => PROJECT_ROOT,
}));

const { listServers, testServer, startServer, stopServer, disposeMcpResources, __resetMcpRunning } =
  await import("../src/main/mcp/mcp-service.js");
const { mcpServerId } = await import("../src/main/mcp/mcp-config.js");

const STUB = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const t = line.trim(); if (!t) continue;
    let msg; try { msg = JSON.parse(t); } catch { continue; }
    if (msg.method === "initialize")
      process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: msg.id, result: { protocolVersion:"2024-11-05", capabilities:{}, serverInfo:{ name:"svc-stub", version:"1.0.0" } } }) + "\\n");
    else if (msg.method === "tools/list")
      process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id: msg.id, result: { tools:[{ name:"ping", description:"" }] } }) + "\\n");
  }
});
`;

const stubPath = path.join(ROOT, "svc-stub.mjs");
const stdioId = mcpServerId("project", "local");
const httpId = mcpServerId("project", "remote");

beforeAll(() => {
  fs.mkdirSync(PROJECT_ROOT, { recursive: true });
  fs.writeFileSync(stubPath, STUB);
  fs.mkdirSync(path.join(PROJECT_ROOT, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_ROOT, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        local: { command: process.execPath, args: [stubPath] },
        remote: { type: "http", url: "https://mcp.example.com" },
      },
    })
  );
});

afterEach(() => {
  disposeMcpResources();
  __resetMcpRunning();
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function find(servers: { id: string }[], id: string) {
  return servers.find((s) => s.id === id);
}

describe("MCP service 生命周期", () => {
  it("list 枚举到两台，初始都不 running", async () => {
    const result = await listServers("ws");
    expect(find(result.servers, stdioId)?.running).toBe(false);
    expect(find(result.servers, httpId)?.running).toBe(false);
  });

  it("test 真连一次：ok + 工具，且瞬时（running 恒 false）", async () => {
    const r = await testServer("ws", stdioId);
    expect(r.ok).toBe(true);
    expect(r.serverInfo).toEqual({ name: "svc-stub", version: "1.0.0" });
    expect(r.tools.map((t) => t.name)).toEqual(["ping"]);
    expect(r.running).toBe(false);
    // test 不留活进程
    expect(find((await listServers("ws")).servers, stdioId)?.running).toBe(false);
  });

  it("start → list.running=true；stop → 翻回 false", async () => {
    const started = await startServer("ws", stdioId);
    expect(started.ok).toBe(true);
    expect(started.running).toBe(true);
    expect(find((await listServers("ws")).servers, stdioId)?.running).toBe(true);

    await stopServer("ws", stdioId);
    expect(find((await listServers("ws")).servers, stdioId)?.running).toBe(false);
  });

  it("dispose kill 全部活进程（teardown）", async () => {
    await startServer("ws", stdioId);
    expect(find((await listServers("ws")).servers, stdioId)?.running).toBe(true);
    disposeMcpResources();
    expect(find((await listServers("ws")).servers, stdioId)?.running).toBe(false);
  });

  it("http 服务器 test → 未实现，而不是假装连上", async () => {
    const r = await testServer("ws", httpId);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.includes("http") && d.includes("未实现"))).toBe(true);
  });

  it("未知 id → 明确诊断，不抛", async () => {
    const r = await testServer("ws", "deadbeefdeadbeef");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.includes("未找到"))).toBe(true);
  });
});

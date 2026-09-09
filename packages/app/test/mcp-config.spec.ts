import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpServerInput } from "@pibuddy/contract";

/**
 * MCP 配置读写测试（能力包 common.mcp）。
 *
 * 覆盖三件容易悄悄退化的事：
 *  - 传输判定（有 url / type 属 http，否则 stdio）；
 *  - **脱敏**：下发给渲染进程的 descriptor 只带 env / header 的键名，绝不带值；
 *  - save / remove 的**先读再合并**：不整文件覆盖用户手写的其它服务器与字段。
 */

const ROOT = path.join(os.tmpdir(), `pibuddy-mcp-config-${process.pid}`);
const PROJECT_ROOT = path.join(ROOT, "project");
const HOME = path.join(ROOT, "home");

// requireWorkspaceRoot 会拖进 workspace-registry（electron）；这里打桩成临时目录。
vi.mock("../src/main/workspace-registry.js", () => ({
  requireWorkspaceRoot: () => PROJECT_ROOT,
}));

const {
  mcpServerId,
  resolveServers,
  findServer,
  toDescriptor,
  saveServer,
  removeServer,
} = await import("../src/main/mcp/mcp-config.js");

const userMcpFile = () => path.join(HOME, ".pi", "agent", "mcp.json");
const projectMcpFile = () => path.join(PROJECT_ROOT, ".pi", "mcp.json");

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_ROOT, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("mcpServerId", () => {
  const config = (name: string, command = "node"): McpServerInput => ({
    name,
    transport: "stdio",
    command,
    args: ["server.mjs"],
    env: {},
    headers: {},
    oauth: false,
  });

  it("同工作区、scope 与完整配置稳定；跨工作区 / scope / name / command 均不同", () => {
    expect(mcpServerId("ws-a", "user", config("fs"))).toBe(
      mcpServerId("ws-a", "user", config("fs"))
    );
    expect(mcpServerId("ws-a", "user", config("fs"))).not.toBe(
      mcpServerId("ws-b", "user", config("fs"))
    );
    expect(mcpServerId("ws-a", "user", config("fs"))).not.toBe(
      mcpServerId("ws-a", "project", config("fs"))
    );
    expect(mcpServerId("ws-a", "user", config("fs"))).not.toBe(
      mcpServerId("ws-a", "user", config("web"))
    );
    expect(mcpServerId("ws-a", "user", config("fs"))).not.toBe(
      mcpServerId("ws-a", "user", config("fs", "deno"))
    );
  });
});

describe("resolveServers 枚举与传输判定", () => {
  it("合并 user + project 两来源，并按 url/type 判传输", async () => {
    writeJson(userMcpFile(), {
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "server-fs", "."], env: { API_KEY: "sk-secret-123" } },
        remote: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer tok" } },
      },
    });
    writeJson(projectMcpFile(), {
      mcpServers: { proj: { command: "node", args: ["srv.js"] } },
    });

    const { servers, errors } = await resolveServers("ws", HOME);
    expect(errors).toEqual([]);
    const byName = new Map(servers.map((s) => [s.config.name, s]));
    expect(byName.get("filesystem")!.config.transport).toBe("stdio");
    expect(byName.get("remote")!.config.transport).toBe("http");
    expect(byName.get("proj")!.scope).toBe("project");
    expect(byName.get("filesystem")!.scope).toBe("user");
  });

  it("stdio 缺 command / http 缺 url 各出诊断，http 恒带「未实现」诊断", async () => {
    writeJson(userMcpFile(), {
      mcpServers: {
        broken: { args: ["x"] }, // stdio 缺 command
        remote: { type: "http" }, // http 缺 url
      },
    });
    const { servers } = await resolveServers("ws", HOME);
    const broken = servers.find((s) => s.config.name === "broken")!;
    const remote = servers.find((s) => s.config.name === "remote")!;
    expect(broken.diagnostics.some((d) => d.includes("缺少 command"))).toBe(true);
    expect(remote.diagnostics.some((d) => d.includes("缺少 url"))).toBe(true);
    expect(remote.diagnostics.some((d) => d.includes("http") && d.includes("未实现"))).toBe(true);
  });

  it("坏 JSON 折成一条 error，不抛异常", async () => {
    fs.mkdirSync(path.dirname(userMcpFile()), { recursive: true });
    fs.writeFileSync(userMcpFile(), "{ not json");
    const { servers, errors } = await resolveServers("ws", HOME);
    expect(servers).toEqual([]);
    expect(errors.some((e) => e.includes("JSON 解析失败"))).toBe(true);
  });

  it("文件不存在不是错误", async () => {
    const { servers, errors } = await resolveServers("ws", HOME);
    expect(servers).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("toDescriptor 脱敏", () => {
  it("只带 env / header 键名，绝不带值", async () => {
    writeJson(userMcpFile(), {
      mcpServers: {
        s: { command: "node", env: { TOKEN: "super-secret" }, args: [] },
      },
    });
    const listed = await resolveServers("ws", HOME);
    const server = await findServer("ws", listed.servers[0]!.id, HOME);
    const d = toDescriptor(server!, false);
    expect(d.envKeys).toEqual(["TOKEN"]);
    // 序列化整份 descriptor，明文密钥一个字都不能出现
    expect(JSON.stringify(d)).not.toContain("super-secret");
    expect(d.running).toBe(false);
    expect(d.runPermissionResource).toContain("mcp-run:");
  });
});

describe("saveServer / removeServer 先读再合并", () => {
  const stdio = (name: string, command: string): McpServerInput => ({
    name,
    transport: "stdio",
    command,
    args: [],
    env: {},
    headers: {},
    oauth: false,
  });

  it("save 写入并可被 resolve 读回；保留同文件里其它服务器与未知顶层键", async () => {
    writeJson(userMcpFile(), {
      $schema: "https://example/schema.json", // 未知顶层键：不能被抹掉
      mcpServers: { keep: { command: "keep-cmd" } },
    });

    await saveServer("ws", "user", stdio("added", "added-cmd"), HOME);

    const doc = JSON.parse(fs.readFileSync(userMcpFile(), "utf8")) as Record<string, unknown>;
    expect(doc.$schema).toBe("https://example/schema.json");
    const names = Object.keys((doc.mcpServers ?? {}) as Record<string, unknown>).sort();
    expect(names).toEqual(["added", "keep"]);
  });

  it("save 同名 = 覆盖（upsert）", async () => {
    await saveServer("ws", "user", stdio("s", "v1"), HOME);
    await saveServer("ws", "user", stdio("s", "v2"), HOME);
    const { servers } = await resolveServers("ws", HOME);
    const s = servers.filter((x) => x.config.name === "s");
    expect(s.length).toBe(1);
    expect(s[0]!.config.command).toBe("v2");
  });

  it("save 空 env 值被剪掉（编辑框清空一个变量）", async () => {
    const cfg = stdio("s", "c");
    cfg.env = { KEEP: "1", DROP: "" };
    await saveServer("ws", "user", cfg, HOME);
    const { servers } = await resolveServers("ws", HOME);
    expect(Object.keys(servers[0]!.config.env)).toEqual(["KEEP"]);
  });

  it("remove 删掉一台、留下其它；删不存在的幂等成功", async () => {
    writeJson(userMcpFile(), {
      mcpServers: { a: { command: "ca" }, b: { command: "cb" } },
    });
    await removeServer("ws", "user", "a", HOME);
    let { servers } = await resolveServers("ws", HOME);
    expect(servers.map((s) => s.config.name).sort()).toEqual(["b"]);

    await removeServer("ws", "user", "does-not-exist", HOME); // 不抛
    ({ servers } = await resolveServers("ws", HOME));
    expect(servers.map((s) => s.config.name)).toEqual(["b"]);
  });

  it("并发 save/save 按文件串行，不丢任一更新", async () => {
    await Promise.all([
      saveServer("ws", "user", stdio("a", "ca"), HOME),
      saveServer("ws", "user", stdio("b", "cb"), HOME),
    ]);
    const { servers } = await resolveServers("ws", HOME);
    expect(servers.map((server) => server.config.name).sort()).toEqual(["a", "b"]);
  });

  it("并发 save/remove 保持调用顺序，最终不会把已删条目写回来", async () => {
    await saveServer("ws", "user", stdio("a", "v1"), HOME);
    await Promise.all([
      saveServer("ws", "user", stdio("b", "v1"), HOME),
      removeServer("ws", "user", "a", HOME),
    ]);
    const { servers } = await resolveServers("ws", HOME);
    expect(servers.map((server) => server.config.name)).toEqual(["b"]);
  });
});

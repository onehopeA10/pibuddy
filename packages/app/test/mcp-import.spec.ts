import { describe, expect, it } from "vitest";
import { parseMcpImport } from "../src/lib/mcp-import.js";

describe("parseMcpImport", () => {
  it("认 mcpServers 包里的 stdio", () => {
    const raw = JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "pkg"] },
      },
    });
    const out = parseMcpImport(raw);
    expect(out.servers).toEqual([
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        env: {},
        oauth: false,
      },
    ]);
    expect(out.skipped).toEqual([]);
  });

  it("远程只解析出来，留给面板跳过写入", () => {
    const out = parseMcpImport(JSON.stringify({ web: { url: "https://mcp.example.com" } }));
    expect(out.servers[0]?.transport).toBe("http");
  });

  it("坏 JSON 老实说", () => {
    expect(parseMcpImport("not-json").skipped[0]).toContain("不是合法 JSON");
  });
});

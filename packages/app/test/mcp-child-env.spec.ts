import { describe, expect, it } from "vitest";

import { buildMcpChildEnv } from "../src/main/mcp/mcp-client.js";

describe("MCP 子进程环境白名单（SEC-002）", () => {
  it("不展开完整 process.env，只继承白名单键", () => {
    const env = buildMcpChildEnv(
      {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-secret",
        NODE_OPTIONS: "--require ./evil.js",
        HOME: "/home/me",
      },
      {}
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBe("");
  });

  it("用户 overlay 可补业务变量，但挡下 NODE_OPTIONS / ELECTRON_ / PIBUDDY_", () => {
    const env = buildMcpChildEnv(
      { PATH: "/bin" },
      {
        API_TOKEN: "ok",
        NODE_OPTIONS: "--inspect=0.0.0.0:9229",
        ELECTRON_RUN_AS_NODE: "1",
        PIBUDDY_SECRET: "nope",
      }
    );
    expect(env.API_TOKEN).toBe("ok");
    expect(env.NODE_OPTIONS).toBe("");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PIBUDDY_SECRET).toBeUndefined();
  });
});

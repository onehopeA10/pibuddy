import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppSettings } from "@pibuddy/contract";
import {
  encodeSessionDirSegment,
  resolveSessionDir,
} from "../src/main/sessions/session-dir.js";

/**
 * SES-001 的唯一验收手段。
 *
 * 目录名编码的缺陷（少一步「剥离前导分隔符」）在 Windows 上完全不可见 ——
 * `D:\x`、`C:\Users\yehh` 两种算法结果一致，只有 POSIX 路径才暴露差异。
 * 所以这里**直接喂已归一化的字符串**，绝不经过平台相关的 path.resolve，
 * 否则在 Windows 开发机上这条断言永远测不出该缺陷。
 */
describe("encodeSessionDirSegment 与 pi 逐字一致", () => {
  it("POSIX 绝对路径不产生三连字符", () => {
    expect(encodeSessionDirSegment("/home/u")).toBe("--home-u--");
    expect(encodeSessionDirSegment("/home/u").includes("---")).toBe(false);
  });

  it("Windows 盘符路径", () => {
    expect(encodeSessionDirSegment("D:\\x")).toBe("--D--x--");
  });

  it("含冒号与多级目录的 Windows 路径", () => {
    expect(encodeSessionDirSegment("C:\\Users\\yehh")).toBe("--C--Users-yehh--");
  });

  it("反斜杠开头的 UNC 风格路径同样只剥一层", () => {
    expect(encodeSessionDirSegment("\\srv\\data")).toBe("--srv-data--");
  });
});

const BASE_SETTINGS: AppSettings = { piRuntimeMode: "bundled" };

describe("resolveSessionDir 四级优先链", () => {
  const saved = {
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };

  afterEach(() => {
    if (saved.sessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = saved.sessionDir;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  });

  it("1) settings.sessionDir 优先级最高", () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = "/env/session";
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    expect(
      resolveSessionDir("/work", { ...BASE_SETTINGS, sessionDir: "/from/settings" })
    ).toBe("/from/settings");
  });

  it("2) 其次是 PI_CODING_AGENT_SESSION_DIR", () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = "/env/session";
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    expect(resolveSessionDir("/work", BASE_SETTINGS)).toBe("/env/session");
  });

  it("3) 再次是 PI_CODING_AGENT_DIR/sessions/<编码后的 cwd>", () => {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    const dir = resolveSessionDir("/work", BASE_SETTINGS);
    expect(dir.startsWith(path.join("/env/agent", "sessions"))).toBe(true);
    expect(path.basename(dir)).toBe(encodeSessionDirSegment(path.resolve("/work")));
  });

  it("4) 兜底是 ~/.pi/agent/sessions/<编码后的 cwd>", () => {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    const dir = resolveSessionDir("/work", BASE_SETTINGS);
    expect(dir).toBe(
      path.join(
        os.homedir(),
        ".pi",
        "agent",
        "sessions",
        encodeSessionDirSegment(path.resolve("/work"))
      )
    );
  });
});

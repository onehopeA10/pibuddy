import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertLaunchablePiSessionFile,
  firstPiSessionHeader,
  INVALID_PI_SESSION_USER_MESSAGE,
  isBrokenPiSessionFile,
  isInvalidPiSessionError,
} from "./pi-session-header.js";

describe("pi 会话文件头", () => {
  it("认第一行 session + id", () => {
    const text = `${JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "D:\\\\w" })}\n`;
    expect(firstPiSessionHeader(text)?.id).toBe("abc");
    expect(isBrokenPiSessionFile(text.length, text)).toBe(false);
  });

  it("空文件不算坏（pi 会自己写头）", () => {
    expect(isBrokenPiSessionFile(0, "")).toBe(false);
  });

  it("只有 loop-state / custom 的文件与 pi 一样判损坏", () => {
    const text = `${JSON.stringify({
      type: "custom",
      customType: "loop-state",
      data: { loops: [] },
    })}\n`;
    expect(firstPiSessionHeader(text)).toBeNull();
    expect(isBrokenPiSessionFile(text.length, text)).toBe(true);
  });

  it("跳过空行和坏 JSON 后再看第一条", () => {
    const text = `\nnot-json\n${JSON.stringify({ type: "session", id: "ok" })}\n`;
    expect(firstPiSessionHeader(text)?.id).toBe("ok");
  });

  it("认 pi 原文错误句", () => {
    expect(
      isInvalidPiSessionError(
        new Error("Session file is not a valid pi session: C:\\\\x\\\\a.jsonl")
      )
    ).toBe(true);
    expect(isInvalidPiSessionError(new Error("客户端已停止"))).toBe(false);
  });

  it("spawn 前拦截只有 loop-state 的文件", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pibuddy-sess-head-"));
    const file = path.join(dir, "broken.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "custom", customType: "loop-state", data: { loops: [] } })}\n`,
      "utf8"
    );
    await expect(assertLaunchablePiSessionFile(file)).rejects.toThrow(INVALID_PI_SESSION_USER_MESSAGE);
    await rm(dir, { recursive: true, force: true });
  });
});

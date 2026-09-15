/**
 * 内核级 extension「按模型追加工具使用提示」的单测。
 *
 * 直接 import resources/kernel-extensions/model-tool-hints.ts（vitest 会转译，
 * 其中对 pi 的 import 是 type-only，运行期被擦除）；主进程侧的参数拼装用纯函数
 * buildKernelExtensionArgs 验，electron 的 app 不在这里出场。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import installHints, {
  GROK_TOOL_HINT,
  HINT_MARKER,
  hintedSystemPrompt,
  isGrokModel,
} from "../resources/kernel-extensions/model-tool-hints";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));

const { buildKernelExtensionArgs, KERNEL_EXTENSION_FILES } = await import(
  "../src/main/pi/kernel-extensions"
);

describe("model-tool-hints · 模型判定", () => {
  it("grok 系按 id 或 provider 识别，大小写不敏感", () => {
    expect(isGrokModel({ id: "grok-4.6", provider: "xai" })).toBe(true);
    expect(isGrokModel({ id: "GROK-3-mini", provider: "openrouter" })).toBe(true);
    expect(isGrokModel({ id: "some-relay-model", provider: "x-ai" })).toBe(true);
  });

  it("其它模型与空模型都不命中", () => {
    expect(isGrokModel({ id: "claude-sonnet-4", provider: "anthropic" })).toBe(false);
    expect(isGrokModel({ id: "gpt-5", provider: "openai" })).toBe(false);
    expect(isGrokModel(undefined)).toBe(false);
    expect(isGrokModel({})).toBe(false);
  });
});

describe("model-tool-hints · 提示词追加", () => {
  const grok = { id: "grok-4.6", provider: "xai" };

  it("grok 时在原提示词后追加，且带防重入标记", () => {
    const out = hintedSystemPrompt("BASE", grok);
    expect(out).toBe(`BASE\n\n${GROK_TOOL_HINT}`);
    expect(out).toContain(HINT_MARKER);
    expect(out).toContain("search_tool_bm25");
    expect(out).toContain("mcp({ search })");
  });

  it("已含标记时不重复追加", () => {
    expect(hintedSystemPrompt(`BASE\n\n${GROK_TOOL_HINT}`, grok)).toBeUndefined();
  });

  it("非 grok 时原样不动", () => {
    expect(hintedSystemPrompt("BASE", { id: "claude-opus-4", provider: "anthropic" })).toBeUndefined();
    expect(hintedSystemPrompt("BASE", undefined)).toBeUndefined();
  });

  it("extension 入口只挂 before_agent_start，handler 按 ctx.model 决定返回", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const fakePi = {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      },
    };
    installHints(fakePi as never);
    expect([...handlers.keys()]).toEqual(["before_agent_start"]);

    const handler = handlers.get("before_agent_start")!;
    const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "SYS" };
    expect(handler(event, { model: grok })).toEqual({ systemPrompt: `SYS\n\n${GROK_TOOL_HINT}` });
    expect(handler(event, { model: { id: "claude-opus-4", provider: "anthropic" } })).toBeUndefined();
    expect(handler(event, { model: undefined })).toBeUndefined();
  });
});

describe("kernel-extensions · 启动参数拼装", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-kext-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("仓库里出厂清单的每个文件都真实存在", () => {
    const root = path.resolve(__dirname, "../resources/kernel-extensions");
    for (const file of KERNEL_EXTENSION_FILES) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it("存在的文件生成成对的 --extension <绝对路径>", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "a.ts"), "export default () => {}");
    fs.writeFileSync(path.join(root, "b.ts"), "export default () => {}");
    expect(buildKernelExtensionArgs(root, ["a.ts", "b.ts"])).toEqual([
      "--extension",
      path.join(root, "a.ts"),
      "--extension",
      path.join(root, "b.ts"),
    ]);
  });

  it("缺失的文件跳过并记一条 warn，不把不存在的路径传给 pi", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "a.ts"), "export default () => {}");
    const warn = vi.fn();
    expect(buildKernelExtensionArgs(root, ["missing.ts", "a.ts"], { warn })).toEqual([
      "--extension",
      path.join(root, "a.ts"),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("pi_kernel_extension_missing", {
      path: path.join(root, "missing.ts"),
    });
  });
});

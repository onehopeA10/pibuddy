/**
 * 打开历史会话时**不覆盖**会话记录的模型，也**不询问是否切换**。
 *
 * 两层断言：
 *   1. **行为层** —— start(sessionId) 之后 `pi.setModel` 调用次数为 0；
 *   2. **结构层** —— 源码里那个 else 块（恢复历史会话）内 `setModel` 命中数
 *      为 0、且不再写 `modelMismatchPrompt`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "./app";

const SESSION_MODEL = { id: "session-model", provider: "anthropic", input: ["text"] };

let setModelSpy: ReturnType<typeof vi.fn>;
let setThinkingSpy: ReturnType<typeof vi.fn>;
let startSpy: ReturnType<typeof vi.fn>;

function installBridge(): void {
  setModelSpy = vi.fn(async () => ({ success: true }));
  setThinkingSpy = vi.fn(async () => ({ success: true }));
  startSpy = vi.fn(async () => ({
    state: { model: SESSION_MODEL, thinkingLevel: "low", sessionId: "sess-1" },
    models: [SESSION_MODEL],
    messages: [],
  }));

  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      pi: {
        runtime: { start: startSpy },
        setModel: setModelSpy,
        setThinkingLevel: setThinkingSpy,
        getState: vi.fn(async () => ({
          success: true,
          data: { model: SESSION_MODEL, thinkingLevel: "low", sessionId: "sess-1" },
        })),
        getSessionStats: vi.fn(async () => ({ success: false })),
        getAvailableThinkingLevels: vi.fn(async () => ({
          success: true,
          data: { levels: ["off", "low", "high"] },
        })),
      },
      settings: { set: vi.fn(async () => ({})), get: vi.fn(async () => ({})) },
      sessions: {
        query: vi.fn(async () => []),
        saveDraft: vi.fn(async () => true),
        getDraft: vi.fn(async () => null),
      },
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  installBridge();
});

describe("恢复历史会话：沿用会话模型，不询问", () => {
  it("会话模型与全局默认不同时，不调 setModel，也不置切换提示", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.settings = {
      ...store.settings,
      provider: "openai",
      modelId: "global-default-model",
      thinkingLevel: "high",
    };

    await store.start("sess-1");

    expect(setModelSpy).toHaveBeenCalledTimes(0);
    expect(setThinkingSpy).toHaveBeenCalledTimes(0);
    expect("modelMismatchPrompt" in store).toBe(false);
  });

  it("workspace 默认与会话不同时同样不询问、不覆盖", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.settings = {
      ...store.settings,
      provider: "openai",
      modelId: "global-default-model",
      workspaceDefaults: { "ws-1": { provider: "groq", modelId: "workspace-model" } },
    };

    await store.start("sess-1");

    expect(setModelSpy).toHaveBeenCalledTimes(0);
    expect("modelMismatchPrompt" in store).toBe(false);
  });
});

describe("新会话仍然套用全局默认（不能顺手把这条也改掉）", () => {
  it("start() 不带 sessionId 时照常发 setModel", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.settings = { ...store.settings, provider: "openai", modelId: "global-default-model" };

    await store.start();

    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(setModelSpy).toHaveBeenCalledWith("openai", "global-default-model");
  });
});

describe("[结构层] 恢复历史会话的 else 块里没有 setModel / 询问", () => {
  it("按行号区间统计：setModel 与 modelMismatchPrompt 命中都为 0", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "app.ts"), "utf8");
    const lines = source.split(/\r?\n/);

    const ifLine = lines.findIndex((l) => l.includes("if (sessionId === undefined)"));
    expect(ifLine).toBeGreaterThan(-1);

    const elseLine = lines.findIndex((l, i) => i > ifLine && /^\s*\}\s*else\s*\{\s*$/.test(l));
    expect(elseLine).toBeGreaterThan(ifLine);

    let depth = 1;
    let endLine = -1;
    for (let i = elseLine + 1; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0) {
        endLine = i;
        break;
      }
    }
    expect(endLine).toBeGreaterThan(elseLine);

    const block = lines.slice(elseLine, endLine + 1).join("\n");
    expect(block).toMatch(/沿用会话文件里的模型/);
    expect(block.match(/setModel\s*\(/g) ?? []).toHaveLength(0);
    expect(block.match(/modelMismatchPrompt/g) ?? []).toHaveLength(0);
  });
});

describe("[签名锁定] send 的签名被五个任务共同依赖", () => {
  it("app.ts 里恰有一处 `export async function send(opts: SendOptions = {}): Promise<boolean>`", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "app.ts"), "utf8");
    const hits =
      source.match(
        /export async function send\(opts: SendOptions = \{\}\): Promise<boolean>/g
      ) ?? [];
    expect(hits).toHaveLength(1);
  });
});

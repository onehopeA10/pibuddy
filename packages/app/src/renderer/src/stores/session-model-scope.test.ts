/**
 * 打开历史会话时**不静默覆盖**会话记录的模型（PROV-101）。
 *
 * 这条是「三大门禁全绿、功能已死」的典型形态：把 `setModel` 留在恢复历史
 * 会话的分支里，typecheck / 单测 / 构建一律通过，用户看到的只是「我三个月
 * 前那条对话，风格怎么变了」。
 *
 * 两层断言：
 *   1. **行为层** —— start(sessionId) 之后 `pi.setModel` 调用次数为 0，
 *      且 `modelMismatchPrompt` 非空；
 *   2. **结构层** —— 源码里那个 else 块（恢复历史会话）内 `setModel` 命中数
 *      为 0、`modelMismatchPrompt` 命中数 >= 1。行为断言可能被一个「恰好没
 *      走到」的分支蒙混过去，结构断言不会。
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

describe("恢复历史会话：一次 setModel 都不发", () => {
  it("会话模型与全局默认不同时，只置提示，不调 setModel", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    // 全局默认是另一个模型 —— 收敛前这里会静默把会话切过去
    store.settings = {
      ...store.settings,
      provider: "openai",
      modelId: "global-default-model",
      thinkingLevel: "high",
    };

    await store.start("sess-1");

    expect(setModelSpy).toHaveBeenCalledTimes(0);
    // thinking 同样不许被默认值覆盖（会话文件里记的是 low）
    expect(setThinkingSpy).toHaveBeenCalledTimes(0);

    expect(store.modelMismatchPrompt).toEqual({
      sessionModelId: "session-model",
      sessionProvider: "anthropic",
      targetModelId: "global-default-model",
      targetProvider: "openai",
    });
  });

  it("workspace 层默认优先于全局默认，作为「切换」目标", async () => {
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
    expect(store.modelMismatchPrompt?.targetModelId).toBe("workspace-model");
    expect(store.modelMismatchPrompt?.targetProvider).toBe("groq");
  });

  it("会话模型与默认相同时不提示（不弹一个无意义的问题）", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.settings = {
      ...store.settings,
      provider: "anthropic",
      modelId: "session-model",
    };
    await store.start("sess-1");
    expect(store.modelMismatchPrompt).toBeNull();
    expect(setModelSpy).toHaveBeenCalledTimes(0);
  });

  it("没有任何默认值时不提示", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    await store.start("sess-1");
    expect(store.modelMismatchPrompt).toBeNull();
    expect(setModelSpy).toHaveBeenCalledTimes(0);
  });
});

describe("两个动作都由用户点", () => {
  it("「保持原来的」只关提示，不发 RPC", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.settings = { ...store.settings, provider: "openai", modelId: "global-default-model" };
    await store.start("sess-1");
    expect(store.modelMismatchPrompt).not.toBeNull();

    store.keepSessionModel();

    expect(store.modelMismatchPrompt).toBeNull();
    expect(setModelSpy).toHaveBeenCalledTimes(0);
  });

  it("「切换到默认」才发 set_model，且不改写全局设置", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.settings = { ...store.settings, provider: "openai", modelId: "global-default-model" };
    await store.start("sess-1");

    await store.switchToPromptedModel();

    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(setModelSpy).toHaveBeenCalledWith("openai", "global-default-model");
    // persist=false：用户是在为「这条会话」做选择，不是在改全局默认
    expect(
      (window as unknown as { piBuddy: { settings: { set: ReturnType<typeof vi.fn> } } }).piBuddy
        .settings.set
    ).toHaveBeenCalledTimes(0);
    expect(store.modelMismatchPrompt).toBeNull();
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

describe("[结构层] 恢复历史会话的 else 块里没有 setModel", () => {
  it("按行号区间统计：setModel 命中 0 次，modelMismatchPrompt 命中 >= 1 次", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "app.ts"), "utf8");
    const lines = source.split(/\r?\n/);

    // 定位 start() 里那条 `if (sessionId === undefined) {` 的配对 else 块
    const ifLine = lines.findIndex((l) => l.includes("if (sessionId === undefined)"));
    expect(ifLine).toBeGreaterThan(-1);

    const elseLine = lines.findIndex((l, i) => i > ifLine && /^\s*\}\s*else\s*\{\s*$/.test(l));
    expect(elseLine).toBeGreaterThan(ifLine);

    // `} else {` 这一行已经把 else 块开出来了（depth 从 1 起算），
    // 从下一行开始按大括号配平找块尾。把这一行也算进循环的话，
    // 它自己的 `}` 与 `{` 相互抵消，depth 会在紧接着的任意一行归零。
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
    // 块必须有实质内容（不是一对空括号）—— 否则「里面没有 setModel」
    // 这条断言是平凡成立的
    expect(endLine - elseLine).toBeGreaterThan(5);

    const block = lines.slice(elseLine, endLine + 1).join("\n");
    const setModelHits = block.match(/setModel\s*\(/g) ?? [];
    const promptHits = block.match(/modelMismatchPrompt/g) ?? [];

    expect(setModelHits).toHaveLength(0);
    expect(promptHits.length).toBeGreaterThanOrEqual(1);
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

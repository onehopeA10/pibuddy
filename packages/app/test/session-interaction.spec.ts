import { setActivePinia, createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSessionScopedReset,
  resetSessionScopedState,
  useAppStore,
} from "../src/renderer/src/stores/app.js";

/**
 * SES-002：会话交互一致性。
 *
 * 三个被实测出来的缺陷各有一组用例：
 *   1. extension 否决（success:true + data.cancelled:true）时界面显示假空白
 *   2. 发送失败时 send 正常 resolve，导致 InputBar 照常清空草稿
 *   3. 恢复历史会话时用全局设置无条件覆盖会话原有的 model / thinkingLevel
 */

type CommandHandler = (cmd: { type: string; [k: string]: unknown }) => unknown;

let commandHandler: CommandHandler;
let commandLog: string[];
let sessionsQuery: ReturnType<typeof vi.fn>;
let startResult: unknown;

function installWindow(): void {
  commandLog = [];
  sessionsQuery = vi.fn(async () => []);
  // TASK-007 之后 window.piBuddy.pi 上只有 15 个产品动作窄方法，通用的
  // command(...) 已被删除。这里把每个窄方法映射回它对应的 rpc 命令 type，
  // 既保留了原有断言（commandLog 记的仍是 rpc 命令名），也让这份 mock 与
  // 真实 preload 的接口面一一对应 —— 少一个方法，测试就会立刻炸。
  const dispatch = async (cmd: { type: string; [k: string]: unknown }): Promise<unknown> => {
    commandLog.push(cmd.type);
    return commandHandler(cmd as never);
  };
  (globalThis as Record<string, unknown>).window = {
    piBuddy: {
      pi: {
        prompt: vi.fn((payload: Record<string, unknown>) =>
          dispatch({ type: "prompt", ...payload })
        ),
        steer: vi.fn((payload: Record<string, unknown>) =>
          dispatch({ type: "steer", ...payload })
        ),
        followUp: vi.fn((payload: Record<string, unknown>) =>
          dispatch({ type: "follow_up", ...payload })
        ),
        abort: vi.fn(() => dispatch({ type: "abort" })),
        newSession: vi.fn(() => dispatch({ type: "new_session" })),
        switchSession: vi.fn((sessionId: string) =>
          dispatch({ type: "switch_session", sessionId })
        ),
        setModel: vi.fn((provider: string, modelId: string) =>
          dispatch({ type: "set_model", provider, modelId })
        ),
        setThinkingLevel: vi.fn((level: string) =>
          dispatch({ type: "set_thinking_level", level })
        ),
        getState: vi.fn(() => dispatch({ type: "get_state" })),
        getMessages: vi.fn(() => dispatch({ type: "get_messages" })),
        getSessionStats: vi.fn(() => dispatch({ type: "get_session_stats" })),
        getAvailableModels: vi.fn(() => dispatch({ type: "get_available_models" })),
        getAvailableThinkingLevels: vi.fn(() =>
          dispatch({ type: "get_available_thinking_levels" })
        ),
        compact: vi.fn((customInstructions?: string) =>
          dispatch({ type: "compact", customInstructions })
        ),
        setSessionName: vi.fn((name: string) => dispatch({ type: "set_session_name", name })),
        // TASK-009 之后 runtime / events / extensionUi 是 pi 的子命名空间
        runtime: {
          start: vi.fn(async () => startResult),
          stop: vi.fn(async () => undefined),
        },
        events: {
          onEvent: () => () => undefined,
          onUiRequest: () => () => undefined,
          onExit: () => () => undefined,
        },
        extensionUi: { respond: vi.fn(async () => undefined) },
      },
      dialog: {
        currentWorkspace: vi.fn(async () => ({ workspaceId: "ws-1", displayPath: "/w" })),
        chooseFolder: vi.fn(async () => ({ workspaceId: "ws-1", displayPath: "/w" })),
        chooseFiles: vi.fn(async () => []),
      },
      sessions: { query: sessionsQuery },
      settings: {
        get: vi.fn(async () => ({ piRuntimeMode: "bundled" })),
        set: vi.fn(async (patch: Record<string, unknown>) => ({
          piRuntimeMode: "bundled",
          ...patch,
        })),
      },
    },
  };
}

/** 默认：一切成功、cancelled 为 false。 */
function defaultHandler(cmd: { type: string }): unknown {
  switch (cmd.type) {
    case "new_session":
    case "switch_session":
      return { success: true, data: { cancelled: false } };
    case "get_messages":
      return { success: true, data: { messages: [] } };
    case "get_state":
      return { success: true, data: makeState() };
    case "get_session_stats":
      return { success: true, data: { userMessages: 0, assistantMessages: 0 } };
    case "get_available_thinking_levels":
      return { success: true, data: { levels: ["off"] } };
    default:
      return { success: true };
  }
}

function makeState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: { provider: "openai", id: "gpt-5.6", name: "gpt-5.6" },
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    sessionId: "s-1",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
    ...over,
  };
}

function envelope(payload: unknown, sequence: number): Record<string, unknown> {
  return {
    protocolVersion: 1,
    workspaceId: "/w",
    sessionId: "s-1",
    runtimeId: "rt-1",
    generation: 0,
    sequence,
    occurredAt: Date.now(),
    payload,
  };
}

/** 往 store 里塞满会话级状态，用于验证清空覆盖面。 */
function fillSessionScopedState(store: ReturnType<typeof useAppStore>): void {
  store.items.push({ key: 1, message: { role: "user", content: "hi" } as never });
  store.toolRuns["t1"] = {
    toolCallId: "t1",
    toolName: "bash",
    args: {},
    status: "running",
    output: "",
    images: [],
  };
  store.queue = { steering: ["a"], followUp: ["b"] };
  store.statusTexts["ext:mode"] = "AUTO";
  store.uiRequests = [{ id: "u1", method: "select" } as never];
  store.liveAssistant = { role: "assistant", content: [] } as never;
}

beforeEach(() => {
  setActivePinia(createPinia());
  startResult = { state: makeState(), models: [], messages: [] };
  commandHandler = defaultHandler;
  installWindow();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("extension veto（data.cancelled）", () => {
  it("new_session 被否决时消息不变且给出警告", async () => {
    const store = useAppStore();
    const warn = vi.fn();
    store.setNotifier({ info: vi.fn(), success: vi.fn(), warning: warn, error: vi.fn() });
    fillSessionScopedState(store);
    commandHandler = (cmd) =>
      cmd.type === "new_session"
        ? { success: true, data: { cancelled: true } }
        : defaultHandler(cmd);

    await store.newTask();

    expect(store.items.length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // 否决后不该继续拉状态
    expect(commandLog).toEqual(["new_session"]);
  });

  it("switch_session 被否决时消息不变且给出警告", async () => {
    const store = useAppStore();
    const warn = vi.fn();
    store.setNotifier({ info: vi.fn(), success: vi.fn(), warning: warn, error: vi.fn() });
    fillSessionScopedState(store);
    commandHandler = (cmd) =>
      cmd.type === "switch_session"
        ? { success: true, data: { cancelled: true } }
        : defaultHandler(cmd);

    await store.openSession({ sessionId: "a" });

    expect(store.items.length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(commandLog).toEqual(["switch_session"]);
  });

  it("cancelled 为 false 时正常切换并清空旧会话状态", async () => {
    const store = useAppStore();
    store.setNotifier({
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    });
    fillSessionScopedState(store);

    await store.openSession({ sessionId: "a" });

    expect(store.items.length).toBe(0);
    expect(Object.keys(store.toolRuns).length).toBe(0);
    expect(store.uiRequests.length).toBe(0);
  });
});

describe("switch 成功但消息加载失败", () => {
  it("设置 sessionLoadError，且不保留旧会话的消息", async () => {
    const store = useAppStore();
    store.setNotifier({
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    });
    fillSessionScopedState(store);
    commandHandler = (cmd) =>
      cmd.type === "get_messages"
        ? { success: false, error: "读取会话文件失败" }
        : defaultHandler(cmd);

    await store.openSession({ sessionId: "a" });

    expect(store.sessionLoadError).toBe("读取会话文件失败");
    expect(store.items.length).toBe(0);
  });

  it("重试成功后错误清空并载入消息", async () => {
    const store = useAppStore();
    store.sessionLoadError = "读取会话文件失败";
    await store.reloadMessages();
    expect(store.sessionLoadError).toBe("");
  });
});

describe("send() 返回值即「草稿能否清空」", () => {
  it("RPC 失败时返回 false 并提示", async () => {
    const store = useAppStore();
    const error = vi.fn();
    store.setNotifier({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error });
    commandHandler = () => ({ success: false, error: "运行时不可用" });

    const ok = await store.send({ text: "帮我整理表格" });

    expect(ok).toBe(false);
    expect(error).toHaveBeenCalledWith("运行时不可用");
    expect(store.items.length).toBe(0);
  });

  it("RPC 抛异常时也返回 false，而不是把异常泄到调用方", async () => {
    const store = useAppStore();
    const error = vi.fn();
    store.setNotifier({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error });
    commandHandler = () => {
      throw new Error("stdin 写队列已满");
    };

    await expect(store.send({ text: "你好" })).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("RPC 接受时返回 true 并乐观插入用户消息", async () => {
    const store = useAppStore();
    store.setNotifier({
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    });
    const ok = await store.send({ text: "你好" });
    expect(ok).toBe(true);
    expect(store.items.length).toBe(1);
  });

  it("没有内容时返回 false（不清空、也不发送）", async () => {
    const store = useAppStore();
    expect(await store.send({ text: "   " })).toBe(false);
    expect(commandLog).toEqual([]);
  });
});

describe("resetSessionScopedState（CT-25）", () => {
  it("按注册表驱动：注册的回调恰被调用一次", () => {
    useAppStore();
    const spy = vi.fn();
    registerSessionScopedReset(spy);
    resetSessionScopedState();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("覆盖 items / toolRuns / queue / statusTexts / uiRequests / liveAssistant 六项", () => {
    const store = useAppStore();
    fillSessionScopedState(store);

    resetSessionScopedState();

    expect(store.items.length).toBe(0);
    expect(Object.keys(store.toolRuns).length).toBe(0);
    expect(store.queue.steering.length + store.queue.followUp.length).toBe(0);
    expect(Object.keys(store.statusTexts).length).toBe(0);
    expect(store.uiRequests.length).toBe(0);
    expect(store.liveAssistant).toBe(null);
  });
});

describe("会话列表刷新防抖", () => {
  it("连续 10 次 agent_settled 只触发一次目录枚举", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.settings = { piRuntimeMode: "bundled" };
    // 会话枚举现在按不透明 workspaceId 走，不再读 settings 里的绝对路径
    store.workspaceId = "ws-1";

    for (let i = 0; i < 10; i++) {
      store.handleEventEnvelope(envelope({ type: "agent_settled" }, i));
    }
    expect(sessionsQuery).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sessionsQuery).toHaveBeenCalledTimes(1);
  });
});

describe("start()：只有新会话才套用全局设置", () => {
  it("恢复历史会话时不改模型、不发 set_thinking_level", async () => {
    const store = useAppStore();
    store.setNotifier({
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    });
    store.workspaceId = "ws-1";
    store.settings = {
      piRuntimeMode: "bundled",
      provider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: "max",
    };
    // 会话自身记录的是另一个模型与思考等级
    startResult = {
      state: makeState({
        model: { provider: "openai", id: "gpt-5.6", name: "gpt-5.6" },
        thinkingLevel: "off",
      }),
      models: [],
      messages: [],
    };

    await store.start("s-old");

    expect(commandLog).not.toContain("set_model");
    expect(commandLog).not.toContain("set_thinking_level");
  });

  it("新建会话时套用全局设置的模型与思考等级", async () => {
    const store = useAppStore();
    store.setNotifier({
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    });
    store.workspaceId = "ws-1";
    store.settings = {
      piRuntimeMode: "bundled",
      provider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: "max",
    };

    await store.start();

    expect(commandLog).toContain("set_model");
    expect(commandLog).toContain("set_thinking_level");
  });

  it("思考等级已经一致时不重复下发 set_thinking_level", async () => {
    const store = useAppStore();
    store.setNotifier({
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    });
    store.workspaceId = "ws-1";
    store.settings = {
      piRuntimeMode: "bundled",
      thinkingLevel: "off",
    };
    startResult = { state: makeState({ thinkingLevel: "off" }), models: [], messages: [] };

    await store.start();

    expect(commandLog).not.toContain("set_thinking_level");
  });
});

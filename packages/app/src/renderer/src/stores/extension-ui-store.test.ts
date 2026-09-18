/**
 * extensionUi store 的单测（EXT-101 渲染侧 + CT-25 迁出后的清空语义）。
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UI_EXPIRED_HINT } from "@pibuddy/contract";
import type { AgentEvent, ExtensionUiRequest } from "@pibuddy/pi-sdk";
import { resetSessionScopedState } from "./session-scope.js";
import {
  TITLE_MAX_CHARS,
  TITLE_PREFIX,
  __resetUnknownEvents,
  useExtensionUiStore,
} from "./extensionUi.js";
import { useAppStore } from "./app.js";

function req(method: string, extra: Record<string, unknown> = {}): ExtensionUiRequest {
  return {
    type: "extension_ui_request",
    id: `id-${Math.random().toString(36).slice(2)}`,
    method,
    ...extra,
  } as ExtensionUiRequest;
}

/**
 * agent_settled 会触发 refreshStats / refreshState / 会话列表刷新，
 * 那三条都走 window.piBuddy。不打这个桩的话，它们会变成 unhandled
 * rejection —— 而这一组测试的另一半断言恰恰是「不产生未处理 rejection」。
 */
const noopRpc = vi.fn(async () => ({ success: false }));

beforeEach(() => {
  setActivePinia(createPinia());
  __resetUnknownEvents();
  (globalThis as Record<string, unknown>).window = {
    piBuddy: {
      pi: {
        getState: noopRpc,
        getSessionStats: noopRpc,
        extensionUi: { respond: vi.fn(async () => ({ ok: true })) },
      },
      sessions: { query: vi.fn(async () => []) },
    },
  };
});

describe("[widget 生命周期] set → unset", () => {
  it("widgetLines 为 undefined 时该 widgetKey 从 Map 中删除", () => {
    const s = useExtensionUiStore();
    s.setWidget("w1", ["line-1", "line-2"], "aboveEditor");
    expect(s.widgets.size).toBe(1);
    s.setWidget("w1", undefined);
    expect(s.widgets.size).toBe(0);
  });

  it("同 key 覆盖而不是叠加；placement 决定它落在输入框上方还是下方", () => {
    const s = useExtensionUiStore();
    s.setWidget("w", ["a"], "aboveEditor");
    s.setWidget("w", ["b", "c"], "belowEditor");
    expect(s.widgets.size).toBe(1);
    expect(s.aboveEditorWidgets).toHaveLength(0);
    expect(s.belowEditorWidgets).toEqual([
      { key: "w", lines: ["b", "c"], placement: "belowEditor" },
    ]);
  });

  it("超长 widget 由 CSS 的 30vh + overflow 承担滚动，store 不截断内容", () => {
    const s = useExtensionUiStore();
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    s.setWidget("big", lines);
    // 内容不丢：滚动是渲染层的事，在这里截断会让扩展写的东西对不上
    expect(s.widgets.get("big")?.lines).toHaveLength(500);
  });
});

describe("[title 截断与前缀]", () => {
  it("200 字符输入：渲染文本长度 <= 70 且以 'PiBuddy · ' 开头", () => {
    const s = useExtensionUiStore();
    s.setTitle("标".repeat(200));
    expect(s.displayTitle.startsWith(TITLE_PREFIX)).toBe(true);
    expect(s.displayTitle.length).toBeLessThanOrEqual(70);
    expect(s.displayTitle.length).toBe(TITLE_PREFIX.length + TITLE_MAX_CHARS);
  });

  it("空标题不显示前缀（否则顶栏会永远挂着一个孤零零的 'PiBuddy · '）", () => {
    const s = useExtensionUiStore();
    expect(s.displayTitle).toBe("");
    s.setTitle("x");
    expect(s.displayTitle).toBe(`${TITLE_PREFIX}x`);
    s.setTitle(undefined);
    expect(s.displayTitle).toBe("");
  });
});

describe("[CT-25] 迁出后清空语义不丢", () => {
  it("2 条 uiRequests + 1 条 statusTexts，调 app store 的 reset 后均归 0", () => {
    useAppStore();
    const s = useExtensionUiStore();
    s.enqueue(req("select", { options: ["a"] }));
    s.enqueue(req("confirm"));
    s.setStatus("mode", "AUTO");
    s.setWidget("w", ["x"]);
    s.setTitle("t");
    expect(s.uiRequests).toHaveLength(2);
    expect(Object.keys(s.statusTexts)).toHaveLength(1);

    resetSessionScopedState();

    expect(s.uiRequests).toHaveLength(0);
    expect(Object.keys(s.statusTexts)).toHaveLength(0);
    expect(s.widgets.size).toBe(0);
    expect(s.displayTitle).toBe("");
  });
});

describe("失效提示", () => {
  it("expire 命中时给出固定文案，未命中时不打扰用户", () => {
    const s = useExtensionUiStore();
    const r = req("input");
    s.enqueue(r);
    expect(s.expire({ id: "not-there", reason: "timeout" })).toBe(false);
    expect(s.lastExpiredHint).toBe("");
    expect(s.expire({ id: r.id, reason: "timeout" })).toBe(true);
    expect(s.lastExpiredHint).toBe(UI_EXPIRED_HINT);
    expect(s.uiRequests).toHaveLength(0);
  });

  it("expireAll 清空整队并返回被清掉的条数", () => {
    const s = useExtensionUiStore();
    s.enqueue(req("select"));
    s.enqueue(req("editor"));
    expect(s.expireAll({ generation: 1, reason: "generation" })).toBe(2);
    expect(s.uiRequests).toHaveLength(0);
  });
});

describe("窗口 reload 的快照恢复", () => {
  it("adoptSnapshot 覆盖式恢复四样状态", () => {
    const s = useExtensionUiStore();
    s.setStatus("stale", "旧的");
    s.setWidget("stale", ["旧的"]);
    s.adoptSnapshot({
      requests: [req("confirm")],
      statuses: [{ key: "k", text: "新的" }],
      widgets: [{ key: "w", lines: ["新的"], placement: "belowEditor" }],
      title: "恢复的标题",
    });
    expect(s.uiRequests).toHaveLength(1);
    expect(s.statusTexts["ext:stale"]).toBeUndefined();
    expect(s.statusTexts["ext:k"]).toBe("新的");
    expect([...s.widgets.keys()]).toEqual(["w"]);
    expect(s.displayTitle).toBe(`${TITLE_PREFIX}恢复的标题`);
  });
});

describe("[静默丢弃根除] 未知事件计数", () => {
  it("投入一个未知 type 后计数 +1，且该 type 出现在 debug 快照里", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.handleEvent({ type: "brand_new_upstream_event" } as unknown as AgentEvent);
    expect(s.unknownEventSnapshot()["brand_new_upstream_event"]).toBe(1);
    app.handleEvent({ type: "brand_new_upstream_event" } as unknown as AgentEvent);
    expect(s.unknownEventSnapshot()["brand_new_upstream_event"]).toBe(2);
  });

  it("pi-sdk 归一化成的 { type:'unknown', raw } 也按 raw.type 计数", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.handleEvent({ type: "unknown", raw: { type: "weird_event" } } as AgentEvent);
    expect(s.unknownEventSnapshot()["weird_event"]).toBe(1);
  });

  it("已显式处理的事件不进计数器", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.handleEvent({ type: "turn_start" } as AgentEvent);
    app.handleEvent({ type: "turn_end" } as unknown as AgentEvent);
    app.handleEvent({ type: "agent_settled" } as AgentEvent);
    expect(s.unknownEventSnapshot()).toEqual({});
  });
});

describe("summarization_retry_* 三个事件（改造前连类型都没有）", () => {
  it("scheduled → statusTexts.summarization 非空且含「重试」", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.handleEvent({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "boom",
    } as AgentEvent);
    expect(s.statusTexts.summarization).toBeTruthy();
    expect(s.statusTexts.summarization).toContain("重试");
  });

  it("attempt_start 之后的 scheduled(1/3) 文案含 (1/3)", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.handleEvent({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "e",
    } as AgentEvent);
    expect(s.statusTexts.summarization).toContain("(1/3)");
  });

  it("attempt_start 写入正在重试的对象", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.handleEvent({
      type: "summarization_retry_attempt_start",
      source: "branchSummary",
    } as AgentEvent);
    expect(s.statusTexts.summarization).toContain("分支摘要");
  });

  it("finished → statusTexts.summarization === undefined", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.handleEvent({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "e",
    } as AgentEvent);
    app.handleEvent({ type: "summarization_retry_finished" } as AgentEvent);
    expect(s.statusTexts.summarization).toBeUndefined();
  });
});

describe("九个 method 的渲染侧路由", () => {
  it("setWidget / setTitle 不再落进 default 分支", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    app.setNotifier({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() });

    app.handleUiRequest(req("setWidget", { widgetKey: "w", widgetLines: ["hello"] }));
    app.handleUiRequest(req("setTitle", { title: "proj" }));
    app.handleUiRequest(req("set_editor_text", { text: "typed" }));
    app.handleUiRequest(req("setStatus", { statusKey: "m", statusText: "YOLO" }));

    expect(s.widgets.size).toBe(1);
    expect(s.displayTitle).toBe(`${TITLE_PREFIX}proj`);
    expect(app.editorText).toBe("typed");
    expect(s.extStatus).toBe("YOLO");
  });

  it("approval-mode 不上顶栏，避免和输入框下拉重复一份英文", () => {
    const s = useExtensionUiStore();
    s.setStatus("approval-mode", "YOLO");
    s.setStatus("other", "AUTO");
    expect(s.statusTexts["ext:approval-mode"]).toBe("YOLO");
    expect(s.extStatus).toBe("AUTO");
  });

  it("四个 dialog 方法都进队列，notify 不进队列", () => {
    const app = useAppStore();
    const s = useExtensionUiStore();
    const notify = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    app.setNotifier(notify);

    for (const m of ["select", "confirm", "input", "editor"]) app.handleUiRequest(req(m));
    app.handleUiRequest(req("notify", { message: "hi", notifyType: "warning" }));

    expect(s.uiRequests).toHaveLength(4);
    expect(notify.warning).toHaveBeenCalledWith("hi");
  });
});

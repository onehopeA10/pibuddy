// @vitest-environment happy-dom
/**
 * 滚动跟随与未读分界线（TASK-010 c[3] / c[17]）。
 *
 * activityTick 是流式期间聊天区跟随滚动的**唯一**驱动。换成分段数据源时
 * 丢掉这个订阅不会报任何错，表现是助手一边输出一边把内容顶到视口外面去。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";
import type { AgentMessage } from "@sdk";
import ChatView from "./ChatView.vue";
import { useAppStore } from "../stores/app";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

function mountView() {
  return mount(ChatView, {
    global: { stubs: { NButton: true, Welcome: true, MessageItem: true } },
    attachTo: document.body,
  });
}

/** 给滚动容器装上可控的几何量（happy-dom 里这些默认都是 0）。 */
function stubGeometry(el: HTMLElement, geo: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, "scrollHeight", { value: geo.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: geo.clientHeight, configurable: true });
}

describe("ChatView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as unknown as { piBuddy: unknown }).piBuddy = {
      pi: {},
      sessions: { readHistoryBefore: vi.fn(), query: vi.fn(async () => []) },
    };
  });

  it("activityTick 递增且 stickToBottom 为真时，scrollTop 被设为 scrollHeight", async () => {
    const store = useAppStore();
    store.items = [{ key: 1, message: userMessage("你好") }];
    const wrapper = mountView();
    const el = wrapper.find(".chat-scroll").element as HTMLElement;
    stubGeometry(el, { scrollHeight: 5000, clientHeight: 600 });
    el.scrollTop = 0;

    store.activityTick++;
    await flushPromises();

    expect(el.scrollTop).toBe(5000);
  });

  it("stickToBottom 为假时不抢滚动", async () => {
    const store = useAppStore();
    store.items = [{ key: 1, message: userMessage("你好") }];
    const wrapper = mountView();
    const el = wrapper.find(".chat-scroll").element as HTMLElement;
    stubGeometry(el, { scrollHeight: 5000, clientHeight: 600 });
    el.scrollTop = 1000;
    // 用户往上翻 → 离开底部
    await wrapper.find(".chat-scroll").trigger("scroll");

    store.activityTick++;
    await flushPromises();

    expect(el.scrollTop).toBe(1000);
  });

  it("未读分界线：不在底部时插一条、只插一条，回到底部后消失", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.items = [{ key: 1, message: userMessage("你好") }];
    const wrapper = mountView();
    const el = wrapper.find(".chat-scroll").element as HTMLElement;
    stubGeometry(el, { scrollHeight: 5000, clientHeight: 600 });
    el.scrollTop = 1000;
    await wrapper.find(".chat-scroll").trigger("scroll");

    // (a) 到达一条新消息
    store.items = [...store.items, { key: 2, message: userMessage("新消息") }];
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("[data-unread-divider]")).toHaveLength(1);

    // (c) 再来三条：不重复插、也不移动
    store.items = [
      ...store.items,
      { key: 3, message: userMessage("三") },
      { key: 4, message: userMessage("四") },
      { key: 5, message: userMessage("五") },
    ];
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("[data-unread-divider]")).toHaveLength(1);

    // (b) 滚回底部并推进 1100ms
    el.scrollTop = 5000 - 600;
    await wrapper.find(".chat-scroll").trigger("scroll");
    vi.advanceTimersByTime(1100);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll("[data-unread-divider]")).toHaveLength(0);
    vi.useRealTimers();
  });
});

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

  /**
   * 抖动回归。
   *
   * showEarlier 会写回 scrollTop，而写 scrollTop 又触发 scroll 事件。少了
   * 重入闸，滚到顶部会并发跑起好几份 showEarlier，各自拿着自己那一刻的
   * prevHeight 去补偿，同一段高度差被重复加，视口来回弹 —— 界面上就是
   * 「一直在抖」。停在顶部时尤其明显：scrollTop < 40 恒成立，循环停不下来。
   */
  it("停在顶部连发 scroll：扩窗不重入，scrollTop 不被反复补偿", async () => {
    const store = useAppStore();
    // 200 条 > INITIAL_WINDOW(60) → hiddenCount > 0，每次扩窗都会真的多渲染
    store.items = Array.from({ length: 200 }, (_, i) => ({
      key: i + 1,
      message: userMessage(`第 ${i + 1} 条`),
    }));
    const readHistoryBefore = vi.fn(async () => ({
      entries: [],
      nextBeforeOffset: null,
      stale: false,
    }));
    (window as unknown as { piBuddy: { sessions: unknown } }).piBuddy.sessions = {
      readHistoryBefore,
      query: vi.fn(async () => []),
    };

    const wrapper = mountView();
    const el = wrapper.find(".chat-scroll").element as HTMLElement;
    // scrollHeight 跟随实际渲染条数增长，这样「扩窗 → 高度变大 → 补偿
    // scrollTop」这条真实链路才会在测试里发生。写死常量的话 grown 恒为 0，
    // 补偿写的是 +0，有没有重入闸都测不出来 —— 那种断言是恒真的。
    Object.defineProperty(el, "scrollHeight", {
      get: () => wrapper.findAll("message-item-stub").length * 100 + 600,
      configurable: true,
    });
    Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
    el.scrollTop = 10; // 顶部，< 40

    // **同步**连发 20 次，中间一次 await 都不能有。
    // 用 trigger() 逐个 await 会把调用串行化，每份 showEarlier 都跑完了下一次
    // 才开始 —— 并发根本不会发生，断言在有 bug 的代码上照样通过（恒真）。
    // 真实浏览器就是这样一帧内连发一串 scroll 的。
    for (let i = 0; i < 20; i++) {
      el.dispatchEvent(new Event("scroll"));
    }
    await flushPromises();
    await flushPromises();

    // 200 条全部铺完后窗口就该停住；旧代码无条件 +100，20 次并发会涨到 2000+
    expect(wrapper.findAll("message-item-stub").length).toBeLessThanOrEqual(200);
    // 每次扩窗只补偿一次高度差。旧代码里 20 份 showEarlier 各自拿着同一个
    // 陈旧的 prevHeight 重复补偿，scrollTop 会被推到远超实际内容高度的位置。
    const contentHeight = wrapper.findAll("message-item-stub").length * 100 + 600;
    expect(el.scrollTop).toBeLessThanOrEqual(contentHeight);
  });
});

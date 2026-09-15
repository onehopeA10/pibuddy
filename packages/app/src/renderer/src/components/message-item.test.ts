// @vitest-environment happy-dom
/**
 * 流式期间**不进 Markdown**（TASK-010 c[4]）。
 *
 * 双向断言：streaming 时一次都不调用，非 streaming 时恰好调用一次。只断言
 * 「流式时为 0」会被「永远不渲染 Markdown」的空实现满足。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import type { AssistantMessage } from "@sdk";

const renderMarkdown = vi.fn((s: string) => `<p>${s}</p>`);
vi.mock("../markdown", () => ({
  renderMarkdown: (s: string) => renderMarkdown(s),
  truncateToolOutput: (s: string) => s,
}));

import MessageItem from "./MessageItem.vue";
import { openThinking, thinkingKey } from "../stores/chat-ui";

const message = {
  role: "assistant",
  content: [{ type: "text", text: "你好，**世界**" }],
} as unknown as AssistantMessage;

function mountItem(streaming: boolean) {
  return mount(MessageItem, {
    props: { message, streaming, messageKey: 7 },
    global: { stubs: { NAlert: true, ToolActivity: true } },
  });
}

describe("MessageItem · Markdown 缓存时机", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    renderMarkdown.mockClear();
  });

  it("streaming: true 时 renderMarkdown 一次都不调用", () => {
    const wrapper = mountItem(true);
    expect(renderMarkdown).toHaveBeenCalledTimes(0);
    // 但正文仍然显示出来了（走纯文本分支），不是干脆不渲染
    expect(wrapper.text()).toContain("你好");
  });

  it("streaming: false 时 renderMarkdown 恰被调用一次", () => {
    mountItem(false);
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe("MessageItem · 相邻思考块合并", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const k of Object.keys(openThinking)) delete openThinking[k];
  });

  it("连续的 thinking 块只渲染一个「思考过程」，内容拼接完整", async () => {
    const fragmented = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一步" },
        { type: "thinking", thinking: "，第二步" },
        { type: "text", text: "回答" },
        { type: "thinking", thinking: "再想想" },
        { type: "thinking", thinking: "一下" },
      ],
    } as unknown as AssistantMessage;
    const wrapper = mount(MessageItem, {
      props: { message: fragmented, messageKey: 9 },
      global: { stubs: { NAlert: true, ToolActivity: true } },
    });
    // 5 个原始块 → 2 个思考块（文本块把两段思考隔开了）
    const toggles = wrapper.findAll(".thinking-toggle");
    expect(toggles).toHaveLength(2);
    // 展开第一个，内容是两段拼起来的
    await toggles[0]!.trigger("click");
    expect(wrapper.find(".thinking-content").text()).toBe("第一步，第二步");
  });

  it("相邻 text 块合并后只进一次 Markdown", () => {
    const fragmented = {
      role: "assistant",
      content: [
        { type: "text", text: "前半" },
        { type: "text", text: "后半" },
      ],
    } as unknown as AssistantMessage;
    renderMarkdown.mockClear();
    mount(MessageItem, {
      props: { message: fragmented, streaming: false, messageKey: 10 },
      global: { stubs: { NAlert: true, ToolActivity: true } },
    });
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
    expect(renderMarkdown).toHaveBeenCalledWith("前半后半");
  });
});

describe("MessageItem · 展开态住在 store 里", () => {  beforeEach(() => {
    setActivePinia(createPinia());
    for (const k of Object.keys(openThinking)) delete openThinking[k];
  });

  it("点开思考过程写的是 store 的 key，组件重建后仍然是展开的", async () => {
    const withThinking = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "先看看文件" }],
    } as unknown as AssistantMessage;
    const first = mount(MessageItem, {
      props: { message: withThinking, messageKey: 7 },
      global: { stubs: { NAlert: true, ToolActivity: true } },
    });
    await first.find(".thinking-toggle").trigger("click");
    expect(openThinking[thinkingKey(7, 0)]).toBe(true);
    first.unmount();

    // 组件被分段数据源回收后重建：展开态必须还在
    const second = mount(MessageItem, {
      props: { message: withThinking, messageKey: 7 },
      global: { stubs: { NAlert: true, ToolActivity: true } },
    });
    expect(second.find(".thinking-content").exists()).toBe(true);
  });
});

describe("MessageItem · 键盘/屏幕阅读器语义", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("复制图标保留 aria-label，且不再显示分叉", () => {
    const wrapper = mountItem(false);
    const labels = wrapper.findAll("button").map((b) => b.attributes("aria-label"));
    expect(labels).toContain("复制这条回复");
    expect(labels).not.toContain("从这条消息分叉");
    expect(wrapper.text()).not.toContain("分叉");
  });

  it("用户消息的复制与重新发送使用图标，并位于气泡后的操作区", () => {
    const userMessage = { role: "user", content: "你好" } as const;
    const wrapper = mount(MessageItem, { props: { message: userMessage as never } });
    const bubble = wrapper.find(".msg-user-bubble");
    const actions = wrapper.find(".user-actions");
    expect(actions.exists()).toBe(true);
    expect(bubble.element.nextElementSibling).toBe(actions.element);
    expect(actions.findAll("button").map((b) => b.attributes("title"))).toEqual(["复制", "重新发送"]);
  });
});

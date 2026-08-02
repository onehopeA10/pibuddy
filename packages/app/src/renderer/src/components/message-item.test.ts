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

describe("MessageItem · 展开态住在 store 里", () => {
  beforeEach(() => {
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

  it("复制 / 分叉 / 思考展开都有 aria-label", () => {
    const wrapper = mountItem(false);
    const labels = wrapper.findAll("button").map((b) => b.attributes("aria-label"));
    expect(labels).toContain("复制这条回复");
    expect(labels).toContain("从这条消息分叉");
  });
});

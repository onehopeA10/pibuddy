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

  it("连续的 thinking 块合并成一段，被中间文本隔开的才是两段", async () => {
    const fragmented = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一步" },
        { type: "thinking", thinking: "，第二步" },
        { type: "text", text: "中间叙述" },
        { type: "thinking", thinking: "再想想" },
        { type: "thinking", thinking: "一下" },
        { type: "text", text: "回答" },
      ],
    } as unknown as AssistantMessage;
    const wrapper = mount(MessageItem, {
      props: { message: fragmented, messageKey: 9 },
      global: { stubs: { NAlert: true, ToolActivity: true, NSpin: true } },
    });
    // 完成态默认收起：只有一个过程组头
    expect(wrapper.findAll(".process-toggle")).toHaveLength(1);
    await wrapper.find(".process-toggle").trigger("click");
    // 5 个 thinking 原始块 → 2 段（中间的文本块把它们隔开）
    const thoughts = wrapper.findAll(".thinking-content");
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]!.text()).toBe("第一步，第二步");
    expect(thoughts[1]!.text()).toBe("再想想一下");
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

  it("点开过程组写的是 store 的 key，组件重建后仍然是展开的", async () => {
    const withThinking = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "先看看文件" }],
    } as unknown as AssistantMessage;
    const first = mount(MessageItem, {
      props: { message: withThinking, messageKey: 7 },
      global: { stubs: { NAlert: true, ToolActivity: true, NSpin: true } },
    });
    expect(first.find(".thinking-content").exists()).toBe(false);
    await first.find(".process-toggle").trigger("click");
    expect(openThinking[thinkingKey(7, "process")]).toBe(true);
    first.unmount();

    // 组件被分段数据源回收后重建：展开态必须还在
    const second = mount(MessageItem, {
      props: { message: withThinking, messageKey: 7 },
      global: { stubs: { NAlert: true, ToolActivity: true, NSpin: true } },
    });
    expect(second.find(".thinking-content").exists()).toBe(true);
  });
});

describe("MessageItem · 过程组：思考 + 中间叙述 + 工具调用全在一个折叠里", () => {
  const stubs = { NAlert: true, ToolActivity: true, NSpin: true };
  const turn = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先查 Node 版本约束" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "command -v maestro" } },
      { type: "text", text: "仓库没有写死「禁止 24」。我再核对 CI。" },
      { type: "toolCall", id: "t2", name: "read", arguments: { path: "package.json" } },
      { type: "text", text: "结论：Node 24 可用。" },
    ],
  } as unknown as AssistantMessage;

  beforeEach(() => {
    setActivePinia(createPinia());
    for (const k of Object.keys(openThinking)) delete openThinking[k];
    renderMarkdown.mockClear();
  });

  it("完成态：默认收起，外面只剩最终回答；展开后中间叙述与工具卡片都在组里", async () => {
    const wrapper = mount(MessageItem, {
      props: { message: turn, messageKey: 11, startedAt: 1_000, endedAt: 153_000 },
      global: { stubs },
    });
    // 头部：已完成 + 时长
    const toggle = wrapper.find(".process-toggle");
    expect(toggle.text()).toContain("已完成");
    expect(toggle.text()).toContain("2m32s");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    // 收起时：中间叙述与工具卡片不可见，只有回答进了 Markdown
    expect(wrapper.find(".process-body").exists()).toBe(false);
    expect(wrapper.findAllComponents({ name: "ToolActivity" })).toHaveLength(0);
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
    expect(renderMarkdown).toHaveBeenCalledWith("结论：Node 24 可用。");

    await toggle.trigger("click");
    const body = wrapper.find(".process-body");
    expect(body.exists()).toBe(true);
    expect(body.find(".thinking-content").text()).toBe("先查 Node 版本约束");
    expect(body.findAllComponents({ name: "ToolActivity" })).toHaveLength(2);
    expect(body.find(".process-text").exists()).toBe(true);
    expect(renderMarkdown).toHaveBeenCalledWith("仓库没有写死「禁止 24」。我再核对 CI。");
    // 回答仍在组外
    expect(wrapper.findAll(".msg-body > .markdown")).toHaveLength(1);
    // 不卸载的话，下个用例的 beforeEach 清 openThinking 会让它异步重渲染一次，
    // 把 renderMarkdown 的调用计数搅进别的用例。
    wrapper.unmount();
  });

  it("进行中已开始作答：头部是「生成中」而不是「已完成」，过程组默认收起", () => {
    const wrapper = mount(MessageItem, {
      props: { message: turn, messageKey: 14, streaming: true, startedAt: Date.now() - 5_000 },
      global: { stubs },
    });
    const toggle = wrapper.find(".process-toggle");
    expect(toggle.text()).toContain("生成中");
    expect(toggle.text()).not.toContain("已完成");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".process-body").exists()).toBe(false);
    wrapper.unmount();
  });

  it("进行中且尚无回答：头部显示「思考中」并默认展开", () => {
    const inProgress = {
      role: "assistant",
      content: turn.content.slice(0, 4),
    } as unknown as AssistantMessage;
    const wrapper = mount(MessageItem, {
      props: { message: inProgress, messageKey: 12, streaming: true, startedAt: Date.now() - 5_000 },
      global: { stubs },
    });
    const toggle = wrapper.find(".process-toggle");
    expect(toggle.text()).toContain("思考中");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".process-body").exists()).toBe(true);
    // 流式期间组内文本也不进 Markdown
    expect(renderMarkdown).toHaveBeenCalledTimes(0);
    wrapper.unmount();
  });

  it("没有 thinking / 工具调用的纯文本回复不出过程组", () => {
    const wrapper = mountItem(false);
    expect(wrapper.find(".process-group").exists()).toBe(false);
  });

  it("复制只复制最终回答", () => {
    const wrapper = mount(MessageItem, {
      props: { message: turn, messageKey: 13 },
      global: { stubs },
    });
    const vm = wrapper.vm as unknown as { assistantText: string };
    expect(vm.assistantText).toBe("结论：Node 24 可用。");
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

// @vitest-environment happy-dom
/**
 * 「查不到这次运行」与「正在运行」必须分开（TASK-010 c[7]）。
 *
 * 合成一个判据的后果：历史会话里没有 tool_execution 事件、toolRuns 恒为空，
 * 于是每张工具卡片都永久转圈，界面看上去像卡死了。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import type { ToolCallContent } from "@sdk";
import ToolActivity from "./ToolActivity.vue";
import { useAppStore } from "../stores/app";
import { expandedTools } from "../stores/chat-ui";

const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } } as
  unknown as ToolCallContent;

/** 转圈标记：NSpin 被 stub 后渲染成一个带 spin 的自定义标签。 */
function hasSpinner(wrapper: { html: () => string }): boolean {
  return /spin/i.test(wrapper.html());
}

function mountChip() {
  return mount(ToolActivity, {
    props: { call },
    global: { stubs: { NSpin: true } },
  });
}

describe("ToolActivity", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const k of Object.keys(expandedTools)) delete expandedTools[k];
    // 不能整个替换 window：happy-dom 的 Event 构造器都挂在上面
    (window as unknown as { piBuddy: unknown }).piBuddy = { pi: {}, sessions: {} };
  });

  it("toolRuns 里查不到 run 时显示「工具记录已不可用」而不是转圈", () => {
    const wrapper = mountChip();
    expect(wrapper.text()).toContain("工具记录已不可用");
    expect(hasSpinner(wrapper)).toBe(false);
  });

  it("run 存在且 running 时才转圈", () => {
    const store = useAppStore();
    store.toolRuns["call-1"] = {
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
      status: "running",
      output: "",
      images: [],
    };
    const wrapper = mountChip();
    expect(wrapper.text()).not.toContain("工具记录已不可用");
    expect(hasSpinner(wrapper)).toBe(true);
  });

  it("展开态写进 store，且 aria-expanded 同步", async () => {
    const wrapper = mountChip();
    const chip = wrapper.find(".tool-chip");
    expect(chip.attributes("aria-expanded")).toBe("false");
    await chip.trigger("click");
    expect(expandedTools["call-1"]).toBe(true);
    expect(wrapper.find(".tool-chip").attributes("aria-expanded")).toBe("true");
  });
});

/**
 * TopBar 对 setTitle 的渲染断言。
 *
 * 扩展可以上报任意长度的标题（rpc.md:1300 只说「设置窗口/标签标题」，
 * 没有任何长度约束）。不截断的表现不是报错，而是模型选择框被挤出可视区 ——
 * 三大门禁全绿，只有肉眼能发现。
 */
// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TopBar from "./TopBar.vue";
import { TITLE_PREFIX, useExtensionUiStore } from "../stores/extensionUi";

beforeEach(() => {
  setActivePinia(createPinia());
  // 往 happy-dom 的 window 上挂桩，**不能整体替换** —— 替换掉之后
  // naive-ui 内部的 window.addEventListener 就没了，报的错和标题毫无关系。
  (window as unknown as Record<string, unknown>).piBuddy = {
    pi: {},
    settings: {},
    sessions: {},
  };
});

describe("TopBar 的扩展标题", () => {
  it("200 字符输入：渲染文本长度 <= 70 且以 'PiBuddy · ' 开头", () => {
    const s = useExtensionUiStore();
    s.setTitle("题".repeat(200));

    const w = mount(TopBar, { global: { stubs: { NSelect: true, NTooltip: true } } });
    const el = w.find(".ext-title");
    expect(el.exists()).toBe(true);
    const text = el.text();
    expect(text.startsWith(TITLE_PREFIX)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(70);
  });

  it("没有扩展上报标题时那一栏根本不渲染", () => {
    const w = mount(TopBar, { global: { stubs: { NSelect: true, NTooltip: true } } });
    expect(w.find(".ext-title").exists()).toBe(false);
  });
});

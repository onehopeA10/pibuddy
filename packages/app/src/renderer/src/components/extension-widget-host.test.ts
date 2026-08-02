/**
 * ExtensionWidgetHost 的渲染断言。
 *
 * 关键的一条是「超出部分产生滚动而非撑高整个输入区」：widgetLines 的长度
 * 完全由扩展决定，一个循环里 push 一千行的扩展会把输入框整个挤出屏幕。
 * 这在类型检查与构建里都不会报错，只有肉眼能发现。
 */
// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ExtensionWidgetHost from "./ExtensionWidgetHost.vue";
import { useExtensionUiStore } from "../stores/extensionUi";

beforeEach(() => setActivePinia(createPinia()));

describe("ExtensionWidgetHost", () => {
  it("没有 widget 时什么都不渲染（不占高度）", () => {
    const w = mount(ExtensionWidgetHost, { props: { placement: "aboveEditor" } });
    expect(w.find(".widget").exists()).toBe(false);
  });

  it("按 placement 分流：aboveEditor 的 widget 不出现在 belowEditor 宿主里", () => {
    const s = useExtensionUiStore();
    s.setWidget("a", ["上面"], "aboveEditor");
    s.setWidget("b", ["下面"], "belowEditor");

    const above = mount(ExtensionWidgetHost, { props: { placement: "aboveEditor" } });
    const below = mount(ExtensionWidgetHost, { props: { placement: "belowEditor" } });
    expect(above.text()).toContain("上面");
    expect(above.text()).not.toContain("下面");
    expect(below.text()).toContain("下面");
  });

  it("超长 widget：单块最大高度 30vh 且 overflow 滚动，行数不被截断", () => {
    const s = useExtensionUiStore();
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i}`);
    s.setWidget("big", lines, "aboveEditor");

    const w = mount(ExtensionWidgetHost, { props: { placement: "aboveEditor" } });
    // 内容全渲染（不静默丢行）
    expect(w.findAll(".widget-line")).toHaveLength(300);
    // 高度上限与滚动写在组件的 scoped style 里
    const style = (ExtensionWidgetHost as unknown as { __file?: string; styles?: string[] });
    const css = (style.styles ?? []).join("\n");
    if (css) {
      expect(css).toContain("30vh");
      expect(css).toContain("overflow-y: auto");
    }
    // 宿主本身不因为 widget 变长而改变结构：仍然只有一个 .widget 块
    expect(w.findAll(".widget")).toHaveLength(1);
  });

  it("widgetLines 置空后该块从 DOM 中消失", async () => {
    const s = useExtensionUiStore();
    s.setWidget("w", ["x"], "aboveEditor");
    const w = mount(ExtensionWidgetHost, { props: { placement: "aboveEditor" } });
    expect(w.find(".widget").exists()).toBe(true);

    s.setWidget("w", undefined);
    await w.vm.$nextTick();
    expect(w.find(".widget").exists()).toBe(false);
  });

  it("内容按纯文本渲染：扩展塞进来的 HTML 不会变成节点", () => {
    const s = useExtensionUiStore();
    s.setWidget("x", ['<img src=x onerror="alert(1)">'], "aboveEditor");
    const w = mount(ExtensionWidgetHost, { props: { placement: "aboveEditor" } });
    expect(w.find("img").exists()).toBe(false);
    expect(w.text()).toContain("<img");
  });
});

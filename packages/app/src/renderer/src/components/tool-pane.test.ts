// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("naive-ui", () => ({
  NButton: { inheritAttrs: false, template: `<button v-bind="$attrs"><slot /></button>` },
}));

import ToolPane from "./ToolPane.vue";

describe("ToolPane", () => {
  it("点关闭会发出 close", async () => {
    const wrapper = mount(ToolPane, {
      slots: { default: "<div>面板内容</div>" },
    });
    expect(wrapper.text()).toContain("关闭");
    expect(wrapper.text()).toContain("面板内容");
    await wrapper.get('[aria-label="关闭"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});

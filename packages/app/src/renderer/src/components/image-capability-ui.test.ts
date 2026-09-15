// @vitest-environment happy-dom
/**
 * [UI-observable] 图片能力拦截在**界面上**的表现（PROV-101）。
 *
 * 全部以 DOM 属性取值判定，不以观感判定：
 *
 *   1. 附件区该图片条目 `aria-disabled === "true"`，说明文本 contains 当前模型 id；
 *   2. 发送按钮 `disabled === true`，其 `title` contains 同一模型 id；
 *   3. 存在文本为「切换到支持图片的模型」的按钮，点开后列表中**每一项**的
 *      `data-model-input` 都 contains "image"；
 *   4. 选中其一后：附件条目 `aria-disabled === "false"`、发送按钮 `disabled === false`；
 *   5. 模型支持图片时以上受阻标记全部消失。
 *
 * 第 3 条是这组断言里唯一能证伪「切换列表其实没过滤」的那一条 ——
 * 光断言「弹出了一个列表」说明不了任何问题。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import type { Model } from "@sdk";

vi.mock("naive-ui", () => ({
  NButton: {
    inheritAttrs: false,
    props: ["disabled"],
    template: `<button v-bind="$attrs" :disabled="disabled"><slot /></button>`,
  },
  NInput: {
    inheritAttrs: false,
    props: ["value"],
    emits: ["update:value"],
    template: `<textarea v-bind="$attrs" :value="value" />`,
  },
  NSpin: { template: `<span class="spin" />` },
  NSelect: { inheritAttrs: false, template: `<div class="n-select" v-bind="$attrs" />` },
  NTag: { inheritAttrs: false, template: `<span v-bind="$attrs"><slot /></span>` },
  NTooltip: { template: `<span><slot /><slot name="trigger" /></span>` },
  useMessage: () => ({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

import InputBar from "./InputBar.vue";
import { useAppStore } from "../stores/app";

const TEXT_ONLY: Partial<Model> = {
  id: "text-only-model",
  provider: "acme",
  input: ["text"],
};
const MULTIMODAL: Partial<Model> = {
  id: "multimodal-model",
  provider: "acme",
  input: ["text", "image"],
};

let setModelSpy: ReturnType<typeof vi.fn>;

function useModel(model: Partial<Model>): void {
  const store = useAppStore();
  store.started = true;
  store.agentState = { model, thinkingLevel: "off", isStreaming: false } as never;
  store.models = [TEXT_ONLY, MULTIMODAL, { id: "another-text", provider: "acme" }] as Model[];
}

/** 往组件内部的 images 里塞一张图（模拟粘贴 / 拖入）。 */
async function attachImage(wrapper: ReturnType<typeof mount>): Promise<void> {
  (wrapper.vm as unknown as { images: unknown[] }).images.push({
    type: "image",
    data: "AAAA",
    mimeType: "image/png",
    name: "screenshot.png",
  });
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  setModelSpy = vi.fn(async () => ({ success: true }));
  (window as unknown as { piBuddy: unknown }).piBuddy = {
    pi: {
      setModel: setModelSpy,
      getState: vi.fn(async () => ({ success: true, data: { model: MULTIMODAL } })),
      getAvailableThinkingLevels: vi.fn(async () => ({ success: true, data: { levels: ["off"] } })),
    },
    settings: { set: vi.fn(async () => ({})) },
    sessions: { saveDraft: vi.fn(async () => true), getDraft: vi.fn(async () => null) },
  };
});

describe("当前模型不支持图片时", () => {
  it("附件条目 aria-disabled='true'，说明文本含当前模型 id", async () => {
    useModel(TEXT_ONLY);
    const wrapper = mount(InputBar);
    await attachImage(wrapper);

    const chip = wrapper.find('[data-testid="image-attachment"]');
    expect(chip.exists()).toBe(true);
    expect(chip.attributes("aria-disabled")).toBe("true");
    expect(chip.attributes("title")).toContain("text-only-model");

    const hint = wrapper.find('[data-testid="image-blocked-text"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain("text-only-model");
  });

  it("发送按钮 disabled === true，其 title 含同一模型 id", async () => {
    useModel(TEXT_ONLY);
    const wrapper = mount(InputBar);
    await attachImage(wrapper);

    const send = wrapper.find('[data-testid="send-button"]');
    expect(send.exists()).toBe(true);
    expect((send.element as HTMLButtonElement).disabled).toBe(true);
    expect(send.attributes("title")).toContain("text-only-model");
  });

  it("有「切换到支持图片的模型」按钮，展开后每一项的 data-model-input 都含 image", async () => {
    useModel(TEXT_ONLY);
    const wrapper = mount(InputBar);
    await attachImage(wrapper);

    const switcher = wrapper.find('[data-testid="switch-image-model"]');
    expect(switcher.exists()).toBe(true);
    expect(switcher.text()).toContain("切换到支持图片的模型");

    await switcher.trigger("click");
    await nextTick();

    const items = wrapper.findAll('[data-testid="image-model-list"] [role="option"]');
    expect(items.length).toBeGreaterThan(0);
    // 逐项判定：任何一项漏了 image 都说明过滤是假的
    for (const item of items) {
      expect(item.attributes("data-model-input")).toContain("image");
    }
    // 只支持文本的那两个模型不该出现在列表里
    const ids = items.map((i) => i.attributes("data-model-id"));
    expect(ids).toContain("multimodal-model");
    expect(ids).not.toContain("text-only-model");
    expect(ids).not.toContain("another-text");
  });

  it("选中一个支持图片的模型后，附件恢复可用、发送键解禁", async () => {
    useModel(TEXT_ONLY);
    const wrapper = mount(InputBar);
    await attachImage(wrapper);

    await wrapper.find('[data-testid="switch-image-model"]').trigger("click");
    await nextTick();
    await wrapper.find('[data-model-id="multimodal-model"]').trigger("click");
    await nextTick();

    // 走的是真实的 store.setModel → pi.setModel
    expect(setModelSpy).toHaveBeenCalledWith("acme", "multimodal-model");

    // store 的模型由 refreshState 从 getState 拿回（stub 返回 MULTIMODAL）
    await nextTick();
    const chip = wrapper.find('[data-testid="image-attachment"]');
    expect(chip.attributes("aria-disabled")).toBe("false");
    const send = wrapper.find('[data-testid="send-button"]');
    expect((send.element as HTMLButtonElement).disabled).toBe(false);
    // 受阻说明整体消失
    expect(wrapper.find('[data-testid="image-blocked-hint"]').exists()).toBe(false);
  });
});

describe("当前模型支持图片时", () => {
  it("附件条目 aria-disabled='false'，发送键可用，没有受阻说明", async () => {
    useModel(MULTIMODAL);
    const wrapper = mount(InputBar);
    await attachImage(wrapper);

    expect(wrapper.find('[data-testid="image-attachment"]').attributes("aria-disabled")).toBe(
      "false"
    );
    const send = wrapper.find('[data-testid="send-button"]');
    expect((send.element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.find('[data-testid="image-blocked-hint"]').exists()).toBe(false);
  });
});

describe("纯文本消息不受影响", () => {
  it("没有图片时，即便模型只收文本，发送键也是可用的", async () => {
    useModel(TEXT_ONLY);
    const wrapper = mount(InputBar);
    await nextTick();
    const send = wrapper.find('[data-testid="send-button"]');
    expect((send.element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.find('[data-testid="image-blocked-hint"]').exists()).toBe(false);
  });
});

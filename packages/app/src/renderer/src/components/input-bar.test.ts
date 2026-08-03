// @vitest-environment happy-dom
/**
 * 发送模式分流按钮与草稿防抖（TASK-010 c[8] / c[16]）。
 *
 * 草稿不防抖的话，长输入就是「每按一个键一次 IPC + 一次 SQLite 写」——
 * UI 上没有任何征兆，只有主进程在闷头刷盘。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { isReactive } from "vue";

// naive-ui 的 useMessage 需要祖先 provider；这里整体换成最小替身，
// 顺带让 aria-label 直接落到真实的 <button> 上便于断言。
vi.mock("naive-ui", () => ({
  NButton: { inheritAttrs: false, template: `<button v-bind="$attrs"><slot /></button>` },
  NInput: {
    inheritAttrs: false,
    props: ["value"],
    emits: ["update:value"],
    template: `<textarea v-bind="$attrs" :value="value" />`,
  },
  NSpin: { template: `<span class="spin" />` },
  useMessage: () => ({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

import { nextTick } from "vue";
import InputBar from "./InputBar.vue";
import { useAppStore } from "../stores/app";

let saveDraft: ReturnType<typeof vi.fn>;

function ariaLabels(wrapper: ReturnType<typeof mount>): (string | undefined)[] {
  return wrapper.findAll("button").map((b) => b.attributes("aria-label"));
}

describe("InputBar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    saveDraft = vi.fn(async () => true);
    (window as unknown as { piBuddy: unknown }).piBuddy = {
      pi: {},
      sessions: { saveDraft, getDraft: vi.fn(async () => null) },
    };
  });

  it("助手输出中途，发送键旁同时给出「立即插话」与「下一轮处理」", () => {
    const store = useAppStore();
    store.started = true;
    store.streaming = true;
    const wrapper = mount(InputBar);
    const labels = ariaLabels(wrapper);
    expect(labels).toContain("立即插话");
    expect(labels).toContain("下一轮处理");
  });

  it("助手空闲时只有普通发送键", () => {
    const store = useAppStore();
    store.started = true;
    store.streaming = false;
    const wrapper = mount(InputBar);
    const labels = ariaLabels(wrapper);
    expect(labels).not.toContain("立即插话");
    expect(labels).not.toContain("下一轮处理");
  });

  it("10 次连续 keystroke 后推进 500ms，saveDraft 恰被调用 1 次", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    // 顺序不能反：started 落在 currentSessionId 对应的 runtimeScope 上，
    // 先写 started 再换 session 会让它落到旧 scope 上、输入框保持禁用，
    // 而 VTU 的 trigger() 对 disabled 元素直接不派发事件。
    store.currentSessionId = "sess-1";
    store.started = true;
    const wrapper = mount(InputBar);
    const input = wrapper.find("textarea");

    for (let i = 0; i < 10; i++) {
      store.editorText += "字";
      await input.trigger("keydown", { key: "a" });
      vi.advanceTimersByTime(20);
    }
    expect(saveDraft).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    // saveDraft(workspaceId, sessionId, draft)：会话 id 只在工作区内唯一
    expect(saveDraft.mock.calls[0][1]).toBe("sess-1");
    expect(saveDraft.mock.calls[0][2]).toMatchObject({ text: "字".repeat(10) });
    vi.useRealTimers();
  });

  it("交给 IPC 的草稿是纯数据，不含 Vue 响应式代理", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.currentSessionId = "sess-1";
    store.started = true;
    store.enqueueLocal("先攒着的一条", "followUp");
    mount(InputBar);
    store.editorText = "草稿正文";
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    const payload = saveDraft.mock.calls.at(-1)![2];
    // Electron 的 IPC 用结构化克隆，响应式代理会以
    // "An object could not be cloned." 失败 —— 而这个异常只在 await 处冒出来，
    // 界面上没有任何征兆，表现就是「草稿永远存不上」。
    expect(isReactive(payload)).toBe(false);
    expect(isReactive(payload.attachments)).toBe(false);
    expect(isReactive(payload.queue)).toBe(false);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload.queue.followUp).toEqual(["先攒着的一条"]);
    vi.useRealTimers();
  });

  /**
   * 图片与文件附件早先是 InputBar 的组件级 `ref([])`。组件不随会话重建 ——
   * 在 A 会话贴的图、拖进来的文件切到 B 之后原样留在输入框里，一按发送就
   * 发进了 B。这条用例的判据落在真实 DOM 上：附件条目要真的消失。
   */
  it("切走之后上一会话的图片与附件不留在输入框里，切回来又原样在", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-A";
    store.started = true;
    const wrapper = mount(InputBar);

    store.draftImages = [
      { type: "image", data: "AAAA", mimeType: "image/png", name: "截图.png" },
    ];
    store.draftAttachments = [
      { token: "tok-1", name: "报表.xlsx", size: 10, kind: "other" },
    ];
    await nextTick();
    expect(wrapper.findAll('[data-testid="image-attachment"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("报表.xlsx");

    store.currentSessionId = "sess-B";
    await nextTick();
    expect(wrapper.findAll('[data-testid="image-attachment"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain("报表.xlsx");

    // 按会话存放而不是一刀清空：回到 A 内容还在
    store.currentSessionId = "sess-A";
    await nextTick();
    expect(wrapper.findAll('[data-testid="image-attachment"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("报表.xlsx");
  });
});

// @vitest-environment happy-dom
/**
 * UpdateBanner 的渲染判据与取消按钮的能力位。
 *
 * 两件事必须双向断言：
 *  1. **十个状态遍历**。只有需要用户做决定（或正在直接反馈用户刚才那次点击）
 *     的状态才渲染内容，其余一律为空。checking / not-available 也弹横幅是纯
 *     UI 噪声，而这种噪声不会触发任何编译或运行时错误。
 *  2. **取消按钮**。cancelSupported=false 时 DOM 里不能有它；=true 时必须
 *     有，且点击真的调到取消动作。只断言「缺席」的话，"根本不实现取消按钮"
 *     也能通过。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { UPDATE_STATUSES, type UpdateState, type UpdateStatus } from "@contract";

import UpdateBanner from "./UpdateBanner.vue";
import { emptyUpdateState, useUpdateStore } from "../stores/update";

/** 横幅会渲染内容的状态集合。 */
const VISIBLE: UpdateStatus[] = ["available", "downloading", "downloaded", "error"];

function stateFor(status: UpdateStatus, over: Partial<UpdateState> = {}): UpdateState {
  return {
    ...emptyUpdateState(),
    status,
    stateSequence: 1,
    currentVersion: "1.0.0",
    candidateVersion: "2.0.0",
    totalBytes: 100_000_000,
    bytesTransferred: 42_000_000,
    percent: 42,
    bytesPerSecond: 1_500_000,
    releaseDate: "2026-08-01T00:00:00.000Z",
    releaseNotes: "修复了若干问题",
    errorCode: status === "error" ? "network" : null,
    retryable: status === "error",
    ...over,
  };
}

function mountWith(state: UpdateState) {
  const wrapper = mount(UpdateBanner);
  const store = useUpdateStore();
  store.apply(state);
  return { wrapper, store };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("十个状态的渲染判据", () => {
  it("只有 available / downloading / downloaded / error 渲染出内容", async () => {
    for (const status of UPDATE_STATUSES) {
      setActivePinia(createPinia());
      const { wrapper } = mountWith(stateFor(status));
      await wrapper.vm.$nextTick();
      const visible = wrapper.find(".update-banner").exists();
      expect(visible, `status=${status}`).toBe(VISIBLE.includes(status));
      wrapper.unmount();
    }
  });

  it("其余六态渲染结果为空", async () => {
    const silent = UPDATE_STATUSES.filter((s) => !VISIBLE.includes(s));
    expect(silent).toHaveLength(6);
    for (const status of silent) {
      setActivePinia(createPinia());
      const { wrapper } = mountWith(stateFor(status));
      await wrapper.vm.$nextTick();
      expect(wrapper.text().trim(), `status=${status}`).toBe("");
      wrapper.unmount();
    }
  });

  it("稍后的自动可用结果不占据页面，下载完成与错误仍可见", async () => {
    const { wrapper, store } = mountWith(
      stateFor("available", { checkSource: "startup", dismissedVersion: "2.0.0" })
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".update-banner").exists()).toBe(false);

    store.apply(stateFor("downloaded", { stateSequence: 2, dismissedVersion: "2.0.0" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("立即重启安装");

    store.apply(stateFor("error", { stateSequence: 3, dismissedVersion: "2.0.0" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("重试");
    wrapper.unmount();
  });

  it("available 显示版本、发布时间、体积与净化后的说明", async () => {
    const { wrapper } = mountWith(stateFor("available"));
    await wrapper.vm.$nextTick();
    const text = wrapper.text();
    expect(text).toContain("2.0.0");
    expect(text).toContain("发布于");
    expect(text).toContain("MB");
    expect(text).toContain("修复了若干问题");
  });

  it("downloading 显示百分比、已传输与速度", async () => {
    const { wrapper } = mountWith(stateFor("downloading"));
    await wrapper.vm.$nextTick();
    const text = wrapper.text();
    expect(text).toContain("42%");
    expect(text).toContain("/");
    expect(text).toContain("/s");
  });
});

describe("取消按钮的能力位（双向）", () => {
  it("(a) cancelSupported=false 时「取消下载」文本节点数为 0", async () => {
    const { wrapper } = mountWith(stateFor("downloading", { cancelSupported: false }));
    await wrapper.vm.$nextTick();
    const hits = wrapper.findAll("button").filter((b) => b.text() === "取消下载");
    expect(hits).toHaveLength(0);
  });

  it("(b) cancelSupported=true 时恰有 1 个，点击调用一次取消动作并回到 idle", async () => {
    const { wrapper, store } = mountWith(stateFor("downloading", { cancelSupported: true }));
    await wrapper.vm.$nextTick();

    const hits = wrapper.findAll("button").filter((b) => b.text() === "取消下载");
    expect(hits).toHaveLength(1);

    // 取消令牌本身住在主进程（release-integrity/singleflight 那边断言它的
    // cancel 只被调一次）；这里断言的是「点击真的走到那条路上」。
    const spy = vi.spyOn(store, "cancelDownload").mockImplementation(async () => {
      store.apply(stateFor("idle", { stateSequence: 2 }));
    });

    await hits[0].trigger("click");
    expect(spy).toHaveBeenCalledTimes(1);
    await wrapper.vm.$nextTick();
    expect(store.state.status).toBe("idle");
  });
});

describe("发布说明是纯文本", () => {
  it("组件源码里没有 v-html", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    for (const f of ["./UpdateBanner.vue", "./UpdateSettingsPanel.vue"]) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(src, f).not.toContain("v-html");
    }
  });

  it("带标签的说明被当成纯文本原样显示，不会变成真的 DOM 节点", async () => {
    const { wrapper } = mountWith(
      stateFor("available", { releaseNotes: "<b>加粗</b> 不该生效" })
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find("b").exists()).toBe(false);
    expect(wrapper.text()).toContain("<b>加粗</b>");
  });
});

describe("错误态", () => {
  it("可重试时给重试按钮，不可重试时不给", async () => {
    const retryable = mountWith(stateFor("error", { errorCode: "network", retryable: true }));
    await retryable.wrapper.vm.$nextTick();
    expect(retryable.wrapper.findAll("button").some((b) => b.text() === "重试")).toBe(true);
    retryable.wrapper.unmount();

    setActivePinia(createPinia());
    const fatal = mountWith(stateFor("error", { errorCode: "signature", retryable: false }));
    await fatal.wrapper.vm.$nextTick();
    expect(fatal.wrapper.findAll("button").some((b) => b.text() === "重试")).toBe(false);
    // 但错误文案必须在，不能是一片空白
    expect(fatal.wrapper.text().length).toBeGreaterThan(0);
  });
});

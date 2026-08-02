// @vitest-environment happy-dom
/**
 * 队列的只读语义必须落到 DOM（TASK-010 c[15]）。
 *
 * pi 的 queue_update 只给字符串数组、没有稳定 id，协议里也没有撤回命令 ——
 * 已提交的条目删不掉。给它配一个假的删除按钮，点了什么都不会发生，而助手
 * 照样会执行那条指令。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import QueuePanel from "./QueuePanel.vue";
import { useAppStore } from "../stores/app";

function labelsIn(wrapper: ReturnType<typeof mount>, section: string): (string | undefined)[] {
  const el = wrapper.find(`[data-queue-section="${section}"]`);
  return el.findAll("button").map((b) => b.attributes("aria-label"));
}

describe("QueuePanel", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as unknown as { piBuddy: unknown }).piBuddy = {
      pi: {},
      sessions: { saveDraft: vi.fn(async () => true) },
    };
  });

  it("已提交分区没有「删除」按钮，并标注不可撤回", () => {
    const store = useAppStore();
    store.queue = { steering: ["先跑测试"], followUp: ["顺便更新文档"] };
    const wrapper = mount(QueuePanel);
    const labels = labelsIn(wrapper, "committed");
    expect(labels).not.toContain("删除");
    expect(labels).not.toContain("编辑");
    expect(wrapper.find('[data-queue-section="committed"]').text()).toContain("不可撤回");
  });

  it("本地未提交分区同时有「编辑」与「删除」", () => {
    const store = useAppStore();
    store.enqueueLocal("等会儿再说", "followUp");
    const wrapper = mount(QueuePanel);
    const labels = labelsIn(wrapper, "local");
    expect(labels).toContain("编辑");
    expect(labels).toContain("删除");
  });

  it("删除真的把条目移出本地队列", async () => {
    const store = useAppStore();
    store.enqueueLocal("写错了", "steer");
    const wrapper = mount(QueuePanel);
    await wrapper.find('[data-queue-section="local"] button[aria-label="删除"]').trigger("click");
    expect(store.localQueue).toHaveLength(0);
  });
});

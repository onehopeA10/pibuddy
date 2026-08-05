/**
 * 权限弹窗的**渲染侧 fail-closed**（SEC-003 硬化 / 交付 2 + 3）。
 *
 * 弹窗本身不放行任何东西——决策与拦截都在主进程。但它决定**用户看到什么**，
 * 而"看到什么"正是用户按下「允许」时所依据的全部信息。因此这里钉两条：
 *
 *   1. 一条命令若因超界被截断、且截断后**不再属于同一个危险类别**，这个框
 *      就不该出现（`request` 返回 false、`pending` 保持 null）。弹一个显示
 *      `echo …` 却实际要执行 `rm -rf` 的框，比不弹更糟。
 *   2. BiDi 覆写字符（Trojan Source）在进入 `pending` 之前就被剥成可见转义——
 *      否则弹窗里那一行能被渲染成与真实命令完全无关的样子。
 *
 * 对拍见 permission-review.spec.ts：拆掉截断后重算 / 拆掉 BiDi 过滤，
 * 对应用例立刻变红。
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { PERMISSION_REVIEW_COMMAND_MAX_BYTES } from "@pibuddy/contract";

import { usePermissionStore } from "./permission.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("request 的投影闸门", () => {
  it("普通申请照常弹窗，字段原样带出", () => {
    const store = usePermissionStore();
    expect(
      store.request({ capabilityId: "coding.terminal", permission: "process.shell", resource: null })
    ).toBe(true);
    expect(store.pending).toMatchObject({
      capabilityId: "coding.terminal",
      permission: "process.shell",
      resource: null,
      command: null,
      dangerous: true,
    });
    expect(store.lastRejectedPrompt).toBe("");
  });

  it("截断后类别翻转 → 不弹窗（pending 保持 null），并留下拒绝原因", () => {
    const store = usePermissionStore();
    const flipping = `echo ${"A".repeat(PERMISSION_REVIEW_COMMAND_MAX_BYTES + 200)} && rm -rf /tmp/x`;
    expect(
      store.request({
        capabilityId: "coding.terminal",
        permission: "process.shell",
        resource: null,
        command: flipping,
      })
    ).toBe(false);
    expect(store.pending).toBeNull();
    expect(store.lastRejectedPrompt).toMatch(/截断后类别由 fs_destructive 变为 shell_unsafe/);
  });

  it("对照：截断但类别不变 → 照常弹窗，并标注已截断", () => {
    const store = usePermissionStore();
    const stable = `rm -rf /tmp/x && echo ${"A".repeat(PERMISSION_REVIEW_COMMAND_MAX_BYTES + 200)}`;
    expect(
      store.request({
        capabilityId: "coding.terminal",
        permission: "process.shell",
        resource: null,
        command: stable,
      })
    ).toBe(true);
    expect(store.pending?.command?.truncated).toBe(true);
    expect(store.pending?.command?.category).toBe("fs_destructive");
  });

  it("BiDi 伪装：进 pending 的展示串已被净化", () => {
    const store = usePermissionStore();
    expect(
      store.request({
        capabilityId: "coding.terminal",
        permission: "process.shell",
        resource: null,
        command: "echo hello‮; rm -rf /tmp/x",
      })
    ).toBe(true);
    expect(store.pending!.command!.text).not.toContain("‮");
    expect(store.pending!.command!.text).toContain("\\u{202E}");
  });

  it("参与授权匹配的 resource 含覆写字符 → 拒绝弹窗（不做净化后放行）", () => {
    const store = usePermissionStore();
    expect(
      store.request({
        capabilityId: "coding.terminal",
        permission: "process.shell",
        resource: "/tmp/‮evil",
      })
    ).toBe(false);
    expect(store.pending).toBeNull();
  });

  it("一次被拒之后，下一次合法申请照常弹（拒绝不是粘性状态）", () => {
    const store = usePermissionStore();
    store.request({
      capabilityId: "coding.terminal",
      permission: "process.shell",
      resource: "/tmp/‮evil",
    });
    expect(store.pending).toBeNull();
    expect(
      store.request({ capabilityId: "coding.terminal", permission: "process.shell", resource: null })
    ).toBe(true);
    expect(store.pending).not.toBeNull();
    expect(store.lastRejectedPrompt).toBe("");
  });
});

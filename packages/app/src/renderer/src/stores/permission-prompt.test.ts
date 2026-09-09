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
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERMISSION_REVIEW_COMMAND_MAX_BYTES,
  PI_RESOURCES_CAPABILITY_ID,
  PI_RESOURCES_PERMISSION,
  piPackagePermissionResource,
} from "@pibuddy/contract";

import { usePermissionStore } from "./permission.js";

const decideSpy = vi.fn();
const describeSpy = vi.fn();
const revokeSpy = vi.fn();

function permissionState(workspaceId: string | null) {
  return { workspaceId, workspaceGrants: [], sessionGrants: [], audit: [] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActivePinia(createPinia());
  decideSpy.mockReset();
  describeSpy.mockReset();
  revokeSpy.mockReset();
  decideSpy.mockImplementation(async (req: { workspaceId: string | null }) =>
    permissionState(req.workspaceId)
  );
  describeSpy.mockImplementation(async (workspaceId: string | null) =>
    permissionState(workspaceId)
  );
  revokeSpy.mockImplementation(async (req: { workspaceId: string | null }) =>
    permissionState(req.workspaceId)
  );
  (globalThis as Record<string, unknown>).window = {
    piBuddy: { permission: { describe: describeSpy, decide: decideSpy, revoke: revokeSpy } },
  };
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

  it("真实 refresh -> request -> decide 流程使用当前工作区，不需手写 store 状态", async () => {
    const store = usePermissionStore();
    const workspaceId = "a".repeat(32);
    await store.refresh(workspaceId);
    store.request({
      capabilityId: PI_RESOURCES_CAPABILITY_ID,
      permission: PI_RESOURCES_PERMISSION,
      resource: piPackagePermissionResource("install", "user", workspaceId, "npm:a"),
      workspaceId,
    });

    await store.decide("allow-session");

    expect(decideSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, disposition: "allow-session" })
    );
    expect(store.lastError).toBe("");
  });

  it("晚到的 A refresh 不覆盖已切到的 B", async () => {
    let resolveA!: (value: ReturnType<typeof permissionState>) => void;
    let resolveB!: (value: ReturnType<typeof permissionState>) => void;
    describeSpy.mockImplementation(
      (workspaceId: string | null) =>
        new Promise((resolve) => {
          if (workspaceId === "A") resolveA = resolve;
          else resolveB = resolve;
        })
    );
    const store = usePermissionStore();
    const pendingA = store.refresh("A");
    const pendingB = store.refresh("B");
    resolveB(permissionState("B"));
    await pendingB;
    resolveA(permissionState("A"));
    await pendingA;
    expect(store.workspaceId).toBe("B");
  });

  it("已经发出的 A decide 晚到时不覆盖 B，也不清掉 B 的新申请", async () => {
    const decided = deferred<ReturnType<typeof permissionState>>();
    decideSpy.mockReturnValueOnce(decided.promise);
    const store = usePermissionStore();
    const workspaceA = "a".repeat(32);
    const workspaceB = "b".repeat(32);
    store.setWorkspaceContext(workspaceA);
    store.request({
      capabilityId: PI_RESOURCES_CAPABILITY_ID,
      permission: PI_RESOURCES_PERMISSION,
      resource: piPackagePermissionResource("install", "user", workspaceA, "npm:a"),
      workspaceId: workspaceA,
    });

    const pendingA = store.decide("allow-session");
    store.setWorkspaceContext(workspaceB);
    store.request({
      capabilityId: PI_RESOURCES_CAPABILITY_ID,
      permission: PI_RESOURCES_PERMISSION,
      resource: piPackagePermissionResource("install", "user", workspaceB, "npm:b"),
      workspaceId: workspaceB,
    });
    decided.resolve(permissionState(workspaceA));
    await pendingA;

    expect(store.workspaceId).toBe(workspaceB);
    expect(store.pendingWorkspaceId).toBe(workspaceB);
    expect(store.pending?.resource).toContain("npm:b");
  });

  it("A 的 revoke 响应晚到时不把权限状态切回 A", async () => {
    const revoked = deferred<ReturnType<typeof permissionState>>();
    revokeSpy.mockReturnValueOnce(revoked.promise);
    const store = usePermissionStore();
    const workspaceA = "a".repeat(32);
    const workspaceB = "b".repeat(32);
    store.setWorkspaceContext(workspaceA);

    const pendingA = store.revoke(
      {
        capabilityId: PI_RESOURCES_CAPABILITY_ID,
        permission: PI_RESOURCES_PERMISSION,
        resource: piPackagePermissionResource("install", "user", workspaceA, "npm:a"),
        grantedAt: 1,
      },
      "session"
    );
    store.setWorkspaceContext(workspaceB);
    revoked.resolve(permissionState(workspaceA));
    await pendingA;

    expect(store.workspaceId).toBe(workspaceB);
    expect(store.lastError).toBe("");
  });

  it("工作目录切换后旧申请作废，不把 A 的授权提交给 B", async () => {
    const store = usePermissionStore();
    const workspaceA = "a".repeat(32);
    const workspaceB = "b".repeat(32);
    store.workspaceId = workspaceA;
    expect(
      store.request({
        capabilityId: PI_RESOURCES_CAPABILITY_ID,
        permission: PI_RESOURCES_PERMISSION,
        resource: piPackagePermissionResource("install", "user", workspaceA, "npm:a"),
        workspaceId: workspaceA,
      })
    ).toBe(true);

    store.workspaceId = workspaceB;
    await store.decide("allow-session");

    expect(decideSpy).not.toHaveBeenCalled();
    expect(store.pending).toBeNull();
    expect(store.lastError).toContain("工作目录已经切换");
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

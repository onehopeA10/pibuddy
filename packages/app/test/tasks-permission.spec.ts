import { describe, expect, it } from "vitest";

import {
  evaluateScheduledPermissions,
  inboxCapabilityOf,
  TASKS_CAPABILITY_ID,
} from "../src/main/tasks/task-permission.js";
import { CapabilityPermissionEngine } from "../src/main/permission/permission-engine.js";
import type { CapabilityGrant } from "@pibuddy/contract";

/**
 * 定时任务权限的可证伪测试——**本能力的关键安全点**。
 *
 * 核心断言：无人值守的定时 run **只认 workspace（预授权、落盘）授权**，绝不
 * 继承交互会话的 allow-once / allow-session。测试用真实的交互引擎制造一个
 * session 授权，证明「同一条权限：交互引擎放行、定时判定拒绝」——这个对照就是
 * 「不继承 session」的证据，而不是断言某个函数没被调用。
 */

function wsGrant(permission: string): CapabilityGrant {
  return { capabilityId: TASKS_CAPABILITY_ID, permission, resource: null, grantedAt: 0 };
}

describe("定时 run 只认 workspace 授权", () => {
  it("有 workspace 授权 → allowed，missing 为空", () => {
    const res = evaluateScheduledPermissions(["process.git"], "ws1", [wsGrant("process.git")]);
    expect(res.allowed).toBe(true);
    expect(res.missing).toEqual([]);
  });

  it("无任何授权 → 拒绝，missing 列出缺的那条", () => {
    const res = evaluateScheduledPermissions(["process.git"], "ws1", []);
    expect(res.allowed).toBe(false);
    expect(res.missing).toEqual(["process.git"]);
  });

  it("多条权限只授权了一部分 → 只 allowed 的不进 missing", () => {
    const res = evaluateScheduledPermissions(
      ["process.git", "process.shell"],
      "ws1",
      [wsGrant("process.git")]
    );
    expect(res.allowed).toBe(false);
    expect(res.missing).toEqual(["process.shell"]);
  });

  it("空 requiredPermissions → 恒 allowed（无危险动作无需预授权）", () => {
    expect(evaluateScheduledPermissions([], "ws1", []).allowed).toBe(true);
  });
});

describe("对照：交互引擎的 session 授权，定时判定不认（不继承 allow-once/session）", () => {
  it("同一条权限：交互 engine 因 session 授权放行，定时判定却拒绝", () => {
    // 构造一个真实的交互引擎，声明上界含 process.git，workspace 授权为空。
    const engine = new CapabilityPermissionEngine({
      declaredPermissions: () => new Set(["process.git"]),
      workspaceGrants: () => [], // 落盘授权表为空
    });
    // 模拟用户在交互会话里点了 allow-session。
    engine.grantSession({ capabilityId: TASKS_CAPABILITY_ID, permission: "process.git", resource: null, grantedAt: 0 });

    const query = {
      capabilityId: TASKS_CAPABILITY_ID,
      permission: "process.git",
      resource: null,
      workspaceId: "ws1",
    };
    // 交互引擎：放行（session 授权命中）。
    expect(engine.evaluate(query).allowed).toBe(true);

    // 定时判定：同一条权限、同一个 workspace，但只看 workspace 授权（这里为空）→ 拒绝。
    // 这就是「定时任务不继承交互会话的 allow-once/session」的直接证据：交互放行的
    // 那次授权，定时侧根本够不到（入参里没有 session 列表这个东西）。
    const scheduled = evaluateScheduledPermissions(["process.git"], "ws1", []);
    expect(scheduled.allowed).toBe(false);
    expect(scheduled.missing).toEqual(["process.git"]);
  });

  it("inboxCapabilityOf 把定时权限映射到声明了该权限的能力", () => {
    expect(inboxCapabilityOf("process.git")).toBe("coding.git");
    expect(inboxCapabilityOf("process.shell")).toBe("coding.terminal");
    expect(inboxCapabilityOf("workspace.read")).toBe("common.workspace-files");
    expect(inboxCapabilityOf("network.local")).toBe("home.assistant");
    expect(inboxCapabilityOf("tasks.manage")).toBe(TASKS_CAPABILITY_ID);
  });

  it("coding.git 落盘的 process.git 也能覆盖定时判定（不要求 capabilityId=common.tasks）", () => {
    const scheduled = evaluateScheduledPermissions(["process.git"], "ws1", [
      { capabilityId: "coding.git", permission: "process.git", resource: null, grantedAt: 0 },
    ]);
    expect(scheduled.allowed).toBe(true);
  });

  it("补上 workspace 授权后，定时判定才放行（预授权是唯一通路）", () => {
    const scheduled = evaluateScheduledPermissions(["process.git"], "ws1", [wsGrant("process.git")]);
    expect(scheduled.allowed).toBe(true);
  });
});

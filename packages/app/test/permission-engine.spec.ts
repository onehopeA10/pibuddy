import { describe, expect, it } from "vitest";

import type { CapabilityGrant } from "@pibuddy/contract";
import {
  CapabilityPermissionEngine,
  grantCovers,
  type PermissionQuery,
} from "../src/main/permission/permission-engine.js";

/**
 * PermissionEngine 的**可证伪**判据（ADR-0002 D3 / SEC-003）。
 *
 * 本项目反复抓到恒真断言，权限这种「断言 engine 被调用」尤其容易恒真。
 * 因此这里的核心是**互斥对拍**：同一条 query，无授权时**必被拒**、有授权时
 * **必放行**。两个方向缺一个，另一个就可能是恒真。
 */

function makeEngine(opts: {
  declared?: Record<string, string[]>;
  workspace?: Record<string, CapabilityGrant[]>;
}) {
  const declared = new Map(Object.entries(opts.declared ?? {}).map(([k, v]) => [k, new Set(v)]));
  const workspace = opts.workspace ?? {};
  return new CapabilityPermissionEngine({
    declaredPermissions: (id) => declared.get(id) ?? new Set<string>(),
    workspaceGrants: (wid) => (wid ? (workspace[wid] ?? []) : []),
  });
}

const gitQuery: PermissionQuery = {
  capabilityId: "kernel.git-probe",
  permission: "process.git",
  resource: null,
  workspaceId: null,
};

describe("默认拒绝 + 互斥对拍（拒绝/放行不能只成立一半）", () => {
  it("已声明但无任何授权 → 拒绝", () => {
    const engine = makeEngine({ declared: { "kernel.git-probe": ["process.git"] } });
    const d = engine.evaluate(gitQuery);
    expect([d.allowed, d.reason !== null]).toEqual([false, true]);
  });

  it("同一条 query：加了 session 授权 → 放行；这正是上一条的互斥对照", () => {
    const engine = makeEngine({ declared: { "kernel.git-probe": ["process.git"] } });
    // 对拍前：拒绝
    expect(engine.evaluate(gitQuery).allowed).toBe(false);
    // 授权后：放行
    engine.grantSession({
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      resource: null,
      grantedAt: 1,
    });
    expect(engine.evaluate(gitQuery).allowed).toBe(true);
  });
});

describe("上界：越过 manifest 声明的权限，给了授权也拒（安全判据的一半）", () => {
  it("未声明 process.git 时，即便硬塞一条 session 授权也拒", () => {
    const engine = makeEngine({ declared: {} }); // 什么都没声明
    engine.grantSession({
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      resource: null,
      grantedAt: 1,
    });
    // 上界在任何 grant 之前判定：自造的授权越不过 manifest。
    expect(engine.evaluate(gitQuery).allowed).toBe(false);
  });

  it("补上声明之后，同一条授权立刻生效 —— 证明上界是真门槛而非恒假", () => {
    const engine = makeEngine({ declared: { "kernel.git-probe": ["process.git"] } });
    engine.grantSession({
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      resource: null,
      grantedAt: 1,
    });
    expect(engine.evaluate(gitQuery).allowed).toBe(true);
  });
});

describe("档位语义", () => {
  it("allow-once：第一次放行，第二次即失效（用后即焚）", () => {
    const engine = makeEngine({ declared: { "kernel.git-probe": ["process.git"] } });
    engine.grantOnce({
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      resource: null,
      grantedAt: 1,
    });
    expect(engine.evaluate(gitQuery).allowed).toBe(true);
    expect(engine.evaluate(gitQuery).allowed).toBe(false);
  });

  it("allow-session：多次评估都放行", () => {
    const engine = makeEngine({ declared: { "kernel.git-probe": ["process.git"] } });
    engine.grantSession({
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      resource: null,
      grantedAt: 1,
    });
    expect(engine.evaluate(gitQuery).allowed).toBe(true);
    expect(engine.evaluate(gitQuery).allowed).toBe(true);
  });

  it("workspace-only：跳过 once/session，只认落盘预授权", () => {
    const engine = makeEngine({
      declared: { "kernel.git-probe": ["process.git"] },
      workspace: {
        wsA: [
          {
            capabilityId: "kernel.git-probe",
            permission: "process.git",
            resource: null,
            grantedAt: 1,
          },
        ],
      },
    });
    engine.grantSession({
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      resource: null,
      grantedAt: 1,
    });
    expect(engine.evaluate({ ...gitQuery, sessionGrantPolicy: "workspace-only" }).allowed).toBe(
      false
    );
    expect(
      engine.evaluate({
        ...gitQuery,
        workspaceId: "wsA",
        sessionGrantPolicy: "workspace-only",
      }).allowed
    ).toBe(true);
  });

  it("allow-workspace：命中该 workspace 的落盘授权则放行，换一个 workspace 则拒", () => {
    const grant: CapabilityGrant = {
      capabilityId: "common.workspace-files",
      permission: "workspace.write",
      resource: null,
      grantedAt: 1,
    };
    const engine = makeEngine({
      declared: { "common.workspace-files": ["workspace.write"] },
      workspace: { wsA: [grant] },
    });
    const base = { capabilityId: "common.workspace-files", permission: "workspace.write", resource: null };
    expect(engine.evaluate({ ...base, workspaceId: "wsA" }).allowed).toBe(true);
    expect(engine.evaluate({ ...base, workspaceId: "wsB" }).allowed).toBe(false);
  });
});

describe("撤销与资源匹配", () => {
  it("revokeSession 撤掉后回到拒绝", () => {
    const engine = makeEngine({ declared: { "kernel.git-probe": ["process.git"] } });
    engine.grantSession({
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      resource: null,
      grantedAt: 1,
    });
    expect(engine.evaluate(gitQuery).allowed).toBe(true);
    expect(engine.revokeSession("kernel.git-probe", "process.git", null)).toBe(1);
    expect(engine.evaluate(gitQuery).allowed).toBe(false);
  });

  it("grantCovers：null 资源通配，具体资源只配同名", () => {
    const any: CapabilityGrant = { capabilityId: "c", permission: "p", resource: null, grantedAt: 0 };
    const specific: CapabilityGrant = { capabilityId: "c", permission: "p", resource: "/x", grantedAt: 0 };
    expect(grantCovers(any, { capabilityId: "c", permission: "p", resource: "/x", workspaceId: null })).toBe(true);
    expect(grantCovers(specific, { capabilityId: "c", permission: "p", resource: "/x", workspaceId: null })).toBe(true);
    expect(grantCovers(specific, { capabilityId: "c", permission: "p", resource: "/y", workspaceId: null })).toBe(false);
  });
});

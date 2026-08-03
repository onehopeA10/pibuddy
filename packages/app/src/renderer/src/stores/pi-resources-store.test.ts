/**
 * piResources store 的单测。
 *
 * 第一条用例钉的是**真机上抓到的回归**：启动时 describeTrust 先于任何一次
 * scan 发生，此时 `scan` 还是 null。若把 trust 只写进 `scan.value.trust`，
 * 那次写入会被 `if (scan.value)` 整个跳过 —— 对话框照常弹出（needsPrompt
 * 是从返回值直接读的），而里面那份「将要加载的 project resources」永远是
 * 空的。typecheck / 单测 / 构建三样全绿，只有真机能看出来。
 *
 * 后半段钉的是**跨项目串写**：A 的 describeTrust 响应晚于切到 B，旧实现
 * 会拿 A 的资源清单去问用户，再把答案写给 B 的目录。
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiResourceScanResult, ProjectTrustState } from "@pibuddy/contract";
import { usePiResourcesStore } from "./piResources.js";

const TRUST: ProjectTrustState = {
  workspaceId: "ws-1",
  hasProjectResources: true,
  resources: [
    { label: "项目设置 .pi/settings.json", path: "D:/proj/.pi/settings.json" },
    { label: "项目技能 .pi/skills", path: "D:/proj/.pi/skills" },
  ],
  saved: "none",
  defaultProjectTrust: "ask",
  effective: "deny",
  needsPrompt: true,
  note: "信任不等于工具权限：……",
};

// 返回类型写死成契约类型（而不是让 TS 从初值推断）：推断出来的形状会把
// `saved: "allow"` 之类的字面量钉死，后面 mockImplementation 换实现就装不进去。
const describeSpy = vi.fn(async (_workspaceId: string): Promise<ProjectTrustState> => TRUST);
const decideSpy = vi.fn(
  async (
    _workspaceId: string,
    _decision: "allow" | "deny",
    _remember: boolean
  ): Promise<ProjectTrustState> => ({
    ...TRUST,
    saved: "allow",
    effective: "allow",
    needsPrompt: false,
  })
);
const scanSpy = vi.fn(
  async (_workspaceId: string): Promise<PiResourceScanResult> => ({
    resources: [],
    trust: TRUST,
    mcp: { implemented: false, note: "未实现" },
    scannedAt: 1,
    errors: [],
  })
);

beforeEach(() => {
  setActivePinia(createPinia());
  describeSpy.mockClear();
  decideSpy.mockClear();
  scanSpy.mockClear();
  (globalThis as Record<string, unknown>).window = {
    piBuddy: {
      piResources: {
        scan: scanSpy,
        trust: { describe: describeSpy, decide: decideSpy },
      },
    },
  };
});

describe("启动时先问 trust、还没扫过资源", () => {
  it("scan 为 null 时 trust 仍然拿得到，弹窗里的资源清单不为空", async () => {
    const s = usePiResourcesStore();
    expect(s.scan).toBeNull();

    await s.describeTrust("ws-1");

    expect(s.trustOpen).toBe(true);
    expect(s.trust).not.toBeNull();
    expect(s.trust?.resources).toHaveLength(2);
    expect(s.trust?.resources[0].label).toContain("项目设置");
  });

  it("决定之后 trust 态被就地更新，弹窗关闭", async () => {
    const s = usePiResourcesStore();
    await s.describeTrust("ws-1");
    await s.decideTrust("ws-1", "allow", true);

    expect(decideSpy).toHaveBeenCalledWith("ws-1", "allow", true);
    expect(s.trustOpen).toBe(false);
    expect(s.trust?.effective).toBe("allow");
  });

  it("后来的一次 scan 不会把已问到的 trust 冲掉", async () => {
    const s = usePiResourcesStore();
    await s.describeTrust("ws-1");
    await s.refresh("ws-1");
    expect(s.trust?.hasProjectResources).toBe(true);
  });

  it("workspaceId 为空时不发 IPC（启动早期还没选工作目录）", async () => {
    const s = usePiResourcesStore();
    await s.describeTrust("");
    await s.refresh("");
    expect(describeSpy).not.toHaveBeenCalled();
    expect(scanSpy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------- 跨项目串写

/** 一个可以由测试自己决定何时兑现的 promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function trustFor(workspaceId: string, label: string): ProjectTrustState {
  return {
    ...TRUST,
    workspaceId,
    resources: [{ label, path: `D:/${workspaceId}/.pi/skills` }],
  };
}

const A = trustFor("ws-A", "A 项目技能 .pi/skills");
const B = trustFor("ws-B", "B 项目技能 .pi/skills");

describe("工作目录切换时，晚到的 trust 响应不许覆盖当前项目", () => {
  /**
   * 时序必须**真的做出来**：A 的响应在 B 之后才兑现。
   * 每次 `await` 一个已经 resolve 的 promise 只会把两次请求串行化，
   * 那样的用例在有缺陷的代码上照样绿。
   */
  it("A 的响应晚于切到 B 时被丢弃，trust 态仍然是 B 的", async () => {
    const a = deferred<ProjectTrustState>();
    const b = deferred<ProjectTrustState>();
    describeSpy.mockImplementation(async (id) => (id === "ws-A" ? a.promise : b.promise));

    const s = usePiResourcesStore();

    // 1) 在 A 上发起（不 await —— 它还没回来）
    const pendingA = s.describeTrust("ws-A");
    // 2) 用户切到 B，B 先回来
    const pendingB = s.describeTrust("ws-B");
    b.resolve(B);
    await pendingB;
    expect(s.trust?.workspaceId).toBe("ws-B");

    // 3) A 这时候才回来 —— 它必须被丢掉
    a.resolve(A);
    await expect(pendingA).resolves.toBeNull();

    expect(s.trust?.workspaceId).toBe("ws-B");
    expect(s.trust?.resources[0].label).toContain("B 项目");
  });

  it("弹窗里显示的是 B 时，拿 A 的 id 提交会被拒，绝不落到 trust.json", async () => {
    describeSpy.mockImplementation(async (id) => (id === "ws-A" ? A : B));
    const s = usePiResourcesStore();
    await s.describeTrust("ws-B");

    const result = await s.decideTrust("ws-A", "allow", true);

    expect(result).toBeNull();
    expect(decideSpy).not.toHaveBeenCalled();
    expect(s.trustOpen).toBe(false);
    expect(s.lastError).toContain("工作目录已经切换");
  });

  it("给当前显示的那个项目提交则照常放行", async () => {
    describeSpy.mockImplementation(async () => B);
    decideSpy.mockImplementation(async () => ({
      ...B,
      saved: "allow",
      effective: "allow",
      needsPrompt: false,
    }));
    const s = usePiResourcesStore();
    await s.describeTrust("ws-B");

    const result = await s.decideTrust("ws-B", "allow", true);

    expect(decideSpy).toHaveBeenCalledWith("ws-B", "allow", true);
    expect(result?.workspaceId).toBe("ws-B");
    expect(s.trust?.effective).toBe("allow");
  });

  it("晚到的 scan 结果不会把当前项目的资源列表与 trust 一起冲掉", async () => {
    const a = deferred<PiResourceScanResult>();
    const b = deferred<PiResourceScanResult>();
    const shell = {
      resources: [],
      mcp: { implemented: false as const, note: "" },
      scannedAt: 1,
      errors: [] as string[],
    };
    scanSpy.mockImplementation(async (id) => (id === "ws-A" ? a.promise : b.promise));

    const s = usePiResourcesStore();
    const pendingA = s.refresh("ws-A");
    const pendingB = s.refresh("ws-B");
    b.resolve({ ...shell, trust: B, errors: ["B 的扫描结果"] });
    await pendingB;
    a.resolve({ ...shell, trust: A, errors: ["A 的扫描结果"] });
    await pendingA;

    expect(s.trust?.workspaceId).toBe("ws-B");
    expect(s.scanErrors).toEqual(["B 的扫描结果"]);
  });
});

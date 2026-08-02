/**
 * piResources store 的单测。
 *
 * 第一条用例钉的是**真机上抓到的回归**：启动时 describeTrust 先于任何一次
 * scan 发生，此时 `scan` 还是 null。若把 trust 只写进 `scan.value.trust`，
 * 那次写入会被 `if (scan.value)` 整个跳过 —— 对话框照常弹出（needsPrompt
 * 是从返回值直接读的），而里面那份「将要加载的 project resources」永远是
 * 空的。typecheck / 单测 / 构建三样全绿，只有真机能看出来。
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTrustState } from "@pibuddy/contract";
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

const describeSpy = vi.fn(async () => TRUST);
const decideSpy = vi.fn(async () => ({ ...TRUST, saved: "allow" as const, effective: "allow" as const, needsPrompt: false }));
const scanSpy = vi.fn(async () => ({
  resources: [],
  trust: TRUST,
  mcp: { implemented: false as const, note: "未实现" },
  scannedAt: 1,
  errors: [],
}));

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

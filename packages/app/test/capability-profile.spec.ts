import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Profile 切换与单个开关的读写回路。
 *
 * ## 这个文件是一条**回归**判据
 *
 * 早先 `describeCapabilities()` 回落到装配期缓存的那份偏好，于是
 * `setProfile('lite')` 之后再 describe 一次，拿回来的还是「general、四个全开」。
 * 界面刷新一次就把用户刚做的选择抹回去了，`restartRequired` 还恒为 false ——
 * 看上去像「切了但什么都没发生」。
 *
 * 这条缺陷单测没抓到（当时的用例都只看 setProfile 的**返回值**，而那一条路径
 * 是直接拿着新 prefs 去 describe 的，恒对）。它是在打包后的真机上用 CDP 走
 * setProfile → location.reload() → 再 describe 才暴露的。判据因此钉在
 * 「**换一次 describe 的入口**再读」上。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-cap-profile-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.1.0" },
  shell: { trashItem: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

const catalog = await import("../src/main/capability/capability-catalog.js");
const prefsModule = await import("../src/main/capability/capability-prefs.js");
const { __resetCapabilityState } = await import("../src/main/capability/capability-state.js");

function enabledIds(state: { capabilities: { id: string; enabled: boolean }[] }): string[] {
  return state.capabilities.filter((c) => c.enabled).map((c) => c.id);
}

beforeEach(() => {
  prefsModule.__setCapabilityPrefsDir(userData);
  fs.rmSync(path.join(userData, "capability-prefs.json"), { force: true });
  catalog.__resetCapabilityAssembly();
  __resetCapabilityState();
});

describe("默认状态", () => {
  it("没有偏好文件时落在默认 Profile，四个通用能力全开", () => {
    const state = catalog.describeCapabilities();
    expect(state.activeProfileId).toBe("general");
    expect(enabledIds(state)).toEqual([
      "common.workspace-files",
      "common.workspace-review",
      "common.preview",
      "common.artifacts",
    ]);
  });

  it("未装配时 restartRequired 为 false（没有可比对的基准，不该凭空要求重启）", () => {
    expect(catalog.describeCapabilities().restartRequired).toBe(false);
  });
});

describe("切 Profile 之后，重新 describe 一次仍然是新值（回归）", () => {
  it("setProfile 的返回值与随后独立的一次 describe 一致", () => {
    catalog.assembleCapabilities(); // 模拟启动装配：此时是 general
    const returned = catalog.setActiveProfile("lite");
    expect(returned.activeProfileId).toBe("lite");
    expect(enabledIds(returned)).toEqual([]);

    // ↓ 这一行才是回归判据：换一个入口再读，不能读回装配期那份
    const reread = catalog.describeCapabilities();
    expect(reread.activeProfileId).toBe("lite");
    expect(enabledIds(reread)).toEqual([]);
  });

  it("装配时是 general、现在是 lite → restartRequired 为 true", () => {
    catalog.assembleCapabilities();
    catalog.setActiveProfile("lite");
    expect(catalog.describeCapabilities().restartRequired).toBe(true);
  });

  it("切回装配时的那一组 → restartRequired 回到 false", () => {
    catalog.assembleCapabilities();
    catalog.setActiveProfile("lite");
    catalog.setActiveProfile("general");
    expect(catalog.describeCapabilities().restartRequired).toBe(false);
  });

  it("未知 Profile 直接抛错，不静默回落到默认值", () => {
    expect(() => catalog.setActiveProfile("nope")).toThrow(/CAPABILITY_PROFILE_UNKNOWN/);
    expect(catalog.describeCapabilities().activeProfileId).toBe("general");
  });
});

describe("单个开关", () => {
  it("关掉一个能力后重新 describe 仍然是关的", () => {
    catalog.setCapabilityEnabled("common.artifacts", false);
    const state = catalog.describeCapabilities();
    expect(enabledIds(state)).not.toContain("common.artifacts");
    expect(state.capabilities.find((c) => c.id === "common.artifacts")?.reason).toBeTruthy();
  });

  it("关掉被依赖的能力，依赖它的那个也跟着被拒，并给出可读原因", () => {
    catalog.setCapabilityEnabled("common.workspace-files", false);
    const state = catalog.describeCapabilities();
    const review = state.capabilities.find((c) => c.id === "common.workspace-review");
    expect(review?.enabled).toBe(false);
    expect(review?.reason).toMatch(/依赖 "common\.workspace-files"/);
  });

  it("换 Profile 会清掉 overrides —— 否则切到「精简」还能看见文件树", () => {
    catalog.setCapabilityEnabled("common.artifacts", false);
    catalog.setActiveProfile("general");
    expect(enabledIds(catalog.describeCapabilities())).toContain("common.artifacts");
  });

  it("未注册的 capabilityId 直接抛错", () => {
    expect(() => catalog.setCapabilityEnabled("vertical.ghost", true)).toThrow(
      /CAPABILITY_UNKNOWN/
    );
  });
});

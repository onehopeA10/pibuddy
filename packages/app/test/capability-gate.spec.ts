import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * feature gate 的行为判据（ADR-0002）。
 *
 * ## 为什么这个文件把 Profile 设成「精简」
 *
 * 「能力未启用时通道不注册」这句话，在四个能力全开的情况下**没有对照组**：
 * 通道全在，看不出是因为 gate 放行还是因为根本没有 gate。sessions-ipc.spec
 * 已经在默认（全开）下断言了「契约里的每条通道都被注册」；这里换成一条一个
 * 可选能力都不开的 Profile，断言那 24 条**一条都不在**。两个文件合起来才
 * 是一条可证伪的判据。
 *
 * 两个文件必须分开：`ipcMain.handle` 在同一 channel 上绑第二次会抛错，
 * 注册面在一个模块图里只能被建立一次。
 */

const handled = new Map<string, unknown>();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-cap-gate-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  shell: { trashItem: vi.fn(async () => undefined), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: unknown) => {
      if (handled.has(channel)) throw new Error(`DUPLICATE_HANDLE: ${channel}`);
      handled.set(channel, fn);
    },
  },
}));

const { CHANNELS } = await import("@pibuddy/contract");
const { registeredChannels, __resetRegisteredChannels } = await import("../src/main/ipc-guard.js");
const { BUILT_IN_CAPABILITIES } = await import("../src/main/capability/capability-manifests.js");
const { __setCapabilityPrefsDir, saveCapabilityPrefs } = await import(
  "../src/main/capability/capability-prefs.js"
);
const { enabledCapabilityIds, isCapabilityAssemblyDone, isCapabilityEnabled } = await import(
  "../src/main/capability/capability-state.js"
);

/** 四个可选能力声明的全部通道。 */
const CAPABILITY_CHANNELS = BUILT_IN_CAPABILITIES.flatMap((m) => [...m.channels]);

beforeAll(async () => {
  __setCapabilityPrefsDir(userData);
  // 「精简」= 一个可选能力都不开。
  saveCapabilityPrefs({ schemaVersion: 1, profileId: "lite", overrides: {} });
  __resetRegisteredChannels();
  handled.clear();
  const { registerAllIpc } = await import("../src/main/ipc-registry.js");
  registerAllIpc();
});

describe("装配确实发生了（默认值是「未装配 = 全部视为启用」，不能靠它蒙混）", () => {
  it("registerAllIpc 之后 capability-state 已被写入", () => {
    expect(isCapabilityAssemblyDone()).toBe(true);
  });

  it("精简 Profile 下启用集合为空", () => {
    expect(enabledCapabilityIds()).toEqual([]);
  });
});

describe("未启用的能力：通道一条都不注册", () => {
  it("24 条可选通道一条都不在已注册表里", () => {
    const table = new Set(registeredChannels());
    const leaked = CAPABILITY_CHANNELS.filter((channel) => table.has(channel));
    expect(leaked).toEqual([]);
    // 集合非空才有意义：CAPABILITY_CHANNELS 空了的话上面那条恒真。
    expect(CAPABILITY_CHANNELS.length).toBe(24);
  });

  it("ipcMain 那一侧也确实没被绑过 —— 不是只有守卫的账本没记", () => {
    const bound = new Set(handled.keys());
    expect(CAPABILITY_CHANNELS.filter((c) => bound.has(c))).toEqual([]);
  });
});

describe("内核不受能力开关影响", () => {
  it("会话 / 设置 / 更新等内核通道照常注册", () => {
    const table = new Set(registeredChannels());
    for (const channel of [
      CHANNELS.piStart,
      CHANNELS.piPrompt,
      CHANNELS.sessionsQuery,
      CHANNELS.settingsGet,
      CHANNELS.updateGetState,
      CHANNELS.providersList,
      CHANNELS.diagnosticsGetReport,
    ]) {
      expect([channel, table.has(channel)]).toEqual([channel, true]);
    }
  });

  it("capabilities:* 三条恒注册 —— 否则「全关」会连带关掉那个用来重新打开的入口", () => {
    const table = new Set(registeredChannels());
    expect(table.has(CHANNELS.capabilitiesDescribe)).toBe(true);
    expect(table.has(CHANNELS.capabilitiesSetProfile)).toBe(true);
    expect(table.has(CHANNELS.capabilitiesSetEnabled)).toBe(true);
  });
});

describe("D4 规则 4：禁用停 listener，保留数据", () => {
  it("产物跟踪在能力未启用时不插记录", async () => {
    const tracker = await import("../src/main/artifacts/artifact-tracker.js");
    expect(isCapabilityEnabled("common.artifacts")).toBe(false);
    const result = tracker.trackToolStart({
      workspaceId: "ws",
      sessionId: "s",
      turnId: "t",
      toolCallId: "call-1",
      relativePath: "a.txt",
    });
    // 未启用时**在 sqlite 之前**就返回 —— 不是「插了再删」，也不是「插了但不显示」
    expect(result).toBeNull();
  });

  it("已落盘的数据一个字节都没被动过（禁用 ≠ 删数据，规则 5）", () => {
    // 装配跑完之后，userData 下不该出现任何被清空/删除的痕迹：这里唯一存在的
    // 文件就是我们自己写的偏好文件，四个能力的 db 一个都没有被创建或清理。
    const files = fs.readdirSync(userData).sort();
    expect(files).toEqual(["capability-prefs.json"]);
  });
});

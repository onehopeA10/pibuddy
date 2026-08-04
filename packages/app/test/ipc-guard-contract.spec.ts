import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-001：注册期契约核对的对拍测试。
 *
 * registerHandler 的闸 2 schema 由调用点传入，本组用例钉住的是「传入的
 * schema 与 CHANNEL_CONTRACTS 里的那一个必须是**同一个对象**」这条加载期
 * 保证。三种失败形态各钉一条：
 *
 *   (a) 契约表里没有这条通道 → IPC_CONTRACT_MISSING；
 *   (b) 传入了结构等价但不是同一实例的 schema → IPC_SCHEMA_MISMATCH ——
 *       结构等价不算数，两份实例正是漂移的起点；
 *   (c) 早先真实存在的五处漂移（分片里内联 z.void()、调用点传
 *       voidRequestSchema）已收敛为同一实例。
 *
 * 把 ipc-guard 里的同一性断言拆掉，(a)(b) 会立刻变红 —— 这正是本机制
 * 存在与生效的证明。
 */
const registered = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      registered.set(channel, fn);
    },
  },
}));

const { registerHandler, __resetRegisteredChannels } = await import("../src/main/ipc-guard.js");
const {
  CHANNELS,
  CHANNEL_CONTRACTS,
  piPromptRequestSchema,
  voidRequestSchema,
} = await import("@pibuddy/contract");

beforeEach(() => {
  registered.clear();
  __resetRegisteredChannels();
});

describe("注册期契约核对（ISS-001）", () => {
  it("传契约表里的那一个实例：注册成功", () => {
    expect(() =>
      registerHandler(CHANNELS.piPrompt, piPromptRequestSchema, () => "ok")
    ).not.toThrow();
    expect(registered.has(CHANNELS.piPrompt)).toBe(true);
  });

  it("契约表缺该通道 → 注册当场抛 IPC_CONTRACT_MISSING", () => {
    expect(() =>
      registerHandler("evil:exec" as never, voidRequestSchema as never, () => "ok")
    ).toThrow(/IPC_CONTRACT_MISSING/);
    // 抛错发生在 ipcMain.handle 之前：这条通道根本没被挂上去
    expect(registered.has("evil:exec")).toBe(false);
  });

  it("结构等价但不是同一实例 → IPC_SCHEMA_MISMATCH", () => {
    // 委托给真 schema 的 parse：结构行为与契约表里的一模一样，唯独不是
    // 同一个对象 —— 正是「各 handler 自己再写一遍 schema」那种漂移的形态。
    const clone = { parse: (value: unknown) => piPromptRequestSchema.parse(value) };
    expect(() =>
      registerHandler(CHANNELS.piPrompt, clone as never, () => "ok")
    ).toThrow(/IPC_SCHEMA_MISMATCH/);
    expect(registered.has(CHANNELS.piPrompt)).toBe(false);
  });

  it("早先漂移的五条无参通道已与 voidRequestSchema 收敛为同一实例", () => {
    // 修复前这五条在契约分片里各自内联 z.void()，而调用点传的是
    // voidRequestSchema —— 结构等价、对象不同，注册期核对会拦下它们。
    const drifted = [
      CHANNELS.capabilitiesDescribe,
      CHANNELS.connectorList,
      CHANNELS.remoteDescribe,
      CHANNELS.remoteCreatePairing,
      CHANNELS.remoteCancelPairing,
    ] as const;
    for (const channel of drifted) {
      expect(CHANNEL_CONTRACTS[channel].request, channel).toBe(voidRequestSchema);
    }
  });

  it("每条通道的契约 request 都能作为闸 2 的 schema（有 parse）", () => {
    for (const [channel, contract] of Object.entries(CHANNEL_CONTRACTS)) {
      expect(typeof contract.request.parse, channel).toBe("function");
    }
  });
});

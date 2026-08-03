import { describe, expect, it, vi } from "vitest";

/**
 * SEC-005：渲染进程不得指定「主进程去启动哪个可执行文件」。
 *
 * 两层判据，缺一层这条修复就是假的：
 *
 *   1. **契约层** —— `settings:set` 的入参 schema 里没有 piRuntimeMode /
 *      piExternalCommand。ipc-guard 用这个 schema 做 parse，zod 的 object
 *      会把不在形状里的键直接丢掉，所以「渲染进程发了也没用」是结构成立的，
 *      不依赖任何 handler 记得去删字段。
 *   2. **流程层** —— external 落盘之前必须有一次不可被渲染进程伪造的用户
 *      确认，且**取消时一个字节都不写**。
 */
const { applyPiRuntimeChoice } = await import("../src/main/security/pi-runtime-approval.js");
const { rendererSettingsPatchSchema, piRuntimeChoiceRequestSchema, CHANNEL_CONTRACTS, CHANNELS } =
  await import("@pibuddy/contract");

type Patch = Record<string, unknown>;

/** 依赖替身：默认是「用户选了文件并确认」这条最宽松的路径。 */
function makeDeps(over: Partial<Record<string, unknown>> = {}) {
  const persisted: Patch[] = [];
  const deps = {
    pickExecutable: vi.fn(async () => "C:\\tools\\pi\\pi"),
    // 真实实现（pi-launcher.resolveExternalCommand）会在 Windows 上补出
    // .cmd/.exe 后缀，这里用一个可辨认的返回值模拟那次改写。
    resolveCommand: vi.fn((picked: string) => `${picked}.cmd`),
    confirm: vi.fn(async () => true),
    persist: vi.fn((patch: Patch) => {
      persisted.push(patch);
      return { schemaVersion: 2, ...patch } as never;
    }),
    current: vi.fn(() => ({ schemaVersion: 2, piRuntimeMode: "bundled" }) as never),
    ...over,
  };
  return { deps, persisted };
}

describe("[SEC-005 契约层] 可执行文件不再是一个渲染进程可写的设置字段", () => {
  it("settings:set 的入参 schema 直接丢弃 piRuntimeMode / piExternalCommand", () => {
    const writable = Object.keys(rendererSettingsPatchSchema.shape);
    expect(writable).not.toContain("piRuntimeMode");
    expect(writable).not.toContain("piExternalCommand");

    // 结构性判据：一个被攻陷的渲染进程照着老接口发过来，parse 之后这两个键
    // 一个都不剩 —— ipc-guard 交给 handler 的就是 parse 的结果，因此
    // 「handler 忘了删字段」这件事在结构上不再可能发生。
    // （其余带 .default() 的字段会被 zod 补齐，这里只判这两个键的存在性。）
    const parsed = rendererSettingsPatchSchema.parse({
      piRuntimeMode: "external",
      piExternalCommand: "C:\\Windows\\System32\\calc.exe",
      sttModel: "whisper-1",
    }) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("piRuntimeMode");
    expect(Object.keys(parsed)).not.toContain("piExternalCommand");
    expect(parsed.sttModel).toBe("whisper-1");
  });

  it("settings:set-pi-runtime 的入参里没有任何路径形参", () => {
    expect(Object.keys(piRuntimeChoiceRequestSchema.shape)).toEqual(["mode"]);
    // 顺手夹带一个 command 字段同样会被丢掉
    expect(
      piRuntimeChoiceRequestSchema.parse({ mode: "external", command: "calc.exe" })
    ).toEqual({ mode: "external" });
    // 通道已在契约表里注册（否则 ipc-guard 会把它当未知通道拒绝）
    expect(CHANNEL_CONTRACTS[CHANNELS.settingsSetPiRuntime].request).toBe(
      piRuntimeChoiceRequestSchema
    );
  });
});

describe("[SEC-005 流程层] external 必须经用户确认才落盘", () => {
  it("用户在文件选择框取消：persist 一次都不被调用", async () => {
    const { deps, persisted } = makeDeps({ pickExecutable: vi.fn(async () => null) });
    const out = await applyPiRuntimeChoice("external", deps as never);

    expect(out.applied).toBe(false);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
    // 取消后仍要弹确认框，等于给了攻击者第二次机会
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it("用户选了文件但在确认框点取消：persist 一次都不被调用", async () => {
    const { deps, persisted } = makeDeps({ confirm: vi.fn(async () => false) });
    const out = await applyPiRuntimeChoice("external", deps as never);

    expect(out.applied).toBe(false);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
  });

  it("确认框上展示的、以及落盘的，都是解析后真正会被 spawn 的那个文件", async () => {
    const { deps, persisted } = makeDeps();
    const out = await applyPiRuntimeChoice("external", deps as never);

    expect(out.applied).toBe(true);
    // 确认文案里的路径必须来自 resolveCommand，而不是用户点中的原始名字
    expect(deps.confirm).toHaveBeenCalledWith("C:\\tools\\pi\\pi.cmd");
    expect(persisted).toEqual([
      { piRuntimeMode: "external", piExternalCommand: "C:\\tools\\pi\\pi.cmd" },
    ]);
  });

  it("切回内置是降权：不弹任何对话框，并清掉上一次的外部命令", async () => {
    const { deps, persisted } = makeDeps();
    const out = await applyPiRuntimeChoice("bundled", deps as never);

    expect(out.applied).toBe(true);
    expect(deps.pickExecutable).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(persisted).toEqual([{ piRuntimeMode: "bundled", piExternalCommand: "" }]);
  });
});

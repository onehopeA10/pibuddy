import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC-002：IPC 四道闸的关键路径断言（不做穷举矩阵）。
 *
 *   1. senderFrame ≠ sender.mainFrame → IPC_FRAME_REJECTED
 *   2. schema 不匹配的 payload 被 zod 拒
 *   3. 超过上限的载荷被拒；CHANNEL_MAX_BYTES 的按通道覆盖真正生效
 *   4. 10 秒内第 11 次 prompt 被限流
 *
 * electron 整体打桩：本测试跑在纯 node 的 vitest 里，没有 electron 运行时。
 * `ipcMain.handle` 的替身把注册进来的 handler 收在 registered 里，测试因此
 * 能直接以「伪造的 IpcMainInvokeEvent」驱动真实的包装器逻辑。
 */
const registered = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      registered.set(channel, fn);
    },
  },
}));

const {
  CHANNEL_MAX_BYTES,
  IpcGuard,
  MAX_IPC_PAYLOAD_BYTES,
  MAX_IPC_PAYLOAD_DEPTH,
  MAX_TEXT_PAYLOAD_BYTES,
  RateLimiter,
  assertMainFrame,
  assertSizeWithin,
  estimateBytes,
  rateLimiter,
  registerHandler,
  ruleFor,
} = await import("../src/main/ipc-guard.js");

const { piPromptRequestSchema, sttTranscribeRequestSchema, tokenRequestSchema } =
  await import("@pibuddy/contract");

/** 伪造一个来自主 frame 的 invoke 事件。 */
function mainFrameEvent(senderId = 1): { senderFrame: object; sender: { id: number; mainFrame: object } } {
  const mainFrame = { name: "main" };
  return { senderFrame: mainFrame, sender: { id: senderId, mainFrame } };
}

/** 伪造一个来自子 frame（iframe / webview）的 invoke 事件。 */
function subFrameEvent(senderId = 1): { senderFrame: object; sender: { id: number; mainFrame: object } } {
  const mainFrame = { name: "main" };
  return { senderFrame: { name: "child" }, sender: { id: senderId, mainFrame } };
}

beforeEach(() => {
  registered.clear();
  rateLimiter.reset();
});

describe("闸 1：来源必须是主 frame", () => {
  it("senderFrame 与 sender.mainFrame 不相等时抛 IPC_FRAME_REJECTED", () => {
    expect(() => assertMainFrame(subFrameEvent() as never)).toThrow("IPC_FRAME_REJECTED");
  });

  it("主 frame 放行", () => {
    expect(() => assertMainFrame(mainFrameEvent() as never)).not.toThrow();
  });

  it("经 registerHandler 注册的 handler 同样挡子 frame，且 handler 根本不被调用", async () => {
    const handler = vi.fn(() => "ok");
    registerHandler("file:read-attachment", tokenRequestSchema, handler);
    const fn = registered.get("file:read-attachment")!;

    await expect(fn(subFrameEvent(), { token: "t" })).rejects.toThrow("IPC_FRAME_REJECTED");
    expect(handler).not.toHaveBeenCalled();

    await expect(fn(mainFrameEvent(), { token: "t" })).resolves.toBe("ok");
  });
});

describe("闸 2：schema 校验", () => {
  it("schema 不匹配的 payload 被拒，handler 不被调用", async () => {
    const handler = vi.fn(() => "ok");
    registerHandler("pi:prompt", piPromptRequestSchema, handler);
    const fn = registered.get("pi:prompt")!;

    // message 必填且必须是字符串
    await expect(fn(mainFrameEvent(), { message: 42 })).rejects.toThrow();
    await expect(fn(mainFrameEvent(), {})).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();

    await expect(fn(mainFrameEvent(), { message: "你好" })).resolves.toBe("ok");
  });

  it("streamingBehavior 只接受 steer / followUp —— 插话分支的契约依据", async () => {
    registerHandler("pi:prompt", piPromptRequestSchema, () => "ok");
    const fn = registered.get("pi:prompt")!;

    await expect(
      fn(mainFrameEvent(), { message: "插话", streamingBehavior: "steer" })
    ).resolves.toBe("ok");
    await expect(
      fn(mainFrameEvent(), { message: "x", streamingBehavior: "bash" })
    ).rejects.toThrow();
  });
});

describe("闸 3：尺寸", () => {
  it("estimateBytes 认得 structured-clone 内建类型，并对深度溢出失败关闭", () => {
    const buf = new ArrayBuffer(1024);
    expect(estimateBytes({ audio: buf })).toBeGreaterThanOrEqual(1024);
    expect(estimateBytes(new Map([["audio", buf]]))).toBeGreaterThanOrEqual(1024);
    expect(estimateBytes(new Set([buf]))).toBeGreaterThanOrEqual(1024);
    expect(estimateBytes(new Date())).toBeGreaterThan(8);
    expect(estimateBytes(new Error("boom"))).toBeGreaterThan(Buffer.byteLength("boom"));
    expect(estimateBytes("héllo")).toBe(6);

    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_IPC_PAYLOAD_DEPTH + 2; i++) deep = { next: deep };
    expect(estimateBytes(deep)).toBe(Number.POSITIVE_INFINITY);
  });

  it("容器与成员本身计费，巨量 null / 空对象数组不能估成接近零", () => {
    expect(estimateBytes(new Array(1_100_000).fill(null))).toBeGreaterThan(
      MAX_IPC_PAYLOAD_BYTES
    );
    expect(estimateBytes(Array.from({ length: 400_000 }, () => ({})))).toBeGreaterThan(
      MAX_IPC_PAYLOAD_BYTES
    );
  });

  it("循环与共享图只计安全引用，不递归爆栈或重复放大", () => {
    const shared = { text: "shared" };
    const root: { self?: unknown; left: unknown; right: unknown } = {
      left: shared,
      right: shared,
    };
    root.self = root;
    const bytes = estimateBytes(root);
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(Buffer.byteLength("shared"));
    expect(bytes).toBeLessThan(1024);
  });

  it("大 RegExp 显式按 source 计费，未知原型失败关闭", () => {
    const source = "a".repeat(300_000);
    expect(estimateBytes(new RegExp(source))).toBeGreaterThanOrEqual(source.length);
    expect(estimateBytes(Object.create({ inherited: true }))).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("schema.parse 前拒绝过深的原始 payload，未知字段不能靠 zod strip 逃过", async () => {
    registerHandler("pi:prompt", piPromptRequestSchema, () => "ok");
    const fn = registered.get("pi:prompt")!;
    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_IPC_PAYLOAD_DEPTH + 2; i++) deep = { next: deep };

    await expect(fn(mainFrameEvent(), { message: "x", hidden: deep })).rejects.toThrow(
      /IPC_PAYLOAD_TOO_DEEP/
    );
  });

  it("超过 MAX_TEXT_PAYLOAD_BYTES 的 prompt 被拒", async () => {
    registerHandler("pi:prompt", piPromptRequestSchema, () => "ok");
    const fn = registered.get("pi:prompt")!;

    const huge = "a".repeat(MAX_TEXT_PAYLOAD_BYTES + 1);
    await expect(fn(mainFrameEvent(), { message: huge })).rejects.toThrow(
      /IPC_TEXT_TOO_LARGE/
    );
    // 刚好卡在上限内则放行
    await expect(
      fn(mainFrameEvent(), { message: "a".repeat(MAX_TEXT_PAYLOAD_BYTES) })
    ).resolves.toBe("ok");
  });

  it("有效 Unicode 在共享 UTF-8 字节上限处通过 schema 与 guard", async () => {
    registerHandler("pi:prompt", piPromptRequestSchema, () => "ok");
    const fn = registered.get("pi:prompt")!;
    const exact = "你".repeat(Math.floor(MAX_TEXT_PAYLOAD_BYTES / 3)) + "x";

    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_TEXT_PAYLOAD_BYTES);
    await expect(fn(mainFrameEvent(), { message: exact })).resolves.toBe("ok");
  });

  it("图片的 base64 挂在 images[].data 上，不受文本上限误伤", async () => {
    registerHandler("pi:prompt", piPromptRequestSchema, () => "ok");
    const fn = registered.get("pi:prompt")!;

    const bigImage = "A".repeat(MAX_TEXT_PAYLOAD_BYTES * 2);
    await expect(
      fn(mainFrameEvent(), {
        message: "看这张图",
        images: [{ type: "image", data: bigImage, mimeType: "image/png" }],
      })
    ).resolves.toBe("ok");
  });

  it("CHANNEL_MAX_BYTES 的按通道覆盖生效：stt 9MB 过、26MB 拒", () => {
    const sttLimit = CHANNEL_MAX_BYTES["stt:transcribe"]!;
    expect(sttLimit).toBe(25 * 1024 * 1024);

    const nine = { audio: new ArrayBuffer(9 * 1024 * 1024) };
    expect(() => assertSizeWithin("stt:transcribe", nine, sttLimit)).not.toThrow();

    const twentySix = { audio: new ArrayBuffer(26 * 1024 * 1024) };
    expect(() => assertSizeWithin("stt:transcribe", twentySix, sttLimit)).toThrow(
      /IPC_PAYLOAD_TOO_LARGE/
    );

    // 没有这张表的话 9MB 就会先被通用 8MB 挡掉，25MB 那个常量成死代码
    expect(9 * 1024 * 1024).toBeGreaterThan(MAX_IPC_PAYLOAD_BYTES);
  });

  it("file:read-attachment 上限 10MB：11MB 被拒", () => {
    const limit = CHANNEL_MAX_BYTES["file:read-attachment"]!;
    expect(limit).toBe(10 * 1024 * 1024);
    expect(() =>
      assertSizeWithin("file:read-attachment", { blob: new ArrayBuffer(11 * 1024 * 1024) }, limit)
    ).toThrow(/IPC_PAYLOAD_TOO_LARGE/);
  });

  it("未在表中的 channel 沿用通用 8MB", () => {
    expect(CHANNEL_MAX_BYTES["settings:set"]).toBeUndefined();
    expect(ruleFor("settings:set").maxBytes).toBe(MAX_IPC_PAYLOAD_BYTES);
    expect(ruleFor("stt:transcribe").maxBytes).toBe(25 * 1024 * 1024);
  });

  it("stt:transcribe 的 25MB 音频真的能过整条包装器", async () => {
    registerHandler("stt:transcribe", sttTranscribeRequestSchema, () => ({ text: "好" }));
    const fn = registered.get("stt:transcribe")!;
    await expect(
      fn(mainFrameEvent(), {
        // SEC-004 后的形状：只有 endpointId，没有 URL 也没有密钥
        endpointId: "e1",
        audio: new ArrayBuffer(9 * 1024 * 1024),
        mimeType: "audio/webm",
      })
    ).resolves.toEqual({ text: "好" });
  });
});

describe("闸 2：解析前限流", () => {
  it("无效 schema 载荷同样消耗配额，第 11 次在 parse 前被限流", async () => {
    registerHandler("pi:prompt", piPromptRequestSchema, () => "ok");
    const fn = registered.get("pi:prompt")!;

    for (let i = 0; i < 10; i++) {
      await expect(fn(mainFrameEvent(), { message: 42 })).rejects.not.toThrow(
        /IPC_RATE_LIMITED/
      );
    }
    await expect(fn(mainFrameEvent(), { message: 42 })).rejects.toThrow(/IPC_RATE_LIMITED/);
  });

  it("10 秒内第 11 次 prompt 被限流拒绝", async () => {
    registerHandler("pi:prompt", piPromptRequestSchema, () => "ok");
    const fn = registered.get("pi:prompt")!;

    for (let i = 0; i < 10; i++) {
      await expect(fn(mainFrameEvent(), { message: `第 ${i} 条` })).resolves.toBe("ok");
    }
    await expect(fn(mainFrameEvent(), { message: "第 11 条" })).rejects.toThrow(
      /IPC_RATE_LIMITED/
    );
  });

  it("prompt / steer / follow-up 共用模型动作桶，其他通道仍独立", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 4; i++) limiter.check("pi:prompt", 1);
    for (let i = 0; i < 3; i++) limiter.check("pi:steer", 1);
    for (let i = 0; i < 3; i++) limiter.check("pi:follow-up", 1);
    expect(() => limiter.check("pi:prompt", 1)).toThrow(/IPC_RATE_LIMITED/);
    expect(() => limiter.check("pi:steer", 1)).toThrow(/IPC_RATE_LIMITED/);
    expect(() => limiter.check("pi:get-state", 1)).not.toThrow();
    expect(() => limiter.check("pi:prompt", 2)).not.toThrow();
  });

  it("窗口滑走之后额度恢复", () => {
    const limiter = new RateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) limiter.check("pi:prompt", 1, t0);
    expect(limiter.evaluate("pi:prompt", 1, t0).allowed).toBe(false);
    expect(limiter.evaluate("pi:prompt", 1, t0 + 10_001).allowed).toBe(true);
  });

  it("非 prompt 通道配额是 30", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 30; i++) limiter.check("pi:get-state", 1);
    expect(() => limiter.check("pi:get-state", 1)).toThrow(/IPC_RATE_LIMITED/);
  });
});

describe("IpcGuard implements PermissionEngine", () => {
  it("checkFrame 拒未知通道", () => {
    const guard = new IpcGuard(new RateLimiter());
    expect(guard.checkFrame("pi:prompt", 1).allowed).toBe(true);
    expect(guard.checkFrame("pi:command", 1).allowed).toBe(false);
    expect(guard.checkFrame("evil:exec", 1).allowed).toBe(false);
  });

  it("checkPayload / checkRate 返回结构化判定而不抛错", () => {
    const guard = new IpcGuard(new RateLimiter());
    expect(guard.checkPayload("pi:prompt", { message: "hi" }).allowed).toBe(true);
    const tooBig = guard.checkPayload("pi:prompt", {
      message: "a".repeat(MAX_TEXT_PAYLOAD_BYTES + 1),
    });
    expect(tooBig.allowed).toBe(false);

    for (let i = 0; i < 10; i++) guard.checkRate("pi:prompt", 7);
    expect(guard.checkRate("pi:prompt", 7).allowed).toBe(false);
  });
});

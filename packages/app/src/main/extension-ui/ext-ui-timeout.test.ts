/**
 * dialog timeout 的实现测试（EXT-101）。
 *
 * 改造前 `timeout` 在全库只有一处：pi-sdk/src/types.ts 里的一行类型声明。
 * 没有任何实现读它。rpc.md:1145 说「客户端不需要跟踪超时」被读成了「什么
 * 都不用做」，而它真正的含义是**到期之后本地那个框上的按钮已经没人接收**。
 *
 * 这里的三条断言合起来就是那个缺陷的形状：到期要广播、到期后作答要被拒、
 * 且一次 stdin 都不能写。
 */
import { describe, expect, it, vi } from "vitest";
import { PUSH_CHANNELS } from "@pibuddy/contract";
import { ExtensionUiService } from "./ext-ui-service.js";
import { makeHost, req } from "./ext-ui-fixtures.js";

const TARGET = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("带 timeout 的 dialog", () => {
  it("50ms 超时：80ms 后广播 pi:ui-expire，此后作答返回 expired 且 respondUi 调用 0 次", async () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    const request = req("select", { options: ["A", "B"], timeout: 50 });

    service.track(TARGET, 1, request);
    expect(service.pendingCount).toBe(1);
    expect(service.pendingTimerCount).toBe(1);

    await sleep(80);

    // (a) renderer 收到 pi:ui-expire —— 本地 modal 因此关闭
    const expires = host.pushes.filter((p) => p.channel === PUSH_CHANNELS.piUiExpire);
    expect(expires).toHaveLength(1);
    expect(expires[0].payload).toEqual({ id: request.id, reason: "timeout" });
    expect(service.pendingCount).toBe(0);

    // (b) 此后对该 id 作答被拒，且 client.respondUi 一次都没被调用
    expect(
      service.respond(TARGET, {
        type: "extension_ui_response",
        id: request.id,
        value: "A",
      })
    ).toEqual({ ok: false, reason: "expired" });
    expect(host.respondSpy).toHaveBeenCalledTimes(0);
  });

  it("没有 timeout 的 dialog 永远不会自己过期", async () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    const request = req("confirm");
    service.track(TARGET, 1, request);
    expect(service.pendingTimerCount).toBe(0);

    await sleep(60);
    expect(service.pendingCount).toBe(1);
    expect(host.pushes).toHaveLength(0);
  });

  it("在超时之前作答：定时器被清掉，之后不会再冒出一条 expire", async () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    const request = req("input", { timeout: 40 });
    service.track(TARGET, 1, request);

    expect(
      service.respond(TARGET, {
        type: "extension_ui_response",
        id: request.id,
        value: "v",
      })
    ).toEqual({ ok: true });
    expect(service.pendingTimerCount).toBe(0);

    await sleep(70);
    // 残留定时器会在几分钟后向已关闭的会话广播 expire，
    // 用户看到的是随机弹出的过期提示。
    expect(host.pushes.filter((p) => p.channel === PUSH_CHANNELS.piUiExpire)).toHaveLength(0);
  });

  it("[定时器不泄漏] 100 次「建带 timeout 的请求 → 立即作答」后残留定时器为 0", () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    for (let i = 0; i < 100; i++) {
      const request = req("editor", { timeout: 60_000 });
      service.track(TARGET, 1, request);
      service.respond(TARGET, {
        type: "extension_ui_response",
        id: request.id,
        value: `v${i}`,
      });
    }
    expect(service.pendingTimerCount).toBe(0);
    expect(service.pendingCount).toBe(0);
    expect(host.respondSpy).toHaveBeenCalledTimes(100);
  });

  it("[定时器不泄漏] 代际清理路径同样清掉定时器", () => {
    const service = new ExtensionUiService(makeHost());
    for (let i = 0; i < 100; i++) {
      service.track(TARGET, 1, req("select", { options: ["x"], timeout: 60_000 }));
    }
    expect(service.pendingTimerCount).toBe(100);
    service.clearGeneration(TARGET, 1);
    expect(service.pendingTimerCount).toBe(0);
  });

  it("AbortSignal：超时会 abort 对应的信号", async () => {
    const service = new ExtensionUiService(makeHost());
    const request = req("confirm", { timeout: 30 });
    service.track(TARGET, 1, request);
    const signal = service.signalFor(request.id);
    expect(signal?.aborted).toBe(false);
    const onAbort = vi.fn();
    signal?.addEventListener("abort", onAbort);

    await sleep(60);
    expect(signal?.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

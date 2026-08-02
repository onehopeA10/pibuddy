/**
 * Extension UI 的生命周期测试（EXT-101）。
 *
 * 改造前 `uiRequests` 只活在渲染进程里，且不随 runtime / session 清理。
 * 被作答的僵尸弹窗会让 `clientFor` 抛错，而调用点是 `void store.respondUi(...)`
 * —— 于是变成一条无人认领的 unhandled promise rejection：日志里有一行没人
 * 看得懂的堆栈，用户看到的是「点了确定什么也没发生」。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUSH_CHANNELS } from "@pibuddy/contract";
import { ExtensionUiService } from "./ext-ui-service.js";
import { makeHost, req } from "./ext-ui-fixtures.js";

const TARGET = 11;

/** 全过程的未处理 rejection 计数。归零是这一组的核心断言。 */
let unhandled = 0;
const onUnhandled = (): void => {
  unhandled++;
};

beforeEach(() => {
  unhandled = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("runtime 重启（代际切换）", () => {
  it("generation 1→2 后，第 1 代的挂起 dialog 全部被清理并广播 expire-all", async () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);

    const a = req("select", { options: ["x"] });
    const b = req("confirm");
    service.track(TARGET, 1, a);
    service.track(TARGET, 1, b);
    expect(service.pendingCount).toBe(2);

    // runtime 重启：代际从 1 变为 2，上一代的挂起项一律作废
    const cleared = service.clearGeneration(TARGET, 1, "generation");
    expect(cleared).toBe(2);
    // 渲染侧的 uiRequests 长度归 0 —— 这里以主进程侧的挂起表为等价判据
    expect(service.pendingCount).toBe(0);

    const all = host.pushes.filter((p) => p.channel === PUSH_CHANNELS.piUiExpireAll);
    expect(all).toHaveLength(1);
    expect(all[0].payload).toEqual({ generation: 1, reason: "generation" });

    // 对旧 id 作答：返回 expired，不抛、不写 stdin、不产生未处理 rejection
    for (const stale of [a, b]) {
      const result = service.respond(TARGET, {
        type: "extension_ui_response",
        id: stale.id,
        cancelled: true,
      });
      expect(result).toEqual({ ok: false, reason: "expired" });
    }
    expect(host.respondSpy).toHaveBeenCalledTimes(0);

    await tick();
    expect(unhandled).toBe(0);
  });

  it("新代际的挂起项不会被上一代的清理误伤", () => {
    const service = new ExtensionUiService(makeHost());
    const old = req("input");
    const fresh = req("input");
    service.track(TARGET, 1, old);
    service.track(TARGET, 2, fresh);

    service.clearGeneration(TARGET, 1, "generation");
    expect(service.pendingIds()).toEqual([fresh.id]);
  });

  it("清理只作用于本窗口，另一个窗口的挂起项原样保留", () => {
    const service = new ExtensionUiService(makeHost());
    const mine = req("confirm");
    const other = req("confirm");
    service.track(TARGET, 1, mine);
    service.track(TARGET + 1, 1, other);

    service.clearGeneration(TARGET, 1, "runtime-gone");
    expect(service.pendingIds()).toEqual([other.id]);
  });

  it("代际清理同时清掉 fire-and-forget 状态（widget / title / status 不跨会话残留）", () => {
    const service = new ExtensionUiService(makeHost());
    service.track(TARGET, 1, req("setWidget", { widgetKey: "w", widgetLines: ["1"] }));
    service.track(TARGET, 1, req("setTitle", { title: "old session" }));
    expect(service.snapshot(TARGET).widgets).toHaveLength(1);

    service.clearGeneration(TARGET, 1, "generation");
    const snap = service.snapshot(TARGET);
    expect(snap.widgets).toHaveLength(0);
    expect(snap.title).toBe("");
  });
});

describe("窗口 reload 的恢复语义", () => {
  it("runtime 还在时快照原样返回挂起项", () => {
    const service = new ExtensionUiService(makeHost());
    const a = req("editor", { prefill: "draft" });
    service.track(TARGET, 1, a);
    expect(service.snapshot(TARGET).requests).toEqual([a]);
  });

  it("runtime 已随 reload 重启时快照为空 —— 这是正确答案，不是恢复失败", () => {
    const service = new ExtensionUiService(makeHost());
    service.track(TARGET, 1, req("editor"));
    service.clearGeneration(TARGET, 1, "runtime-gone");
    expect(service.snapshot(TARGET).requests).toEqual([]);
  });

  it("forgetTarget 不广播（没人收），但定时器一个不留", () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    service.track(TARGET, 1, req("select", { options: ["a"], timeout: 60_000 }));
    service.forgetTarget(TARGET);
    expect(service.pendingTimerCount).toBe(0);
    expect(host.pushes).toHaveLength(0);
  });
});

describe("多请求排队", () => {
  it("挂起表按到达顺序保序 —— 渲染侧一次只问一个", () => {
    const service = new ExtensionUiService(makeHost());
    const ids = ["select", "confirm", "input", "editor"].map((m) => {
      const r = req(m as "select");
      service.track(TARGET, 1, r);
      return r.id;
    });
    expect(service.pendingIds()).toEqual(ids);

    // 回答中间那一条，其余顺序不变
    service.respond(TARGET, { type: "extension_ui_response", id: ids[1], confirmed: true });
    expect(service.pendingIds()).toEqual([ids[0], ids[2], ids[3]]);
  });

  it("同 id 重发：旧定时器被清掉，不会冒出两条 expire", async () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    const first = req("confirm", { timeout: 30 });
    service.track(TARGET, 1, first);
    service.track(TARGET, 1, { ...first, timeout: 30 });
    expect(service.pendingCount).toBe(1);
    expect(service.pendingTimerCount).toBe(1);

    await new Promise((r) => setTimeout(r, 70));
    expect(host.pushes.filter((p) => p.channel === PUSH_CHANNELS.piUiExpire)).toHaveLength(1);
  });
});

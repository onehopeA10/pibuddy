/**
 * Extension UI 协议的契约测试（rpc.md:1170-1310）。
 *
 * 断言的对象是**常量表**而不是数字 9：升级 pi 之后上游多一个 method，
 * 这里会自动变严，而硬编码 9 的写法会照样全绿 —— 那个新方法在产品里会
 * 落进 default 分支被静默丢弃，恰恰是这次要根除的那类缺陷。
 */
import { describe, expect, it } from "vitest";
import { PUSH_CHANNELS } from "@pibuddy/contract";
import {
  EXTENSION_UI_DIALOG_METHODS,
  EXTENSION_UI_METHODS,
  type ExtensionUiResponse,
} from "@pibuddy/pi-sdk";
import { ExtensionUiService, routeOf } from "./ext-ui-service.js";
import { makeHost, req } from "./ext-ui-fixtures.js";

const TARGET = 7;

describe("九个 method 全覆盖（表驱动，不硬编码数量）", () => {
  it("EXTENSION_UI_METHODS 与 rpc.md 列出的方法集合一致", () => {
    expect([...EXTENSION_UI_METHODS].sort()).toEqual([
      "confirm",
      "editor",
      "input",
      "notify",
      "select",
      "setStatus",
      "setTitle",
      "setWidget",
      "set_editor_text",
    ]);
    // dialog 四法是 EXTENSION_UI_METHODS 的真子集
    for (const m of EXTENSION_UI_DIALOG_METHODS) {
      expect(EXTENSION_UI_METHODS).toContain(m);
    }
  });

  it.each(EXTENSION_UI_METHODS.map((m) => [m] as const))(
    "%s 被路由到一个确定的处理分支（没有一个落进 default）",
    (method) => {
      const service = new ExtensionUiService(makeHost());
      const branch = service.track(TARGET, 1, req(method));
      expect(branch).toBe(routeOf(method));
      expect(["dialog", "notify", "status", "widget", "title", "editorText"]).toContain(branch);
    }
  );

  it("只有 dialog 四法进入挂起表，其余五法一律 fire-and-forget", () => {
    const service = new ExtensionUiService(makeHost());
    for (const method of EXTENSION_UI_METHODS) {
      service.track(TARGET, 1, req(method));
    }
    expect(service.pendingCount).toBe(EXTENSION_UI_DIALOG_METHODS.length);
  });

  it("setWidget / setTitle 不再被静默丢弃：状态进了主进程快照", () => {
    const service = new ExtensionUiService(makeHost());
    service.track(
      TARGET,
      1,
      req("setWidget", { widgetKey: "w1", widgetLines: ["a", "b"], widgetPlacement: "belowEditor" })
    );
    service.track(TARGET, 1, req("setTitle", { title: "my project" }));
    service.track(TARGET, 1, req("setStatus", { statusKey: "k", statusText: "AUTO" }));
    service.track(TARGET, 1, req("set_editor_text", { text: "prefilled" }));

    const snap = service.snapshot(TARGET);
    expect(snap.widgets).toEqual([
      { key: "w1", lines: ["a", "b"], placement: "belowEditor" },
    ]);
    expect(snap.title).toBe("my project");
    expect(snap.statuses).toEqual([{ key: "k", text: "AUTO" }]);
    expect(snap.editorText).toBe("prefilled");
  });
});

describe("四个 dialog 方法各自的三种响应形状", () => {
  it.each(EXTENSION_UI_DIALOG_METHODS.map((m) => [m] as const))(
    "%s 能产出 value / confirmed / cancelled 三种响应",
    (method) => {
      const shapes: ExtensionUiResponse[] = [];
      for (const payload of [{ value: "x" }, { confirmed: true }, { cancelled: true }]) {
        const host = makeHost();
        const service = new ExtensionUiService(host);
        const request = req(method);
        service.track(TARGET, 1, request);

        const result = service.respond(TARGET, {
          type: "extension_ui_response",
          id: request.id,
          ...payload,
        });
        expect(result).toEqual({ ok: true });
        expect(host.writes).toHaveLength(1);
        shapes.push(host.writes[0]);
      }
      expect(shapes[0].value).toBe("x");
      expect(shapes[1].confirmed).toBe(true);
      expect(shapes[2].cancelled).toBe(true);
    }
  );

  it("同一条只能被回答一次；第二次是 expired 且不再写 stdin", () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    const request = req("confirm");
    service.track(TARGET, 1, request);

    expect(service.respond(TARGET, {
      type: "extension_ui_response",
      id: request.id,
      confirmed: true,
    })).toEqual({ ok: true });

    expect(service.respond(TARGET, {
      type: "extension_ui_response",
      id: request.id,
      confirmed: false,
    })).toEqual({ ok: false, reason: "expired" });

    expect(host.respondSpy).toHaveBeenCalledTimes(1);
  });

  it("runtime 不在时返回 no-runtime，且一次 stdin 都没写", () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    const request = req("input");
    service.track(TARGET, 1, request);
    host.alive = false;

    expect(
      service.respond(TARGET, {
        type: "extension_ui_response",
        id: request.id,
        value: "v",
      })
    ).toEqual({ ok: false, reason: "no-runtime" });
    expect(host.respondSpy).toHaveBeenCalledTimes(0);
  });
});

describe("fire-and-forget 的清除语义（rpc.md:1265 / :1283）", () => {
  it("statusText 缺席即清除该 key", () => {
    const service = new ExtensionUiService(makeHost());
    service.track(TARGET, 1, req("setStatus", { statusKey: "k", statusText: "on" }));
    expect(service.snapshot(TARGET).statuses).toHaveLength(1);
    service.track(TARGET, 1, req("setStatus", { statusKey: "k" }));
    expect(service.snapshot(TARGET).statuses).toHaveLength(0);
  });

  it("widgetLines 缺席即删除该 widget", () => {
    const service = new ExtensionUiService(makeHost());
    service.track(TARGET, 1, req("setWidget", { widgetKey: "w", widgetLines: ["x"] }));
    expect(service.snapshot(TARGET).widgets).toHaveLength(1);
    service.track(TARGET, 1, req("setWidget", { widgetKey: "w" }));
    expect(service.snapshot(TARGET).widgets).toHaveLength(0);
  });

  it("expire 只广播、绝不向 pi 补写响应（上游已自行 auto-resolve）", () => {
    const host = makeHost();
    const service = new ExtensionUiService(host);
    const request = req("select", { options: ["A", "B"] });
    service.track(TARGET, 1, request);

    expect(service.expire(request.id, "timeout")).toBe(true);
    expect(host.respondSpy).toHaveBeenCalledTimes(0);
    expect(host.pushes).toEqual([
      {
        targetId: TARGET,
        channel: PUSH_CHANNELS.piUiExpire,
        payload: { id: request.id, reason: "timeout" },
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
// 用契约里**真实的** zod schema，而不是手搓一个「长得像 schema 的对象」——
// 这条读取器唯一会出错的地方就是 zod 的内部形状，拿假对象测等于没测。
import { automationTriggerSchema, homeCallServiceArgsSchema } from "@pibuddy/contract";

import {
  LOOP_GATE_IDENTICAL_THRESHOLD,
  ToolLoopGate,
  ToolOutcomeUnknownError,
  formatToolArgsViolationText,
  toolParameterFields,
  uncertainOutcomeFromError,
} from "./tool-guards";

/** 走一遍「签名 → 判是否被拦 → 记账」的完整闭环，与生产路径同序。 */
function attempt(gate: ToolLoopGate, tool: string, args: unknown, failed: boolean): boolean {
  const signature = gate.signatureOf(tool, args, `call-${Math.random()}`);
  if (gate.blocked(signature)) return true; // 被拦的这次不记账
  gate.record(signature, failed);
  return false;
}

describe("循环闸：判据是「连续」，不是「累计」", () => {
  it(`同一 tool+args 连续失败 ${LOOP_GATE_IDENTICAL_THRESHOLD} 次即被拦，且之后每次重复都继续被拦`, () => {
    const gate = new ToolLoopGate();
    expect(attempt(gate, "home.light.set", { on: true }, true)).toBe(false);
    expect(attempt(gate, "home.light.set", { on: true }, true)).toBe(false);
    // 第 3 次：前两次已经连续失败，这一次不再真的执行。
    expect(attempt(gate, "home.light.set", { on: true }, true)).toBe(true);
    // 被拦的那次不记账 ⇒ 连击停在阈值上 ⇒ 后面每次一模一样的重复都继续被拦。
    expect(attempt(gate, "home.light.set", { on: true }, true)).toBe(true);
    expect(attempt(gate, "home.light.set", { on: true }, true)).toBe(true);
  });

  it("轮询不被误伤：同一个查询反复调，只要没失败就永远不被拦", () => {
    const gate = new ToolLoopGate();
    // 轮询「还没好」是一次**成功**的调用（工具正常返回了一个「未就绪」）。
    for (let i = 0; i < 10; i += 1) {
      expect(attempt(gate, "task.status", { id: "t1" }, false)).toBe(false);
    }
  });

  it("轮询不被误伤：失败与成功交替时连击一直被清零（累计计数在这里早就拦死了）", () => {
    const gate = new ToolLoopGate();
    let failures = 0;
    // 服务还没起来 → 连接被拒（失败）；起来了 → 成功。真实轮询就长这样。
    for (let i = 0; i < 6; i += 1) {
      expect(attempt(gate, "net.probe", { url: "http://127.0.0.1:1" }, true)).toBe(false);
      failures += 1;
      expect(attempt(gate, "net.probe", { url: "http://127.0.0.1:1" }, false)).toBe(false);
    }
    // 累计失败已经 6 次，累计判据在第 3 次就该拦死；连续判据一次都没拦。
    expect(failures).toBe(6);
  });

  it("改了再测不被误伤：中间插一次别的调用就断开连击", () => {
    const gate = new ToolLoopGate();
    attempt(gate, "run.test", { name: "a" }, true);
    attempt(gate, "run.test", { name: "a" }, true);
    // 中间去改了个文件（一次不同的调用）。
    expect(attempt(gate, "edit.file", { path: "a.ts" }, false)).toBe(false);
    // 再跑同一条测试：连击已断，照常执行。
    expect(attempt(gate, "run.test", { name: "a" }, true)).toBe(false);
    expect(attempt(gate, "run.test", { name: "a" }, true)).toBe(false);
    expect(attempt(gate, "run.test", { name: "a" }, true)).toBe(true);
  });

  it("实参差一个字节就是另一次调用，不共用连击", () => {
    const gate = new ToolLoopGate();
    attempt(gate, "home.light.set", { on: true }, true);
    attempt(gate, "home.light.set", { on: true }, true);
    expect(attempt(gate, "home.light.set", { on: false }, true)).toBe(false);
  });

  it("实参不是严格 JSON 时签名每次不同 —— 拦不住的是我们算不出哈希，不该记在模型头上", () => {
    const gate = new ToolLoopGate();
    const bad = { when: new Date(0) };
    for (let i = 0; i < 5; i += 1) {
      expect(attempt(gate, "x.y", bad, true)).toBe(false);
    }
  });

  it("reset 清空连击（换一轮）", () => {
    const gate = new ToolLoopGate();
    attempt(gate, "a", 1, true);
    attempt(gate, "a", 1, true);
    gate.reset();
    expect(attempt(gate, "a", 1, true)).toBe(false);
  });
});

describe("不确定档：独立于失败，且 retrySafe 恒 false", () => {
  it("ToolOutcomeUnknownError → outcome_unknown / retrySafe:false", () => {
    const signal = uncertainOutcomeFromError(
      new ToolOutcomeUnknownError("请求已送出，回执丢了")
    );
    expect(signal).toEqual({
      code: "outcome_unknown",
      retrySafe: false,
      detail: "请求已送出，回执丢了",
    });
  });

  it("普通失败不进不确定档 —— 那是可以放心重试的一档", () => {
    expect(uncertainOutcomeFromError(new Error("端点拒绝"))).toBeUndefined();
    expect(uncertainOutcomeFromError("boom")).toBeUndefined();
  });
});

describe("参数违规回执：`[]` 与 undefined 是两个不同的答案", () => {
  it("读得出 schema → 报出字段名（模型据此能改）", () => {
    expect(toolParameterFields(homeCallServiceArgsSchema)).toEqual([
      "data",
      "domain",
      "entity_id",
      "service",
    ]);
    const text = formatToolArgsViolationText({
      toolName: "home.call_service",
      parameters: homeCallServiceArgsSchema,
      args: { entityId: "light.a" },
      error: new Error("domain 缺失"),
    });
    expect(text).toContain("entity_id");
    expect(text).toContain("service");
  });

  it("schema 明说不收参数（`[]`）→ 就这么说", () => {
    expect(toolParameterFields({ shape: {} })).toEqual([]);
    expect(
      formatToolArgsViolationText({
        toolName: "home.ping",
        parameters: { shape: {} },
        args: { x: 1 },
        error: new Error("多了字段"),
      })
    ).toContain("不接受任何参数");
  });

  it("schema 读不出来（undefined）→ 什么都不说，绝不渲染成空列表", () => {
    // 没有判定键的普通联合：哪一支都可能，说不出接受什么。
    const union = { options: [{ shape: { a: {} } }, { shape: { b: {} } }] };
    expect(toolParameterFields(union)).toBeUndefined();
    expect(toolParameterFields(undefined)).toBeUndefined();

    const text = formatToolArgsViolationText({
      toolName: "mystery",
      parameters: union,
      args: { a: 1 },
      error: new Error("形状不对"),
    });
    // 关键判据：不能出现「不接受任何参数」—— 那是把「不知道」教成了一条假事实。
    expect(text).not.toContain("不接受任何参数");
    expect(text).not.toContain("接受这些字段");
    expect(text).toContain("形状不对");
  });

  it("有判定键的联合：按模型给的那一支报字段；判定键本身填错则什么都不说", () => {
    expect(toolParameterFields(automationTriggerSchema, { kind: "time" })).toEqual([
      "kind",
      "time",
    ]);
    expect(toolParameterFields(automationTriggerSchema, { kind: "state" })).toEqual([
      "entityId",
      "from",
      "kind",
      "to",
    ]);
    expect(toolParameterFields(automationTriggerSchema, { kind: "spin" })).toBeUndefined();
    expect(toolParameterFields(automationTriggerSchema, {})).toBeUndefined();
  });

  it("第三方 / MCP 的 JSON Schema 也读得出 properties", () => {
    expect(
      toolParameterFields({ jsonSchema: { type: "object", properties: { q: {}, limit: {} } } })
    ).toEqual(["limit", "q"]);
  });

  it("schema 读的时候抛错 → 退回 undefined，绝不退回一个错的列表", () => {
    const hostile = {
      get shape(): never {
        throw new Error("第三方 getter 炸了");
      },
    };
    expect(toolParameterFields(hostile)).toBeUndefined();
  });
});

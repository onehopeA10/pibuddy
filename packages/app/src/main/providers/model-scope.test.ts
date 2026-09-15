/**
 * 模型作用域三层解析（PROV-101）。
 *
 * 8 种取值组合逐一断言：三层各有 / 各无，共 2³ = 8 种。逐一写出而不是
 * 循环生成，是因为**每一行的期望值都要人读一遍才算数** —— 用生成器算
 * 期望值等于用被测逻辑验证被测逻辑。
 */
import { describe, expect, it } from "vitest";
import type { ModelRef } from "@pibuddy/contract";

import { resolveModel } from "./model-scope.js";

const S: ModelRef = { provider: "anthropic", modelId: "session-model" };
const W: ModelRef = { provider: "openai", modelId: "workspace-model" };
const G: ModelRef = { provider: "google", modelId: "global-model" };

describe("优先级恒为 session > workspace > global", () => {
  it("(1) 三层都有 → session 赢，且与 workspace 不同故 mismatch", () => {
    const r = resolveModel({ sessionModel: S, workspaceDefault: W, globalDefault: G });
    expect(r.model).toEqual(S);
    expect(r.source).toBe("session");
    expect(r.mismatch).toBe(true);
    // 「切换」按钮的目标是 workspace 层（它才是没有 session 时会生效的那个）
    expect(r.wouldBe).toEqual(W);
  });

  it("(2) session + workspace → session 赢", () => {
    const r = resolveModel({ sessionModel: S, workspaceDefault: W });
    expect(r.model).toEqual(S);
    expect(r.source).toBe("session");
    expect(r.mismatch).toBe(true);
    expect(r.wouldBe).toEqual(W);
  });

  it("(3) session + global → session 赢，切换目标是 global", () => {
    const r = resolveModel({ sessionModel: S, globalDefault: G });
    expect(r.model).toEqual(S);
    expect(r.source).toBe("session");
    expect(r.mismatch).toBe(true);
    expect(r.wouldBe).toEqual(G);
  });

  it("(4) 只有 session → 赢，但没有可切换目标，不算 mismatch", () => {
    const r = resolveModel({ sessionModel: S });
    expect(r.model).toEqual(S);
    expect(r.source).toBe("session");
    // 没有 fallback 时也不构成对照差异
    expect(r.mismatch).toBe(false);
    expect(r.wouldBe).toBeNull();
  });

  it("(5) workspace + global → workspace 赢", () => {
    const r = resolveModel({ workspaceDefault: W, globalDefault: G });
    expect(r.model).toEqual(W);
    expect(r.source).toBe("workspace");
    expect(r.mismatch).toBe(false);
  });

  it("(6) 只有 workspace → 赢", () => {
    const r = resolveModel({ workspaceDefault: W });
    expect(r.model).toEqual(W);
    expect(r.source).toBe("workspace");
    expect(r.mismatch).toBe(false);
  });

  it("(7) 只有 global → 赢", () => {
    const r = resolveModel({ globalDefault: G });
    expect(r.model).toEqual(G);
    expect(r.source).toBe("global");
    expect(r.mismatch).toBe(false);
  });

  it("(8) 三层都空 → null + source:'none'（界面走 no-model 空状态）", () => {
    const r = resolveModel({});
    expect(r.model).toBeNull();
    expect(r.source).toBe("none");
    expect(r.mismatch).toBe(false);
    expect(r.wouldBe).toBeNull();
  });
});

describe("mismatch 的边界", () => {
  it("session 与 fallback 完全相同时不 mismatch（不该弹一个无意义的问题）", () => {
    const r = resolveModel({ sessionModel: { ...W }, workspaceDefault: W, globalDefault: G });
    expect(r.mismatch).toBe(false);
  });

  it("provider 相同但 modelId 不同 → 仍算 mismatch", () => {
    const r = resolveModel({
      sessionModel: { provider: "openai", modelId: "a" },
      workspaceDefault: { provider: "openai", modelId: "b" },
    });
    expect(r.mismatch).toBe(true);
  });

  it("modelId 相同但 provider 不同 → 仍算 mismatch（同名模型在两家价格不同）", () => {
    const r = resolveModel({
      sessionModel: { provider: "openai", modelId: "x" },
      workspaceDefault: { provider: "openrouter", modelId: "x" },
    });
    expect(r.mismatch).toBe(true);
  });
});

describe("脏数据一律当成「这一层没设」", () => {
  it("空串 / null / 缺字段都被规范化掉", () => {
    expect(resolveModel({ sessionModel: { provider: "", modelId: "x" } }).source).toBe("none");
    expect(resolveModel({ sessionModel: { provider: "a", modelId: "  " } }).source).toBe("none");
    expect(resolveModel({ sessionModel: null, workspaceDefault: W }).source).toBe("workspace");
    expect(
      resolveModel({ sessionModel: { provider: "a" } as unknown as ModelRef }).source
    ).toBe("none");
  });
});

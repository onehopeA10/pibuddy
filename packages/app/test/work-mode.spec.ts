import { describe, expect, it } from "vitest";
import {
  applyWorkMode,
  isPlanApprove,
  PLAN_INSTRUCTION,
  stripPlanInstruction,
} from "../src/lib/work-mode.js";

describe("work-mode", () => {
  it("直接干不改原文", () => {
    expect(applyWorkMode("整理表格", "act")).toBe("整理表格");
  });

  it("先看方案加上宿主约束，批准口令不再加", () => {
    const planned = applyWorkMode("整理表格", "plan");
    expect(planned.startsWith(PLAN_INSTRUCTION)).toBe(true);
    expect(planned.endsWith("整理表格")).toBe(true);
    expect(applyWorkMode("按这个做", "plan")).toBe("按这个做");
    expect(isPlanApprove("按这个方案执行。")).toBe(true);
  });

  it("回显时裁掉前缀", () => {
    const full = applyWorkMode("整理表格", "plan");
    expect(stripPlanInstruction(full)).toBe("整理表格");
    expect(stripPlanInstruction("普通一句话")).toBe("普通一句话");
  });
});

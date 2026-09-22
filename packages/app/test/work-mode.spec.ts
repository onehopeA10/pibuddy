import { describe, expect, it } from "vitest";
import {
  applyWorkMode,
  isPlanApprove,
  PLAN_INSTRUCTION,
  stripPlanInstruction,
} from "../src/lib/work-mode.js";
import { isPureGreeting } from "../src/lib/pure-greeting.js";

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

  it("纯问候不追加方案约束，带任务文本的问候仍按正常任务处理", () => {
    for (const greeting of ["你好", " 您好！ ", "hi", "HELLO...", "hey？！"]) {
      expect(isPureGreeting(greeting)).toBe(true);
      expect(applyWorkMode(greeting, "plan")).toBe(greeting);
    }

    for (const request of ["你好，继续上次报告", "hello, review this change", "hey there"]) {
      expect(isPureGreeting(request)).toBe(false);
      expect(applyWorkMode(request, "plan")).toBe(`${PLAN_INSTRUCTION}\n\n${request}`);
    }
  });

  it("普通问答使用条件式计划约束，回显仍保留完整原问题", () => {
    for (const question of ["今天天气如何", "那明天呢", "请解释这个概念", "帮我翻译这句话"]) {
      const prepared = applyWorkMode(question, "plan");
      expect(prepared).toContain("只使用相关背景");
      expect(prepared).toContain("知识问答和只读查询正常处理，不强制生成实施方案");
      expect(prepared).toContain("批准前不要执行这些操作");
      expect(stripPlanInstruction(prepared)).toBe(question);
    }
  });

  it("回显时裁掉前缀", () => {
    const full = applyWorkMode("整理表格", "plan");
    expect(stripPlanInstruction(full)).toBe("整理表格");
    expect(stripPlanInstruction("普通一句话")).toBe("普通一句话");
  });
});

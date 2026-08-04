/**
 * 用量汇总纯函数（R5.2）的口径测试。
 *
 * 钉死三件容易悄悄错掉的事：「近 7 日」含今天共 7 个自然日、跨月边界的
 * 日期回退、未来 / 更早的数据不混进 last7。
 */
import { describe, expect, it } from "vitest";
import { localDayOf, summarizeUsage } from "./usage-summary";

function row(day: string, inputTokens: number, outputTokens = 0, cost = 0) {
  return { day, inputTokens, outputTokens, cost };
}

describe("summarizeUsage", () => {
  it("今日 / 近 7 日 / 累计三档口径正确", () => {
    const rows = [
      row("2026-08-04", 100, 10, 0.1), // 今天
      row("2026-07-29", 200, 20, 0.2), // 7 天窗口的第一天（含）
      row("2026-07-28", 400, 40, 0.4), // 窗口外，只进累计
    ];
    const s = summarizeUsage(rows, "2026-08-04");
    expect(s.today).toEqual({ inputTokens: 100, outputTokens: 10, cost: 0.1 });
    expect(s.last7.inputTokens).toBe(300);
    expect(s.last7.cost).toBeCloseTo(0.3, 6);
    expect(s.total.inputTokens).toBe(700);
    expect(s.total.outputTokens).toBe(70);
  });

  it("跨月边界：8 月 3 日的近 7 日窗口回退到 7 月 28 日", () => {
    const s = summarizeUsage([row("2026-07-28", 50), row("2026-07-27", 60)], "2026-08-03");
    expect(s.last7.inputTokens).toBe(50); // 7-27 在窗口外
    expect(s.total.inputTokens).toBe(110);
  });

  it("空数据得全零，不抛错", () => {
    const s = summarizeUsage([], "2026-08-04");
    expect(s.today.inputTokens).toBe(0);
    expect(s.last7.cost).toBe(0);
    expect(s.total.outputTokens).toBe(0);
  });

  it("localDayOf 输出本地时区的 YYYY-MM-DD", () => {
    // 本地时区正午不存在跨日歧义，直接和 Date 的本地分量对齐
    const ts = new Date(2026, 7, 4, 12, 0, 0).getTime();
    expect(localDayOf(ts)).toBe("2026-08-04");
  });
});

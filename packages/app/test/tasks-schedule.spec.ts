import { describe, expect, it } from "vitest";

import { parseCron, cronMatches, cronDayMatches } from "../src/main/tasks/cron.js";
import {
  computeNextRun,
  wallToEpoch,
  zonedParts,
} from "../src/main/tasks/schedule.js";
import { planMisfire } from "../src/main/tasks/misfire.js";
import type { TaskSchedule } from "@pibuddy/contract";

/**
 * 计划解析 + 时区 / DST / 时钟回拨 / 错过运行的可证伪测试。
 *
 * 这一批全部**用真实的时序制造那个病态**再断言具体的 epoch / 槽位集合，
 * 而不是断言「函数被调用了」。DST 用 America/New_York 的真实切换日
 * （2026 春季前跳 3/8 02:00→03:00、秋季回拨 11/1 02:00→01:00）。
 */

const SH = "Asia/Shanghai"; // UTC+8，无 DST
const NY = "America/New_York";

describe("时区换算（无 DST 的基准）", () => {
  it("Asia/Shanghai 09:00 = 该日 01:00 UTC", () => {
    // from = 2026-06-01T00:00:00Z（上海 08:00），下一次 09:00 上海 = 01:00 UTC。
    const from = Date.UTC(2026, 5, 1, 0, 0, 0);
    const next = computeNextRun({ kind: "daily", time: "09:00" }, SH, from);
    expect(next).toBe(Date.UTC(2026, 5, 1, 1, 0, 0));
  });

  it("wallToEpoch 与 zonedParts 互为逆（上海）", () => {
    const w = { year: 2026, month: 7, day: 15, hour: 14, minute: 30, second: 0 };
    const { epoch, exists } = wallToEpoch(w, SH);
    expect(exists).toBe(true);
    const back = zonedParts(epoch, SH);
    expect([back.hour, back.minute, back.day]).toEqual([14, 30, 15]);
  });
});

describe("DST 春季前跳（gap）：不存在的墙钟时间滚到 gap 之后", () => {
  it("daily 02:30 在 3/8 那天不存在，滚到 03:30 EDT（只跑一次、不静默丢弃）", () => {
    // from = 3/8 00:00Z（NY 前一晚 19:00 EST）。当天 02:30 被前跳吃掉。
    const from = Date.UTC(2026, 2, 8, 0, 0, 0);
    const next = computeNextRun({ kind: "daily", time: "02:30" }, NY, from);
    expect(next).not.toBeNull();
    const p = zonedParts(next!, NY);
    // 滚到 gap 之后：本地时间 03:30。
    expect([p.hour, p.minute, p.day]).toEqual([3, 30, 8]);
  });

  it("wallToEpoch 对 gap 时间返回 exists=false", () => {
    const { exists } = wallToEpoch(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      NY
    );
    expect(exists).toBe(false);
  });

  it("对拍：gap 之外的正常 daily 02:30 存在且落在本地 02:30", () => {
    const from = Date.UTC(2026, 2, 9, 0, 0, 0); // 3/9，DST 已切换完
    const next = computeNextRun({ kind: "daily", time: "02:30" }, NY, from);
    const p = zonedParts(next!, NY);
    expect([p.hour, p.minute]).toEqual([2, 30]);
  });
});

describe("DST 秋季回拨（overlap）：重复的墙钟时间只取较早一次", () => {
  it("daily 01:30 在 11/1 出现两次，解出较早（EDT，05:30 UTC）", () => {
    const from = Date.UTC(2026, 10, 1, 0, 0, 0); // 11/1 00:00Z = 10/31 20:00 EDT
    const next = computeNextRun({ kind: "daily", time: "01:30" }, NY, from);
    // 01:30 EDT = 05:30 UTC（较早的那一次）；不是 06:30 UTC 的 EST 那次。
    expect(next).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
  });

  it("回拨当天不会把同一墙钟槽位跑两遍（catch-up 也只列一次）", () => {
    // sinceMs 设在 01:30 之前，now 设在两次 01:30 都过完之后（07:00 UTC）。
    const schedule: TaskSchedule = { kind: "daily", time: "01:30" };
    const plan = planMisfire({
      schedule,
      timeZone: NY,
      sinceMs: Date.UTC(2026, 10, 1, 4, 0, 0),
      now: Date.UTC(2026, 10, 1, 7, 0, 0),
      policy: "catch-up",
    });
    // 同一天的 01:30 只作为一个槽位出现，绝不因回拨变成两个。
    const onNov1 = plan.dueSlots.filter(
      (s) => zonedParts(s, NY).day === 1 && zonedParts(s, NY).month === 11
    );
    expect(onNov1).toEqual([Date.UTC(2026, 10, 1, 5, 30, 0)]);
  });
});

describe("weekly", () => {
  it("只在选定的星期几触发", () => {
    // 2026-06-01 是周一。选周三(3)+周五(5)，09:00 上海。
    const from = Date.UTC(2026, 5, 1, 0, 0, 0);
    const next = computeNextRun(
      { kind: "weekly", weekdays: [3, 5], time: "09:00" },
      SH,
      from
    );
    // 下一个周三是 6/3。09:00 上海 = 01:00 UTC。
    expect(next).toBe(Date.UTC(2026, 5, 3, 1, 0, 0));
    expect(zonedParts(next!, SH).weekday).toBe(3);
  });
});

describe("once / event", () => {
  it("once 过了就没有下一次", () => {
    const at = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(computeNextRun({ kind: "once", at }, SH, at - 1)).toBe(at);
    expect(computeNextRun({ kind: "once", at }, SH, at)).toBeNull();
    expect(computeNextRun({ kind: "once", at }, SH, at + 1)).toBeNull();
  });

  it("event 不由时钟驱动，恒无下一次", () => {
    expect(computeNextRun({ kind: "event", event: "x" }, SH, 0)).toBeNull();
  });
});

describe("cron 解析与匹配", () => {
  it("*/15 展开成 0,15,30,45", () => {
    const expr = parseCron("*/15 * * * *");
    expect([...expr.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it("区间 + 步长 1-5/2 = 1,3,5", () => {
    const expr = parseCron("1-5/2 * * * *");
    expect([...expr.minutes].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("字段数不对直接抛错，不猜", () => {
    expect(() => parseCron("* * * *")).toThrow(/CRON_INVALID/);
  });

  it("越界抛错", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/CRON_FIELD_INVALID/);
  });

  it("周 7 归一到 0（周日）", () => {
    const expr = parseCron("0 0 * * 7");
    expect(expr.daysOfWeek.has(0)).toBe(true);
  });

  it("日/周 OR 语义：两者都受限时命中任一即算（不是 AND）", () => {
    // 每月 15 号 或 每周一。
    const expr = parseCron("0 0 15 * 1");
    // 15 号但不是周一 → 命中（靠 dom）。
    expect(cronDayMatches(expr, { day: 15, weekday: 3 })).toBe(true);
    // 周一但不是 15 号 → 命中（靠 dow）。
    expect(cronDayMatches(expr, { day: 8, weekday: 1 })).toBe(true);
    // 既不是 15 号也不是周一 → 不命中。
    expect(cronDayMatches(expr, { day: 8, weekday: 3 })).toBe(false);
  });

  it("computeNextRun 对 cron 每天 09:00 上海解出 01:00 UTC", () => {
    const from = Date.UTC(2026, 5, 1, 0, 0, 0);
    const next = computeNextRun({ kind: "cron", expression: "0 9 * * *" }, SH, from);
    expect(next).toBe(Date.UTC(2026, 5, 1, 1, 0, 0));
  });

  it("cronMatches 全字段对账", () => {
    const expr = parseCron("30 9 * * *");
    expect(cronMatches(expr, { minute: 30, hour: 9, day: 1, month: 6, weekday: 1 })).toBe(true);
    expect(cronMatches(expr, { minute: 31, hour: 9, day: 1, month: 6, weekday: 1 })).toBe(false);
  });
});

describe("错过运行（missed run）的三档策略", () => {
  const schedule: TaskSchedule = { kind: "daily", time: "09:00" }; // 上海
  // sinceMs = 6/1 08:00 上海（当天 09:00 之前）；now = 6/3 10:00 上海。
  // 错过了 6/1、6/2、6/3 三个 09:00。
  const sinceMs = Date.UTC(2026, 5, 1, 0, 0, 0);
  const now = Date.UTC(2026, 5, 3, 2, 0, 0); // 6/3 10:00 上海 = 02:00 UTC

  it("skip：错过的一律不补（都超出 grace）", () => {
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs, now, policy: "skip" });
    expect(plan.dueSlots).toEqual([]);
    // 下一次是 6/4 09:00。
    expect(plan.nextAfter).toBe(Date.UTC(2026, 5, 4, 1, 0, 0));
  });

  it("run-once：无论错过多少，只补最近那一个槽位", () => {
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs, now, policy: "run-once" });
    expect(plan.dueSlots).toEqual([Date.UTC(2026, 5, 3, 1, 0, 0)]); // 6/3 09:00
  });

  it("catch-up：逐个补跑错过的每一次", () => {
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs, now, policy: "catch-up" });
    expect(plan.dueSlots).toEqual([
      Date.UTC(2026, 5, 1, 1, 0, 0),
      Date.UTC(2026, 5, 2, 1, 0, 0),
      Date.UTC(2026, 5, 3, 1, 0, 0),
    ]);
  });

  it("时钟回拨：now 早于 sinceMs → 一个槽位都不产生（不重复触发）", () => {
    const plan = planMisfire({
      schedule,
      timeZone: SH,
      sinceMs: Date.UTC(2026, 5, 3, 1, 0, 0),
      now: Date.UTC(2026, 5, 1, 0, 0, 0), // 时钟被拨回两天
      policy: "catch-up",
    });
    expect(plan.dueSlots).toEqual([]);
  });

  it("准点触发（grace 窗口内）：skip 也会跑刚到点的那次", () => {
    // now 恰在 09:00 之后 5 秒。
    const at = Date.UTC(2026, 5, 1, 1, 0, 0);
    const plan = planMisfire({
      schedule,
      timeZone: SH,
      sinceMs: Date.UTC(2026, 4, 31, 12, 0, 0),
      now: at + 5000,
      policy: "skip",
    });
    expect(plan.dueSlots).toEqual([at]);
  });
});

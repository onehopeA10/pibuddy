import { describe, expect, it } from "vitest";

import { computeNextRun, wallToEpoch, zonedParts } from "../src/main/tasks/schedule.js";
import { planMisfire, MAX_CATCHUP_SLOTS } from "../src/main/tasks/misfire.js";
import type { TaskSchedule } from "@pibuddy/contract";

/**
 * DST / 时钟回拨 / 错过运行的**补充**边界 case（FEAT-tasks.md §2 / §8）——补齐
 * 既有 tasks-schedule.spec 未覆盖的时序：sleep/wake 前跳、weekly / cron 落在
 * 春季 gap、catch-up 封顶、planMisfire 的 nextAfter 不变量。
 *
 * 断言的都是**具体 epoch / 具体条数**，用 America/New_York 真实切换日
 * （2026 春 3/8 02:00→03:00、秋 11/1 02:00→01:00）制造时序，不是「函数被调用」。
 */

const NY = "America/New_York";
const SH = "Asia/Shanghai";

describe("sleep / wake：时钟大幅前跳后，三档 misfire 策略各自的行为", () => {
  // 每天 09:00 上海（无 DST，= 01:00 UTC），App 从 6/1 睡到 6/4。
  const schedule: TaskSchedule = { kind: "daily", time: "09:00" };
  const slot = (d: number) => Date.UTC(2026, 5, 1 + d, 1, 0, 0);
  const since = Date.UTC(2026, 5, 1, 0, 0, 0); // 排他下界，早于 slot(0)
  const now = slot(3) + 30_000; // 醒在 6/4 槽位后 30s（准点窗口内）

  it("catch-up：逐个补跑错过的每一天（4 个槽位）", () => {
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs: since, now, policy: "catch-up" });
    expect(plan.dueSlots).toEqual([slot(0), slot(1), slot(2), slot(3)]);
    // nextAfter 严格晚于 now，绝不停在过去的槽位。
    expect(plan.nextAfter).toBe(slot(4));
    expect(plan.nextAfter! > now).toBe(true);
  });

  it("run-once：无论睡多久，只补最近那一个槽位", () => {
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs: since, now, policy: "run-once" });
    expect(plan.dueSlots).toEqual([slot(3)]);
  });

  it("skip：只跑落在 grace 窗口内的准点那次，错过的历史一律不补", () => {
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs: since, now, policy: "skip" });
    expect(plan.dueSlots).toEqual([slot(3)]);
  });

  it("skip：连准点都错过很久（超出 grace）→ 一个都不补", () => {
    const lateNow = slot(3) + 10 * 60_000; // 晚 10 分钟，超出 60s grace
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs: since, now: lateNow, policy: "skip" });
    expect(plan.dueSlots).toEqual([]);
    expect(plan.nextAfter).toBe(slot(4));
  });
});

describe("weekly 落在春季 gap：不存在的墙钟时间滚到 gap 之后，绝不静默丢弃", () => {
  it("weekly 周日 02:30、3/8 那天 02:30 不存在 → 解到 03:30 EDT（07:30 UTC）", () => {
    // 3/8/2026 是周日，也是春季前跳日；02:30 被跳过。
    const schedule: TaskSchedule = { kind: "weekly", time: "02:30", weekdays: [0] };
    const from = Date.UTC(2026, 2, 8, 0, 0, 0); // 3/8 00:00 UTC = 3/7 19:00 EST（周六晚）
    const next = computeNextRun(schedule, NY, from);
    expect(next).toBe(Date.UTC(2026, 2, 8, 7, 30, 0)); // 03:30 EDT
    // 解出来的本地时间确实是 03:30（gap 之后），不是被吞掉。
    const p = zonedParts(next!, NY);
    expect([p.hour, p.minute]).toEqual([3, 30]);
  });
});

describe("cron 落在春季 gap：与 daily/weekly 语义不同——cron 跳过不存在的墙钟分钟", () => {
  // 记录一处真实的语义分歧（诚实标注，不擅自改 cron gap 行为）：
  //   - daily / weekly 用 wallToEpoch，gap 时**滚到 gap 之后**（02:30→03:30）；
  //   - cron 逐「真实墙钟分钟」扫描匹配，而 gap 那一分钟（02:30）根本不存在于
  //     任何真实 epoch，于是 cron 直接**跳过这一次**，落到下一个真实存在的匹配
  //     （下周日 02:30 EDT）。这不是 bug，是「cron 匹配的是真实发生过的墙钟分钟」
  //     这一定义的自然结果——但它与 daily 的 roll-forward 不一致，值得钉住以防
  //     日后有人无意改动其中一侧。
  it("cron 30 2 * * 0 在 3/8（gap）→ 跳到下一个存在的周日 02:30（3/15 EDT，06:30 UTC）", () => {
    const schedule: TaskSchedule = { kind: "cron", expression: "30 2 * * 0" };
    const from = Date.UTC(2026, 2, 8, 0, 0, 0);
    const next = computeNextRun(schedule, NY, from);
    expect(next).toBe(Date.UTC(2026, 2, 15, 6, 30, 0));
    const p = zonedParts(next!, NY);
    expect([p.hour, p.minute, p.weekday]).toEqual([2, 30, 0]); // 02:30、周日、真实存在
  });
});

describe("秋季回拨：daily 落在 overlap 的墙钟只算一次、取较早", () => {
  it("wallToEpoch 对 11/1 01:30 返回较早一次（EDT，05:30 UTC）且 exists", () => {
    const r = wallToEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, NY);
    expect(r.exists).toBe(true);
    expect(r.epoch).toBe(Date.UTC(2026, 10, 1, 5, 30, 0)); // 01:30 EDT = 05:30 UTC（较早）
  });

  it("computeNextRun daily 01:30 跨回拨日：解出较早那一次，回拨不制造第二次", () => {
    const schedule: TaskSchedule = { kind: "daily", time: "01:30" };
    const from = Date.UTC(2026, 10, 1, 0, 0, 0); // 11/1 00:00 UTC = 10/31 20:00 EDT
    const next = computeNextRun(schedule, NY, from);
    expect(next).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
  });
});

describe("catch-up 封顶：积压超过 MAX_CATCHUP_SLOTS 时截断并如实报告 dropped", () => {
  it("每分钟 cron 睡过 1001+ 个槽位 → 恰好补 MAX 个，dropped 标记还有更多", () => {
    const schedule: TaskSchedule = { kind: "cron", expression: "* * * * *" };
    const since = Date.UTC(2026, 5, 1, 0, 0, 0);
    const now = since + (MAX_CATCHUP_SLOTS + 2) * 60_000; // 制造 >MAX 个到期槽位
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs: since, now, policy: "catch-up" });
    expect(plan.dueSlots.length).toBe(MAX_CATCHUP_SLOTS);
    expect(plan.dropped).toBeGreaterThan(0);
    // 升序、无重复。
    for (let i = 1; i < plan.dueSlots.length; i++) {
      expect(plan.dueSlots[i] > plan.dueSlots[i - 1]).toBe(true);
    }
  });

  it("非 catch-up 策略不报告 dropped（run-once 坍缩成一个槽位）", () => {
    const schedule: TaskSchedule = { kind: "cron", expression: "* * * * *" };
    const since = Date.UTC(2026, 5, 1, 0, 0, 0);
    const now = since + (MAX_CATCHUP_SLOTS + 2) * 60_000;
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs: since, now, policy: "run-once" });
    expect(plan.dueSlots.length).toBe(1);
    expect(plan.dropped).toBe(0);
  });
});

describe("planMisfire 不变量：nextAfter 恒严格晚于 now（即便本次一个槽位都没跑）", () => {
  it("回拨（now 早于 sinceMs）：dueSlots 空，但 nextAfter 仍是 now 之后的下一次", () => {
    const schedule: TaskSchedule = { kind: "daily", time: "09:00" };
    const since = Date.UTC(2026, 5, 10, 1, 0, 0);
    const now = Date.UTC(2026, 5, 9, 1, 0, 0); // 比 since 早一天（时钟被拨回）
    const plan = planMisfire({ schedule, timeZone: SH, sinceMs: since, now, policy: "catch-up" });
    expect(plan.dueSlots).toEqual([]);
    // now = 6/9 09:00 上海，下一次 09:00 严格晚于它 = 6/10 01:00 UTC。
    expect(plan.nextAfter).toBe(Date.UTC(2026, 5, 10, 1, 0, 0));
    expect(plan.nextAfter! > now).toBe(true);
  });
});

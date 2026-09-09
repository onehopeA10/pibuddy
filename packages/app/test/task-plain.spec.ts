import { describe, expect, it } from "vitest";
import {
  formatWallClock,
  humanAuthGap,
  humanNextRun,
  humanSchedule,
  humanTaskCreated,
  humanTaskHeadline,
} from "../src/lib/task-plain.js";

const TZ = "Asia/Shanghai";
const WED = Date.parse("2026-08-19T01:00:00+08:00");

describe("formatWallClock / humanSchedule", () => {
  it("去掉小时前导零", () => {
    expect(formatWallClock("09:00")).toBe("9:00");
    expect(formatWallClock("15:00")).toBe("15:00");
  });

  it("每天 / 每周不说 cron", () => {
    expect(humanSchedule({ kind: "daily", time: "09:00" })).toBe("每天 9:00");
    expect(humanSchedule({ kind: "weekly", weekdays: [1], time: "09:00" })).toBe("周一 9:00");
    expect(humanSchedule({ kind: "cron", expression: "0 9 * * *" })).toBe("每天 9:00");
    expect(humanSchedule({ kind: "cron", expression: "0 9 * * 1" })).toBe("每周一 9:00");
    expect(humanSchedule({ kind: "cron", expression: "*/5 * * * *" })).toBe("按自定义时间表");
    expect(humanSchedule({ kind: "event", event: "inbox" })).toBe("等「inbox」发生时");
  });
});

describe("humanNextRun", () => {
  it("今天 / 明天 / 本周 / 更远", () => {
    expect(humanNextRun(null, TZ, WED)).toBe("还没排下次");
    expect(humanNextRun(Date.parse("2026-08-19T09:00:00+08:00"), TZ, WED)).toBe("今天 9:00");
    expect(humanNextRun(Date.parse("2026-08-20T15:00:00+08:00"), TZ, WED)).toBe("明天 15:00");
    expect(humanNextRun(Date.parse("2026-08-21T09:00:00+08:00"), TZ, WED)).toBe("周五 9:00");
    expect(humanNextRun(Date.parse("2026-09-01T09:00:00+08:00"), TZ, WED)).toBe("9月1日 9:00");
  });
});

describe("humanTaskHeadline / created", () => {
  it("下一跑 + 缺授权拼成一句", () => {
    expect(
      humanTaskHeadline({
        nextRunAt: Date.parse("2026-08-20T09:00:00+08:00"),
        timeZone: TZ,
        missingPermissions: ["workspace.write"],
        paused: false,
        schedule: { kind: "daily", time: "09:00" },
        now: WED,
      })
    ).toBe("明天 9:00 会跑，还差工作区授权：改工作区文件");
    expect(
      humanTaskHeadline({
        nextRunAt: Date.parse("2026-08-20T09:00:00+08:00"),
        timeZone: TZ,
        missingPermissions: [],
        paused: true,
        schedule: { kind: "daily", time: "09:00" },
        now: WED,
      })
    ).toBe("已暂停");
    expect(
      humanTaskCreated({
        nextRunAt: Date.parse("2026-08-20T15:00:00+08:00"),
        timeZone: TZ,
        schedule: { kind: "once", at: Date.parse("2026-08-20T15:00:00+08:00") },
        now: WED,
      })
    ).toBe("已排好：明天 15:00 会跑");
  });

  it("权限 ID 翻成办事用语", () => {
    expect(humanAuthGap(["process.git", "workspace.read"])).toBe(
      "还差工作区授权：使用 Git、读工作区文件"
    );
    expect(humanAuthGap([])).toBe("");
  });
});

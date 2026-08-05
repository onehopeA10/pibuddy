import { describe, expect, it } from "vitest";

import {
  RuleEngine,
  evaluateCondition,
  nextTimeFire,
  stateTriggerMatches,
  type EngineRule,
} from "../src/main/home-automation/rule-engine.js";

/**
 * 规则引擎纯函数全覆盖（home.automation / 智能家居 Phase B）。
 *
 * 引擎不 import electron / net / sqlite，全部时序经注入时钟——这里用手动
 * now + 记录器把「状态触发 / 时间触发对齐 tick / 条件求值 / DST」逐条钉死。
 * DST 用例直接对着 tasks schedule 的既有语义断言**具体 epoch**（gap 补偿到
 * 3:30、overlap 取较早一次），不是「函数被调用了」。
 */

// ---------------------------------------------------------------- 状态触发

describe("stateTriggerMatches：to / from / 任意变化 / 去重", () => {
  const base = { kind: "state", entityId: "light.living_room" } as const;

  it("to 匹配：新状态逐字相等才命中", () => {
    const trigger = { ...base, to: "on" } as EngineRule["trigger"];
    expect(stateTriggerMatches(trigger, { entityId: "light.living_room", state: "on" }, null)).toBe(true);
    expect(stateTriggerMatches(trigger, { entityId: "light.living_room", state: "off" }, null)).toBe(false);
    expect(stateTriggerMatches(trigger, { entityId: "switch.kettle", state: "on" }, null)).toBe(false);
  });

  it("from 指定时 prev 必须逐字相等；prev 未知（null）不猜、不命中", () => {
    const trigger = { ...base, from: "off", to: "on" } as EngineRule["trigger"];
    expect(stateTriggerMatches(trigger, { entityId: "light.living_room", state: "on" }, "off")).toBe(true);
    expect(stateTriggerMatches(trigger, { entityId: "light.living_room", state: "on" }, "unavailable")).toBe(false);
    expect(stateTriggerMatches(trigger, { entityId: "light.living_room", state: "on" }, null)).toBe(false);
  });

  it("from/to 都省略 = 任意状态变化；但相同状态的重复事件不算变化", () => {
    const trigger = { ...base } as EngineRule["trigger"];
    expect(stateTriggerMatches(trigger, { entityId: "light.living_room", state: "on" }, "off")).toBe(true);
    // HA 在 attributes 变化时也发 state_changed——状态没变就不触发。
    expect(stateTriggerMatches(trigger, { entityId: "light.living_room", state: "on" }, "on")).toBe(false);
  });

  it("实体移除（state null）不是状态命中；time 触发对状态事件恒 false", () => {
    expect(stateTriggerMatches({ ...base } as EngineRule["trigger"], { entityId: "light.living_room", state: null }, "on")).toBe(false);
    expect(
      stateTriggerMatches(
        { kind: "time", time: "08:00" } as EngineRule["trigger"],
        { entityId: "light.living_room", state: "on" },
        null
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- 条件求值

describe("evaluateCondition：实体状态比较", () => {
  const states = new Map<string, string | null>([
    ["sensor.temp", "21.5"],
    ["light.living_room", "on"],
  ]);
  const ctx = {
    stateOf: (id: string) => states.get(id) ?? null,
    nowMs: Date.UTC(2026, 0, 1, 12, 0),
    timeZone: "UTC",
  };

  it("eq / neq 逐字比较", () => {
    expect(evaluateCondition({ kind: "state", entityId: "sensor.temp", op: "eq", value: "21.5" }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: "state", entityId: "sensor.temp", op: "eq", value: "22" }, ctx)).toBe(false);
    expect(evaluateCondition({ kind: "state", entityId: "sensor.temp", op: "neq", value: "22" }, ctx)).toBe(true);
  });

  it("状态未知（null）：eq 恒 false、neq 恒 true——「不等于」对未知世界如实成立", () => {
    expect(evaluateCondition({ kind: "state", entityId: "sensor.ghost", op: "eq", value: "x" }, ctx)).toBe(false);
    expect(evaluateCondition({ kind: "state", entityId: "sensor.ghost", op: "neq", value: "x" }, ctx)).toBe(true);
  });
});

describe("evaluateCondition：时间窗（含跨午夜与空窗口）", () => {
  const stateOf = (): string | null => null;
  /** Asia/Shanghai 恒 UTC+8：UTC 15:30 = 当地 23:30。 */
  const at = (utcHour: number, utcMinute: number): number =>
    Date.UTC(2026, 0, 1, utcHour, utcMinute);
  const tz = "Asia/Shanghai";

  it("普通窗口 [after, before)：左闭右开", () => {
    const win = { kind: "time_window", after: "08:00", before: "18:00" } as const;
    expect(evaluateCondition(win, { stateOf, nowMs: at(0, 0), timeZone: tz })).toBe(true); // 08:00 当地
    expect(evaluateCondition(win, { stateOf, nowMs: at(9, 59), timeZone: tz })).toBe(true); // 17:59
    expect(evaluateCondition(win, { stateOf, nowMs: at(10, 0), timeZone: tz })).toBe(false); // 18:00（右开）
    expect(evaluateCondition(win, { stateOf, nowMs: at(23, 0), timeZone: tz })).toBe(false); // 07:00
  });

  it("跨午夜窗口（after > before）：22:00–06:00", () => {
    const win = { kind: "time_window", after: "22:00", before: "06:00" } as const;
    expect(evaluateCondition(win, { stateOf, nowMs: at(15, 30), timeZone: tz })).toBe(true); // 23:30
    expect(evaluateCondition(win, { stateOf, nowMs: at(20, 0), timeZone: tz })).toBe(true); // 04:00
    expect(evaluateCondition(win, { stateOf, nowMs: at(4, 0), timeZone: tz })).toBe(false); // 12:00
    expect(evaluateCondition(win, { stateOf, nowMs: at(22, 0), timeZone: tz })).toBe(false); // 06:00（右开）
  });

  it("after === before 是空窗口（恒 false），不做「全天」的隐式解释", () => {
    const win = { kind: "time_window", after: "08:00", before: "08:00" } as const;
    expect(evaluateCondition(win, { stateOf, nowMs: at(0, 0), timeZone: tz })).toBe(false);
    expect(evaluateCondition(win, { stateOf, nowMs: at(12, 0), timeZone: tz })).toBe(false);
  });
});

// ---------------------------------------------------------------- 时间触发（DST 继承 tasks）

describe("nextTimeFire：daily 语义与 DST 策略逐字继承 tasks schedule", () => {
  it("普通日：严格晚于 fromMs 的下一个墙钟槽位", () => {
    const trigger = { kind: "time", time: "12:00" } as const;
    // 2026-01-05 00:00Z = 上海 08:00 → 当天 12:00 CST = 04:00Z。
    expect(nextTimeFire(trigger, "Asia/Shanghai", Date.UTC(2026, 0, 5, 0, 0))).toBe(
      Date.UTC(2026, 0, 5, 4, 0)
    );
    // 已过当天槽位 → 次日。
    expect(nextTimeFire(trigger, "Asia/Shanghai", Date.UTC(2026, 0, 5, 4, 0))).toBe(
      Date.UTC(2026, 0, 6, 4, 0)
    );
  });

  it("DST gap（纽约 2026-03-08 春季前跳）：02:30 不存在 → 补偿到 03:30 EDT，不静默丢掉", () => {
    const trigger = { kind: "time", time: "02:30" } as const;
    // from = 03-08 00:00 EST（05:00Z）。当天 02:30 被前跳吃掉 → 03:30 EDT = 07:30Z。
    expect(nextTimeFire(trigger, "America/New_York", Date.UTC(2026, 2, 8, 5, 0))).toBe(
      Date.UTC(2026, 2, 8, 7, 30)
    );
  });

  it("DST overlap（纽约 2026-11-01 秋季回拨）：01:30 出现两次 → 取较早（EDT）那一次，只算一次", () => {
    const trigger = { kind: "time", time: "01:30" } as const;
    // from = 11-01 00:00Z（10-31 20:00 EDT）。次日 01:30 有 EDT(05:30Z) 与 EST(06:30Z) 两个候选。
    expect(nextTimeFire(trigger, "America/New_York", Date.UTC(2026, 10, 1, 0, 0))).toBe(
      Date.UTC(2026, 10, 1, 5, 30)
    );
  });

  it("state 触发没有下一次时刻（恒 null）", () => {
    expect(nextTimeFire({ kind: "state", entityId: "light.x" }, "UTC", 0)).toBe(null);
  });
});

// ---------------------------------------------------------------- 引擎

interface Fired {
  ruleId: string;
  slot: number;
  cause: "state" | "time";
}

function makeEngine(startNow: number): {
  engine: RuleEngine;
  fired: Fired[];
  setNow: (ms: number) => void;
  scheduled: { fn: () => void; ms: number }[];
} {
  let now = startNow;
  const fired: Fired[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  const engine = new RuleEngine({
    now: () => now,
    schedule: (fn, ms) => {
      const entry = { fn, ms };
      scheduled.push(entry);
      return () => {
        const i = scheduled.indexOf(entry);
        if (i >= 0) scheduled.splice(i, 1);
      };
    },
    fire: (rule, slot, cause) => fired.push({ ruleId: rule.id, slot, cause }),
  });
  return { engine, fired, setNow: (ms) => (now = ms), scheduled };
}

const timeRule = (id: string, time: string, enabled = true): EngineRule => ({
  id,
  enabled,
  trigger: { kind: "time", time },
  timezone: "UTC",
});

const stateRule = (id: string, entityId: string, to?: string, enabled = true): EngineRule => ({
  id,
  enabled,
  trigger: { kind: "state", entityId, ...(to !== undefined ? { to } : {}) },
  timezone: "UTC",
});

describe("RuleEngine：时间触发对齐 tick", () => {
  const day1 = Date.UTC(2026, 0, 1, 0, 0);

  it("到点触发一次（slot = 解出的槽位），未到点不触发，同一槽位不重复", () => {
    const { engine, fired } = makeEngine(day1);
    engine.setRules([timeRule("r1", "12:00")]);
    const slot = Date.UTC(2026, 0, 1, 12, 0);
    expect(engine.__nextFireAt("r1")).toBe(slot);

    engine.tick(slot - 1000);
    expect(fired).toEqual([]);

    engine.tick(slot + 30_000);
    expect(fired).toEqual([{ ruleId: "r1", slot, cause: "time" }]);
    // 下一次已推进到次日；同一时刻再 tick 不重复触发。
    expect(engine.__nextFireAt("r1")).toBe(Date.UTC(2026, 0, 2, 12, 0));
    engine.tick(slot + 40_000);
    expect(fired.length).toBe(1);
  });

  it("misfire 语义：跨过多个槽位只触发一次，下一次从 now 重算（轻量规则不补跑）", () => {
    const { engine, fired } = makeEngine(day1);
    engine.setRules([timeRule("r1", "12:00")]);
    // 睡了三天再醒。
    const wake = Date.UTC(2026, 0, 4, 13, 0);
    engine.tick(wake);
    expect(fired.length).toBe(1);
    expect(fired[0]!.slot).toBe(Date.UTC(2026, 0, 1, 12, 0));
    expect(engine.__nextFireAt("r1")).toBe(Date.UTC(2026, 0, 5, 12, 0));
  });

  it("disabled 的时间规则没有排定、不触发；setRules 整份替换（重灌从 now 起算）", () => {
    const { engine, fired } = makeEngine(day1);
    engine.setRules([timeRule("r1", "12:00", false)]);
    expect(engine.__nextFireAt("r1")).toBe(null);
    engine.tick(Date.UTC(2026, 0, 2, 0, 0));
    expect(fired).toEqual([]);

    engine.setRules([timeRule("r1", "12:00", true)]);
    expect(engine.__nextFireAt("r1")).toBe(Date.UTC(2026, 0, 1, 12, 0));
  });

  it("start/stop：自持对齐 tick 经注入 schedule 循环，stop 后不再排定", () => {
    const { engine, fired, setNow, scheduled } = makeEngine(day1);
    engine.setRules([timeRule("r1", "12:00")]);
    engine.start(30_000);
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]!.ms).toBe(30_000);

    // 推进时钟越过槽位，然后让排定的 tick 醒来：触发 + 重新排定下一轮。
    const pending = scheduled.shift()!; // 模拟定时器到期（真实 setTimeout 到期即出队）
    setNow(Date.UTC(2026, 0, 1, 12, 0, 30));
    pending.fn();
    expect(fired.length).toBe(1);
    expect(scheduled.length).toBe(1); // 新的一轮已挂上

    engine.stop();
    expect(scheduled.length).toBe(0);
    engine.stop(); // 幂等
  });
});

describe("RuleEngine：状态触发", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0);

  it("命中启用中的匹配规则；disabled 不触发；prev 由引擎自持（from 匹配与去重）", () => {
    const { engine, fired } = makeEngine(now);
    engine.setRules([
      stateRule("on-rule", "light.living_room", "on"),
      stateRule("any-rule", "light.living_room"),
      stateRule("dead-rule", "light.living_room", "on", false),
      stateRule("other", "switch.kettle", "on"),
    ]);

    engine.handleStateChanged({ entityId: "light.living_room", state: "on" });
    expect(fired.map((f) => f.ruleId).sort()).toEqual(["any-rule", "on-rule"]);
    expect(fired.every((f) => f.cause === "state" && f.slot === now)).toBe(true);

    // 相同状态的重复事件：prev 已是 on → 一条都不触发。
    fired.length = 0;
    engine.handleStateChanged({ entityId: "light.living_room", state: "on" });
    expect(fired).toEqual([]);

    // 变回 off：只有 any-rule（to:"on" 不匹配 off）。
    engine.handleStateChanged({ entityId: "light.living_room", state: "off" });
    expect(fired.map((f) => f.ruleId)).toEqual(["any-rule"]);
  });

  it("hasEnabledStateRules：只有启用中的状态触发规则才算数", () => {
    const { engine } = makeEngine(now);
    engine.setRules([timeRule("t", "08:00"), stateRule("s", "light.x", "on", false)]);
    expect(engine.hasEnabledStateRules()).toBe(false);
    engine.setRules([stateRule("s", "light.x", "on", true)]);
    expect(engine.hasEnabledStateRules()).toBe(true);
  });
});

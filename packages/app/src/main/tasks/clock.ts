/**
 * 可注入时钟（Durable Tasks 的可测试性地基）。
 *
 * ## 为什么定时任务必须有一个可 mock 的时钟
 *
 * 定时任务的全部已知坑都在时间处理：DST 切换、时钟回拨、错过的运行、
 * sleep/wake。这些只有在**能人为制造那个时序**的前提下才测得了——直接调
 * `Date.now()` 的代码，测不了「时钟往回跳了一小时会怎样」，因为你没法让
 * 真实的墙钟往回跳。因此 scheduler 从不直接读 `Date.now()`，一律经这里的
 * `Clock.now()`，单测注入 `ManualClock` 就能把时间捏成任意形状。
 *
 * 这与本仓一贯做法一致：`ipc-guard` 的 `RateLimiter.check(…, now)`、
 * `artifact-store` 的 `now = Date.now()` 形参都是同一手法——把「现在几点」
 * 变成一个可注入的参数，而不是一个藏在函数体里的隐式依赖。
 */

/** 「现在几点」的唯一来源。 */
export interface Clock {
  /** 当前 epoch 毫秒。 */
  now(): number;
}

/** 生产时钟：读系统墙钟。 */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * 单测 / 取证用的手动时钟。
 *
 * `set` 可以把时间设成任意值，**包括比当前更早**——那正是「时钟回拨」测试
 * 需要的能力。scheduler 对这种回拨的正确反应（不重复执行非幂等 action）只有
 * 在能真的把时间拨回去时才验证得了。
 */
export class ManualClock implements Clock {
  constructor(private t: number) {}

  now(): number {
    return this.t;
  }

  /** 直接设定当前时刻（可前可后）。 */
  set(epochMs: number): void {
    this.t = epochMs;
  }

  /** 前进（或后退，若 ms 为负）指定毫秒。 */
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * 更新后第一次启动的轻量健康检查（OBS-101）。
 *
 * 三项，每项独立 5 秒超时：
 *
 *   db-migration    会话索引的 SQLite migration 能不能跑完
 *   renderer-ready  主窗口有没有真的可交互
 *   pi-handshake    内置 pi 运行时能不能握上手
 *
 * ## 超时不是可选项
 *
 * 没有超时的话，任何一项永不 resolve 的表现是**应用永远停在启动画面，
 * 日志里什么都没有** —— 而这恰恰是「更新之后打不开了」这类报障最常见的
 * 形态。超时算失败：卡住和失败对用户是同一件事，区分它们是开发者的事，
 * 那个区分写在 durations 里。
 *
 * 三项并发跑而不是串行：串行时总耗时可能到 15 秒，那是用户在启动路径上
 * 白等的时间。
 *
 * 本文件不 import electron：探针由调用方注入，因此整套超时语义能在
 * fake timers 下被断言。
 */
import type { HealthCheckName, HealthCheckResult } from "@pibuddy/contract";

/** 单项检查的超时。三项并发，因此这也是整体上限。 */
export const HEALTH_CHECK_TIMEOUT_MS = 5000;

export const HEALTH_CHECK_NAMES: HealthCheckName[] = [
  "db-migration",
  "renderer-ready",
  "pi-handshake",
];

/** 三个探针。任一抛错或超时即该项失败。 */
export interface HealthProbes {
  dbMigration(): Promise<unknown>;
  rendererReady(): Promise<unknown>;
  piHandshake(): Promise<unknown>;
}

export interface HealthCheckOptions {
  timeoutMs?: number;
  now?: () => number;
}

/**
 * 给一个 promise 套超时。
 *
 * 用 globalThis.setTimeout 而不是 import 的 timers：vitest 的 fake timers
 * 替换的是全局那一个，import 进来的那份不受控，测出来的是真实等待 5 秒。
 * settle 之后必须 clearTimeout —— 否则每跑一次健康检查就漏一个定时器，
 * 而主进程会被它拖着退不掉。
 */
function withTimeout(
  factory: () => Promise<unknown>,
  timeoutMs: number
): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, ms: timeoutMs });
    }, timeoutMs);

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ ok, ms: Math.max(0, Date.now() - started) });
    };

    let started$: Promise<unknown>;
    try {
      started$ = factory();
    } catch {
      // 同步抛错也算失败：探针里一个手滑的 undefined 解引用不该让
      // 整个健康检查以 unhandled rejection 的形式消失。
      finish(false);
      return;
    }
    void Promise.resolve(started$).then(
      () => finish(true),
      () => finish(false)
    );
  });
}

/**
 * 跑一遍启动健康检查。**永远 resolve**，不 reject。
 *
 * 调用方拿到的 failed 数组就是给用户看的那份清单，因此顺序固定为
 * HEALTH_CHECK_NAMES 的顺序，不随并发完成顺序抖动。
 */
export async function runStartupHealthCheck(
  probes: HealthProbes,
  options: HealthCheckOptions = {}
): Promise<HealthCheckResult> {
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  const factories: Record<HealthCheckName, () => Promise<unknown>> = {
    "db-migration": () => probes.dbMigration(),
    "renderer-ready": () => probes.rendererReady(),
    "pi-handshake": () => probes.piHandshake(),
  };

  const settled = await Promise.all(
    HEALTH_CHECK_NAMES.map((name) => withTimeout(factories[name], timeoutMs))
  );

  const failed: HealthCheckName[] = [];
  const durations: Record<string, number> = {};
  HEALTH_CHECK_NAMES.forEach((name, i) => {
    durations[name] = settled[i].ms;
    if (!settled[i].ok) failed.push(name);
  });

  return { ok: failed.length === 0, failed, durations, checkedAt: now() };
}

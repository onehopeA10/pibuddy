/**
 * 内核的日志出口（ADR-0002 实施顺序第 1 条）。
 *
 * ## 为什么这个文件必须存在
 *
 * 搬迁前 `log()` 住在 `pi/pi-ipc.ts` 里，而 `ipc.ts`、`misc-ipc.ts`、
 * `update/update-ipc.ts` 都反过来从 pi 域取它。后果有两层：
 *
 *   1. pi runtime 将来要作为**可替换件**（能力包架构里 Agent runtime 只是
 *      内核的一个实现），可它一旦被摘掉，内核门面与更新子系统会连编译都
 *      过不了 —— 依赖方向是反的。
 *   2. 更新子系统必须在 pi runtime 起不来的时候照常工作（UPD-001 的前提就是
 *      「应用坏了也要能更新回去」），而它的日志出口却挂在 pi runtime 上。
 *
 * 现在方向倒过来：日志是内核设施，pi 域和其它所有域一样**消费**它。
 *
 * ## 为什么不直接用 logger.ts
 *
 * `logger.ts` 刻意不 import electron（那样它才能在纯 node 的 vitest 里被直接
 * 驱动，见该文件头）。可「日志写到哪个目录」这个答案只有 electron 的
 * `app.getPath("userData")` 给得出来。这一层薄封装就是那两件事的接缝：
 * electron 相关的只有本文件这一处，logger 本体仍然可测。
 *
 * ## 全仓仍然只有一个日志器
 *
 * 本文件**不实现**任何日志逻辑，只做「解析目录 + 记住实例」。真正的
 * 结构化落盘、脱敏、轮转仍然只有 `logger.ts` 一份实现，结构性断言见
 * `packages/app/test/kernel-boundary.spec.ts`。
 */
import { app } from "electron";
import path from "node:path";

import { configureLogging, createLogger, type Logger } from "./logger.js";

let cached: Logger | null = null;

/**
 * 全应用共享的主进程 logger。
 *
 * 惰性创建：`createLogger` 在构造时就 mkdir 日志目录，而模块加载期
 * `app.getPath` 还不可用（whenReady 之前拿不到 userData）。
 *
 * 顺带把默认目录钉下来：其它模块用 `createLogger('updater')` 这种简写时，
 * 拿到的必须是同一个目录，否则 support-bundle 只会收到其中一半。
 */
export function log(): Logger {
  if (!cached) {
    const dir = path.join(app.getPath("userData"), "logs");
    configureLogging({ dir });
    cached = createLogger({ dir, scope: "main" });
  }
  return cached;
}

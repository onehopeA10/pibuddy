/**
 * 全仓唯一的日志器（裁定4）。
 *
 * 结构化 JSONL 落盘 + 出口脱敏 + 按大小轮转 + 总量上限。
 *
 * 刻意**不 import electron**：日志目录由调用方（main/index.ts）以
 * app.getPath("userData")/logs 传入，或经 configureLogging() 一次性配好。
 * 这样 logger 可以在纯 node 的 vitest 里直接跑，不需要给 electron 打桩 ——
 * 给 electron 打桩的测试跑的是桩，不是 logger。
 *
 * ## 脱敏挂在**出口**，不挂在入口（OBS-101）
 *
 * 改前 `redactSecrets` 只作用在 `fields` 上，`event` 名字原样落盘。于是
 * `logger.info(someUserString)` 这类写法可以把密钥直接写进日志文件，而现场
 * 没有任何征兆 —— 只有真的去翻文件才看得出来。现在整条记录（含 event）在
 * `writeLine` 里、也只在那里过一遍 redactSecrets，那是唯一真正写盘的函数。
 *
 * ## 三个必填上下文键
 *
 * 每行 JSON 恒含 correlationId / runtimeId / sessionId。调用方没给
 * correlationId 时**自动生成**一个，不写 undefined 也不抛错：一条没有关联
 * 键的日志，在跨进程排查里等于没有。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactSecrets } from "./logger-redact.js";

/** 单文件上限；超过即轮转。 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/**
 * 保留的历史归档份数（不含当前文件）。
 *
 * 总量上限 = MAX_LOG_BYTES * (MAX_LOG_FILES + 1) ≈ 40MB。诊断包会把它们
 * 一起收走，再大就没人愿意上传了。
 */
export const MAX_LOG_FILES = 7;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 日志作用域。新增一个域就在这里加一个字面量，便于按域过滤。 */
export type LogScope =
  | "main"
  | "pi-runtime"
  | "updater"
  | "session-index"
  | "permission"
  | "tasks"
  | "connector"
  | "home"
  | "home-automation";

export interface LoggerOptions {
  /** 日志目录，通常是 app.getPath("userData")/logs */
  dir: string;
  /** 文件名前缀，默认 pibuddy */
  prefix?: string;
  /** 低于该级别的记录被丢弃，默认 debug */
  minLevel?: LogLevel;
  /** 同时写 stdout，默认仅在非 production 开启 */
  echo?: boolean;
  /** 作用域标签，进入每行 JSON 的 scope 字段 */
  scope?: LogScope;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** 派生带固定字段的子 logger（如绑定 runtimeId / sessionId） */
  child(bound: Record<string, unknown>): Logger;
  /** 当前落盘文件的绝对路径（供 support-bundle 收集） */
  filePath(): string;
  /** 当前文件 + 全部归档的绝对路径，按新到旧（供 support-bundle 收集） */
  logFiles(): string[];
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * `createLogger('main')` 这种简写用的默认配置。
 *
 * main/index.ts 在 whenReady 之后调一次 configureLogging({dir: userData/logs})，
 * 之后任何模块都可以只写作用域名。没配过时回落到临时目录 —— 不抛错，
 * 因为「日志没配好」不该把应用搞挂，但也不静默丢弃，至少还写得出来。
 */
let defaults: Omit<LoggerOptions, "scope"> = {
  dir: path.join(os.tmpdir(), "pibuddy-logs"),
};

export function configureLogging(options: Omit<LoggerOptions, "scope">): void {
  defaults = { ...defaults, ...options };
}

/** 当前生效的日志目录（support-bundle 按它收集文件）。 */
export function logDir(): string {
  return defaults.dir;
}

function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

function newCorrelationId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * 进程级 runtimeId：一次主进程运行的代际标识。
 * 没有它的话，用户重启应用之后的日志和重启之前的混在同一个文件里无法区分。
 */
const PROCESS_RUNTIME_ID = crypto.randomUUID().slice(0, 8);

/**
 * 轮转：当前文件 → .1，.1 → .2，…，.MAX_LOG_FILES 直接丢弃。
 * 从后往前逐级顺移，避免覆盖。renameSync 保留 mtime，因此被丢弃的
 * `.MAX_LOG_FILES` 恒是目录内 mtime 最旧的那一个。
 */
function rotate(filePath: string): void {
  const oldest = `${filePath}.${MAX_LOG_FILES}`;
  try {
    fs.unlinkSync(oldest);
  } catch {
    /* 还没轮到那么多份 */
  }
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    } catch {
      /* 该份不存在 */
    }
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    /* 当前文件不存在 */
  }
}

export function createLogger(options: LoggerOptions | LogScope): Logger {
  const opts: LoggerOptions =
    typeof options === "string" ? { ...defaults, scope: options } : options;

  const prefix = opts.prefix ?? "pibuddy";
  const minLevel = LEVEL_ORDER[opts.minLevel ?? "debug"];
  const echo = opts.echo ?? process.env.NODE_ENV !== "production";
  const scope = opts.scope ?? "main";

  fs.mkdirSync(opts.dir, { recursive: true });

  let day = today();
  let file = path.join(opts.dir, `${prefix}-${day}.log`);
  let written = sizeOf(file);

  function sizeOf(p: string): number {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  }

  function targetFile(): string {
    const now = today();
    if (now !== day) {
      day = now;
      file = path.join(opts.dir, `${prefix}-${day}.log`);
      written = sizeOf(file);
    }
    return file;
  }

  /**
   * **唯一真正写盘的函数**，因此也是唯一做脱敏的地方。
   *
   * 顺序不能换：先脱敏整条记录（含 event 名），再序列化，再判轮转，最后
   * 落盘。把 redactSecrets 挪到调用方任何一层，都会留下一条「某个入口忘了
   * 过脱敏」的可能路径，而那条路径不会有任何报错。
   */
  function writeLine(record: Record<string, unknown>): void {
    const safe = redactSecrets(record) as Record<string, unknown>;
    let line: string;
    try {
      line = `${JSON.stringify(safe)}\n`;
    } catch {
      line = `${JSON.stringify({
        ts: safe.ts,
        level: safe.level,
        event: "unserializable-record",
        correlationId: safe.correlationId,
        runtimeId: safe.runtimeId,
        sessionId: safe.sessionId,
      })}\n`;
    }

    const target = targetFile();
    if (written + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      rotate(target);
      written = 0;
    }
    try {
      fs.appendFileSync(target, line, "utf8");
      written += Buffer.byteLength(line);
    } catch {
      // 日志写不进去不能反过来把应用搞挂
    }
    if (echo) process.stdout.write(line);
  }

  function emit(level: LogLevel, event: string, merged: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minLevel) return;

    // 三个必填键单独取出，避免既出现在顶层又出现在 rest 里。
    const { correlationId, runtimeId, sessionId, ...rest } = merged;

    writeLine({
      ts: new Date().toISOString(),
      level,
      scope,
      event,
      // 调用方没给就现生成一个：写 undefined 会在 JSON 里直接消失，
      // 而那正是「每行都有 correlationId」这条断言想防的事。
      correlationId: (correlationId as string | undefined) ?? newCorrelationId(),
      runtimeId: (runtimeId as string | undefined) ?? PROCESS_RUNTIME_ID,
      sessionId: (sessionId as string | null | undefined) ?? null,
      ...rest,
    });
  }

  function make(bound: Record<string, unknown>): Logger {
    return {
      debug: (event, fields) => emit("debug", event, { ...bound, ...fields }),
      info: (event, fields) => emit("info", event, { ...bound, ...fields }),
      warn: (event, fields) => emit("warn", event, { ...bound, ...fields }),
      error: (event, fields) => emit("error", event, { ...bound, ...fields }),
      child: (extra) => make({ ...bound, ...extra }),
      filePath: () => targetFile(),
      logFiles: () => {
        const current = targetFile();
        const out = [current];
        for (let i = 1; i <= MAX_LOG_FILES; i++) {
          const archive = `${current}.${i}`;
          if (fs.existsSync(archive)) out.push(archive);
        }
        return out;
      },
    };
  }

  return make({});
}

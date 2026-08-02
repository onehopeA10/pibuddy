/**
 * 全仓唯一的日志器（裁定4）。
 *
 * 结构化 JSONL 落盘 + 键名脱敏 + 按大小轮转。
 *
 * 刻意**不 import electron**：日志目录由调用方（main/index.ts）以
 * app.getPath("userData")/logs 传入。这样 logger 可以在纯 node 的 vitest
 * 里直接跑，不需要给 electron 打桩 —— 给 electron 打桩的测试跑的是桩，
 * 不是 logger。
 */
import fs from "node:fs";
import path from "node:path";

import { redactSecrets } from "./logger-redact.js";

/** 单文件上限；超过即轮转。 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** 保留的历史文件份数（不含当前文件）。 */
export const MAX_LOG_FILES = 5;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /** 日志目录，通常是 app.getPath("userData")/logs */
  dir: string;
  /** 文件名前缀，默认 pibuddy */
  prefix?: string;
  /** 低于该级别的记录被丢弃，默认 debug */
  minLevel?: LogLevel;
  /** 同时写 stdout，默认仅在非 production 开启 */
  echo?: boolean;
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
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

/**
 * 轮转：当前文件 → .1，.1 → .2，…，.MAX_LOG_FILES 直接丢弃。
 * 用 renameSync 逐级顺移，从后往前，避免覆盖。
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

export function createLogger(options: LoggerOptions): Logger {
  const prefix = options.prefix ?? "pibuddy";
  const minLevel = LEVEL_ORDER[options.minLevel ?? "debug"];
  const echo = options.echo ?? process.env.NODE_ENV !== "production";

  fs.mkdirSync(options.dir, { recursive: true });

  let day = today();
  let file = path.join(options.dir, `${prefix}-${day}.log`);
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
      file = path.join(options.dir, `${prefix}-${day}.log`);
      written = sizeOf(file);
    }
    return file;
  }

  function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minLevel) return;

    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redactSecrets(fields) as Record<string, unknown>),
    };
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({ ts: record.ts, level, event, error: "unserializable-fields" })}\n`;
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

  function make(bound: Record<string, unknown>): Logger {
    return {
      debug: (event, fields) => emit("debug", event, { ...bound, ...fields }),
      info: (event, fields) => emit("info", event, { ...bound, ...fields }),
      warn: (event, fields) => emit("warn", event, { ...bound, ...fields }),
      error: (event, fields) => emit("error", event, { ...bound, ...fields }),
      child: (extra) => make({ ...bound, ...extra }),
      filePath: () => targetFile(),
    };
  }

  return make({});
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_LOG_BYTES,
  MAX_LOG_FILES,
  configureLogging,
  createLogger,
} from "../src/main/logger.js";

/**
 * 日志器的关键路径断言（不做穷举矩阵）：
 *   1. API key 不落盘
 *   2. prompt 正文不落盘，但保留 promptLength
 *   3. 超过 MAX_LOG_BYTES 触发轮转
 */

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-log-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readAll(dir: string): string {
  return fs
    .readdirSync(dir)
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("");
}

describe("createLogger 脱敏", () => {
  it("API key 与 prompt 正文都不落盘，只留 promptLength", () => {
    const dir = tmpDir();
    const logger = createLogger({ dir, echo: false });

    logger.info("pi_start", { apiKey: "sk-live-XYZ", prompt: "机密正文" });

    const content = readAll(dir);
    expect(content).not.toContain("sk-live-XYZ");
    expect(content).not.toContain("机密正文");
    expect(content).toContain("promptLength");

    const record = JSON.parse(content.trim()) as Record<string, unknown>;
    expect(record.apiKey).toBe("[redacted]");
    expect(record.promptLength).toBe("机密正文".length);
    expect(record.event).toBe("pi_start");
    expect(record.level).toBe("info");
  });

  it("Authorization 头与环境变量值都不落盘（只留白名单键名）", () => {
    const dir = tmpDir();
    const logger = createLogger({ dir, echo: false });

    logger.warn("stt_request", {
      headers: { Authorization: "Bearer secret-token-value" },
      env: { PATH: "/usr/bin", MY_PRIVATE_TOKEN: "nope" },
    });

    const content = readAll(dir);
    expect(content).not.toContain("secret-token-value");
    expect(content).not.toContain("/usr/bin");
    expect(content).not.toContain("nope");
    expect(content).toContain("PATH");
    expect(content).not.toContain("MY_PRIVATE_TOKEN");
  });
});

describe("createLogger 轮转", () => {
  it("超过 MAX_LOG_BYTES 后当前文件被顺移为 .1", () => {
    const dir = tmpDir();
    // 先把当天文件填到只差一点就满，避免真的写 5MB 条目
    const probe = createLogger({ dir, echo: false });
    const file = probe.filePath();
    fs.writeFileSync(file, "x".repeat(MAX_LOG_BYTES - 10), "utf8");

    const logger = createLogger({ dir, echo: false });
    logger.info("rotate_me", { n: 1 });

    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(`${file}.1`).size).toBe(MAX_LOG_BYTES - 10);
    // 新文件只含刚写的那一条
    const fresh = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toContain("rotate_me");
    expect(MAX_LOG_FILES).toBe(7);
  });

  it("归档超过 MAX_LOG_FILES 份之后，目录里恰好 8 个文件，被丢弃的是 mtime 最旧的那个", () => {
    const dir = tmpDir();
    const probe = createLogger({ dir, echo: false });
    const file = probe.filePath();

    // 触发 9 次轮转：第 8 次开始就该有文件被丢弃了。
    // 每次之间把 mtime 拉开，才能断言"丢的是最旧的那个"而不是"丢了一个"。
    const seen: Array<{ name: string; mtime: number }> = [];
    for (let i = 0; i < 9; i++) {
      fs.writeFileSync(file, "x".repeat(MAX_LOG_BYTES - 10), "utf8");
      const t = new Date(Date.now() - (9 - i) * 60_000);
      fs.utimesSync(file, t, t);
      seen.push({ name: `round-${i}`, mtime: t.getTime() });
      createLogger({ dir, echo: false }).info("rotate_me", { round: i });
    }

    const names = fs.readdirSync(dir);
    // 当前文件 + 7 个归档 = 8。多一个说明上限没生效，日志会无限长下去。
    expect(names).toHaveLength(MAX_LOG_FILES + 1);

    const stats = names
      .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    // 留下来的最旧一份，必须比"曾经写过的最旧那份"更新 —— 也就是说
    // 被删掉的确实是 mtime 最旧的那个，而不是随便一个。
    expect(stats[0].m).toBeGreaterThan(seen[0].mtime);
  });
});

describe("必填上下文键", () => {
  it("每行 JSON 都含 correlationId / runtimeId / sessionId，未提供时自动生成", () => {
    const dir = tmpDir();
    const logger = createLogger({ dir, echo: false });

    logger.info("a", { n: 1 });
    logger.child({ sessionId: "s-1" }).warn("b");

    const lines = readAll(dir).trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(record)).toContain("correlationId");
      expect(Object.keys(record)).toContain("runtimeId");
      expect(Object.keys(record)).toContain("sessionId");
      // 自动生成的必须是真值，不是 undefined 也不是空串
      expect(typeof record.correlationId).toBe("string");
      expect((record.correlationId as string).length).toBeGreaterThan(0);
      expect(typeof record.runtimeId).toBe("string");
    }
    expect((JSON.parse(lines[0]) as { sessionId: unknown }).sessionId).toBeNull();
    expect((JSON.parse(lines[1]) as { sessionId: unknown }).sessionId).toBe("s-1");
  });
});

describe("stdout 回显断管", () => {
  it("EPIPE 只停回显，不把应用打崩，文件照常落盘", () => {
    const dir = tmpDir();
    const original = process.stdout.write.bind(process.stdout);
    let writes = 0;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes += 1;
      const err = new Error("EPIPE: broken pipe, write") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    }) as typeof process.stdout.write;

    try {
      const logger = createLogger({ dir, echo: true });
      expect(() => logger.info("pi_wake", { reason: "focus" })).not.toThrow();
      expect(() => logger.info("pi_wake", { reason: "send" })).not.toThrow();
    } finally {
      process.stdout.write = original;
    }

    const content = readAll(dir);
    expect(content).toContain("pi_wake");
    expect(content).toContain("focus");
    expect(writes).toBe(1);
  });
});

describe("脱敏挂在写出函数里", () => {
  it("createLogger('main').info(<密钥>) —— 连 event 名本身都不会明文落盘", () => {
    const dir = tmpDir();
    configureLogging({ dir, echo: false });

    createLogger("main").info("sk-ant-0123456789abcdef");

    const content = readAll(dir);
    expect(content).not.toContain("sk-ant-0123456789abcdef");
    expect(content).toContain("[redacted]");
    expect(content).toContain('"scope":"main"');
  });
});

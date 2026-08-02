import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_LOG_BYTES, MAX_LOG_FILES, createLogger } from "../src/main/logger.js";

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
    expect(MAX_LOG_FILES).toBe(5);
  });
});

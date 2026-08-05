import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUSH_CHANNELS, PUSH_CONTRACTS } from "@pibuddy/contract";

/**
 * MDL-101 的**结构性断言**。
 *
 * 归一化域本身的行为由它自己的单测钉住；这里钉的是三件单测钉不住、又恰好
 * 会静默失效的事：
 *
 *   1. `model-errors/` 是纯函数域 —— 一旦有人在里面 import electron，整域就
 *      再也不能脱离 Electron 被驱动，而现有单测**照样全绿**（vitest 里
 *      electron 直到被调用才炸）；
 *   2. 主进程真的在推那条通道 —— 域算得再准，没人 sendPush 的话界面上一个
 *      字都不会变，而三大门禁对「功能整体是死的」完全无感；
 *   3. 渲染进程真的订阅了它。
 *
 * 同类手法在本仓已有先例：`test/kernel-boundary.spec.ts` 的依赖方向断言。
 */

const MAIN = path.resolve(import.meta.dirname, "../src/main");
const RENDERER = path.resolve(import.meta.dirname, "../src/renderer/src");
const PRELOAD = path.resolve(import.meta.dirname, "../src/preload");

const DOMAIN = path.join(MAIN, "model-errors");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function domainFiles(): string[] {
  return fs
    .readdirSync(DOMAIN)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(DOMAIN, name));
}

describe("model-errors 是纯函数域", () => {
  it("域里没有任何文件 import electron", () => {
    const offenders = domainFiles()
      .filter((file) => /from\s+["']electron["']/.test(read(file)))
      .map((file) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it("域里没有任何文件 import pi 域（依赖方向是 pi → kernel，不能反过来）", () => {
    const offenders = domainFiles()
      .filter((file) => /from\s+["'][^"']*\/pi\/[\w-]+\.js["']/.test(read(file)))
      .map((file) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it("每个实现文件都有同名单测", () => {
    const impls = domainFiles()
      .map((file) => path.basename(file))
      .filter((name) => !name.endsWith(".test.ts") && name !== "index.ts");
    const tests = new Set(
      domainFiles()
        .map((file) => path.basename(file))
        .filter((name) => name.endsWith(".test.ts"))
    );
    const missing = impls.filter((name) => !tests.has(name.replace(/\.ts$/, ".test.ts")));
    expect(missing).toEqual([]);
  });
});

describe("归一化结论真的接上了 pi 的错误展示路径", () => {
  const supervisor = read(path.join(MAIN, "pi-supervisor.ts"));

  it("事件路径与退出路径都会推 pi:model-error", () => {
    expect(supervisor).toContain("modelErrorFromAgentEvent");
    expect(supervisor).toContain("modelErrorFromExit");
    const pushes = supervisor.match(/PUSH_CHANNELS\.piModelError/g) ?? [];
    expect(pushes.length).toBe(2);
  });

  it("推送仍然只经 event-forwarder 的 sendPush（不新开直发口）", () => {
    expect(supervisor).not.toMatch(/target\.send\(\s*PUSH_CHANNELS\.piModelError/);
  });

  it("通道在 PUSH_CONTRACTS 里有 payload schema", () => {
    const schema = PUSH_CONTRACTS[PUSH_CHANNELS.piModelError];
    expect(schema).toBeTruthy();
    expect(
      schema.safeParse({
        kind: "context_overflow",
        source: "message",
        message: "Context window exceeded",
        raw: "prompt is too long",
        retryable: false,
      }).success
    ).toBe(true);
    // kind 是封闭集合：上游多一类而我们没跟上时，宁可在边界上被挡住
    expect(schema.safeParse({ kind: "brand_new", source: "message" }).success).toBe(false);
  });

  it("preload 暴露了订阅口，渲染进程真的订阅了它", () => {
    expect(read(path.join(PRELOAD, "api/pi.ts"))).toContain("onModelError");
    expect(read(path.join(RENDERER, "stores/app.ts"))).toContain(
      "onModelError((e) => handleModelErrorEnvelope(e))"
    );
  });

  it("渲染层的中文建议覆盖归一化的每一个 kind", () => {
    // 少一个 kind 的表现是界面上落到「出了点问题」这句没内容的话上，
    // 不报错、不失败类型检查。用一次穷举把它变成红灯。
    const advice = read(path.join(RENDERER, "model-error-advice.ts"));
    for (const kind of [
      "context_overflow",
      "rate_limit",
      "auth",
      "provider_billing",
      "provider_unavailable",
      "network",
      "timeout",
      "abort",
      "unknown",
    ]) {
      expect(advice, kind).toContain(`${kind}:`);
    }
  });
});

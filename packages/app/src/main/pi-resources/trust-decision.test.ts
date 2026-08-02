/**
 * project trust 决定 → pi 启动参数的三条**互斥**断言。
 *
 * 断言的对象刻意是 `buildPiSpawn(...).args` 而不是 trust-store 里的某个
 * 源码字面量：任何一种「固定行为」（永远加 -a / 永远加 -na / 永远不加）
 * 都会同时挂在其中两条上，因此这一组测试真正钉住的是**决定与参数之间的
 * 映射**，而不是「代码里出现过这两个字符串」。
 *
 * 依据 pi docs/security.md:30：
 *   非交互模式（-p / --mode json / --mode rpc）**不显示 trust 提示**。
 *   没有可用的已保存决定时，`--approve`/`-a` 与 `--no-approve`/`-na`
 *   可以覆盖本次运行的 project trust。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TRUST_NOT_PERMISSION_NOTE } from "@pibuddy/contract";

import { buildPiSpawn } from "../pi-launcher.js";
import { describeTrust, lookupTrust, trustArgsFor, writeTrustDecision } from "./trust-store.js";

let home = "";
let project = "";

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "pibuddy-trust-"));
  home = path.join(base, "home");
  project = path.join(base, "project");
  await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
  await fs.mkdir(path.join(project, ".pi", "skills"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(home), { recursive: true, force: true }).catch(() => undefined);
});

/** 用一次真实的 buildPiSpawn 把 trust 参数走完整条路。 */
function spawnArgs(trustArgs: string[]): string[] {
  return buildPiSpawn({ packaged: false, trustArgs }).args ?? [];
}

describe("(a) 无已保存决定 + 用户拒绝", () => {
  it("args 含 -na 且不含 -a", () => {
    const args = spawnArgs(
      trustArgsFor({ hasProjectResources: true, saved: "none", decision: "deny" })
    );
    expect(args).toContain("-na");
    expect(args).not.toContain("-a");
  });
});

describe("(b) 无已保存决定 + 用户信任", () => {
  it("args 含 -a 且不含 -na", () => {
    const args = spawnArgs(
      trustArgsFor({ hasProjectResources: true, saved: "none", decision: "allow" })
    );
    expect(args).toContain("-a");
    expect(args).not.toContain("-na");
  });
});

describe("(c) trust.json 中已有该目录的决定", () => {
  it("args 既不含 -a 也不含 -na —— 让 pi 自己去读 trust.json", async () => {
    await writeTrustDecision(project, true, { homeDir: home });
    const saved = await lookupTrust(project, home);
    expect(saved.decision).toBe("allow");

    const args = spawnArgs(
      trustArgsFor({ hasProjectResources: true, saved: saved.decision, decision: "allow" })
    );
    expect(args).not.toContain("-a");
    expect(args).not.toContain("-na");
    expect(args).toEqual([]);
  });

  it("已保存 deny 同样不重复表达", async () => {
    await writeTrustDecision(project, false, { homeDir: home });
    const saved = await lookupTrust(project, home);
    expect(saved.decision).toBe("deny");
    expect(
      trustArgsFor({ hasProjectResources: true, saved: saved.decision, decision: "deny" })
    ).toEqual([]);
  });
});

describe("trust 状态里的固定文案", () => {
  it("note 恒等于契约里的常量，调用方编不出一句更好听的话", async () => {
    const state = await describeTrust({
      workspaceId: "ws",
      workspaceRoot: project,
      defaultProjectTrust: "ask",
      homeDir: home,
    });
    expect(state.note).toBe(TRUST_NOT_PERMISSION_NOTE);
    expect(state.note).toContain("信任不等于工具权限");
    // .pi/skills 存在 => 有需要信任才会加载的项目资源 => RPC 模式下必须由我们问
    expect(state.hasProjectResources).toBe(true);
    expect(state.needsPrompt).toBe(true);
  });
});

describe("[CT-11] 追加 trust 参数不得动摇运行时定位", () => {
  it("spawn 仍然是「内置运行时 + --mode rpc」，command 恒为 process.execPath", () => {
    const spawn = buildPiSpawn({ packaged: false, trustArgs: ["-na"] });
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.shell).toBe(false);
    expect(spawn.runtime.source).toBe("bundled");
    // prefixArgs 里是 pi 的 cli.js；trust 参数在 args 里，两者不混
    expect(spawn.prefixArgs?.[0]).toMatch(/cli\.js$/);
    expect(spawn.args).toEqual(["-na"]);
  });

  it("不传 trustArgs 时 args 为空数组（不是 undefined，避免调用方各写一次兜底）", () => {
    expect(buildPiSpawn({ packaged: false }).args).toEqual([]);
  });
});

/**
 * 资源扫描的四条回归线（TASK-012）。
 *
 *   1. 形状 —— 契约字段一个都不能少，且 user / project 两种来源都要枚举到；
 *   2. 未受信 —— project 资源必须显示成「不会被加载」，不能冒充正常条目；
 *   3. 冲突 —— 同名同类必须互指，否则用户会以为自己改的那份没生效是 bug；
 *   4. 不阻塞 —— 几千条资源时事件循环必须还能转，否则窗口在扫描期间是死的。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRUST_NOT_PERMISSION_NOTE,
  type ProjectTrustState,
  type TrustDecision,
} from "@pibuddy/contract";

import { scanResources, UNTRUSTED_DIAGNOSTIC } from "./resource-scanner.js";

let base: string;
let home: string;
let workspace: string;

function trustState(effective: TrustDecision): ProjectTrustState {
  return {
    workspaceId: "ws-1",
    hasProjectResources: true,
    resources: [],
    saved: effective === "allow" ? "allow" : "deny",
    defaultProjectTrust: "ask",
    effective,
    needsPrompt: false,
    note: TRUST_NOT_PERMISSION_NOTE,
  };
}

async function writeFileIn(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "pibuddy-scan-"));
  home = path.join(base, "home");
  workspace = path.join(base, "workspace");

  // 假 home
  await writeFileIn(path.join(home, ".pi", "agent", "skills", "a.md"), "# 技能 a\n");
  await writeFileIn(path.join(home, ".pi", "agent", "skills", "b", "SKILL.md"), "# 技能 b\n");
  await writeFileIn(path.join(home, ".agents", "skills", "c", "SKILL.md"), "# 技能 c\n");

  // 假 workspace
  await writeFileIn(path.join(workspace, ".pi", "skills", "d", "SKILL.md"), "# 技能 d\n");
  await writeFileIn(path.join(workspace, ".pi", "settings.json"), "{}\n");
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("scanResources 的结果形状", () => {
  it("每条资源都带齐契约字段，且 source 覆盖 user 与 project", async () => {
    const result = await scanResources({
      workspaceRoot: workspace,
      workspaceId: "ws-1",
      homeDir: home,
      trust: trustState("allow"),
    });

    expect(result.resources.length).toBeGreaterThan(0);
    for (const resource of result.resources) {
      for (const key of [
        "kind",
        "name",
        "version",
        "source",
        "path",
        "enabled",
        "conflictWith",
      ] as const) {
        expect(Object.keys(resource)).toContain(key);
      }
      expect(Array.isArray(resource.conflictWith)).toBe(true);
      expect(resource.id).toMatch(/^[0-9a-f]{16}$/);
    }

    const sources = new Set(result.resources.map((r) => r.source));
    expect(sources.has("user")).toBe(true);
    expect(sources.has("project")).toBe(true);

    const names = result.resources.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["a", "b", "c", "d"]));

    expect(result.mcp.implemented).toBe(false);
    expect(result.mcp.note).toContain("尚未实现");
    expect(result.errors).toEqual([]);
    expect(result.scannedAt).toBeGreaterThan(0);
  });

  it("没传 trust 时退回保守占位：effective=deny", async () => {
    const result = await scanResources({
      workspaceRoot: workspace,
      workspaceId: "ws-1",
      homeDir: home,
    });

    expect(result.trust.effective).toBe("deny");
    expect(result.trust.saved).toBe("none");
    expect(result.trust.needsPrompt).toBe(false);
  });
});

describe("未受信的项目资源", () => {
  it("trust.effective 为 deny 时 enabled=false 且带诊断", async () => {
    const result = await scanResources({
      workspaceRoot: workspace,
      workspaceId: "ws-1",
      homeDir: home,
      trust: trustState("deny"),
    });

    const projectOnes = result.resources.filter((r) => r.source === "project");
    expect(projectOnes.length).toBeGreaterThan(0);
    for (const resource of projectOnes) {
      expect(resource.enabled).toBe(false);
      expect(resource.diagnostics.length).toBeGreaterThan(0);
      expect(resource.diagnostics).toContain(UNTRUSTED_DIAGNOSTIC);
    }

    // user 来源不受 trust 影响，否则用户会以为自己的全局技能也坏了。
    const userOnes = result.resources.filter((r) => r.source === "user");
    expect(userOnes.every((r) => r.enabled)).toBe(true);
  });
});

describe("同名冲突", () => {
  it("user 与 project 的同名技能互相出现在对方的 conflictWith 里", async () => {
    await writeFileIn(path.join(home, ".pi", "agent", "skills", "dup", "SKILL.md"), "# 全局\n");
    await writeFileIn(path.join(workspace, ".pi", "skills", "dup", "SKILL.md"), "# 项目\n");

    const result = await scanResources({
      workspaceRoot: workspace,
      workspaceId: "ws-1",
      homeDir: home,
      trust: trustState("allow"),
    });

    const dups = result.resources.filter((r) => r.kind === "skill" && r.name === "dup");
    expect(dups).toHaveLength(2);

    const [first, second] = dups;
    expect(first.conflictWith).toContain(second.id);
    expect(second.conflictWith).toContain(first.id);
    expect(first.id).not.toBe(second.id);

    // 不冲突的条目必须是空数组，不能被顺手填上自己。
    const solo = result.resources.find((r) => r.name === "a");
    expect(solo?.conflictWith).toEqual([]);
  });
});

describe("禁用列表", () => {
  it("settings.json 的 disabledSkills 命中时 enabled=false", async () => {
    await writeFileIn(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ disabledSkills: ["b"] })
    );

    const result = await scanResources({
      workspaceRoot: workspace,
      workspaceId: "ws-1",
      homeDir: home,
      trust: trustState("allow"),
    });

    const b = result.resources.find((r) => r.name === "b");
    expect(b?.enabled).toBe(false);
  });
});

describe("错误折叠", () => {
  it("settings.json 坏掉时记一条中文错误而不是抛异常", async () => {
    await writeFileIn(path.join(workspace, ".pi", "settings.json"), "{ 这不是 JSON");

    const result = await scanResources({
      workspaceRoot: workspace,
      workspaceId: "ws-1",
      homeDir: home,
      trust: trustState("allow"),
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join("\n")).toContain("JSON 解析失败");
    // 错误不能让整次扫描作废。
    expect(result.resources.length).toBeGreaterThan(0);
  });
});

describe("不阻塞事件循环", () => {
  it("5000 条目扫描期间，setImmediate 回调仍在 50ms 内被执行", async () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      path.join(home, ".pi", "agent", "skills", `bulk-${i}`)
    );
    await writeFileIn(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ skills: many })
    );

    const started = Date.now();
    let ranAt = 0;

    const pending = scanResources({
      workspaceRoot: workspace,
      workspaceId: "ws-1",
      homeDir: home,
      trust: trustState("allow"),
    });
    setImmediate(() => {
      ranAt = Date.now();
    });

    const result = await pending;

    expect(ranAt).toBeGreaterThan(0);
    expect(ranAt - started).toBeLessThan(50);
    expect(result.resources.length).toBeGreaterThanOrEqual(5000);
  });
});

/**
 * 真机上抓到的噪声：`~/.pi/agent/npm/node_modules` 下平铺着 npm 给那几个
 * pi 包拉下来的**全部传递依赖**。实测用户装了 3 个包，面板上列出 454 条 ——
 * zod / chalk / @babel/runtime 逐条出现在「Pi 资源」里，用户既看不懂也没法
 * 处置，而 conflictWith 会在这几百条之间互相点名，真正的同名技能冲突就此
 * 淹没在噪声里。
 */
describe("只登记真正的 pi 包，不登记传递依赖", () => {
  it("带 pi 键 / pi-package 关键字的包进列表，普通依赖不进", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "pibuddy-pkg-"));
    const nm = path.join(home, ".pi", "agent", "npm", "node_modules");
    const mk = async (name: string, manifest: Record<string, unknown>) => {
      const dir = path.join(nm, ...name.split("/"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name, version: "1.0.0", ...manifest }),
        "utf8"
      );
    };
    await mk("real-pi-pkg", { pi: { skills: ["skills"] } });
    await mk("keyworded-pkg", { keywords: ["pi-package"] });
    await mk("conventional-pkg", { files: ["extensions"] });
    await mk("zod", {});
    await mk("@babel/runtime", {});

    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "pibuddy-ws-"));
    const result = await scanResources({ workspaceRoot: ws, workspaceId: "ws", homeDir: home });
    const names = result.resources.filter((r) => r.kind === "package").map((r) => r.name).sort();

    expect(names).toEqual(["conventional-pkg", "keyworded-pkg", "real-pi-pkg"]);
    expect(names).not.toContain("zod");
    expect(names).not.toContain("@babel/runtime");

    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });
});

/**
 * 真机上抓到的缺口：装完一个带技能的包，「包」那一组多了一条，而「技能」
 * 那一组一条不变 —— 用户看不到自己刚装的技能，只能盲发 `/skill:xxx` 试。
 * skills.md 明确 pi 会从包的 `skills/` 目录或 `pi.skills` 声明里加载技能。
 */
describe("包自带的资源也要列出来", () => {
  it("包里的 skills/ 与 extensions/ 以 source=package 出现在列表里", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "pibuddy-owned-"));
    const pkg = path.join(home, ".pi", "agent", "npm", "node_modules", "with-stuff");
    await fs.mkdir(path.join(pkg, "skills", "packed-skill"), { recursive: true });
    await fs.mkdir(path.join(pkg, "extensions"), { recursive: true });
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "with-stuff", version: "2.0.0", pi: { skills: ["skills"] } }),
      "utf8"
    );
    await fs.writeFile(
      path.join(pkg, "skills", "packed-skill", "SKILL.md"),
      "---\nname: packed-skill\n---\n",
      "utf8"
    );
    await fs.writeFile(path.join(pkg, "extensions", "packed-ext.ts"), "export default () => {};", "utf8");

    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "pibuddy-ws2-"));
    const result = await scanResources({ workspaceRoot: ws, workspaceId: "ws", homeDir: home });

    const skill = result.resources.find((r) => r.kind === "skill" && r.name === "packed-skill");
    const ext = result.resources.find((r) => r.kind === "extension" && r.name.includes("packed-ext"));
    expect(skill).toBeTruthy();
    expect(skill?.source).toBe("package");
    expect(ext).toBeTruthy();
    expect(ext?.source).toBe("package");

    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });
});

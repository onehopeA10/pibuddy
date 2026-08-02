/**
 * trust.json 的四条回归线（TASK-012）。
 *
 * 每条都对着一个具体的坏结果，而不是「覆盖率」：
 *   (a) 合并写 —— 覆盖式写会抹掉用户在终端里对别的项目做过的决定；
 *   (b) canonical key —— 同一目录两条入口写出两条记录，用户被反复追问；
 *   (c) 祖先继承 —— 在 monorepo 根信任过，子包里又被问一遍；
 *   (d) trustArgsFor —— `-a`/`-na` 是一次性覆盖，常驻会架空 trust.json。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalDir,
  describeTrust,
  detectProjectResources,
  lookupTrust,
  readTrust,
  trustArgsFor,
  trustFilePath,
  writeTrustDecision,
} from "./trust-store.js";

let home: string;
let scratch: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "pibuddy-trust-"));
  home = path.join(base, "home");
  scratch = path.join(base, "scratch");
  await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
  await fs.mkdir(scratch, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(home), { recursive: true, force: true });
});

async function readRaw(): Promise<Record<string, unknown>> {
  const text = await fs.readFile(trustFilePath(home), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("writeTrustDecision", () => {
  it("(a) 写入新目录的决定时，其它目录的已有条目原样保留", async () => {
    const foreign = path.join(scratch, "别的项目");
    await fs.mkdir(foreign, { recursive: true });
    const foreignKey = await canonicalDir(foreign);

    await writeTrustDecision(foreign, true, { homeDir: home });

    const mine = path.join(scratch, "我的项目");
    await fs.mkdir(mine, { recursive: true });
    await writeTrustDecision(mine, false, { homeDir: home });

    const file = await readTrust(home);
    expect(Object.keys(file)).toHaveLength(2);
    expect(file[foreignKey]?.trusted).toBe(true);
    expect(file[await canonicalDir(mine)]?.trusted).toBe(false);
  });

  it("(b) 同一目录经 symlink 与真实路径分别写入，只产生一条记录", async () => {
    const real = path.join(scratch, "real-project");
    await fs.mkdir(real, { recursive: true });
    const link = path.join(scratch, "link-project");

    let linkCreated = true;
    try {
      // Windows 上普通用户建符号链接要 EPERM；目录 junction 不需要特权。
      await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      linkCreated = false;
    }

    // 无建链权限时的等价回落：同一目录的两种写法（`./sub/../sub` 与绝对路径），
    // 同样必须折成一条记录。跳过这条断言等于让 (b) 在 CI 上默默失效。
    const secondEntry = linkCreated
      ? link
      : path.join(scratch, "real-project", "..", "real-project");

    await writeTrustDecision(real, true, { homeDir: home });
    await writeTrustDecision(secondEntry, true, { homeDir: home });

    const raw = await readRaw();
    expect(Object.keys(raw)).toHaveLength(1);
    expect(Object.keys(raw)[0]).toBe(await canonicalDir(real));
  });

  it("(b') 无 symlink 权限时的等价形式：./sub/../sub 与绝对路径仍只产生一条记录", async () => {
    const real = path.join(scratch, "dotdot-project");
    await fs.mkdir(real, { recursive: true });

    await writeTrustDecision(real, false, { homeDir: home });
    await writeTrustDecision(path.join(scratch, "dotdot-project", "..", "dotdot-project"), false, {
      homeDir: home,
    });

    expect(Object.keys(await readRaw())).toHaveLength(1);
  });

  it("坏掉的 trust.json 读成空对象而不是抛异常", async () => {
    await fs.writeFile(trustFilePath(home), "{ 这不是 JSON", "utf8");
    await expect(readTrust(home)).resolves.toEqual({});
  });
});

describe("lookupTrust", () => {
  it("(c) 从祖先目录继承决定，并报出命中的那个目录", async () => {
    const root = path.join(scratch, "monorepo");
    const nested = path.join(root, "packages", "app", "src");
    await fs.mkdir(nested, { recursive: true });

    await writeTrustDecision(root, true, { homeDir: home });

    const hit = await lookupTrust(nested, home);
    expect(hit.decision).toBe("allow");
    expect(hit.at).toBe(await canonicalDir(root));
  });

  it("最近的祖先赢：子目录的 deny 覆盖根目录的 allow", async () => {
    const root = path.join(scratch, "mono2");
    const nested = path.join(root, "vendor");
    await fs.mkdir(nested, { recursive: true });

    await writeTrustDecision(root, true, { homeDir: home });
    await writeTrustDecision(nested, false, { homeDir: home });

    await expect(lookupTrust(nested, home)).resolves.toMatchObject({ decision: "deny" });
  });

  it("没有任何已保存决定时返回 none", async () => {
    await expect(lookupTrust(scratch, home)).resolves.toEqual({ decision: "none" });
  });
});

describe("trustArgsFor", () => {
  it("(d) 无已保存决定 + deny → ['-na']，且不含 -a", () => {
    const argv = trustArgsFor({ hasProjectResources: true, saved: "none", decision: "deny" });
    expect(argv).toEqual(["-na"]);
    expect(argv).not.toContain("-a");
  });

  it("(d) 无已保存决定 + allow → ['-a']，且不含 -na", () => {
    const argv = trustArgsFor({ hasProjectResources: true, saved: "none", decision: "allow" });
    expect(argv).toEqual(["-a"]);
    expect(argv).not.toContain("-na");
  });

  it("(d) 已有已保存决定 → []，既不含 -a 也不含 -na", () => {
    for (const saved of ["allow", "deny"] as const) {
      const argv = trustArgsFor({ hasProjectResources: true, saved, decision: "allow" });
      expect(argv).toEqual([]);
      expect(argv).not.toContain("-a");
      expect(argv).not.toContain("-na");
    }
  });

  it("无已保存决定且用户还没做选择 → []", () => {
    expect(trustArgsFor({ hasProjectResources: true, saved: "none" })).toEqual([]);
  });
});

describe("detectProjectResources", () => {
  it("裸 .pi 目录不算需要信任的项目资源", async () => {
    const ws = path.join(scratch, "bare");
    await fs.mkdir(path.join(ws, ".pi"), { recursive: true });
    await expect(detectProjectResources(ws)).resolves.toEqual([]);
  });

  it("认出 .pi/settings.json 与 .pi/skills", async () => {
    const ws = path.join(scratch, "withres");
    await fs.mkdir(path.join(ws, ".pi", "skills"), { recursive: true });
    await fs.writeFile(path.join(ws, ".pi", "settings.json"), "{}", "utf8");

    const found = await detectProjectResources(ws);
    const labels = found.map((r) => r.label);
    expect(labels).toContain("项目设置 .pi/settings.json");
    expect(labels).toContain("项目技能 .pi/skills");
  });
});

describe("describeTrust", () => {
  it("有项目资源 + 无已保存决定 + ask → 必须弹窗，且本次生效为 deny", async () => {
    const ws = path.join(scratch, "ask-ws");
    await fs.mkdir(path.join(ws, ".pi", "skills"), { recursive: true });

    const state = await describeTrust({
      workspaceId: "ws-1",
      workspaceRoot: ws,
      defaultProjectTrust: "ask",
      homeDir: home,
    });

    expect(state.hasProjectResources).toBe(true);
    expect(state.saved).toBe("none");
    expect(state.effective).toBe("deny");
    expect(state.needsPrompt).toBe(true);
    expect(state.note).toContain("信任不等于工具权限");
  });

  it("defaultProjectTrust=always 时无需弹窗且直接 allow", async () => {
    const ws = path.join(scratch, "always-ws");
    await fs.mkdir(path.join(ws, ".pi", "skills"), { recursive: true });

    const state = await describeTrust({
      workspaceId: "ws-2",
      workspaceRoot: ws,
      defaultProjectTrust: "always",
      homeDir: home,
    });

    expect(state.effective).toBe("allow");
    expect(state.needsPrompt).toBe(false);
  });

  it("已保存的 deny 压过 defaultProjectTrust=always", async () => {
    const ws = path.join(scratch, "saved-deny-ws");
    await fs.mkdir(path.join(ws, ".pi", "skills"), { recursive: true });
    await writeTrustDecision(ws, false, { homeDir: home });

    const state = await describeTrust({
      workspaceId: "ws-3",
      workspaceRoot: ws,
      defaultProjectTrust: "always",
      homeDir: home,
    });

    expect(state.saved).toBe("deny");
    expect(state.effective).toBe("deny");
    expect(state.needsPrompt).toBe(false);
  });
});

/**
 * 磁盘形状必须与 pi 完全一致。
 *
 * pi 的 core/trust-manager.js `readTrustFile` 对每个值做严格校验：
 * 不是 true / false / null 就**整文件抛错**。也就是说，我们只要写错一次
 * 形状，用户下次在终端里跑 pi 就会看到 "Invalid trust store"，
 * 而且是他对**所有**项目做过的决定一起失效 —— 这是本任务 risks[2]
 * 「误写会影响用户在终端里的 pi」的具体形态。
 */
describe("trust.json 的磁盘形状与 pi 严格兼容", () => {
  /** pi 的校验逻辑，逐字照搬自 core/trust-manager.js:readTrustFile */
  function piWouldAccept(raw: string): boolean {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (value !== true && value !== false && value !== null) return false;
    }
    return true;
  }

  it("写入后每个值都是布尔，pi 读得动", async () => {
    const dir = path.join(home, "proj-a");
    await fs.mkdir(dir, { recursive: true });
    await writeTrustDecision(dir, true, { homeDir: home });

    const raw = await fs.readFile(trustFilePath(home), "utf8");
    expect(piWouldAccept(raw)).toBe(true);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.values(parsed).every((v) => typeof v === "boolean")).toBe(true);
  });

  it("`at` 只活在内存里，不落盘（不赌另一个程序的解析器）", async () => {
    const dir = path.join(home, "proj-b");
    await fs.mkdir(dir, { recursive: true });
    const inMemory = await writeTrustDecision(dir, false, { homeDir: home });
    const key = Object.keys(inMemory)[0];
    expect(inMemory[key].at).toBeTruthy();

    const raw = await fs.readFile(trustFilePath(home), "utf8");
    expect(raw).not.toContain('"at"');
    expect(raw).not.toContain('"trusted"');
  });

  it("已有的 pi 原生条目（布尔）在我们写入之后原样保留且仍是布尔", async () => {
    await fs.mkdir(path.dirname(trustFilePath(home)), { recursive: true });
    await fs.writeFile(
      trustFilePath(home),
      JSON.stringify({ "C:\other\project": true, "D:\nope": false }, null, 2),
      "utf8"
    );
    const dir = path.join(home, "proj-c");
    await fs.mkdir(dir, { recursive: true });
    await writeTrustDecision(dir, true, { homeDir: home });

    const raw = await fs.readFile(trustFilePath(home), "utf8");
    expect(piWouldAccept(raw)).toBe(true);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["C:\other\project"]).toBe(true);
    expect(parsed["D:\nope"]).toBe(false);
    expect(Object.keys(parsed)).toHaveLength(3);
  });
});

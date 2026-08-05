import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defineCapability,
  validateCapabilityManifest,
  type CapabilityManifest,
} from "@pibuddy/contract";
import {
  ASSET_LEDGER_FILENAME,
  nodeAssetFileOps,
  syncCapabilityAssets,
  verifyCapabilityAssets,
  type AssetFileOps,
} from "../src/main/capability/capability-assets.js";
import { BUILT_IN_CAPABILITIES } from "../src/main/capability/capability-manifests.js";

/**
 * 能力包 pi 资源装卸的判据（REQ-0001 R4）。
 *
 * ## 三块判据，对应 R4.4 的三句话
 *
 *  1. **物化 / 移除 / 升级的幂等性**：全部用真实文件系统跑在临时目录里
 *     （fs 操作可注入，这里注入一个计数包装来数「到底写了几次盘」——
 *     幂等的判据不是「结果长得一样」，而是「第二次一个字节都没写」）。
 *  2. **结构断言**：声明了资源的 manifest，其资源文件必须真实存在于
 *     capability-assets。断言函数自己要先被证明会红（拿指空的 fixture 喂它），
 *     再对真实清单跑——否则「当前没有包声明资源」会让它恒真。
 *  3. **drift 扩展：物化不绕过权限闸**。物化器是纯逻辑模块：不 import
 *     electron、不注册通道、不碰权限引擎；携带 extension 的包必须经 tools
 *     声明权限需求（validateCapabilityManifest 的 R4.3 规则，含反例）。
 *
 * fixture 包（test.fixture）的资源文件在 test/fixtures/capability-assets/，
 * 三类资源各一份，其中技能含子目录——证明整棵树物化与收回的端到端可用。
 */

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "fixtures", "capability-assets");
const REAL_ASSETS_ROOT = path.resolve(import.meta.dirname, "..", "resources", "capability-assets");
const APP_ROOT = path.resolve(import.meta.dirname, "..");

const FIXTURE_ID = "test.fixture";

function makeFixtureManifest(overrides: Record<string, unknown> = {}): CapabilityManifest {
  return defineCapability({
    manifestVersion: 1,
    id: FIXTURE_ID,
    version: "1.0.0",
    tier: "vertical",
    displayName: "R4 fixture",
    description: "装卸机制端到端 fixture，仅用于测试。",
    compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
    dependencies: [],
    // R4.3：携带 extension（回路内工具）就必须在 tools 里声明权限需求
    permissions: ["workspace.read"],
    channels: [],
    pushChannels: [],
    tools: [{ name: "test.fixture.echo", description: "回显", permissions: ["workspace.read"] }],
    uiContributions: [],
    settingsSchema: [],
    dataSchemaVersion: 1,
    runtime: { loading: "inline", heavyDependencies: [], teardown: [] },
    exposure: { module: "main/x.ts", register: "registerX" },
    piResources: {
      prompts: ["prompts/hello-fixture.md"],
      skills: ["skills/demo-skill"],
      extensions: ["extensions/demo-tool.ts"],
    },
    ...overrides,
  });
}

/** 计数包装：幂等判据要数的是「写盘次数」，不是「结果对不对」。 */
function countingOps(): { ops: AssetFileOps; counts: { writes: number; deletes: number } } {
  const counts = { writes: 0, deletes: 0 };
  const ops: AssetFileOps = {
    ...nodeAssetFileOps,
    async writeFile(file, data) {
      counts.writes += 1;
      await nodeAssetFileOps.writeFile(file, data);
    },
    async deleteFile(file) {
      counts.deletes += 1;
      await nodeAssetFileOps.deleteFile(file);
    },
  };
  return { ops, counts };
}

let piAgentDir: string;
let tmpRoots: string[];

beforeEach(() => {
  piAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-pi-agent-"));
  tmpRoots = [piAgentDir];
});

afterEach(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/** 可写的 assetsRoot 副本（升级用例要改源文件，fixture 目录本体是只读源）。 */
function mutableAssetsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-assets-"));
  tmpRoots.push(dir);
  fs.cpSync(path.join(FIXTURES_ROOT, FIXTURE_ID), path.join(dir, FIXTURE_ID), {
    recursive: true,
  });
  return dir;
}

function agentFile(rel: string): string {
  return path.join(piAgentDir, ...rel.split("/"));
}

async function syncOnce(args: {
  enabled: boolean;
  assetsRoot?: string;
  manifest?: CapabilityManifest;
  ops?: AssetFileOps;
  packs?: { manifest: CapabilityManifest; enabled: boolean }[];
}) {
  return syncCapabilityAssets({
    packs: args.packs ?? [{ manifest: args.manifest ?? makeFixtureManifest(), enabled: args.enabled }],
    assetsRoot: args.assetsRoot ?? FIXTURES_ROOT,
    piAgentDir,
    ops: args.ops,
  });
}

describe("R4.2 物化：启用即落盘，落到 pi 的目录约定上", () => {
  it("三类资源按 pi 约定落位：prompts/*.md、skills/<name>/**、extensions/*.ts", async () => {
    const report = await syncOnce({ enabled: true });
    expect(report.errors).toEqual([]);
    expect(report.conflicts).toEqual([]);
    // pi 的发现规则：prompts 非递归只认 .md；技能是含 SKILL.md 的目录（整树）；
    // extensions 认目录下的 .ts 文件
    expect(fs.existsSync(agentFile("prompts/hello-fixture.md"))).toBe(true);
    expect(fs.existsSync(agentFile("skills/demo-skill/SKILL.md"))).toBe(true);
    expect(fs.existsSync(agentFile("skills/demo-skill/references/notes.md"))).toBe(true);
    expect(fs.existsSync(agentFile("extensions/demo-tool.ts"))).toBe(true);
    // 内容逐字节等于源
    expect(fs.readFileSync(agentFile("prompts/hello-fixture.md"), "utf8")).toBe(
      fs.readFileSync(
        path.join(FIXTURES_ROOT, FIXTURE_ID, "prompts", "hello-fixture.md"),
        "utf8"
      )
    );
    // 归属账本落在 pi 目录根下，记着这个包的全部文件
    const ledger = JSON.parse(fs.readFileSync(agentFile(ASSET_LEDGER_FILENAME), "utf8"));
    expect(Object.keys(ledger.packs)).toEqual([FIXTURE_ID]);
    expect(Object.keys(ledger.packs[FIXTURE_ID].files).sort()).toEqual([
      "extensions/demo-tool.ts",
      "prompts/hello-fixture.md",
      "skills/demo-skill/SKILL.md",
      "skills/demo-skill/references/notes.md",
    ]);
  });

  it("幂等：重复启用一个字节都不写（含账本）", async () => {
    await syncOnce({ enabled: true });
    const { ops, counts } = countingOps();
    const report = await syncOnce({ enabled: true, ops });
    expect(report.written).toEqual([]);
    expect(counts.writes).toBe(0);
    expect(counts.deletes).toBe(0);
  });

  it("升级：源内容变了才覆盖，且只覆盖变了的那个文件", async () => {
    const assetsRoot = mutableAssetsRoot();
    await syncOnce({ enabled: true, assetsRoot });
    fs.writeFileSync(
      path.join(assetsRoot, FIXTURE_ID, "prompts", "hello-fixture.md"),
      "---\ndescription: v2\n---\n新版内容\n"
    );
    const { ops, counts } = countingOps();
    const report = await syncOnce({ enabled: true, assetsRoot, ops });
    expect(report.written).toEqual(["prompts/hello-fixture.md"]);
    // 一次文件写 + 一次账本写，其余文件不动
    expect(counts.writes).toBe(2);
    expect(fs.readFileSync(agentFile("prompts/hello-fixture.md"), "utf8")).toContain("新版内容");
  });

  it("自愈：在账的文件被删掉后，启用态的下一次对账把它补回来", async () => {
    await syncOnce({ enabled: true });
    fs.rmSync(agentFile("extensions/demo-tool.ts"));
    const report = await syncOnce({ enabled: true });
    expect(report.written).toEqual(["extensions/demo-tool.ts"]);
    expect(fs.existsSync(agentFile("extensions/demo-tool.ts"))).toBe(true);
  });

  it("用户已有同名文件：拒绝覆盖、不入账，停用时也绝不删它", async () => {
    fs.mkdirSync(agentFile("prompts"), { recursive: true });
    fs.writeFileSync(agentFile("prompts/hello-fixture.md"), "用户自己的同名 prompt\n");
    const report = await syncOnce({ enabled: true });
    expect(report.conflicts.some((c) => c.includes("prompts/hello-fixture.md"))).toBe(true);
    expect(fs.readFileSync(agentFile("prompts/hello-fixture.md"), "utf8")).toBe(
      "用户自己的同名 prompt\n"
    );
    // 停用：用户的文件原样留下（它从未进过账）
    await syncOnce({ enabled: false });
    expect(fs.readFileSync(agentFile("prompts/hello-fixture.md"), "utf8")).toBe(
      "用户自己的同名 prompt\n"
    );
  });
});

describe("R4.2 移除：停用只收自己的，用户的东西一根手指都不碰", () => {
  it("停用移除全部物化文件与建出来的技能目录，账本条目消失", async () => {
    await syncOnce({ enabled: true });
    // 用户手放的无关文件：必须原样活过整个装卸周期
    fs.writeFileSync(agentFile("prompts/user-own.md"), "用户自己的 prompt\n");
    const report = await syncOnce({ enabled: false });
    expect(report.removed.sort()).toEqual([
      "extensions/demo-tool.ts",
      "prompts/hello-fixture.md",
      "skills/demo-skill/SKILL.md",
      "skills/demo-skill/references/notes.md",
    ]);
    expect(fs.existsSync(agentFile("prompts/hello-fixture.md"))).toBe(false);
    // 物化时建出来的技能目录整个收掉；pi 的 kind 根目录（prompts/…）保留
    expect(fs.existsSync(agentFile("skills/demo-skill"))).toBe(false);
    expect(fs.existsSync(agentFile("prompts"))).toBe(true);
    expect(fs.readFileSync(agentFile("prompts/user-own.md"), "utf8")).toBe("用户自己的 prompt\n");
    const ledger = JSON.parse(fs.readFileSync(agentFile(ASSET_LEDGER_FILENAME), "utf8"));
    expect(ledger.packs).toEqual({});
  });

  it("停用是幂等的：再停一次，零写零删", async () => {
    await syncOnce({ enabled: true });
    await syncOnce({ enabled: false });
    const { ops, counts } = countingOps();
    const report = await syncOnce({ enabled: false, ops });
    expect([report.removed, counts.writes, counts.deletes]).toEqual([[], 0, 0]);
  });

  it("用户改过我们物化的文件：停用时保留文件、只从账上除名", async () => {
    await syncOnce({ enabled: true });
    fs.writeFileSync(agentFile("prompts/hello-fixture.md"), "用户在物化文件上的手改\n");
    const report = await syncOnce({ enabled: false });
    expect(report.keptEdited).toEqual(["prompts/hello-fixture.md"]);
    expect(fs.readFileSync(agentFile("prompts/hello-fixture.md"), "utf8")).toBe(
      "用户在物化文件上的手改\n"
    );
    const ledger = JSON.parse(fs.readFileSync(agentFile(ASSET_LEDGER_FILENAME), "utf8"));
    expect(ledger.packs).toEqual({});
  });

  it("包从构建里消失（账上有、清单里没有）：视同停用收回", async () => {
    await syncOnce({ enabled: true });
    const report = await syncOnce({ enabled: false, packs: [] });
    expect(report.removed.length).toBe(4);
    expect(fs.existsSync(agentFile("prompts/hello-fixture.md"))).toBe(false);
  });

  it("账本损坏：按空账处理——本次不移除任何旧文件，坏账报出来", async () => {
    await syncOnce({ enabled: true });
    fs.writeFileSync(agentFile(ASSET_LEDGER_FILENAME), "{ 不是 JSON");
    const report = await syncOnce({ enabled: false });
    expect(report.errors.some((e) => e.includes("归属账本解析失败"))).toBe(true);
    expect(report.removed).toEqual([]);
    // 读不出归属就不删：物化过的文件原地保留，等账本恢复后的下一次对账
    expect(fs.existsSync(agentFile("prompts/hello-fixture.md"))).toBe(true);
  });
});

describe("R4.1 manifest 扩展：字段可选缺省空，路径形态被钉死", () => {
  it("全部内置清单校验通过；未声明资源的 manifest 缺省补空（一字不改仍合法）", () => {
    // edu.kids（R3）的资产内容与物化/收回判据在 edu-assets.spec.ts，此处只锁名单。
    // R2 起 common.office-skills 成为第一个真声明 piResources 的内置包，
    // 「全员为空」的断言从此过时。改成两半：声明了的包名单**显式锁死**
    // （新包想带资源必须来改这一行，顺便被人审一眼），其余包仍必须是
    // zod default 补出来的三个空数组——既有 manifest 一字不改仍合法。
    // home.assistant 只带 1 个 extension（回路内工具的注册端，实现全部经主进程
    // tool bridge）；其资产存在性由 verifyCapabilityAssets 对真实资源根统一校验。
    // home.automation 同 home.assistant 口径：只带 1 个 extension（manage_rule
    // 的注册端，实现全部经主进程 tool bridge），资产存在性同样由
    // verifyCapabilityAssets 统一校验（home-automation-e2e.spec）。
    const DECLARING_PACKS = [
      "common.office-skills",
      "edu.kids",
      "home.assistant",
      "home.advisor",
      "home.automation",
    ];
    for (const manifest of BUILT_IN_CAPABILITIES) {
      expect([manifest.id, validateCapabilityManifest(manifest)]).toEqual([manifest.id, []]);
      if (DECLARING_PACKS.includes(manifest.id)) continue;
      expect([manifest.id, manifest.piResources]).toEqual([
        manifest.id,
        { prompts: [], skills: [], extensions: [] },
      ]);
    }
    const declared = BUILT_IN_CAPABILITIES.filter((m) => {
      const p = m.piResources;
      return p.prompts.length + p.skills.length + p.extensions.length > 0;
    }).map((m) => m.id);
    expect(declared.sort()).toEqual([...DECLARING_PACKS].sort());
  });

  it("R2：办公技能包恰声明三个技能目录，且是纯技能包（无 prompts / extensions）", () => {
    const office = BUILT_IN_CAPABILITIES.find((m) => m.id === "common.office-skills");
    expect(office).toBeDefined();
    expect([...office!.piResources.skills]).toEqual([
      "skills/office-file-organize",
      "skills/office-table-clean",
      "skills/office-doc-convert",
    ]);
    expect([...office!.piResources.prompts]).toEqual([]);
    expect([...office!.piResources.extensions]).toEqual([]);
  });

  it("路径逃逸一律拒绝：..、开头 /、反斜杠、盘符", () => {
    for (const bad of ["../evil.md", "/abs.md", "a\\b.md", "C:/x.md", "a/./b.md"]) {
      expect(() => makeFixtureManifest({ piResources: { prompts: [bad] } })).toThrow(
        /不是安全的相对 posix 路径/
      );
    }
  });

  it("重复声明与非 .md 的 prompt 都被拒绝", () => {
    expect(() =>
      makeFixtureManifest({
        piResources: { prompts: ["prompts/a.md"], skills: ["prompts/a.md"] },
      })
    ).toThrow(/piResources 重复声明/);
    expect(() => makeFixtureManifest({ piResources: { prompts: ["prompts/a.txt"] } })).toThrow(
      /必须是 \.md 文件/
    );
  });

  it("R4.3：携带 extensions 却不声明 tools → 校验失败（权限需求必须走 tools 进权限引擎）", () => {
    expect(() =>
      makeFixtureManifest({ tools: [], piResources: { extensions: ["extensions/demo-tool.ts"] } })
    ).toThrow(/携带回路内工具必须在 tools 里声明其权限需求/);
  });
});

describe("R4.4 结构断言：声明的资源必须真实存在（且断言自己会红）", () => {
  it("fixture 包对着 fixture 资源根：绿", async () => {
    const errors = await verifyCapabilityAssets([makeFixtureManifest()], FIXTURES_ROOT);
    expect(errors).toEqual([]);
  });

  it("清单指空（文件不存在）：红——这条证明断言不是恒真的", async () => {
    const bogus = makeFixtureManifest({
      piResources: { prompts: ["prompts/does-not-exist.md"] },
    });
    const errors = await verifyCapabilityAssets([bogus], FIXTURES_ROOT);
    expect(errors.some((e) => e.includes("does-not-exist.md") && e.includes("不存在"))).toBe(true);
  });

  it("技能目录缺 SKILL.md：红", async () => {
    const assetsRoot = mutableAssetsRoot();
    fs.rmSync(path.join(assetsRoot, FIXTURE_ID, "skills", "demo-skill", "SKILL.md"));
    const errors = await verifyCapabilityAssets([makeFixtureManifest()], assetsRoot);
    expect(errors.some((e) => e.includes("没有 SKILL.md"))).toBe(true);
  });

  it("全部内置清单对着真实 capability-assets 根：绿（有包声明资源起即刻生效）", async () => {
    const errors = await verifyCapabilityAssets(BUILT_IN_CAPABILITIES, REAL_ASSETS_ROOT);
    expect(errors).toEqual([]);
  });

  it("electron-builder 把 capability-assets 接进了 extraResources，且没动 pi-runtime 既有条目", () => {
    const yml = fs.readFileSync(path.join(APP_ROOT, "electron-builder.yml"), "utf8");
    expect(yml).toMatch(/from:\s*resources\/capability-assets\s*\n\s*to:\s*capability-assets/);
    expect(yml).toMatch(/from:\s*resources\/pi-runtime\s*\n\s*to:\s*pi-runtime/);
    // 源目录必须在磁盘上（extraResources 对缺目录直接构建失败）
    expect(fs.existsSync(REAL_ASSETS_ROOT)).toBe(true);
  });
});

describe("drift 扩展：资源物化不绕过权限闸（R4.3）", () => {
  const materializerSource = fs.readFileSync(
    path.join(APP_ROOT, "src", "main", "capability", "capability-assets.ts"),
    "utf8"
  );

  it("物化器是纯逻辑模块：不 import electron", () => {
    expect(materializerSource).not.toMatch(/from\s+["']electron["']/);
  });

  it("物化器不注册通道、不碰权限引擎：没有任何授予或旁路的入口", () => {
    // 物化是内核动作（R4.3）。它要是开始 registerHandler / setPermissionGate，
    // 就等于给资源通道开了一条自己的权限面——这里钉死为 0。
    for (const forbidden of ["ipcMain", "registerHandler(", "setPermissionGate"]) {
      expect([forbidden, materializerSource.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it("接线真实存在：index.ts 在装配后调用了启动对账", () => {
    const indexSource = fs.readFileSync(
      path.join(APP_ROOT, "src", "main", "index.ts"),
      "utf8"
    );
    expect(indexSource).toContain("syncCapabilityAssetsOnStartup()");
  });

  it("携带 extensions 的包（现在与将来）：tools 非空且工具权限 ⊆ manifest.permissions", () => {
    for (const manifest of [...BUILT_IN_CAPABILITIES, makeFixtureManifest()]) {
      const declared = manifest.piResources ?? { prompts: [], skills: [], extensions: [] };
      if (declared.extensions.length === 0) continue;
      expect([manifest.id, manifest.tools.length > 0]).toEqual([manifest.id, true]);
      for (const tool of manifest.tools) {
        const outside = tool.permissions.filter((p) => !manifest.permissions.includes(p));
        expect([manifest.id, tool.name, outside]).toEqual([manifest.id, tool.name, []]);
      }
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HOME_ADVISOR_CAPABILITY_ID,
  HOME_ADVISOR_SKILLS,
  HOME_AUTOMATION_CAPABILITY_ID,
} from "@pibuddy/contract";
import {
  ASSET_LEDGER_FILENAME,
  syncCapabilityAssets,
  verifyCapabilityAssets,
} from "../src/main/capability/capability-assets.js";
import { homeAdvisorCapability } from "../src/main/capability/manifests/home-advisor.manifest.js";
import { homeAutomationCapability } from "../src/main/capability/manifests/home-automation.manifest.js";
import { AGENT_PROFILES } from "../src/main/capability/capability-manifests.js";

/**
 * 智能家居场景/联动建议包的资产判据（home.advisor，家居四包之四）。
 *
 * ## 三块判据（照 edu-assets.spec 的手法）
 *
 *  1. **内容资产结构自检**：SKILL.md 的 name/description 满足 pi 的加载条件
 *     （name 小写连字符且与目录名一致、description 非空 ≤1024——缺了 pi 会
 *     静默不加载，那种失败 dev/单测全绿，只有真机看得出来）；两个技能的
 *     操作规程里钉着与基座/automation 包的工具名约定（并行开发的接口锚点）
 *     与「先确认再落地」的前置原则。
 *  2. **manifest 形态**：纯技能包（无 prompts / extensions / tools）、依赖
 *     home.assistant、不进任何内置 Profile（基座尚未合并，进 Profile 只会
 *     让整条 Profile 多一条常驻拒绝）。
 *  3. **启用物化 / 停用零残留**：对着真实资源根在临时 pi 目录里真跑一遍
 *     装→卸，断言停用后除账本外一个文件都不剩。
 */

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const REAL_ASSETS_ROOT = path.join(APP_ROOT, "resources", "capability-assets");
const ADVISOR_ASSETS_ROOT = path.join(REAL_ASSETS_ROOT, HOME_ADVISOR_CAPABILITY_ID);

/** 简易 frontmatter 解析（--- 包围的头部键值对），与 edu-assets.spec 同款。 */
function frontmatterOf(file: string): Record<string, string> {
  const source = fs.readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  expect([file, match !== null]).toEqual([file, true]);
  const out: Record<string, string> = {};
  for (const line of match![1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) out[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return out;
}

describe("内容资产结构自检（pi 的加载条件是隐式的，这里把它变成显式判据）", () => {
  it("声明的资源都真实存在（结构断言对本包单跑，防止混在全量里看不出归属）", async () => {
    expect(await verifyCapabilityAssets([homeAdvisorCapability], REAL_ASSETS_ROOT)).toEqual([]);
  });

  it("skills ≥2：SKILL.md 的 name 与目录名一致且形态合法，description 非空 ≤1024", () => {
    expect(homeAdvisorCapability.piResources.skills.length).toBeGreaterThanOrEqual(2);
    for (const rel of homeAdvisorCapability.piResources.skills) {
      const dirName = path.posix.basename(rel);
      const fm = frontmatterOf(path.join(ADVISOR_ASSETS_ROOT, rel, "SKILL.md"));
      // pi 的加载条件：name 必填（小写/数字/连字符）、description 必填 ≤1024，
      // 缺了不加载且不报错——这里把静默失败变成红灯。
      expect([rel, fm.name]).toEqual([rel, dirName]);
      expect([rel, /^[a-z0-9-]+$/.test(fm.name)]).toEqual([rel, true]);
      const description = fm.description ?? "";
      expect([rel, description.length > 0 && description.length <= 1024]).toEqual([rel, true]);
    }
  });

  it("manifest 的技能目录从契约唯一定义点派生，且带 home- 前缀防撞名", () => {
    expect([...homeAdvisorCapability.piResources.skills]).toEqual(
      HOME_ADVISOR_SKILLS.map((s) => `skills/${s.name}`)
    );
    for (const skill of HOME_ADVISOR_SKILLS) {
      expect([skill.name, skill.name.startsWith("home-")]).toEqual([skill.name, true]);
    }
  });

  it("场景建议技能钉着与基座/automation 的工具名约定与「先确认再落地」原则", () => {
    const scene = fs.readFileSync(
      path.join(ADVISOR_ASSETS_ROOT, "skills", "home-scene-advisor", "SKILL.md"),
      "utf8"
    );
    // 与并行开发的 home.assistant 基座钉死的三个工具名（计划里的接口锚点）：
    // 基座侧改名必须连这里一起改，否则技能文本指挥不动真工具。
    for (const tool of ["home.assistant.list_entities", "home.assistant.get_state", "home.assistant.call_service"]) {
      expect([tool, scene.includes(tool)]).toEqual([tool, true]);
    }
    // 落地走 home.automation 的规则工具；未启用时如实告知，不得静默模拟。
    expect(scene).toContain("home.automation.manage_rule");
    expect(scene).toContain("建议 → 确认 → 落地");
    // 安防慎自动化是本技能的安全底线，必须成文。
    expect(scene).toContain("默认不进自动化动作序列");
    // R4.5：散文兜底不再是唯一防线——正文里必须指名那条机制，否则读的人
    // 会以为「automation 关着时靠这段话兜住」，而那正是要被替掉的东西。
    expect(scene).toContain('requiredCapabilities: ["home.automation"]');
    // R4.6：技能内容的优先级边界成文。
    expect(scene).toContain("用户级内容");
  });

  it("能耗回顾技能只读、估算恒标注（不把快照包装成权威账单）", () => {
    const energy = fs.readFileSync(
      path.join(ADVISOR_ASSETS_ROOT, "skills", "home-energy-review", "SKILL.md"),
      "utf8"
    );
    for (const tool of ["home.assistant.list_entities", "home.assistant.get_state"]) {
      expect([tool, energy.includes(tool)]).toEqual([tool, true]);
    }
    expect(energy).toContain("估算");
    // 只读技能：正文不得出现控制类工具（唯一控制面 home.assistant.call_service 不许进来）。
    expect(energy.includes("home.assistant.call_service")).toBe(false);
  });

  it("纯技能包：无 prompts / extensions / tools，权限恰 workspace.read，依赖恰基座", () => {
    expect([...homeAdvisorCapability.piResources.prompts]).toEqual([]);
    expect([...homeAdvisorCapability.piResources.extensions]).toEqual([]);
    expect([...homeAdvisorCapability.tools]).toEqual([]);
    expect([...homeAdvisorCapability.permissions]).toEqual(["workspace.read"]);
    expect([...homeAdvisorCapability.dependencies]).toEqual(["home.assistant"]);
  });

  it("两级门控分工：整包依赖基座，场景技能单条额外要 automation（且两者不重叠）", () => {
    // 整包级：没有基座 ⇒ 本包整体拒绝启用（resolve 的不动点），一个技能都不物化。
    expect([...homeAdvisorCapability.dependencies]).toEqual(["home.assistant"]);
    // 单资源级：automation 没开 ⇒ 只有场景技能不物化，能耗回顾照常在。
    expect(homeAdvisorCapability.piResourceGates.map((g) => [g.kind, g.path])).toEqual([
      ["skills", "skills/home-scene-advisor"],
    ]);
    expect([...homeAdvisorCapability.piResourceGates[0].requiredCapabilities]).toEqual([
      HOME_AUTOMATION_CAPABILITY_ID,
    ]);
    // 门控从契约的唯一定义点派生，不手抄。
    expect(
      HOME_ADVISOR_SKILLS.filter((s) => (s.requiredCapabilities?.length ?? 0) > 0).map((s) => s.name)
    ).toEqual(["home-scene-advisor"]);
    // 两级判据不重叠（校验器已强制，这里把它变成本包的显式事实）。
    const gated = new Set(
      homeAdvisorCapability.piResourceGates.flatMap((g) => [...g.requiredCapabilities])
    );
    for (const dep of homeAdvisorCapability.dependencies) {
      expect([dep, gated.has(dep)]).toEqual([dep, false]);
    }
  });

  it("home.advisor 不进任何内置 Profile（基座未合并，全经 overrides 启用）", () => {
    for (const profile of AGENT_PROFILES) {
      expect([profile.id, profile.capabilityIds.includes(HOME_ADVISOR_CAPABILITY_ID)]).toEqual([
        profile.id,
        false,
      ]);
    }
  });
});

describe("启用物化 / 停用经账本收回、零残留", () => {
  let piAgentDir = "";

  beforeEach(() => {
    piAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-advisor-pi-"));
  });
  afterEach(() => {
    fs.rmSync(piAgentDir, { recursive: true, force: true });
  });

  function listAllFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    };
    walk(dir);
    return out.sort();
  }

  /**
   * 「automation 也开着」的宿主面。
   *
   * 用显式 host 而不是把 automation 塞进 packs：本组用例断言的是**本包**的
   * 零残留，多一个包进来就会多一份它自己的 extension 文件，那与本包无关。
   */
  const HOST_WITH_AUTOMATION = {
    enabledCapabilityIds: new Set([HOME_ADVISOR_CAPABILITY_ID, HOME_AUTOMATION_CAPABILITY_ID]),
    toolNames: new Set<string>(),
  };

  it("启用 → 两个技能物化就位；停用 → 全部收回，除账本外零残留", async () => {
    const enabledReport = await syncCapabilityAssets({
      packs: [{ manifest: homeAdvisorCapability, enabled: true }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
      host: HOST_WITH_AUTOMATION,
    });
    expect(enabledReport.errors).toEqual([]);
    expect(enabledReport.conflicts).toEqual([]);

    const files = new Set(listAllFiles(piAgentDir));
    for (const skill of HOME_ADVISOR_SKILLS) {
      expect([skill.name, files.has(`skills/${skill.name}/SKILL.md`)]).toEqual([skill.name, true]);
    }
    const ledger = JSON.parse(
      fs.readFileSync(path.join(piAgentDir, ASSET_LEDGER_FILENAME), "utf8")
    ) as { packs: Record<string, { files: Record<string, string> }> };
    expect(Object.keys(ledger.packs)).toEqual([HOME_ADVISOR_CAPABILITY_ID]);

    // 幂等：重跑一遍一个字节都不写
    const idempotent = await syncCapabilityAssets({
      packs: [{ manifest: homeAdvisorCapability, enabled: true }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
      host: HOST_WITH_AUTOMATION,
    });
    expect(idempotent.written).toEqual([]);
    expect(idempotent.removed).toEqual([]);

    // 停用：经账本收回，零残留
    const disabledReport = await syncCapabilityAssets({
      packs: [{ manifest: homeAdvisorCapability, enabled: false }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    expect(disabledReport.errors).toEqual([]);
    expect(disabledReport.keptEdited).toEqual([]);
    expect(listAllFiles(piAgentDir)).toEqual([ASSET_LEDGER_FILENAME]);
    const after = JSON.parse(
      fs.readFileSync(path.join(piAgentDir, ASSET_LEDGER_FILENAME), "utf8")
    ) as { packs: Record<string, unknown> };
    expect(after.packs).toEqual({});
  });

  it("automation 关 → 场景技能不物化，能耗回顾照常（真实场景的门控矩阵）", async () => {
    const report = await syncCapabilityAssets({
      // host 由 packs 推导：automation 不在册 ⇒ 门关着。
      packs: [
        { manifest: homeAdvisorCapability, enabled: true },
        { manifest: homeAutomationCapability, enabled: false },
      ],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    expect(report.errors).toEqual([]);
    const files = new Set(listAllFiles(piAgentDir));
    // 关键判据：模型看不到这个技能，也就不会去调一个不存在的 manage_rule。
    expect(files.has("skills/home-scene-advisor/SKILL.md")).toBe(false);
    // 单资源级：同包的另一个技能完全不受影响。
    expect(files.has("skills/home-energy-review/SKILL.md")).toBe(true);

    const scene = report.decisions.find((d) => d.path === "skills/home-scene-advisor");
    expect([scene?.capabilityId, scene?.reason, scene?.detail]).toEqual([
      HOME_ADVISOR_CAPABILITY_ID,
      "required_capability_missing",
      `所需能力包未启用：${HOME_AUTOMATION_CAPABILITY_ID}`,
    ]);
    expect(report.decisions.find((d) => d.path === "skills/home-energy-review")?.reason).toBe(
      "materialized"
    );
  });

  it("automation 由关转开 → 场景技能补上；再关回去 → 按账本收回", async () => {
    const packs = [
      { manifest: homeAdvisorCapability, enabled: true },
      { manifest: homeAutomationCapability, enabled: false },
    ];
    await syncCapabilityAssets({ packs, assetsRoot: REAL_ASSETS_ROOT, piAgentDir });

    const opened = await syncCapabilityAssets({
      packs: [packs[0], { manifest: homeAutomationCapability, enabled: true }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    expect(opened.written).toContain("skills/home-scene-advisor/SKILL.md");
    expect(new Set(listAllFiles(piAgentDir)).has("skills/home-scene-advisor/SKILL.md")).toBe(true);

    const closed = await syncCapabilityAssets({ packs, assetsRoot: REAL_ASSETS_ROOT, piAgentDir });
    expect(closed.removed).toContain("skills/home-scene-advisor/SKILL.md");
    // 目录整个收掉，不留一个空壳
    expect(fs.existsSync(path.join(piAgentDir, "skills", "home-scene-advisor"))).toBe(false);
    expect(new Set(listAllFiles(piAgentDir)).has("skills/home-energy-review/SKILL.md")).toBe(true);
  });
});

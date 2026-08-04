import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EDU_CAPABILITY_ID, EDU_MISTAKE_FILE_RELATIVE } from "@pibuddy/contract";
import {
  ASSET_LEDGER_FILENAME,
  syncCapabilityAssets,
  verifyCapabilityAssets,
} from "../src/main/capability/capability-assets.js";
import { eduKidsCapability } from "../src/main/capability/manifests/edu-kids.manifest.js";
import { AGENT_PROFILES } from "../src/main/capability/capability-manifests.js";

/**
 * 首个真内容垂直包的资产判据（edu.kids / REQ-0001 R3.2）。
 *
 * ## 三块判据
 *
 *  1. **两份出题器算法逐字节一致**：核心算法在仓库（可 typecheck、可单测）与
 *     extension（物化后由 pi 加载，不参与仓库 typecheck）各有一份，同步不靠
 *     自觉——PIBUDDY_EDU_MATH_CORE 标记块逐字节对账，改一份不改另一份即红。
 *  2. **内容资产的结构自检**：prompts 有 frontmatter description、文件名带
 *     edu- 前缀（防与 pi 已有命令撞名）；SKILL.md 的 name/description 满足
 *     pi 的加载条件（name 小写连字符且与目录名一致、description 非空 ≤1024
 *     ——缺了 pi 会静默不加载，那种失败 dev/单测全绿，只有真机看得出来）；
 *     错题本约定路径在 SKILL.md 与契约常量两处一致。
 *  3. **启用物化 / 停用零残留（R3.2）**：对着真实资源根在临时 pi 目录里真跑
 *     一遍装→卸，断言停用后除账本外一个文件都不剩、账本里无 edu.kids 条目。
 *     （通道侧的对照组在 capability-gate.spec：lite Profile 下 edu 三条通道
 *     一条都不注册。）
 */

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const REAL_ASSETS_ROOT = path.join(APP_ROOT, "resources", "capability-assets");
const EDU_ASSETS_ROOT = path.join(REAL_ASSETS_ROOT, EDU_CAPABILITY_ID);
const CORE_FILE = path.join(APP_ROOT, "src", "main", "edu", "math-worksheet-core.ts");
const EXTENSION_FILE = path.join(EDU_ASSETS_ROOT, "extensions", "edu-math-worksheet.ts");

const BEGIN = "// === PIBUDDY_EDU_MATH_CORE_BEGIN ===";
const END = "// === PIBUDDY_EDU_MATH_CORE_END ===";

function coreBlockOf(file: string): string {
  const source = fs.readFileSync(file, "utf8");
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  expect([file, begin >= 0 && end > begin]).toEqual([file, true]);
  return source.slice(begin, end + END.length);
}

/** 简易 frontmatter 解析（--- 包围的头部键值对）。 */
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

describe("出题器两份拷贝的同步（不靠自觉）", () => {
  it("仓库核心与 extension 的标记块逐字节一致，且块非空", () => {
    const repoBlock = coreBlockOf(CORE_FILE);
    const extensionBlock = coreBlockOf(EXTENSION_FILE);
    expect(repoBlock.length).toBeGreaterThan(1000);
    expect(extensionBlock).toBe(repoBlock);
  });

  it("标记块自包含：不含任何 import（物化后单文件执行，无处可 import）", () => {
    expect(/^\s*import\b/m.test(coreBlockOf(CORE_FILE))).toBe(false);
  });

  it("extension 注册的工具名与 manifest.tools 的声明一致", () => {
    const source = fs.readFileSync(EXTENSION_FILE, "utf8");
    for (const tool of eduKidsCapability.tools) {
      expect([tool.name, source.includes(`name: "${tool.name}"`)]).toEqual([tool.name, true]);
    }
  });
});

describe("内容资产结构自检（pi 的加载条件是隐式的，这里把它变成显式判据）", () => {
  it("声明的资源都真实存在（结构断言对本包单跑，防止混在全量里看不出归属）", async () => {
    expect(await verifyCapabilityAssets([eduKidsCapability], REAL_ASSETS_ROOT)).toEqual([]);
  });

  it("prompts ≥5：都有 frontmatter description，文件名带 edu- 前缀防撞名", () => {
    expect(eduKidsCapability.piResources.prompts.length).toBeGreaterThanOrEqual(5);
    for (const rel of eduKidsCapability.piResources.prompts) {
      const base = path.posix.basename(rel);
      expect([rel, base.startsWith("edu-")]).toEqual([rel, true]);
      const fm = frontmatterOf(path.join(EDU_ASSETS_ROOT, rel));
      expect([rel, (fm.description ?? "").length > 0]).toEqual([rel, true]);
    }
  });

  it("skills ≥2：SKILL.md 的 name 与目录名一致且形态合法，description 非空 ≤1024", () => {
    expect(eduKidsCapability.piResources.skills.length).toBeGreaterThanOrEqual(2);
    for (const rel of eduKidsCapability.piResources.skills) {
      const dirName = path.posix.basename(rel);
      const fm = frontmatterOf(path.join(EDU_ASSETS_ROOT, rel, "SKILL.md"));
      // pi 的加载条件：name 必填（小写/数字/连字符）、description 必填 ≤1024，
      // 缺了不加载且不报错——这里把静默失败变成红灯。
      expect([rel, fm.name]).toEqual([rel, dirName]);
      expect([rel, /^[a-z0-9-]+$/.test(fm.name)]).toEqual([rel, true]);
      const description = fm.description ?? "";
      expect([rel, description.length > 0 && description.length <= 1024]).toEqual([rel, true]);
    }
  });

  it("错题本约定路径在契约常量与 SKILL.md 两处一致（三方约定不许分叉）", () => {
    const skillSource = fs.readFileSync(
      path.join(EDU_ASSETS_ROOT, "skills", "edu-mistake-book", "SKILL.md"),
      "utf8"
    );
    expect(skillSource).toContain(EDU_MISTAKE_FILE_RELATIVE);
  });

  it("辅导原则前置：数学引导 prompt 里钉着「不代做作业」，出卷 skill 禁止改答案", () => {
    const coach = fs.readFileSync(path.join(EDU_ASSETS_ROOT, "prompts", "edu-math-coach.md"), "utf8");
    expect(coach).toContain("不代做作业");
    const worksheet = fs.readFileSync(
      path.join(EDU_ASSETS_ROOT, "skills", "edu-worksheet", "SKILL.md"),
      "utf8"
    );
    expect(worksheet).toContain("edu.kids.math_worksheet");
  });

  it("edu.kids 只进「家庭教育」Profile：默认 general 不带它（向后兼容铁律）", () => {
    for (const profile of AGENT_PROFILES) {
      const has = profile.capabilityIds.includes(EDU_CAPABILITY_ID);
      expect([profile.id, has]).toEqual([profile.id, profile.id === "education"]);
    }
  });
});

describe("R3.2：启用物化 / 停用经账本收回、零残留", () => {
  let piAgentDir = "";

  beforeEach(() => {
    piAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-edu-pi-"));
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

  it("启用 → 四件套物化就位；停用 → 全部收回，除账本外零残留", async () => {
    // ---- 启用：物化
    const enabledReport = await syncCapabilityAssets({
      packs: [{ manifest: eduKidsCapability, enabled: true }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    expect(enabledReport.errors).toEqual([]);
    expect(enabledReport.conflicts).toEqual([]);

    const files = new Set(listAllFiles(piAgentDir));
    for (const rel of eduKidsCapability.piResources.prompts) {
      expect([rel, files.has(`prompts/${path.posix.basename(rel)}`)]).toEqual([rel, true]);
    }
    expect(files.has("skills/edu-worksheet/SKILL.md")).toBe(true);
    expect(files.has("skills/edu-mistake-book/SKILL.md")).toBe(true);
    expect(files.has("extensions/edu-math-worksheet.ts")).toBe(true);
    const ledger = JSON.parse(
      fs.readFileSync(path.join(piAgentDir, ASSET_LEDGER_FILENAME), "utf8")
    ) as { packs: Record<string, { files: Record<string, string> }> };
    expect(Object.keys(ledger.packs)).toEqual([EDU_CAPABILITY_ID]);
    // 账上的文件数 == 物化的文件数（6 prompts + 2 SKILL.md + 1 extension = 9）
    expect(Object.keys(ledger.packs[EDU_CAPABILITY_ID].files)).toHaveLength(9);

    // ---- 幂等：重跑一遍一个字节都不写
    const idempotent = await syncCapabilityAssets({
      packs: [{ manifest: eduKidsCapability, enabled: true }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    expect(idempotent.written).toEqual([]);
    expect(idempotent.removed).toEqual([]);

    // ---- 停用：经账本收回，零残留
    const disabledReport = await syncCapabilityAssets({
      packs: [{ manifest: eduKidsCapability, enabled: false }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    expect(disabledReport.errors).toEqual([]);
    expect(disabledReport.keptEdited).toEqual([]);
    expect(disabledReport.removed).toHaveLength(9);

    // 除账本外一个文件都不剩；空出来的 skills/<name> 子目录也被收掉
    expect(listAllFiles(piAgentDir)).toEqual([ASSET_LEDGER_FILENAME]);
    const after = JSON.parse(
      fs.readFileSync(path.join(piAgentDir, ASSET_LEDGER_FILENAME), "utf8")
    ) as { packs: Record<string, unknown> };
    expect(after.packs).toEqual({});
  });

  it("用户手放的同名文件不被物化覆盖、停用时也不被误删（账本归属判据）", async () => {
    // 用户自己在 pi 目录里放了一个同名 prompt
    const userFile = path.join(piAgentDir, "prompts", "edu-word-cards.md");
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, "用户自己的同名提示词\n");

    const report = await syncCapabilityAssets({
      packs: [{ manifest: eduKidsCapability, enabled: true }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    expect(report.conflicts.some((c) => c.includes("edu-word-cards.md"))).toBe(true);
    expect(fs.readFileSync(userFile, "utf8")).toBe("用户自己的同名提示词\n");

    await syncCapabilityAssets({
      packs: [{ manifest: eduKidsCapability, enabled: false }],
      assetsRoot: REAL_ASSETS_ROOT,
      piAgentDir,
    });
    // 停用收回不碰用户的文件
    expect(fs.existsSync(userFile)).toBe(true);
  });
});

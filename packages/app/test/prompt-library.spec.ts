import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// prompt-library-prefs.ts 顶层 import electron（生产路径要 userData）。本文件
// 只测它的纯函数 togglePrefName，给 electron 一个最小替身即可 —— 工厂函数
// 会被 vitest 提升，因此这里只用字面量，不引用外层变量。
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/pibuddy-prompt-prefs-test" },
}));

import {
  PRESET_MARKER_KEY,
  createUserPromptFile,
  deleteUserPromptFile,
  listPromptLibrary,
  materializePresetPrompts,
  parsePromptFile,
  scanPromptDir,
  updateUserPromptFile,
} from "../src/main/prompt-library/prompt-library-files.js";
import { togglePrefName } from "../src/main/prompt-library/prompt-library-prefs.js";

/**
 * 提示词库（common.prompt-library / REQ-0001 R1）的行为判据。
 *
 * 全部走纯函数层（prompt-library-files.ts），目录由测试喂临时路径 ——
 * 不需要给 electron 打桩，判据因此钉在真正做事的那一半上。
 *
 * ## 对拍记录（把机制临时拆掉、确认变红）
 *
 *  1. 「首启动库非空」：把 listPromptLibrary 里的 materializePresetPrompts
 *     调用临时拆掉 → 「全新用户首启动……」两条用例红
 *     （entries 为空、目录里没有文件）。
 *  2. 「绝不覆盖用户文件」：把 materializePresetPrompts 里
 *     `existing.presetVersion === null → skip` 的归属标记判断临时拆掉
 *     （无条件覆盖）→ 「同名用户文件……」用例红（用户内容被预置覆盖）。
 */

/** 随包分发的预置目录（extraResources 的源头，仓库里真实存在）。 */
const PRESET_DIR = path.resolve(import.meta.dirname, "../resources/prompt-library");

/** 五个预置分类（R1.1 的五类办公场景）。 */
const PRESET_CATEGORIES = ["email", "data", "summary", "translate", "report"] as const;

let promptsDir: string;

beforeEach(() => {
  promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-prompts-"));
});

afterEach(() => {
  fs.rmSync(promptsDir, { recursive: true, force: true });
});

function presetFileNames(): string[] {
  return fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith(".md"));
}

describe("预置内容资产本身合规（R1.1：五类 × 每类 ≥3，含参数占位说明）", () => {
  it("至少 15 条，每条都有归属标记、分类、标题、说明与完整正文", () => {
    const names = presetFileNames();
    expect(names.length).toBeGreaterThanOrEqual(15);

    for (const name of names) {
      const parsed = parsePromptFile(fs.readFileSync(path.join(PRESET_DIR, name), "utf8"));
      // 归属标记：没有它，物化就无法区分预置与用户文件（升级永远不敢碰它）
      expect([name, parsed.presetVersion !== null]).toEqual([name, true]);
      expect([name, (PRESET_CATEGORIES as readonly string[]).includes(parsed.category ?? "")]).toEqual([name, true]);
      expect([name, (parsed.title ?? "").length > 0]).toEqual([name, true]);
      expect([name, parsed.description.length > 0]).toEqual([name, true]);
      // 「完整的模板正文，不是一句话占位」：正文要有实打实的长度，
      // 且带【】参数占位与「参数占位说明」一节（R1.1 的两条硬要求）
      expect([name, parsed.body.length >= 200]).toEqual([name, true]);
      expect([name, parsed.body.includes("【")]).toEqual([name, true]);
      expect([name, parsed.body.includes("参数占位说明")]).toEqual([name, true]);
    }
  });

  it("五类每类都不少于 3 条", () => {
    const counts = new Map<string, number>();
    for (const name of presetFileNames()) {
      const parsed = parsePromptFile(fs.readFileSync(path.join(PRESET_DIR, name), "utf8"));
      const category = parsed.category ?? "custom";
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    for (const category of PRESET_CATEGORIES) {
      expect([category, (counts.get(category) ?? 0) >= 3]).toEqual([category, true]);
    }
  });
});

describe("首启动物化：全新用户零配置，库非空（R1.4 前半）", () => {
  it("空 prompts 目录上 list 一次，预置全部就位", async () => {
    const result = await listPromptLibrary({ presetDir: PRESET_DIR, promptsDir });
    expect(result.errors).toEqual([]);
    expect(result.prompts.length).toBe(presetFileNames().length);
    expect(result.prompts.length).toBeGreaterThanOrEqual(15);
    // 磁盘上真的落了 pi 原生资源：pi 不经 PiBuddy 也能 `/名字` 用到它们
    const onDisk = fs.readdirSync(promptsDir).filter((n) => n.endsWith(".md"));
    expect(onDisk.sort()).toEqual(presetFileNames().sort());
  });

  it("prompts 目录不存在时也能物化（首启动没有 ~/.pi/agent/prompts 是常态）", async () => {
    const fresh = path.join(promptsDir, "nested", "prompts");
    const result = await listPromptLibrary({ presetDir: PRESET_DIR, promptsDir: fresh });
    expect(result.prompts.length).toBeGreaterThanOrEqual(15);
  });
});

describe("物化幂等 + 版本升级（R1.2）", () => {
  it("第二次物化一个字节都不写", async () => {
    const first = await materializePresetPrompts({ presetDir: PRESET_DIR, promptsDir });
    expect(first.written.length).toBe(presetFileNames().length);
    const second = await materializePresetPrompts({ presetDir: PRESET_DIR, promptsDir });
    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual(presetFileNames().sort());
  });

  it("目标带旧版本标记时覆盖成新版", async () => {
    const [name] = presetFileNames();
    const stale = [
      "---",
      "description: 旧版",
      `${PRESET_MARKER_KEY}: 0`,
      "pibuddy-category: email",
      "---",
      "旧版内容",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(promptsDir, name), stale, "utf8");

    const result = await materializePresetPrompts({ presetDir: PRESET_DIR, promptsDir });
    expect(result.written).toContain(name);
    expect(fs.readFileSync(path.join(promptsDir, name), "utf8")).toBe(
      fs.readFileSync(path.join(PRESET_DIR, name), "utf8")
    );
  });
});

describe("归属标记：绝不覆盖、绝不删除用户文件（R1.2）", () => {
  it("同名用户文件（无归属标记）物化后原封不动", async () => {
    const [name] = presetFileNames();
    const userContent = "---\ndescription: 我自己改过的\n---\n这是用户自己的内容，谁都不许动。\n";
    fs.writeFileSync(path.join(promptsDir, name), userContent, "utf8");

    const result = await materializePresetPrompts({ presetDir: PRESET_DIR, promptsDir });
    expect(result.written).not.toContain(name);
    expect(result.skipped).toContain(name);
    expect(fs.readFileSync(path.join(promptsDir, name), "utf8")).toBe(userContent);
  });

  it("用户自建的其它文件在物化后仍然在（物化只增改自己的，从不删别人的）", async () => {
    const userFile = path.join(promptsDir, "wo-de-moban.md");
    fs.writeFileSync(userFile, "---\ndescription: 用户自建\n---\n正文\n", "utf8");

    await materializePresetPrompts({ presetDir: PRESET_DIR, promptsDir });
    expect(fs.existsSync(userFile)).toBe(true);

    const scanned = await scanPromptDir(promptsDir);
    const mine = scanned.prompts.find((p) => p.entry.name === "wo-de-moban");
    expect(mine?.entry.preset).toBe(false);
    // 没有 pibuddy-category 的用户文件归入 custom 分组照常展示（同列，R1.3）
    expect(mine?.entry.category).toBe("custom");
  });
});

describe("用户自建提示词：可增删改；预置不可删不可改（R1.3）", () => {
  it("新建 → 扫描可见 → 编辑 → 删除，全程 pi 原生格式", async () => {
    const filePath = await createUserPromptFile({
      promptsDir,
      title: "周报速写",
      description: "把流水账变成周报",
      category: "report",
      content: "请把下面的工作流水账整理成周报：\n【粘贴流水账】",
    });
    expect(path.basename(filePath)).toBe("周报速写.md");

    let scanned = await scanPromptDir(promptsDir);
    let entry = scanned.prompts.find((p) => p.entry.name === "周报速写")?.entry;
    expect(entry).toBeDefined();
    expect(entry!.preset).toBe(false);
    expect(entry!.category).toBe("report");
    expect(entry!.title).toBe("周报速写");

    await updateUserPromptFile({ filePath, patch: { content: "改过的正文【占位】" } });
    scanned = await scanPromptDir(promptsDir);
    entry = scanned.prompts.find((p) => p.entry.name === "周报速写")?.entry;
    expect(entry!.content).toBe("改过的正文【占位】");
    // 编辑只动正文，标题与分类原样保留
    expect(entry!.title).toBe("周报速写");

    await deleteUserPromptFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("同名新建不覆盖，自动追加序号", async () => {
    const a = await createUserPromptFile({
      promptsDir,
      title: "同名",
      description: "",
      category: "custom",
      content: "第一份",
    });
    const b = await createUserPromptFile({
      promptsDir,
      title: "同名",
      description: "",
      category: "custom",
      content: "第二份",
    });
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, "utf8")).toContain("第一份");
    expect(fs.readFileSync(b, "utf8")).toContain("第二份");
  });

  it("预置文件：编辑与删除都被拒绝，文件原样", async () => {
    await materializePresetPrompts({ presetDir: PRESET_DIR, promptsDir });
    const [name] = presetFileNames();
    const target = path.join(promptsDir, name);
    const before = fs.readFileSync(target, "utf8");

    await expect(updateUserPromptFile({ filePath: target, patch: { content: "篡改" } })).rejects.toThrow(
      "PROMPT_PRESET_READONLY"
    );
    await expect(deleteUserPromptFile(target)).rejects.toThrow("PROMPT_PRESET_READONLY");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });
});

describe("收藏 / 隐藏偏好的集合操作", () => {
  it("togglePrefName 幂等增删", () => {
    expect(togglePrefName([], "a", true)).toEqual(["a"]);
    expect(togglePrefName(["a"], "a", true)).toEqual(["a"]);
    expect(togglePrefName(["a", "b"], "a", false)).toEqual(["b"]);
    expect(togglePrefName(["b"], "a", false)).toEqual(["b"]);
  });
});

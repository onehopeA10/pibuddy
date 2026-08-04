/**
 * 提示词库的文件层（common.prompt-library / REQ-0001 R1）。
 *
 * ## 这一层在回答什么
 *
 * 「预置提示词怎么到用户手里、用户自建的提示词怎么落盘」。落盘形态是
 * **pi 原生 prompt template**（docs/prompt-templates.md）：`~/.pi/agent/prompts/`
 * 下的 .md 文件，YAML frontmatter + Markdown 正文，文件名即 `/命令名`。
 * PiBuddy 只是这些文件的一个编辑器 + 分发器，不发明第二种存储 —— 界面上
 * 看到的每一条，pi 在会话里 `/名字` 同样能展开。
 *
 * ## 归属标记与三条铁律
 *
 * 预置文件的 frontmatter 带 `pibuddy-preset: <版本号>` 归属标记。物化
 * （materialize）据它做三件事：
 *
 *   1. **幂等**：目标文件已是同版本预置 → 一个字节都不写；
 *   2. **可升级**：目标文件带标记但版本更旧 → 覆盖成新版；
 *   3. **绝不碰用户的文件**：目标文件没有标记（用户自建，或用户改过并
 *      删掉了标记）→ 跳过，永不覆盖、永不删除。删除预置只有「隐藏」，
 *      隐藏是 PiBuddy 的偏好，不动磁盘上的 .md。
 *
 * 本文件是**纯函数层**：不 import electron，目录全部由调用方传入 ——
 * 单测直接喂临时目录，不需要给 electron 打桩（对拍判据钉在这里）。
 * 与 pi-resources 同一纪律：扫描 / 物化不抛异常，失败折成 errors 里的
 * 一句中文；全程 fs/promises。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  PROMPT_CATEGORIES,
  type PromptCategory,
  type PromptEntry,
} from "@pibuddy/contract";

/** frontmatter 里的归属标记键。值是该预置文件的版本号（整数）。 */
export const PRESET_MARKER_KEY = "pibuddy-preset";

// ---------------------------------------------------------------- frontmatter

/**
 * 解析后的 prompt 文件。
 *
 * 只认我们自己会写的那几个键（description / pibuddy-*）；用户手写的其它
 * frontmatter 键原样保留在 `extraLines` 里，编辑回写时不丢 —— 这份文件
 * 是 pi 的资源，PiBuddy 不能因为看不懂某个键就把它抹掉。
 */
export interface ParsedPromptFile {
  description: string;
  title: string | null;
  category: PromptCategory | null;
  /** 归属标记的版本号；无标记（用户文件）为 null */
  presetVersion: number | null;
  /** 我们不认识的 frontmatter 原始行（编辑回写时原样保留） */
  extraLines: string[];
  body: string;
}

const KNOWN_KEYS = new Set(["description", PRESET_MARKER_KEY, "pibuddy-category", "pibuddy-title"]);

/** 去掉 YAML 值两侧的引号（我们序列化时用 JSON 字符串，JSON 是合法 YAML）。 */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // 引号里不是合法 JSON：按去壳处理
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * 解析一个 prompt .md 文件。
 *
 * fence 判定与 pi 的 parseFrontmatter 同规则（`---` 开头 + `\n---` 结束），
 * 保证「我们认为的正文」与 pi 展开的正文一致。键值解析是行级的简化版：
 * 我们只消费自己写的几个键，其余行进 extraLines 原样保留。
 */
export function parsePromptFile(raw: string): ParsedPromptFile {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out: ParsedPromptFile = {
    description: "",
    title: null,
    category: null,
    presetVersion: null,
    extraLines: [],
    body: normalized,
  };

  if (!normalized.startsWith("---")) {
    fallbackDescription(out);
    return out;
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    fallbackDescription(out);
    return out;
  }

  const yamlBlock = normalized.slice(4, end);
  out.body = normalized.slice(end + 4).replace(/^\n/, "").trim();

  for (const line of yamlBlock.split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) {
      if (line.trim()) out.extraLines.push(line);
      continue;
    }
    const key = line.slice(0, sep).trim();
    const value = unquote(line.slice(sep + 1));
    if (!KNOWN_KEYS.has(key)) {
      out.extraLines.push(line);
      continue;
    }
    if (key === "description") out.description = value;
    else if (key === "pibuddy-title") out.title = value;
    else if (key === "pibuddy-category") {
      out.category = (PROMPT_CATEGORIES as readonly string[]).includes(value)
        ? (value as PromptCategory)
        : null;
    } else if (key === PRESET_MARKER_KEY) {
      const version = Number.parseInt(value, 10);
      if (Number.isInteger(version) && version >= 0) out.presetVersion = version;
    }
  }

  fallbackDescription(out);
  return out;
}

/** description 缺失时退回正文首个非空行（与 pi 的展示规则一致）。 */
function fallbackDescription(parsed: ParsedPromptFile): void {
  if (parsed.description) return;
  const firstLine = parsed.body.split("\n").find((line) => line.trim());
  if (firstLine) {
    parsed.description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
  }
}

/**
 * 序列化一个**用户自建**的 prompt 文件。
 *
 * 值一律用 JSON 字符串写（JSON 是合法 YAML）：description 里出现冒号 /
 * 井号时裸写会被 YAML 解析成别的东西，pi 那边读出来就不是用户写的那句话。
 * extraLines 原样带回 —— 用户手加的 frontmatter 键不因为经我们编辑一次而消失。
 */
export function serializeUserPromptFile(input: {
  description: string;
  title: string;
  category: PromptCategory;
  content: string;
  extraLines?: readonly string[];
}): string {
  const lines = [
    "---",
    `description: ${JSON.stringify(input.description || input.title)}`,
    `pibuddy-category: ${input.category}`,
    `pibuddy-title: ${JSON.stringify(input.title)}`,
    ...(input.extraLines ?? []),
    "---",
    input.content.replace(/\r\n/g, "\n").trimEnd(),
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- 物化

export interface MaterializeResult {
  /** 本次真实写盘的文件名 */
  written: string[];
  /** 已是同版本 / 属于用户而被跳过的文件名 */
  skipped: string[];
  errors: string[];
}

/**
 * 把预置提示词物化到 pi 用户级 prompts 目录。
 *
 * 幂等、可重入、绝不覆盖用户文件（规则见文件头）。预置目录缺失不算致命
 * （开发态没跑过打包脚本时就是这样），折成一条错误说明返回。
 */
export async function materializePresetPrompts(args: {
  presetDir: string;
  promptsDir: string;
}): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], skipped: [], errors: [] };

  let names: string[];
  try {
    names = (await fs.readdir(args.presetDir)).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch (err) {
    result.errors.push(`预置提示词目录读取失败：${args.presetDir}（${describeError(err)}）`);
    return result;
  }

  try {
    await fs.mkdir(args.promptsDir, { recursive: true });
  } catch (err) {
    result.errors.push(`无法创建 pi prompts 目录：${args.promptsDir}（${describeError(err)}）`);
    return result;
  }

  for (const name of names) {
    const sourcePath = path.join(args.presetDir, name);
    const targetPath = path.join(args.promptsDir, name);
    try {
      const sourceText = await fs.readFile(sourcePath, "utf8");
      const source = parsePromptFile(sourceText);
      if (source.presetVersion === null) {
        // 预置目录里出现没有归属标记的文件属打包错误：写下去就再也没法
        // 与用户文件区分（升级永远不敢碰它），因此拒绝物化并明说。
        result.errors.push(`预置文件缺少 ${PRESET_MARKER_KEY} 标记，已跳过：${name}`);
        continue;
      }

      let existingText: string | null = null;
      try {
        existingText = await fs.readFile(targetPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      if (existingText !== null) {
        const existing = parsePromptFile(existingText);
        if (existing.presetVersion === null) {
          // 没有归属标记 = 用户的文件（自建，或改过预置并删了标记）。
          // 绝不覆盖 —— 这是本模块最重要的一条承诺。
          result.skipped.push(name);
          continue;
        }
        if (existing.presetVersion >= source.presetVersion) {
          result.skipped.push(name);
          continue;
        }
      }

      await fs.writeFile(targetPath, sourceText, "utf8");
      result.written.push(name);
    } catch (err) {
      result.errors.push(`物化预置提示词失败：${name}（${describeError(err)}）`);
    }
  }

  return result;
}

// ---------------------------------------------------------------- 扫描与增删改

/** `prompt:${path}` 的 sha256 前 16 位（与 resource-scanner 的 id 手法一致）。 */
function entryId(filePath: string): string {
  const normalized = path.resolve(filePath);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(`prompt:${key}`).digest("hex").slice(0, 16);
}

/** 扫描出的条目 + 回写需要的路径（路径不出主进程）。 */
export interface ScannedPrompt {
  entry: Omit<PromptEntry, "favorite" | "hidden">;
  filePath: string;
  extraLines: string[];
}

export interface ScanResult {
  prompts: ScannedPrompt[];
  errors: string[];
}

/**
 * 扫描 pi 用户级 prompts 目录（非递归，与 pi 的发现规则一致）。
 *
 * 没有 pibuddy-category 的文件（用户在终端里自己写的模板）归入 `custom`
 * 分组照常展示 —— 用户自建与预置同列（R1.3），来源不同不该被藏起来。
 */
export async function scanPromptDir(promptsDir: string): Promise<ScanResult> {
  const result: ScanResult = { prompts: [], errors: [] };

  let names: string[];
  try {
    names = (await fs.readdir(promptsDir)).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      result.errors.push(`prompts 目录读取失败：${promptsDir}（${describeError(err)}）`);
    }
    return result;
  }

  for (const fileName of names.sort()) {
    const filePath = path.join(promptsDir, fileName);
    try {
      const parsed = parsePromptFile(await fs.readFile(filePath, "utf8"));
      const name = fileName.slice(0, -3);
      result.prompts.push({
        filePath,
        extraLines: parsed.extraLines,
        entry: {
          id: entryId(filePath),
          name,
          title: parsed.title ?? name,
          description: parsed.description,
          category: parsed.category ?? "custom",
          content: parsed.body,
          preset: parsed.presetVersion !== null,
          presetVersion: parsed.presetVersion,
        },
      });
    } catch (err) {
      result.errors.push(`读取提示词失败：${fileName}（${describeError(err)}）`);
    }
  }

  return result;
}

/** Windows 不允许的文件名字符 + 空白，折成短横线。 */
function sanitizeFileName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^[.-]+|[-.]+$/g, "")
    .slice(0, 40);
}

/**
 * 新建一条用户提示词。
 *
 * 文件名从标题净化而来（文件名即 `/命令名`，中文标题就是中文命令，pi 照常
 * 匹配）；同名文件已存在时追加序号，**绝不覆盖**任何现有文件。
 */
export async function createUserPromptFile(args: {
  promptsDir: string;
  title: string;
  description: string;
  category: PromptCategory;
  content: string;
}): Promise<string> {
  await fs.mkdir(args.promptsDir, { recursive: true });
  const base = sanitizeFileName(args.title) || "wo-de-tishici";

  for (let attempt = 0; attempt < 100; attempt++) {
    const fileName = attempt === 0 ? `${base}.md` : `${base}-${attempt + 1}.md`;
    const target = path.join(args.promptsDir, fileName);
    try {
      // wx：文件已存在则失败 —— 「查再写」之间没有窗口
      await fs.writeFile(target, serializeUserPromptFile(args), { encoding: "utf8", flag: "wx" });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`PROMPT_NAME_EXHAUSTED: 同名提示词过多，请换一个标题（${base}）`);
}

/**
 * 编辑一条**用户**提示词。带归属标记的预置文件直接拒绝 —— 预置只能隐藏，
 * 改它的正确姿势是「另存为我的提示词」（渲染侧提供）。
 */
export async function updateUserPromptFile(args: {
  filePath: string;
  patch: {
    title?: string;
    description?: string;
    category?: PromptCategory;
    content?: string;
  };
}): Promise<void> {
  const current = parsePromptFile(await fs.readFile(args.filePath, "utf8"));
  if (current.presetVersion !== null) {
    throw new Error("PROMPT_PRESET_READONLY: 预置提示词不可编辑，可以隐藏或另存为我的提示词");
  }
  const name = path.basename(args.filePath, ".md");
  const next = serializeUserPromptFile({
    title: args.patch.title ?? current.title ?? name,
    description: args.patch.description ?? current.description,
    category: args.patch.category ?? current.category ?? "custom",
    content: args.patch.content ?? current.body,
    extraLines: current.extraLines,
  });
  await fs.writeFile(args.filePath, next, "utf8");
}

/** 删除一条**用户**提示词。预置文件直接拒绝（R1.3：预置可隐藏不可删）。 */
export async function deleteUserPromptFile(filePath: string): Promise<void> {
  const current = parsePromptFile(await fs.readFile(filePath, "utf8"));
  if (current.presetVersion !== null) {
    throw new Error("PROMPT_PRESET_READONLY: 预置提示词不可删除，可以在列表里隐藏它");
  }
  await fs.rm(filePath);
}

/**
 * 物化 + 扫描一步到位 —— `prompt-library:list` 的实现主体。
 *
 * 物化挂在 list 的最前面而不是应用启动钩子里：首次调用（首启动的主界面
 * 挂载即会调）就把预置铺进 pi 目录，重复调用因幂等而零成本。「全新用户
 * 零配置启动，提示词库非空」（R1.4）这句承诺的机器判据就钉在这个函数上
 * —— 拆掉 materialize 这一步，对应单测立刻变红（对拍记录见测试文件头）。
 */
export async function listPromptLibrary(args: {
  presetDir: string;
  promptsDir: string;
}): Promise<ScanResult & { materialized: MaterializeResult }> {
  const materialized = await materializePresetPrompts(args);
  const scanned = await scanPromptDir(args.promptsDir);
  return {
    prompts: scanned.prompts,
    errors: [...materialized.errors, ...scanned.errors],
    materialized,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

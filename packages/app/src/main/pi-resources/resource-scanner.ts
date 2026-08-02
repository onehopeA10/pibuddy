/**
 * pi 资源清单的扫描（TASK-012 / EXT-102）。
 *
 * 这个模块回答的是一个用户会当面问的问题：**「我装的那个技能，pi 到底加载
 * 了没有？」** 所以它的产出不是「磁盘上有哪些文件」，而是三件事的合成：
 *
 *  1. **来源**（user / project / package）—— 决定它受不受 trust 管；
 *  2. **是否生效**（enabled + diagnostics）—— project 资源在未受信时 pi 根本
 *     不会读它，界面上必须写出这句话，而不是渲染成一条正常条目；
 *  3. **冲突**（conflictWith）—— pi 的去重是「先加载的赢」，同名同类的第二个
 *     会被静默丢弃。不显式标出来，用户会以为自己改的那份没生效是 bug。
 *
 * 三条实现纪律：
 *
 *  - **绝不抛异常**。任何目录读失败 / JSON 解析失败都折成 `errors` 里的一句
 *    中文。扫描是启动路径上的旁路，让它把整个窗口拖崩是最坏的取舍。
 *  - **全程 fs/promises**。本目录不允许出现任何同步文件 API（列目录 / 取状态 /
 *    读文件的 `*Sync` 形式），有机器判据在盯。
 *  - **不阻塞事件循环**。每处理 YIELD_EVERY 条主动让出一次；用户的工作目录
 *    里放几千个技能是完全可能的，同步扫完的表现是「点开资源页窗口卡死」。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TRUST_NOT_PERMISSION_NOTE,
  type DefaultProjectTrust,
  type PiResource,
  type PiResourceKind,
  type PiResourceScanResult,
  type PiResourceSource,
  type ProjectTrustState,
} from "@pibuddy/contract";

/** MCP 管理未实现的固定说明。界面上要写出「未实现」，不能渲染空列表冒充。 */
export const MCP_NOT_IMPLEMENTED_NOTE =
  "MCP 管理（增删改查、启停、连接测试、OAuth 状态、工具列表）本轮尚未实现";

/** project 资源在未受信时的固定诊断。 */
export const UNTRUSTED_DIAGNOSTIC = "项目未受信，pi 不会加载它";

/** 每处理多少条目让出一次事件循环。 */
const YIELD_EVERY = 200;

/** 包目录向下找 package.json 的最大深度（npm 的 node_modules/@scope/pkg 是 3 层）。 */
const PACKAGE_SCAN_DEPTH = 4;

type Logger = { warn(event: string, fields?: Record<string, unknown>): void };

/** 中间态：id / conflictWith 要等全部枚举完才能算。 */
interface Draft {
  kind: PiResourceKind;
  name: string;
  version: string | undefined;
  source: PiResourceSource;
  path: string;
  diagnostics: string[];
  spec: string | undefined;
  pinned: boolean;
  /** 是否被 settings 的禁用列表命中（trust 造成的禁用另算） */
  disabled: boolean;
}

/**
 * 扫描过程中的可变状态。
 *
 * 单独抽出来是因为「让出事件循环」和「收集错误」这两件事贯穿每一个枚举
 * 函数；靠参数逐层传比塞进闭包更容易漏。
 */
class ScanContext {
  readonly drafts = new Map<string, Draft>();
  readonly errors: string[] = [];
  private ticks = 0;

  constructor(private readonly logger?: Logger) {}

  /** 处理完一条目就叫一次；到点让出事件循环。 */
  async tick(): Promise<void> {
    this.ticks += 1;
    if (this.ticks % YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  fail(message: string, fields?: Record<string, unknown>): void {
    this.errors.push(message);
    this.logger?.warn("pi-resources.scan-error", { message, ...fields });
  }

  /**
   * 登记一条资源。
   *
   * **按 path 去重**：settings.json 里声明的包与 `~/.pi/agent/npm/` 下实际装出来
   * 的目录指向同一个位置，它们是同一个东西的两面。不去重的话，同一个包会
   * 在列表里出现两次，还会被 conflictWith 判成「自己和自己冲突」。
   * 先登记的赢（与 pi 自身的去重规则一致），后来者只补空字段。
   */
  add(draft: Draft): void {
    const key = normalizePath(draft.path);
    const existing = this.drafts.get(key);
    if (!existing) {
      this.drafts.set(key, draft);
      return;
    }

    existing.version ??= draft.version;
    existing.spec ??= draft.spec;
    existing.pinned ||= draft.pinned;
    existing.disabled ||= draft.disabled;
    for (const d of draft.diagnostics) {
      if (!existing.diagnostics.includes(d)) existing.diagnostics.push(d);
    }
  }
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** `${source}:${kind}:${path}` 的 sha256 前 16 位十六进制。 */
function resourceId(source: PiResourceSource, kind: PiResourceKind, target: string): string {
  return createHash("sha256").update(`${source}:${kind}:${target}`).digest("hex").slice(0, 16);
}

// ---------- 文件系统小工具（全部吞异常，不抛） ----------

async function readJsonFile(
  file: string,
  ctx: ScanContext
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    // 文件不存在是常态（大多数用户没有 project settings），不算错误。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.fail(`读取失败：${file}（${describeError(err)}）`);
    }
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.fail(`内容不是 JSON 对象，已跳过：${file}`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    ctx.fail(`JSON 解析失败：${file}（${describeError(err)}）`);
    return null;
  }
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** 列目录。目录不存在返回 null 且不记错误；其它失败记一条错误。 */
async function listDir(dir: string, ctx: ScanContext): Promise<DirEntry[] | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      // symlink 指向目录时 isDirectory() 是 false —— 用户把技能库 link 进来是
      // 常见做法，漏掉它等于整片技能凭空消失。所以这里不信 dirent，回落 stat。
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.fail(`目录读取失败：${dir}（${describeError(err)}）`);
    }
    return null;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** dirent 说不是目录时再确认一次（symlink 场景）。 */
async function resolvesToDirectory(parent: string, entry: DirEntry): Promise<boolean> {
  if (entry.isDirectory) return true;
  if (entry.isFile) return false;
  return isDirectory(path.join(parent, entry.name));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 展开 `~` 前缀，并相对 baseDir 解析相对路径。 */
function expandPath(raw: string, baseDir: string, homeDir: string): string {
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(homeDir, raw.slice(2));
  }
  return path.resolve(baseDir, raw);
}

// ---------- 包规格解析 ----------

interface ParsedSpec {
  name: string;
  pinned: boolean;
  /** 预期的安装目录；与实际扫描 npm/git 目录得到的路径一致，用于去重 */
  installDir: string;
}

/** 从最后一段里剥掉 `@version` / `@ref`。`@scope/pkg` 的 `@` 在 0 位，不算版本。 */
function splitRef(segment: string): { base: string; ref: string | null } {
  const at = segment.lastIndexOf("@");
  if (at <= 0) return { base: segment, ref: null };
  return { base: segment.slice(0, at), ref: segment.slice(at + 1) };
}

/**
 * 解析 packages 数组里的一条规格。
 *
 * 安装位置照 packages.md：npm → `<root>/npm/node_modules/<name>`，
 * git → `<root>/git/<host>/<path>`，本地路径原样。
 */
function parsePackageSpec(
  spec: string,
  roots: { npmRoot: string; gitRoot: string; settingsDir: string; homeDir: string }
): ParsedSpec {
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const slash = rest.lastIndexOf("/");
    const lastSegment = slash >= 0 ? rest.slice(slash + 1) : rest;
    const { base, ref } = splitRef(lastSegment);
    const name = slash >= 0 ? `${rest.slice(0, slash)}/${base}` : base;
    return {
      name,
      pinned: ref !== null,
      installDir: path.join(roots.npmRoot, "node_modules", ...name.split("/")),
    };
  }

  const gitPrefix = ["git:", "https://", "http://", "ssh://", "git://"].find((p) =>
    spec.startsWith(p)
  );
  if (gitPrefix) {
    let rest = spec.slice(gitPrefix.length);
    // `git@github.com:user/repo` 的 scp 形式：把 user@host: 折成 host/
    const scp = /^([^/@]+@)?([^/:]+):(.+)$/.exec(rest);
    if (gitPrefix === "git:" && scp && !rest.includes("/")) {
      rest = `${scp[2]}/${scp[3]}`;
    } else if (scp && scp[1] && !rest.startsWith(scp[2] + "/")) {
      rest = `${scp[2]}/${scp[3]}`;
    }
    rest = rest.replace(/^[^/@]+@/, "");

    const segments = rest.split("/").filter((s) => s.length > 0);
    const last = segments.pop() ?? rest;
    const { base, ref } = splitRef(last);
    segments.push(base.replace(/\.git$/, ""));

    return {
      name: segments[segments.length - 1] ?? spec,
      pinned: ref !== null,
      installDir: path.join(roots.gitRoot, ...segments),
    };
  }

  // 本地路径：不复制，settings 里存什么就是什么（packages.md「Local Paths」）。
  const resolved = expandPath(spec, roots.settingsDir, roots.homeDir);
  return { name: path.basename(resolved), pinned: false, installDir: resolved };
}

// ---------- settings.json 的枚举 ----------

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * 收集禁用列表。
 *
 * pi 的 `pi config` 把禁用写进 settings.json，但字段名在文档里没有定死。
 * 三个候选字段全读、任一命中即算禁用 —— 猜错字段的表现是「用户明明关掉了
 * 却显示为启用」，比多读两个不存在的字段糟糕得多。
 */
function collectDisabled(settings: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  if (!settings) return out;
  for (const field of ["disabled", "disabledExtensions", "disabledSkills"]) {
    for (const entry of stringArray(settings[field])) out.add(entry);
  }
  return out;
}

function isDisabled(disabled: Set<string>, name: string, target: string): boolean {
  if (disabled.size === 0) return false;
  return disabled.has(name) || disabled.has(target) || disabled.has(path.basename(target));
}

/** settings.json 的 packages / extensions / skills 三个数组。 */
async function scanSettingsArrays(
  ctx: ScanContext,
  args: {
    settingsFile: string;
    settings: Record<string, unknown> | null;
    source: PiResourceSource;
    disabled: Set<string>;
    npmRoot: string;
    gitRoot: string;
    homeDir: string;
  }
): Promise<void> {
  const settings = args.settings;
  if (!settings) return;

  const settingsDir = path.dirname(args.settingsFile);
  const roots = {
    npmRoot: args.npmRoot,
    gitRoot: args.gitRoot,
    settingsDir,
    homeDir: args.homeDir,
  };

  // packages：条目可以是字符串，也可以是 { source, extensions, ... } 过滤对象。
  const rawPackages = Array.isArray(settings.packages) ? settings.packages : [];
  for (const entry of rawPackages) {
    await ctx.tick();
    const spec =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string"
          ? ((entry as { source: string }).source)
          : null;
    if (!spec) {
      ctx.fail(`packages 条目无法识别，已跳过：${args.settingsFile}`);
      continue;
    }

    const parsed = parsePackageSpec(spec, roots);
    const diagnostics: string[] = [];
    if (!(await isDirectory(parsed.installDir))) {
      diagnostics.push("已在设置中声明，但安装目录不存在（pi 会在下次启动时补装）");
    }

    // 读一次包自己的 package.json：真名与版本号都在那里，只看目录名会把
    // `pibuddy-probe-pkg` 显示成 `probe-pkg`。读不到就退回按目录名来。
    const manifest =
      (await readJsonFile(path.join(parsed.installDir, "package.json"), ctx)) ?? {};
    const realName = typeof manifest.name === "string" ? manifest.name : parsed.name;
    const version = typeof manifest.version === "string" ? manifest.version : undefined;

    ctx.add({
      kind: "package",
      name: realName,
      version,
      source: args.source,
      path: parsed.installDir,
      diagnostics,
      spec,
      pinned: parsed.pinned,
      disabled: isDisabled(args.disabled, realName, parsed.installDir),
    });

    // 设置里声明的包同样会把自己的技能 / 扩展带进 pi。不在这里展开的话，
    // 用户装完一个本地路径包，「包」那一组多了一条、技能一条不变 ——
    // 真机实测就是这个表现，用户只能盲发 `/skill:xxx` 试。
    await scanPackageOwnedResources(ctx, parsed.installDir, manifest, args.disabled);
  }

  // extensions / skills：条目是文件或目录路径。
  const arrayKinds: { field: string; kind: PiResourceKind }[] = [
    { field: "extensions", kind: "extension" },
    { field: "skills", kind: "skill" },
  ];
  for (const { field, kind } of arrayKinds) {
    for (const raw of stringArray(settings[field])) {
      await ctx.tick();
      const target = expandPath(raw, settingsDir, args.homeDir);
      const diagnostics: string[] = [];
      if (!(await isDirectory(target)) && !(await isFile(target))) {
        diagnostics.push("设置里声明的路径不存在");
      }

      ctx.add({
        kind,
        name: path.basename(target),
        version: undefined,
        source: args.source,
        path: target,
        diagnostics,
        spec: undefined,
        pinned: false,
        disabled: isDisabled(args.disabled, path.basename(target), target),
      });
    }
  }
}

// ---------- 目录约定的枚举 ----------

/**
 * 技能目录。
 *
 * 发现规则照 skills.md：
 *   - `~/.pi/agent/skills/` 与 `.pi/skills/`：根 `.md` 文件算一个技能；
 *   - 所有技能目录：**递归**找含 `SKILL.md` 的目录；
 *   - `~/.agents/skills/` 与项目 `.agents/skills/`：根 `.md` 文件忽略。
 */
async function scanSkillDir(
  ctx: ScanContext,
  args: {
    dir: string;
    source: PiResourceSource;
    disabled: Set<string>;
    allowRootMarkdown: boolean;
  }
): Promise<void> {
  const entries = await listDir(args.dir, ctx);
  if (!entries) return;

  for (const entry of entries) {
    await ctx.tick();
    const target = path.join(args.dir, entry.name);

    if (await resolvesToDirectory(args.dir, entry)) {
      await scanSkillTree(ctx, target, args.source, args.disabled, 0);
      continue;
    }

    if (args.allowRootMarkdown && entry.name.toLowerCase().endsWith(".md")) {
      const name = entry.name.slice(0, -3);
      ctx.add({
        kind: "skill",
        name,
        version: undefined,
        source: args.source,
        path: target,
        diagnostics: [],
        spec: undefined,
        pinned: false,
        disabled: isDisabled(args.disabled, name, target),
      });
    }
  }
}

/** 递归找含 SKILL.md 的目录。找到就停止下钻：技能内部的子目录是它的资产。 */
async function scanSkillTree(
  ctx: ScanContext,
  dir: string,
  source: PiResourceSource,
  disabled: Set<string>,
  depth: number
): Promise<void> {
  await ctx.tick();

  if (await isFile(path.join(dir, "SKILL.md"))) {
    const name = path.basename(dir);
    ctx.add({
      kind: "skill",
      name,
      version: undefined,
      source,
      path: dir,
      diagnostics: [],
      spec: undefined,
      pinned: false,
      disabled: isDisabled(disabled, name, dir),
    });
    return;
  }

  if (depth >= 6) return;

  const entries = await listDir(dir, ctx);
  if (!entries) return;
  for (const entry of entries) {
    if (await resolvesToDirectory(dir, entry)) {
      await scanSkillTree(ctx, path.join(dir, entry.name), source, disabled, depth + 1);
    }
  }
}

/** 按扩展名收集单层目录里的资源（extensions / prompts / themes 三处约定）。 */
async function scanFlatDir(
  ctx: ScanContext,
  args: {
    dir: string;
    kind: PiResourceKind;
    extensions: string[];
    source: PiResourceSource;
    disabled: Set<string>;
  }
): Promise<void> {
  const entries = await listDir(args.dir, ctx);
  if (!entries) return;

  for (const entry of entries) {
    await ctx.tick();
    const lower = entry.name.toLowerCase();
    if (!args.extensions.some((ext) => lower.endsWith(ext))) continue;
    if (await resolvesToDirectory(args.dir, entry)) continue;

    const target = path.join(args.dir, entry.name);
    const name = entry.name.slice(0, entry.name.length - path.extname(entry.name).length);
    ctx.add({
      kind: args.kind,
      name,
      version: undefined,
      source: args.source,
      path: target,
      diagnostics: [],
      spec: undefined,
      pinned: false,
      disabled: isDisabled(args.disabled, name, target),
    });
  }
}

/**
 * 枚举一个 pi 包自己带的资源（skills / extensions / prompts / themes）。
 *
 * 目录来源有两处，都要认（packages.md「Package Structure」）：
 *   1. `package.json` 的 `pi` 键显式声明的相对路径；
 *   2. 约定目录（同名目录直接放在包根下）。
 *
 * 这些资源的 source 记为 `package` —— 它们既不是用户手写的，也不属于项目，
 * 用户对它们的处置方式是「卸载这个包」而不是「删掉这个文件」。
 */
async function scanPackageOwnedResources(
  ctx: ScanContext,
  packageDir: string,
  manifest: Record<string, unknown>,
  disabled: Set<string>
): Promise<void> {
  const piField = (manifest.pi ?? {}) as Record<string, unknown>;

  const declared = (key: string): string[] => {
    const value = piField[key];
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.map(String);
    return [];
  };

  const dirsFor = (key: string): string[] => {
    const set = new Set<string>([...declared(key), key]);
    return [...set].map((rel) => path.resolve(packageDir, rel));
  };

  for (const dir of dirsFor("skills")) {
    if (!(await isDirectory(dir))) continue;
    await scanSkillDir(ctx, { dir, source: "package", disabled, allowRootMarkdown: true });
  }

  const flat: { key: string; kind: PiResourceKind; extensions: string[] }[] = [
    { key: "extensions", kind: "extension", extensions: [".ts", ".js", ".mjs"] },
    { key: "prompts", kind: "prompt", extensions: [".md"] },
    { key: "themes", kind: "theme", extensions: [".json"] },
  ];
  for (const { key, kind, extensions } of flat) {
    for (const dir of dirsFor(key)) {
      if (!(await isDirectory(dir))) continue;
      await scanFlatDir(ctx, { dir, kind, extensions, source: "package", disabled });
    }
  }
}

/**
 * 这个 package.json 描述的是一个 pi 包吗？
 *
 * 判据来自 pi docs/packages.md「Creating a Pi Package」：包用 `package.json`
 * 的 `pi` 键声明资源，并**建议**带上 `pi-package` 关键字；也允许只用约定
 * 目录（extensions / skills / prompts / themes）。三条任一命中即算。
 *
 * 不做这个判定的后果不是「多列几条」：npm 会把传递依赖平铺在同一层
 * node_modules 里，于是一个 pi 包能带出几百条与 pi 毫无关系的库。
 */
function isPiPackage(manifest: Record<string, unknown>): boolean {
  if (manifest.pi && typeof manifest.pi === "object") return true;
  const keywords = manifest.keywords;
  if (Array.isArray(keywords) && keywords.some((k) => String(k) === "pi-package")) return true;
  // 约定目录写在 files 里的情况（没有 pi 键也没有关键字）
  const files = manifest.files;
  if (Array.isArray(files)) {
    const conventional = new Set(["extensions", "skills", "prompts", "themes"]);
    if (files.some((f) => conventional.has(String(f).replace(/^\.\//, "").replace(/\/$/, "")))) {
      return true;
    }
  }
  return false;
}

/**
 * 已安装的包目录。
 *
 * npm 的布局是 `npm/node_modules/<name>`（scope 再多一层），git 的布局是
 * `git/<host>/<user>/<repo>`。与其为两种布局各写一套遍历，不如统一成
 * 「含 package.json 的目录就是一个包，否则继续下钻」—— 两种布局都能吃下，
 * 将来 pi 改了目录层级也不至于整片消失。
 */
async function scanInstalledPackages(
  ctx: ScanContext,
  args: { root: string; disabled: Set<string> }
): Promise<void> {
  const entries = await listDir(args.root, ctx);
  if (!entries) return;

  for (const entry of entries) {
    if (await resolvesToDirectory(args.root, entry)) {
      await scanPackageTree(ctx, path.join(args.root, entry.name), args.disabled, 1);
    }
  }
}

async function scanPackageTree(
  ctx: ScanContext,
  dir: string,
  disabled: Set<string>,
  depth: number
): Promise<void> {
  await ctx.tick();

  const manifestPath = path.join(dir, "package.json");
  if (await isFile(manifestPath)) {
    const manifest = await readJsonFile(manifestPath, ctx);
    if (!manifest) return;

    const name = typeof manifest.name === "string" ? manifest.name : path.basename(dir);
    const version = typeof manifest.version === "string" ? manifest.version : undefined;
    // 只登记**真正的 pi 包**。`~/.pi/agent/npm/node_modules` 下躺着的是
    // npm 给那几个 pi 包拉下来的全部传递依赖 —— 真机实测：用户装了 3 个包，
    // 这里数出 454 条。把 zod / chalk / @babel/runtime 逐条列进「Pi 资源」，
    // 用户既看不懂也没法处置，而 conflictWith 会在这 454 条之间互相点名，
    // 真正的同名技能冲突就此淹没在噪声里。
    if (isPiPackage(manifest)) {
      ctx.add({
        kind: "package",
        name,
        version,
        source: "package",
        path: dir,
        diagnostics: [],
        spec: undefined,
        pinned: false,
        disabled: isDisabled(disabled, name, dir),
      });
      // 包**带进来的资源**同样要列出来。真机上抓到的缺口：装完一个带技能的
      // 包，「包」那一组多了一条，而「技能」那一组一条不变 —— 用户看不到
      // 自己刚装的技能，只能靠盲发 `/skill:xxx` 试。skills.md 明确 pi 从
      // 包的 `skills/` 目录或 `package.json` 的 `pi.skills` 里加载技能。
      await scanPackageOwnedResources(ctx, dir, manifest, disabled);
    }
    return;
  }

  if (depth >= PACKAGE_SCAN_DEPTH) {
    ctx.fail(`未找到 package.json，已跳过该包目录：${dir}`);
    return;
  }

  const entries = await listDir(dir, ctx);
  if (!entries) return;

  let descended = false;
  for (const entry of entries) {
    if (await resolvesToDirectory(dir, entry)) {
      descended = true;
      await scanPackageTree(ctx, path.join(dir, entry.name), disabled, depth + 1);
    }
  }
  if (!descended) ctx.fail(`未找到 package.json，已跳过该包目录：${dir}`);
}

// ---------- 对外入口 ----------

/**
 * 扫描一个工作目录能看到的全部 pi 资源。
 *
 * `settings.npmCommand` 目前不参与扫描（它只影响安装命令的 argv），保留在
 * 入参里是为了让 IPC 层一次性把 settings 传进来，不必分两处取。
 */
export async function scanResources(args: {
  workspaceRoot: string;
  workspaceId: string;
  homeDir?: string;
  settings?: { npmCommand?: string[]; defaultProjectTrust?: DefaultProjectTrust };
  trust?: ProjectTrustState;
  logger?: Logger;
}): Promise<PiResourceScanResult> {
  const homeDir = args.homeDir ?? os.homedir();
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const ctx = new ScanContext(args.logger);

  const trust: ProjectTrustState = args.trust ?? {
    workspaceId: args.workspaceId,
    hasProjectResources: false,
    resources: [],
    saved: "none",
    defaultProjectTrust: args.settings?.defaultProjectTrust ?? "ask",
    // 没拿到 trust 就按最保守的一侧渲染：把未受信的项目资源显示成「已生效」
    // 会让用户去调试一个根本没被加载的技能。
    effective: "deny",
    needsPrompt: false,
    note: TRUST_NOT_PERMISSION_NOTE,
  };

  const agentDir = path.join(homeDir, ".pi", "agent");
  const userNpmRoot = path.join(agentDir, "npm");
  const userGitRoot = path.join(agentDir, "git");
  const userSettingsFile = path.join(agentDir, "settings.json");
  const userSettings = await readJsonFile(userSettingsFile, ctx);
  const userDisabled = collectDisabled(userSettings);

  const projectPiDir = path.join(workspaceRoot, ".pi");
  const projectSettingsFile = path.join(projectPiDir, "settings.json");
  const projectSettings = await readJsonFile(projectSettingsFile, ctx);
  const projectDisabled = collectDisabled(projectSettings);

  // ---- user ----
  await scanSettingsArrays(ctx, {
    settingsFile: userSettingsFile,
    settings: userSettings,
    source: "user",
    disabled: userDisabled,
    npmRoot: userNpmRoot,
    gitRoot: userGitRoot,
    homeDir,
  });
  await scanSkillDir(ctx, {
    dir: path.join(agentDir, "skills"),
    source: "user",
    disabled: userDisabled,
    allowRootMarkdown: true,
  });
  await scanSkillDir(ctx, {
    dir: path.join(homeDir, ".agents", "skills"),
    source: "user",
    disabled: userDisabled,
    allowRootMarkdown: false,
  });
  await scanFlatDir(ctx, {
    dir: path.join(agentDir, "extensions"),
    kind: "extension",
    extensions: [".ts", ".js", ".mjs", ".cjs"],
    source: "user",
    disabled: userDisabled,
  });
  await scanFlatDir(ctx, {
    dir: path.join(agentDir, "prompts"),
    kind: "prompt",
    extensions: [".md"],
    source: "user",
    disabled: userDisabled,
  });
  await scanFlatDir(ctx, {
    dir: path.join(agentDir, "themes"),
    kind: "theme",
    extensions: [".json"],
    source: "user",
    disabled: userDisabled,
  });

  // ---- project ----
  await scanSettingsArrays(ctx, {
    settingsFile: projectSettingsFile,
    settings: projectSettings,
    source: "project",
    disabled: projectDisabled,
    npmRoot: path.join(projectPiDir, "npm"),
    gitRoot: path.join(projectPiDir, "git"),
    homeDir,
  });
  await scanSkillDir(ctx, {
    dir: path.join(projectPiDir, "skills"),
    source: "project",
    disabled: projectDisabled,
    allowRootMarkdown: true,
  });
  await scanSkillDir(ctx, {
    dir: path.join(workspaceRoot, ".agents", "skills"),
    source: "project",
    disabled: projectDisabled,
    allowRootMarkdown: false,
  });
  await scanFlatDir(ctx, {
    dir: path.join(projectPiDir, "extensions"),
    kind: "extension",
    extensions: [".ts", ".js", ".mjs", ".cjs"],
    source: "project",
    disabled: projectDisabled,
  });
  await scanFlatDir(ctx, {
    dir: path.join(projectPiDir, "prompts"),
    kind: "prompt",
    extensions: [".md"],
    source: "project",
    disabled: projectDisabled,
  });
  await scanFlatDir(ctx, {
    dir: path.join(projectPiDir, "themes"),
    kind: "theme",
    extensions: [".json"],
    source: "project",
    disabled: projectDisabled,
  });

  // ---- package ----
  await scanInstalledPackages(ctx, { root: userNpmRoot, disabled: userDisabled });
  await scanInstalledPackages(ctx, { root: userGitRoot, disabled: userDisabled });

  return {
    resources: finalize(ctx, trust),
    trust,
    mcp: { implemented: false, note: MCP_NOT_IMPLEMENTED_NOTE },
    scannedAt: Date.now(),
    errors: ctx.errors,
  };
}

/** 补 id、按「同 kind 同 name」互填 conflictWith、按 trust 折 enabled。 */
function finalize(ctx: ScanContext, trust: ProjectTrustState): PiResource[] {
  const untrustedProject = trust.effective !== "allow";

  const resources: PiResource[] = [];
  for (const draft of ctx.drafts.values()) {
    const diagnostics = [...draft.diagnostics];
    let enabled = !draft.disabled;

    if (draft.source === "project" && untrustedProject) {
      enabled = false;
      if (!diagnostics.includes(UNTRUSTED_DIAGNOSTIC)) diagnostics.push(UNTRUSTED_DIAGNOSTIC);
    }

    resources.push({
      id: resourceId(draft.source, draft.kind, draft.path),
      kind: draft.kind,
      name: draft.name,
      version: draft.version,
      source: draft.source,
      path: draft.path,
      enabled,
      conflictWith: [],
      diagnostics,
      spec: draft.spec,
      pinned: draft.pinned,
    });
  }

  const groups = new Map<string, PiResource[]>();
  for (const resource of resources) {
    const key = `${resource.kind}\u0000${resource.name}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(resource);
    else groups.set(key, [resource]);
  }

  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    for (const resource of bucket) {
      resource.conflictWith = bucket.filter((o) => o.id !== resource.id).map((o) => o.id);
    }
  }

  return resources;
}

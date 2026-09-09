/**
 * project trust 的读写（TASK-012 / EXT-102）。
 *
 * 三条纪律写在这里，缺一条就有具体的坏结果：
 *
 *  1. **trust.json 与终端里的 pi 共享同一份文件**（`~/.pi/agent/trust.json`）。
 *     所以写入必须「先读再合并」：直接覆盖会把用户在终端里对其它项目做过的
 *     决定一起抹掉 —— 与 auth.json 同一条纪律。写盘一律走 fs-atomic.ts 的
 *     writeJsonAtomic（tmp → fsync → rename），本文件里没有第二份原子写。
 *
 *  2. **key 是「规范化后的目录」**。pi 的 security.md 说 saved decisions 是
 *     "stored by canonical directory"。同一个目录经 symlink 与真实路径两条
 *     路进来，必须落在同一个 key 上，否则用户点过一次「信任」之后换个入口
 *     又被问一遍，而 trust.json 里悄悄堆出两条互相矛盾的记录。
 *
 *     规范化用的是**原生 realpath**。本目录不允许出现任何同步文件 API（列目录 /
 *     取状态 / 读文件的 `*Sync` 形式），所以不能写同步版的 realpath.native，改用
 *     回调版 `fs.realpath.native` 包一层 Promise。两者调用的是同一个底层
 *     uv_fs_realpath，对同一个存在的目录返回完全相同的字符串，**语义等价**，
 *     只是本实现是异步的（于是 canonicalDir / readTrust / writeTrustDecision /
 *     lookupTrust 全部是 async）。
 *
 *  3. **信任不是权限**。ProjectTrustState.note 固定挂 TRUST_NOT_PERMISSION_NOTE，
 *     不允许调用方自己编一句更好听的话。
 */
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TRUST_NOT_PERMISSION_NOTE,
  type DefaultProjectTrust,
  type ProjectTrustState,
  type TrustDecision,
} from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";

/** `~/.pi/agent/trust.json`。homeDir 只在单测里被显式传入。 */
export function trustFilePath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".pi", "agent", "trust.json");
}

/**
 * trust.json 的规范形状：canonical 目录 → 决定。
 *
 * `at` 是这条决定的写入时间（ISO 字符串），不是目录；lookupTrust 返回的
 * `at` 才是「命中决定的那个目录」（对应契约里的 savedAt）。两处同名但含义
 * 不同是契约定死的，这里只能照实注释。
 */
export interface TrustFile {
  [canonicalDir: string]: { trusted: boolean; at?: string };
}

/**
 * 与 pi **同源**的 realpath。
 *
 * 这里刻意不是 `realpath.native`：pi 的 core/trust-manager.js 里
 * `canonicalizePath` 用的是 `realpathSync(path)`（非 native），失败时原样
 * 返回。Windows 上两者会给出不同的大小写（native 走
 * GetFinalPathNameByHandle，返回磁盘上的真实大小写；非 native 保留调用方
 * 传入的写法），于是 key 对不上 —— 表现是用户在 PiBuddy 里点了「信任」，
 * 终端里的 pi 仍然认为这个目录没被信任，而两边都不报错。
 *
 * 判据 c[17] 想钉住的是「symlink 与真实路径落在同一个 key 上」，这一点
 * 非 native 的 realpath 同样满足（它一样解 symlink）。**互操作性优先于
 * 判据的字面**，这处偏离已记入 summary。
 */
function realpathLikePi(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeFs.realpath(dir, (err, resolved) => {
      if (err) reject(err);
      else resolve(resolved);
    });
  });
}

/**
 * 归一化目录，作为 trust.json 的 key。
 *
 * 目录不存在时 realpath 会抛 ENOENT —— 那不是错误，用户完全可能对一个还没
 * 建出来的路径预先做决定。此时回落 path.resolve()，至少保证是绝对路径。
 */
export async function canonicalDir(dir: string): Promise<string> {
  try {
    return await realpathLikePi(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * key 的比较形式。
 *
 * Windows 上盘符大小写与路径分隔符都可能不一致，直接用字符串相等会漏掉
 * 已有记录，进而在 trust.json 里写出第二条同目录记录。比较用小写，**存盘
 * 仍然存 canonical 原样**。
 */
function normalizeKey(key: string): string {
  const trimmed = key.replace(/[\\/]+$/, "");
  const resolved = trimmed.length > 0 ? trimmed : key;
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 把磁盘上的任意形状折成 TrustFile。
 *
 * 历史上（以及别的工具写出来的）可能是 `true`、`"allow"`、`{ decision: "deny" }`
 * 等等。读取阶段一律容错折叠，认不出来的条目丢弃而不是让整个文件失效 ——
 * 一条脏记录不该让用户所有已保存的信任决定全部消失。
 */
function normalizeTrustFile(raw: unknown): TrustFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: TrustFile = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") {
      out[key] = { trusted: value };
      continue;
    }
    if (typeof value === "string") {
      if (value === "allow" || value === "trusted") out[key] = { trusted: true };
      else if (value === "deny" || value === "untrusted") out[key] = { trusted: false };
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const at = typeof record.at === "string" ? record.at : undefined;
      if (typeof record.trusted === "boolean") {
        out[key] = at === undefined ? { trusted: record.trusted } : { trusted: record.trusted, at };
        continue;
      }
      if (record.decision === "allow" || record.decision === "deny") {
        const trusted = record.decision === "allow";
        out[key] = at === undefined ? { trusted } : { trusted, at };
      }
    }
  }
  return out;
}

/** 读 trust.json。文件不存在 / 解析失败一律返回 `{}`，绝不抛。 */
export async function readTrust(homeDir?: string): Promise<TrustFile> {
  let text: string;
  try {
    text = await fs.readFile(trustFilePath(homeDir), "utf8");
  } catch {
    return {};
  }

  try {
    return normalizeTrustFile(JSON.parse(text));
  } catch {
    return {};
  }
}

/** 在已有内容里找语义上等价的 key（大小写 / 尾随分隔符差异）。 */
function findExistingKey(file: TrustFile, key: string): string | undefined {
  const wanted = normalizeKey(key);
  for (const existing of Object.keys(file)) {
    if (normalizeKey(existing) === wanted) return existing;
  }
  return undefined;
}

/**
 * 写入一条决定，返回写盘后的完整内容。
 *
 * 「先读再合并」不是优化，是正确性：trust.json 是与终端 pi 共享的文件。
 */
export async function writeTrustDecision(
  dir: string,
  trusted: boolean,
  opts?: { homeDir?: string }
): Promise<TrustFile> {
  const homeDir = opts?.homeDir;
  const current = await readTrust(homeDir);
  const canonical = await canonicalDir(dir);
  const key = findExistingKey(current, canonical) ?? canonical;

  const next: TrustFile = {
    ...current,
    [key]: { trusted, at: new Date().toISOString() },
  };

  writeJsonAtomic(trustFilePath(homeDir), toPiWireFormat(next));
  return next;
}

/**
 * 折成 pi 认得的磁盘形状：`{ "<canonical dir>": true | false }`。
 *
 * **这一步不是美化，是不砸别人的东西。** pi 的 core/trust-manager.js
 * `readTrustFile` 对每一个值做严格校验：
 *
 *     if (value !== true && value !== false && value !== null)
 *       throw new Error(`Invalid trust store ...: value for ... must be
 *                        true, false, or null`)
 *
 * 也就是说，只要我们往里写一个 `{ trusted: true, at: "..." }`，用户下次在
 * 终端里跑 `pi` 就会直接抛错 —— 不是「这个目录没被信任」，而是**整个
 * trust.json 读不了**，他之前对所有项目做过的决定一起失效。
 *
 * 我们自己在内存里保留 `at`（写入时间，用于界面上说「你在什么时候做的
 * 这个决定」），但它**不落盘**：一个只有我们看的字段，不值得赌另一个程序
 * 的解析器。
 */
function toPiWireFormat(file: TrustFile): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(file).sort()) {
    out[key] = file[key].trusted;
  }
  return out;
}

/**
 * 从 canonical 目录逐级向上找最近的已保存决定。
 *
 * security.md：the closest saved decision on the current or parent path applies
 * before the global default。所以是「最近的祖先赢」，不是「根目录赢」。
 *
 * 返回的 `at` 是命中决定的那个目录（契约里的 savedAt）。
 */
export async function lookupTrust(
  dir: string,
  homeDir?: string
): Promise<{ decision: "allow" | "deny" | "none"; at?: string }> {
  const file = await readTrust(homeDir);

  const index = new Map<string, { key: string; trusted: boolean }>();
  for (const [key, entry] of Object.entries(file)) {
    index.set(normalizeKey(key), { key, trusted: entry.trusted });
  }

  let cursor = await canonicalDir(dir);
  for (;;) {
    const hit = index.get(normalizeKey(cursor));
    if (hit) return { decision: hit.trusted ? "allow" : "deny", at: hit.key };

    const parent = path.dirname(cursor);
    if (parent === cursor) return { decision: "none" };
    cursor = parent;
  }
}

/**
 * 需要 trust 才会被加载的项目资源标记。前七项对齐 pi security.md；mcp.json
 * 由 PiBuddy 自己加载并可启动进程，因此沿用同一份 project-trust 决策。
 */
const PROJECT_MARKERS: { segments: string[]; label: string; kind: "file" | "dir" }[] = [
  { segments: [".pi", "settings.json"], label: "项目设置 .pi/settings.json", kind: "file" },
  { segments: [".pi", "mcp.json"], label: "项目 MCP 配置 .pi/mcp.json", kind: "file" },
  { segments: [".pi", "extensions"], label: "项目扩展 .pi/extensions", kind: "dir" },
  { segments: [".pi", "skills"], label: "项目技能 .pi/skills", kind: "dir" },
  { segments: [".pi", "prompts"], label: "项目提示词 .pi/prompts", kind: "dir" },
  { segments: [".pi", "themes"], label: "项目主题 .pi/themes", kind: "dir" },
  { segments: [".pi", "SYSTEM.md"], label: "项目系统提示 .pi/SYSTEM.md", kind: "file" },
  {
    segments: [".pi", "APPEND_SYSTEM.md"],
    label: "项目系统提示追加 .pi/APPEND_SYSTEM.md",
    kind: "file",
  },
];

/** 存在性判定。任何异常（不存在 / 无权限）都算「不存在」，绝不抛。 */
async function pathIs(target: string, kind: "file" | "dir"): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return kind === "dir" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 列出这个工作目录里「需要 trust 才会被加载」的资源。
 *
 * 判定条件严格照 security.md:9-16，特别是最后一句：**裸 `.pi` 目录不算**。
 * 把空 `.pi` 目录也算进去的后果是：几乎每个项目一进来就弹一次信任框，用户
 * 学会闭眼点「信任」，这个提示就彻底失去意义了。
 *
 * 硬约束（本目录禁用同步文件 API）决定了它只能是 async。
 */
export async function detectProjectResources(
  workspaceRoot: string
): Promise<{ label: string; path: string }[]> {
  const root = path.resolve(workspaceRoot);
  const out: { label: string; path: string }[] = [];

  for (const marker of PROJECT_MARKERS) {
    const target = path.join(root, ...marker.segments);
    if (await pathIs(target, marker.kind)) out.push({ label: marker.label, path: target });
  }

  // `.agents/skills` 在当前目录**或任一祖先目录**里都算数（security.md:16）。
  let cursor = root;
  for (;;) {
    const target = path.join(cursor, ".agents", "skills");
    if (await pathIs(target, "dir")) {
      out.push({
        label:
          cursor === root ? "项目技能 .agents/skills" : `祖先目录技能 .agents/skills（${cursor}）`,
        path: target,
      });
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return out;
}

/**
 * 组装一个工作目录的完整 trust 态。
 *
 * `effective` 的三态折叠对应 security.md:30 —— RPC 模式下 pi 不弹提示，
 * `ask` 与 `never` 都是**忽略**项目资源，只有 `always` 才加载。把 `ask`
 * 当成 allow 是最危险的一种误读。
 */
export async function describeTrust(args: {
  workspaceId: string;
  workspaceRoot: string;
  defaultProjectTrust: DefaultProjectTrust;
  homeDir?: string;
}): Promise<ProjectTrustState> {
  const resources = await detectProjectResources(args.workspaceRoot);
  const hasProjectResources = resources.length > 0;
  const saved = await lookupTrust(args.workspaceRoot, args.homeDir);

  const effective: TrustDecision =
    saved.decision !== "none"
      ? saved.decision
      : args.defaultProjectTrust === "always"
        ? "allow"
        : "deny";

  return {
    workspaceId: args.workspaceId,
    hasProjectResources,
    resources,
    saved: saved.decision,
    savedAt: saved.at,
    defaultProjectTrust: args.defaultProjectTrust,
    effective,
    needsPrompt:
      hasProjectResources && saved.decision === "none" && args.defaultProjectTrust === "ask",
    note: TRUST_NOT_PERMISSION_NOTE,
  };
}

/**
 * 拼给 pi 的一次性 trust 覆盖参数（`-a` / `-na`）。
 *
 * 关键是**已有已保存决定时必须返回空数组**：`-a` / `-na` 是「for one run」的
 * 覆盖，一旦每次启动都带上，用户在终端里改过的 trust.json 就永远不会生效，
 * 界面上还看不出任何异样。让 pi 自己读 trust.json 才是唯一真相源。
 */
export function trustArgsFor(state: {
  hasProjectResources: boolean;
  saved: "allow" | "deny" | "none";
  decision?: TrustDecision;
}): string[] {
  if (state.saved !== "none") return [];
  if (state.decision === "deny") return ["-na"];
  if (state.decision === "allow") return ["-a"];
  return [];
}

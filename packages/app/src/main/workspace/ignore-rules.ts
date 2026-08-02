/**
 * ignore 规则的编译与匹配（FS-101）。
 *
 * 单独成文件的理由是进程边界：搜索跑在 utility process 里，那里既没有
 * `app.getPath` 也不该拖进整条 electron 依赖链。file-tree 与 search-scan
 * 共用本文件，于是「文件树里看不见的东西，搜索也搜不到」这件事在结构上
 * 成立 —— 两边各写一套匹配规则的话，用户会在搜索结果里点开一个
 * `node_modules` 里的文件。
 *
 * **这里不做任何路径收容判定**：收容只有 workspace-registry 的
 * `resolveInWorkspace` 一个实现（CT-18）。本文件只回答「这条相对路径要不要
 * 显示」，那是产品问题，不是安全边界。
 */
import type { WorkspaceTrust } from "@pibuddy/contract";
import fs from "node:fs";
import path from "node:path";

/** 契约里的信任态在本模块只作类型引用，用它锚住「ignore 策略归工作区所有」。 */
export type IgnoreOwnerTrust = WorkspaceTrust;

interface IgnoreRule {
  test: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/**
 * 把一条 gitignore 模式编译成正则。
 *
 * 刻意**不用任何 look-around**（全计划约定）：`(?:...)` 是非捕获分组，
 * 不是环视，在所有正则引擎上行为一致。
 */
export function compileIgnorePattern(raw: string): IgnoreRule | null {
  let pattern = raw.trim();
  if (pattern === "" || pattern.startsWith("#")) return null;

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === "") return null;

  // gitignore 规则：模式里出现 `/` 即视为相对 .gitignore 所在目录锚定，
  // 否则可以匹配任意层级下的同名条目。
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);

  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        body += "(?:.*/)?";
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
  }

  const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  return { test: new RegExp(source), negated, dirOnly };
}

/** 一个工作区的完整 ignore 规则集（策略列表 + root 下的 .gitignore）。 */
export interface IgnoreMatcher {
  rules: IgnoreRule[];
}

const matcherCache = new Map<string, { mtimeMs: number; matcher: IgnoreMatcher }>();

/** 仅供单测：丢弃 .gitignore 的解析缓存。 */
export function __resetIgnoreCache(): void {
  matcherCache.clear();
}

export function buildIgnoreMatcher(root: string, policy: string[]): IgnoreMatcher {
  const gitignore = path.join(root, ".gitignore");
  let mtimeMs = 0;
  let text = "";
  try {
    mtimeMs = fs.statSync(gitignore).mtimeMs;
    text = fs.readFileSync(gitignore, "utf8");
  } catch {
    // 没有 .gitignore 是常态，不是错误
  }
  const cacheKey = `${root}::${policy.join("|")}`;
  const hit = matcherCache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs) return hit.matcher;

  const rules: IgnoreRule[] = [];
  for (const p of policy) {
    const rule = compileIgnorePattern(p);
    if (rule) rules.push(rule);
  }
  for (const line of text.split(/\r?\n/)) {
    const rule = compileIgnorePattern(line);
    if (rule) rules.push(rule);
  }
  const matcher: IgnoreMatcher = { rules };
  matcherCache.set(cacheKey, { mtimeMs, matcher });
  return matcher;
}

/**
 * 判断一条相对路径是否被忽略。
 *
 * **最后一条命中的规则说了算** —— 这正是 `!` 否定模式起作用的方式：
 * `dist/` 之后再写 `!dist/keep.txt`，keep.txt 会被重新包含进来。
 * 只要写成「命中即忽略、不看后面」，否定模式就等于不存在，而它不报错。
 */
export function isIgnored(matcher: IgnoreMatcher, relativePath: string, isDir: boolean): boolean {
  const posix = relativePath.split(path.sep).join("/");
  let ignored = false;
  for (const rule of matcher.rules) {
    if (rule.dirOnly && !isDir) continue;
    if (!rule.test.test(posix)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

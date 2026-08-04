/**
 * 仓库探测、状态解析与输入校验（coding.git / GIT-101）。
 *
 * ## 仓库根就是 git 的信任边界
 *
 * 所有 git 命令的 cwd 都是 `git rev-parse --show-toplevel` 解析出的**仓库根**
 * （由主进程解析，绝不接受渲染进程给的路径）。渲染进程只递一个不透明的
 * workspaceId + 仓库相对路径；相对路径要么来自 git 自己的 status 输出（天然
 * 在仓库内），要么经 `assertRepoRelPath` 挡掉绝对路径与 `..` 穿越，再由
 * `assertContained` 用 realpath 复核，确保读到的文件不逃出仓库根。
 *
 * ## 分支名 / 相对路径必须校验，即便已经 shell:false
 *
 * argv + shell:false 挡住了命令注入，但挡不住**选项注入**：一个叫
 * `--force` 或 `-D` 的「分支名」会被 git 当成选项。因此分支名过一遍严格
 * 白名单正则（另外借 `--` 结束选项解析当第二道保险），路径拒绝绝对与 `..`。
 */
import fs from "node:fs";
import path from "node:path";
import type { GitFileEntry, GitStatusResult } from "@pibuddy/contract";

import { assertContained, requireWorkspaceRoot } from "../workspace-registry.js";
import { gitText, runGit } from "./git-cli.js";

/** 分支名白名单：字母数字加 `._/-`，不得以 `-` 或 `/` 开头、不得含 `..`。 */
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * 校验分支名，非法直接抛 `GIT_BRANCH_NAME_REJECTED`。
 *
 * 抛而不是返回布尔：调用方漏判返回值时，抛异常会在测试里立刻炸出来，而一个
 * 被漏判的 false 会把 `-D`、`--force` 这样的名字一路送进 argv。
 */
export function assertSafeBranchName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) {
    throw new Error("GIT_BRANCH_NAME_REJECTED: 分支名为空或过长");
  }
  if (!BRANCH_NAME_RE.test(name)) {
    throw new Error(`GIT_BRANCH_NAME_REJECTED: 分支名含非法字符或以 - / 开头：${name}`);
  }
  if (name.includes("..") || name.endsWith("/") || name.endsWith(".lock")) {
    throw new Error(`GIT_BRANCH_NAME_REJECTED: 不是合法的 ref：${name}`);
  }
}

/**
 * remote 名白名单：字母数字加 `._-`，不得以 `-` 开头。
 *
 * 与分支名同理——即便 shell:false，一个叫 `--upload-pack=…` 的「remote」会被 git
 * 当选项。remote 名比分支名更严（不允许 `/`）。
 */
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeRemoteName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) {
    throw new Error("GIT_REMOTE_NAME_REJECTED: remote 名为空或过长");
  }
  if (!REMOTE_NAME_RE.test(name)) {
    throw new Error(`GIT_REMOTE_NAME_REJECTED: remote 名含非法字符或以 - 开头：${name}`);
  }
}

/**
 * ref 白名单（比分支名宽一档，允许 `~` `^` `@{}` 与 hash）。
 *
 * log/show/reset 的目标可以是 `HEAD~1` / `abc123` / `origin/main` 这类表达式，但
 * 仍必须挡掉选项注入（以 `-` 开头）与命令替换字符。白名单收在这里，凡是接受
 * 「用户给的 ref」的动作都过它。
 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/;

export function assertSafeRef(ref: string): void {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 255) {
    throw new Error("GIT_REF_REJECTED: ref 为空或过长");
  }
  if (ref.startsWith("-")) {
    throw new Error(`GIT_REF_REJECTED: ref 不得以 - 开头（选项注入）：${ref}`);
  }
  if (!REF_RE.test(ref) || ref.includes("..")) {
    throw new Error(`GIT_REF_REJECTED: 非法 ref：${ref}`);
  }
}

/** 校验仓库相对路径：拒绝绝对路径与任何 `..` 段。命中即抛。 */
export function assertRepoRelPath(relativePath: string): void {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("GIT_PATH_REJECTED: 空路径");
  }
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`GIT_PATH_REJECTED: 绝对路径不被接受：${relativePath}`);
  }
  if (relativePath.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new Error(`GIT_PATH_REJECTED: 路径穿越被拒：${relativePath}`);
  }
}

/**
 * 解析仓库根。工作区不在任何 git 仓库里时返回 null（而不是抛错）——
 * 「这个文件夹不是仓库」是一个正常的、要在界面上如实显示的状态。
 */
export async function resolveRepoRoot(workspaceId: string): Promise<string | null> {
  let workspaceRoot: string;
  try {
    workspaceRoot = requireWorkspaceRoot(workspaceId);
  } catch {
    return null;
  }
  const top = await gitText(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (top === null) return null;
  const root = top.trim();
  return root.length > 0 ? root : null;
}

/** 仓库根内的绝对路径，经 realpath 复核收容；逃出仓库根即抛。 */
export async function resolveInRepo(repoRoot: string, relativePath: string): Promise<string> {
  assertRepoRelPath(relativePath);
  const candidate = path.resolve(repoRoot, relativePath);
  return assertContained(repoRoot, candidate);
}

/**
 * porcelain v1（`-z`）解析。
 *
 * 每条记录以 NUL 结尾，形如 `XY <path>`；重命名/复制记录后面再跟一个 NUL 段
 * 装原路径。用 `-z` 而不是普通换行：文件名里可以合法地含空格、引号乃至
 * 换行，按行切会把这些文件名切碎。
 */
export function parsePorcelainZ(z: string): GitFileEntry[] {
  const tokens = z.split("\0");
  const entries: GitFileEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 3) continue; // 末尾空段 / 半截
    const x = tok[0];
    const y = tok[1];
    const relativePath = tok.slice(3); // 跳过 "XY "
    const renamed = x === "R" || x === "C" || y === "R" || y === "C";
    let renamedFrom: string | null = null;
    if (renamed) {
      // 下一段是来源路径（`-z` 下重命名跨两段）。
      renamedFrom = tokens[i + 1] ?? null;
      i++;
    }
    entries.push({
      relativePath,
      x,
      y,
      // 已暂存 = index 侧有改动（X 非空格、非未跟踪标记）。
      staged: x !== " " && x !== "?",
      untracked: x === "?" && y === "?",
      renamedFrom,
    });
  }
  return entries;
}

/**
 * 仓库状态。非仓库时返回 `{isRepo:false,…}`，绝不抛——面板据它显示
 * 「这个文件夹还不是 git 仓库」。
 */
export async function getStatus(workspaceId: string): Promise<GitStatusResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) {
    return { isRepo: false, branch: null, detached: false, entries: [] };
  }
  // 当前分支：detached / 未出生分支时输出为空。
  const branchRaw = await gitText(repoRoot, ["branch", "--show-current"]);
  const branch = branchRaw !== null && branchRaw.trim().length > 0 ? branchRaw.trim() : null;
  const detached = branch === null;

  const statusRes = await runGit(repoRoot, ["status", "--porcelain", "-z"]);
  const entries =
    statusRes.code === 0 ? parsePorcelainZ(statusRes.stdout.toString("utf8")) : [];

  return { isRepo: true, branch, detached, entries };
}

/** 读仓库内某文件的当前工作树字节（收容校验后）；不存在返回空 Buffer。 */
export function readWorktreeBytes(absPath: string): Buffer {
  try {
    return fs.readFileSync(absPath);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Git stash（coding.git v2）：save / list / pop / drop。
 *
 * stash 栈用下标（0 = 最近，对应 `stash@{0}`）而不是让渲染进程拼 `stash@{n}`
 * 表达式——下标是数字，主进程侧再拼成受控的 `stash@{<n>}`，渲染进程表达不出
 * 别的 ref 形态。
 */
import type { GitActionResult, GitStashEntry, GitStashListResult } from "@pibuddy/contract";

import { runGit } from "./git-cli.js";
import { resolveRepoRoot } from "./git-repo.js";

const US = "\x1f";
const NOT_A_REPO: GitActionResult = { ok: false, message: "不是 git 仓库" };

function firstLine(bytes: Buffer): string {
  const text = bytes.toString("utf8").trim();
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

/** `stash@{3}` —— 下标由主进程从校验过的数字拼，不接受渲染进程的字符串。 */
function stashRef(index: number): string {
  return `stash@{${index}}`;
}

/** save：`git stash push`（可带备注与 -u）。 */
export async function stashSave(
  workspaceId: string,
  message: string | null,
  includeUntracked: boolean
): Promise<GitActionResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;

  const argv = ["stash", "push"];
  if (includeUntracked) argv.push("--include-untracked");
  if (message !== null && message.length > 0) argv.push("-m", message);

  const res = await runGit(repoRoot, argv);
  if (res.code !== 0) return { ok: false, message: firstLine(res.stderr) };
  // 无改动可 stash 时 git 也返回 0 并打印一句说明——如实转述，别谎报「已 stash」。
  const out = res.stdout.toString("utf8");
  if (/no local changes to save/i.test(out)) {
    return { ok: false, message: "没有可 stash 的改动" };
  }
  return { ok: true, message: null };
}

/**
 * 解析 stash 描述里的分支名。
 *
 * `%gs` 形如 `WIP on main: 1a2b3c msg` 或 `On main: msg`——取 "on <branch>:" 里的
 * branch。解析不出返回 null（detached 时 git 也可能不给分支名）。
 */
function parseBranch(subject: string): string | null {
  const m = /\bon\s+([^:]+):/i.exec(subject);
  return m ? m[1].trim() : null;
}

/** list：`git stash list`，逐条带下标、描述、来源分支。 */
export async function stashList(workspaceId: string): Promise<GitStashListResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return { entries: [] };

  const res = await runGit(repoRoot, ["stash", "list", `--format=%gd${US}%gs`]);
  if (res.code !== 0) return { entries: [] };

  const entries: GitStashEntry[] = [];
  for (const line of res.stdout.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const [gd, gs] = line.split(US);
    // %gd = `stash@{0}` —— 抽出下标。
    const m = /stash@\{(\d+)\}/.exec(gd ?? "");
    if (!m) continue;
    const subject = gs ?? "";
    entries.push({
      index: Number(m[1]),
      message: subject,
      branch: parseBranch(subject),
    });
  }
  return { entries };
}

/** pop：`git stash pop stash@{index}`。冲突时 git 会保留 stash 并报冲突，如实转述。 */
export async function stashPop(workspaceId: string, index: number): Promise<GitActionResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const res = await runGit(repoRoot, ["stash", "pop", stashRef(index)]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/** drop：`git stash drop stash@{index}`。 */
export async function stashDrop(workspaceId: string, index: number): Promise<GitActionResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const res = await runGit(repoRoot, ["stash", "drop", stashRef(index)]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

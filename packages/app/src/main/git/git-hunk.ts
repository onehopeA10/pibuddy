/**
 * Git hunk 级暂存（coding.git v2）。
 *
 * v1 的 stage 是**文件级**（`git add -- path`），diff 视图能看到 hunk（复用
 * changeset 的逐行 LCS 渲染），但没法只暂存其中一段。这里补上逐 hunk 暂存。
 *
 * ## 为什么这里的 hunk 与 changeset 的 hunk 是两种东西
 *
 * changeset 的 `ChangesetHunk` 是 LCS 逐行结果，**供渲染**（before/after 两组行）。
 * 而 hunk 级暂存必须靠 `git apply --cached` 吃回一段**合法补丁**，补丁格式（`@@`
 * 头 + 上下文/增删行）只有 `git diff` 给得出。因此本模块直接解析 `git diff` 的
 * 原生 unified diff，而不是把 changeset 的结构反推成补丁——反推一定会在换行 /
 * `\ No newline` / 上下文这些细节上与 git 自己的补丁产生偏差，apply 就会失败。
 * 渲染仍用 changeset（git:diff），暂存用 git 原生补丁（本模块），各司其职。
 *
 * ## apply 为什么能只吃一段
 *
 * 同一个文件的所有 hunk 头都以**同一份原文件（index / HEAD）**为坐标系，因此把
 * 任意一段 hunk 单独喂给 `git apply --cached`，git 靠 `@@` 行号 + 上下文就能定位、
 * 应用——这正是 `git add -p` 逐段暂存的原理。补丁经 stdin 送（不进 argv、不进日志）。
 */
import type { GitActionResult, GitDiffHunksResult, GitHunk } from "@pibuddy/contract";

import { runGit } from "./git-cli.js";
import { assertRepoRelPath, resolveRepoRoot } from "./git-repo.js";

const NOT_A_REPO: GitActionResult = { ok: false, message: "不是 git 仓库" };

/** git 的 `--` 之后的路径一律正斜杠。 */
function toGitPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

interface SplitDiff {
  /** 文件头块（`diff --git` … `+++`），补丁重建时原样放最前 */
  header: string;
  hunks: { header: string; body: string[] }[];
}

/**
 * 把 `git diff` 输出切成「文件头 + 若干 hunk」。
 *
 * 以行首 `@@` 判定 hunk 边界：diff 里增删/上下文行分别以 `+` / `-` / ` ` 起头，
 * `\ No newline…` 以 `\` 起头，都不会以 `@@` 起头，因此行首 `@@` 必是 hunk 头。
 * 无 hunk（空 diff / 二进制）时返回 null。
 */
function splitDiff(diff: string): SplitDiff | null {
  const lines = diff.split("\n");
  const header: string[] = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("@@")) {
    header.push(lines[i]);
    i++;
  }
  if (i >= lines.length) return null; // 没有任何 hunk
  const hunks: { header: string; body: string[] }[] = [];
  while (i < lines.length) {
    if (!lines[i].startsWith("@@")) {
      i++;
      continue;
    }
    const hHeader = lines[i];
    i++;
    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith("@@")) {
      body.push(lines[i]);
      i++;
    }
    hunks.push({ header: hHeader, body });
  }
  return { header: header.join("\n"), hunks };
}

/** 取某个文件的原生 diff（staged 选 `--cached`）。 */
async function rawDiff(
  repoRoot: string,
  relativePath: string,
  staged: boolean
): Promise<{ text: string; binary: boolean } | null> {
  const argv = ["diff", "--no-color"];
  if (staged) argv.push("--cached");
  argv.push("--", toGitPath(relativePath));
  const res = await runGit(repoRoot, argv);
  if (res.code !== 0) return null;
  const text = res.stdout.toString("utf8");
  return { text, binary: /^Binary files /m.test(text) || text.includes("GIT binary patch") };
}

/** diff-hunks：给渲染层列出可逐段暂存的 hunk（原生补丁片段 + 下标）。 */
export async function diffHunks(
  workspaceId: string,
  relativePath: string,
  staged: boolean
): Promise<GitDiffHunksResult> {
  assertRepoRelPath(relativePath);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return { hunks: [], degraded: "不是 git 仓库" };

  const raw = await rawDiff(repoRoot, relativePath, staged);
  if (raw === null) return { hunks: [], degraded: "读取 diff 失败" };
  if (raw.binary) return { hunks: [], degraded: "二进制文件" };

  const split = splitDiff(raw.text);
  if (split === null || split.hunks.length === 0) return { hunks: [], degraded: null };

  const hunks: GitHunk[] = split.hunks.map((h, index) => ({
    index,
    header: h.header,
    // 去掉解析时产生的尾部空段（原始 diff 末尾换行造成），保留真实正文行。
    lines: h.body.filter((l, i) => !(l === "" && i === h.body.length - 1)),
  }));
  return { hunks, degraded: null };
}

/** 重建只含单个 hunk 的补丁文本，末尾保证有换行（git apply 要求）。 */
function buildHunkPatch(split: SplitDiff, hunk: { header: string; body: string[] }): string {
  const bodyText = hunk.body.join("\n");
  let patch = `${split.header}\n${hunk.header}\n${bodyText}`;
  if (!patch.endsWith("\n")) patch += "\n";
  return patch;
}

/**
 * 应用单个 hunk 到 index（暂存）或反向从 index 移除（取消暂存）。
 *
 *   - stage：以**工作树↔index** 的 diff 为源，`git apply --cached` 把该段应用到 index；
 *   - unstage：以 **index↔HEAD** 的 diff 为源，`git apply --cached --reverse` 反向移除。
 */
async function applyHunk(
  workspaceId: string,
  relativePath: string,
  hunkIndex: number,
  mode: "stage" | "unstage"
): Promise<GitActionResult> {
  assertRepoRelPath(relativePath);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;

  const staged = mode === "unstage"; // unstage 看 index↔HEAD
  const raw = await rawDiff(repoRoot, relativePath, staged);
  if (raw === null) return { ok: false, message: "读取 diff 失败" };
  if (raw.binary) return { ok: false, message: "二进制文件不支持逐 hunk 暂存" };

  const split = splitDiff(raw.text);
  if (split === null || hunkIndex < 0 || hunkIndex >= split.hunks.length) {
    return { ok: false, message: "hunk 下标越界（diff 可能已变化，请刷新）" };
  }

  const patch = buildHunkPatch(split, split.hunks[hunkIndex]);
  const argv = ["apply", "--cached", "--unidiff-zero"];
  if (mode === "unstage") argv.push("--reverse");
  const res = await runGit(repoRoot, argv, { input: Buffer.from(patch, "utf8") });
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: res.stderr.toString("utf8").split("\n")[0] || "git apply 失败" };
}

export function stageHunk(
  workspaceId: string,
  relativePath: string,
  hunkIndex: number
): Promise<GitActionResult> {
  return applyHunk(workspaceId, relativePath, hunkIndex, "stage");
}

export function unstageHunk(
  workspaceId: string,
  relativePath: string,
  hunkIndex: number
): Promise<GitActionResult> {
  return applyHunk(workspaceId, relativePath, hunkIndex, "unstage");
}

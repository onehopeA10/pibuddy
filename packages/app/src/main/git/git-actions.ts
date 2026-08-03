/**
 * Git 写动作（coding.git / GIT-101）：stage / unstage / 安全 revert / commit /
 * 分支列举·创建·切换。
 *
 * 每个动作都：① 由主进程解析仓库根（cwd）；② 路径 / 分支名先过校验
 * （`assertRepoRelPath` / `assertSafeBranchName`）；③ 经 `runGit` 以纯 argv +
 * shell:false 执行；④ 无论成败结构化返回，绝不向上抛。
 *
 * ## 危险类本批不做（deferred）
 *
 * 本批只做 GIT-101 的前半部分。`push --force` / `reset --hard` / `branch -D`
 * 这类会**丢用户提交或历史**的操作要单独走高风险审批（一次主进程原生确认 +
 * 更细的 resource 授权），本轮不实现，如实标注 deferred，见 FEAT-git.md。
 * fetch/push 属网络操作（要 credential helper），同样不在本批。
 *
 * ## 「安全」revert 的含义
 *
 * revert 丢弃的是一个文件**未提交的工作树改动**（`git restore`），只影响这
 * 一个文件、不碰 HEAD、不碰历史。丢弃前先把当前字节备份到
 * `<userData>/git-revert-backup`（`writeFileAtomic`，全仓唯一原子写）——
 * 与 changeset 接受前备份同一手法：丢弃是不可逆的，留一份可捞回来的副本
 * 才配叫「安全」。
 */
import { app } from "electron";
import path from "node:path";
import type {
  GitActionResult,
  GitBranchListResult,
  GitCommitResult,
} from "@pibuddy/contract";

import { writeFileAtomic } from "../fs-atomic.js";
import { gitText, runGit } from "./git-cli.js";
import {
  assertSafeBranchName,
  readWorktreeBytes,
  resolveInRepo,
  resolveRepoRoot,
} from "./git-repo.js";

const NOT_A_REPO: GitActionResult = { ok: false, message: "不是 git 仓库" };

function firstLine(bytes: Buffer): string {
  const text = bytes.toString("utf8").trim();
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

/** 暂存一个文件：`git add -- <path>`。 */
export async function stagePath(workspaceId: string, relativePath: string): Promise<GitActionResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  await resolveInRepo(repoRoot, relativePath); // 收容校验（越界即抛）
  const res = await runGit(repoRoot, ["add", "--", relativePath]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/** 取消暂存：`git restore --staged -- <path>`（index 退回 HEAD，工作树不动）。 */
export async function unstagePath(
  workspaceId: string,
  relativePath: string
): Promise<GitActionResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  await resolveInRepo(repoRoot, relativePath);
  const res = await runGit(repoRoot, ["restore", "--staged", "--", relativePath]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/** revert 备份的落点。丢弃前的原始字节存这里，跨会话可捞回。 */
function revertBackupDir(): string {
  return path.join(app.getPath("userData"), "git-revert-backup");
}

/**
 * 安全 revert：丢弃一个文件未提交的工作树改动（`git restore -- <path>`）。
 * 丢弃前先备份当前字节。只处理已跟踪文件；未跟踪文件没有「原样」可回退，
 * 直接返回一条说明而不是把它删掉。
 */
export async function revertPath(
  workspaceId: string,
  relativePath: string
): Promise<GitActionResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const abs = await resolveInRepo(repoRoot, relativePath);

  // 备份当前工作树字节（可能为空——文件被删的场景 restore 会把它找回来）。
  const current = readWorktreeBytes(abs);
  if (current.byteLength > 0) {
    const stamp = `${Date.now()}-${path.basename(relativePath)}`;
    writeFileAtomic(path.join(revertBackupDir(), workspaceId, stamp), current);
  }

  const res = await runGit(repoRoot, ["restore", "--", relativePath]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/**
 * 提交已暂存的改动：`git commit -m <message>`。
 *
 * message 经 argv 传，不拼进任何 shell。「暂存区空」与真实故障分开报（见
 * 契约 GitCommitResult 的注释）：前者用户下一步是先 stage，后者是缺
 * user.name / 冲突中 / 磁盘之类。
 */
export async function commit(workspaceId: string, message: string): Promise<GitCommitResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) {
    return { ok: false, nothingToCommit: false, commit: null, message: "不是 git 仓库" };
  }
  const res = await runGit(repoRoot, ["commit", "-m", message]);
  if (res.code === 0) {
    const short = await gitText(repoRoot, ["rev-parse", "--short", "HEAD"]);
    return { ok: true, nothingToCommit: false, commit: short?.trim() ?? null, message: null };
  }
  const out = `${res.stdout.toString("utf8")}\n${res.stderr.toString("utf8")}`;
  const nothingToCommit = /nothing to commit|no changes added to commit/i.test(out);
  return {
    ok: false,
    nothingToCommit,
    commit: null,
    message: nothingToCommit ? "暂存区是空的，先 stage 一些改动再提交" : firstLine(res.stderr),
  };
}

/** 本地分支列表 + 当前分支。 */
export async function branchList(workspaceId: string): Promise<GitBranchListResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return { branches: [], current: null };
  const listed = await gitText(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const branches =
    listed === null
      ? []
      : listed
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  const currentRaw = await gitText(repoRoot, ["branch", "--show-current"]);
  const current = currentRaw !== null && currentRaw.trim().length > 0 ? currentRaw.trim() : null;
  return { branches, current };
}

/** 创建分支（不切换）：`git branch <name>`。name 先过严格白名单。 */
export async function branchCreate(workspaceId: string, name: string): Promise<GitActionResult> {
  assertSafeBranchName(name);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const res = await runGit(repoRoot, ["branch", name]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/**
 * 切换分支：`git switch <name>`。name 先过严格白名单。
 *
 * 工作树有未提交冲突时 git 自己会拒绝切换（那正是安全的行为），此时如实把
 * git 的原因返回给用户，而不是强切。
 */
export async function branchSwitch(workspaceId: string, name: string): Promise<GitActionResult> {
  assertSafeBranchName(name);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const res = await runGit(repoRoot, ["switch", name]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

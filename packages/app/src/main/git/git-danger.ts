/**
 * 危险 git 操作（coding.git v2）：force push / reset --hard / branch -D。
 *
 * ## 为什么这三条要**两道**闸
 *
 * 它们与 stage/commit 的区别是**不可逆地丢用户提交或历史**。process.git 那道闸
 * （第五道闸）回答的是「这个工作区能不能碰 git」——粒度太粗：一旦授权，force
 * push 与 status 就无从区分了。因此这三条在 process.git 之外，handler 内再走一次
 * **主进程原生二次确认**（`dialog.showMessageBox`，渲染进程伪造不了、绕不开），
 * 且确认框逐字列出**精确范围**（哪个 remote/branch、丢到哪个 ref、要删的分支 tip
 * 是谁）。
 *
 * 语义参照 SEC-003 的 allow-once：**每次现确认、用后即焚**，不落任何持久授权——
 * 「上次点过允许」不该让这次的 reset --hard 直接执行。因此这里不碰
 * capabilityGrants，确认状态只活在这一次调用里。
 *
 * ## 可证伪
 *
 * 确认器可注入（`setDangerConfirmer`）。测试里注入一个「恒拒绝」的确认器，断言
 * 操作**没有发生**（HEAD 未动 / 分支还在）；再注入「恒允许」，断言操作发生。把
 * 确认这道闸临时删掉，恒拒绝那条用例立刻变红——确认是真门槛，不是走过场。
 */
import { dialog } from "electron";
import type { GitActionResult, GitNetworkResult } from "@pibuddy/contract";

import { gitText, runGit } from "./git-cli.js";
import { assertSafeBranchName, assertSafeRef, assertSafeRemoteName, resolveRepoRoot } from "./git-repo.js";

/** 一次危险操作的确认请求：三段都是给人读的精确范围。 */
export interface DangerConfirmRequest {
  /** 操作名（如 "reset --hard"） */
  operation: string;
  /** 精确范围（如 "当前工作区 → 目标 ref HEAD~1"） */
  scope: string;
  /** 后果一句话（如 "工作树与暂存区的全部未提交改动将丢失"） */
  consequence: string;
}

export interface DangerConfirmer {
  /** 展示精确范围要求用户明确确认；默认按钮必须是「取消」。 */
  confirm(req: DangerConfirmRequest): Promise<boolean>;
}

const nativeConfirmer: DangerConfirmer = {
  async confirm(req: DangerConfirmRequest): Promise<boolean> {
    const res = await dialog.showMessageBox({
      type: "warning",
      buttons: ["取消", "确认执行"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: `危险操作确认：${req.operation}`,
      message: `确定要执行 ${req.operation} 吗？`,
      detail: `范围：${req.scope}\n后果：${req.consequence}\n\n此操作不可撤销。`,
    });
    return res.response === 1;
  },
};

let confirmer: DangerConfirmer = nativeConfirmer;
/** 仅供单测 / 真机取证：替换原生二次确认。 */
export function setDangerConfirmer(c: DangerConfirmer): void {
  confirmer = c;
}
/** 恢复默认原生确认器（测试收尾用）。 */
export function resetDangerConfirmer(): void {
  confirmer = nativeConfirmer;
}

const NOT_A_REPO_ACTION: GitActionResult = { ok: false, message: "不是 git 仓库" };
const NOT_A_REPO_NET: GitNetworkResult = { ok: false, message: "不是 git 仓库", output: null };
/** 用户在二次确认框点了取消：如实回报，绝不静默执行。 */
const CANCELLED = "已取消（未通过二次确认）";

function firstLine(bytes: Buffer): string {
  const text = bytes.toString("utf8").trim();
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

function truncate(text: string, max = 4096): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（输出已截断）`;
}

/**
 * force push（`--force-with-lease`）。
 *
 * 用 with-lease 而非裸 `--force`：别人在你上次 fetch 之后又推了东西时会被拒，
 * 而不是无声覆盖别人的提交。即便如此仍走二次确认——with-lease 只防「覆盖别人」，
 * 不防「你自己把远端历史改写了」。
 */
export async function forcePush(
  workspaceId: string,
  remote: string,
  branch: string
): Promise<GitNetworkResult> {
  assertSafeRemoteName(remote);
  assertSafeBranchName(branch);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO_NET;

  const confirmed = await confirmer.confirm({
    operation: "git push --force-with-lease",
    scope: `远端 ${remote} 的分支 ${branch}`,
    consequence: `将用本地 ${branch} 改写远端历史；--force-with-lease 会在远端有你未见的新提交时拒绝`,
  });
  if (!confirmed) return { ok: false, message: CANCELLED, output: null };

  const res = await runGit(repoRoot, [
    "push",
    "--force-with-lease",
    "--",
    remote,
    branch,
  ]);
  const output = truncate(`${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`.trim());
  return res.code === 0
    ? { ok: true, message: null, output: output.length > 0 ? output : null }
    : { ok: false, message: firstLine(res.stderr), output: output.length > 0 ? output : null };
}

/** reset --hard 到某个 ref。丢弃工作树与暂存区全部未提交改动，并移动 HEAD。 */
export async function resetHard(workspaceId: string, ref: string): Promise<GitActionResult> {
  assertSafeRef(ref);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO_ACTION;

  const head = (await gitText(repoRoot, ["rev-parse", "--short", "HEAD"]))?.trim() ?? "HEAD";
  const confirmed = await confirmer.confirm({
    operation: "git reset --hard",
    scope: `当前 HEAD（${head}）→ 目标 ${ref}`,
    consequence: "工作树与暂存区的全部未提交改动将丢失，HEAD 移到目标 ref",
  });
  if (!confirmed) return { ok: false, message: CANCELLED };

  const res = await runGit(repoRoot, ["reset", "--hard", ref]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/**
 * 强制删除分支（`branch -D`）。
 *
 * `-D` 会删掉一个**尚未合并**的分支——那正是危险所在（普通 `-d` 会拒绝删未合并
 * 的分支）。确认框里带上该分支的 tip 短 hash，让用户知道自己在丢什么。
 */
export async function branchDelete(workspaceId: string, name: string): Promise<GitActionResult> {
  assertSafeBranchName(name);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO_ACTION;

  const tip = (await gitText(repoRoot, ["rev-parse", "--short", name]))?.trim() ?? "?";
  const confirmed = await confirmer.confirm({
    operation: "git branch -D",
    scope: `本地分支 ${name}（tip ${tip}）`,
    consequence: "分支引用被删除，若它有未合并到别处的提交，那些提交将只能靠 reflog 找回",
  });
  if (!confirmed) return { ok: false, message: CANCELLED };

  const res = await runGit(repoRoot, ["branch", "-D", "--", name]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

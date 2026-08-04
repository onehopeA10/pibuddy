/**
 * Git 网络操作（coding.git v2）：fetch / pull / push。
 *
 * v1 把这三条 defer 了，理由是「要 credential helper、碰凭据」。补上它们并不放松
 * 任何纪律：
 *
 *  - 仍走 `runGit`（execFile + shell:false + 只传 argv）。
 *  - **凭据由 git 子进程自己经 credential helper / SSH agent 处理**，PiBuddy
 *    从不经手 token：`GIT_TERMINAL_PROMPT=0` + 空 askpass（见 git-cli 的
 *    controlledEnv）让缺凭据的操作**立刻失败**而非挂起等输入，token 既不进
 *    argv 也不进日志。因此本能力包**不申请 network 权限**——出站是 git 自己
 *    的事，PiBuddy 侧没有第二条出站路径，也没有 safeFetch。
 *  - remote / branch 名过白名单（`assertSafeRemoteName` / `assertSafeBranchName`），
 *    挡选项注入；一律用 `--` 结束选项解析当第二道保险。
 *
 * push（非 force）保持默认语义：远端领先时被 git 以 non-fast-forward 拒绝——那正是
 * 安全的行为，如实把 git 的原因返回给用户，force 覆盖走单独的 git:force-push（带
 * 二次确认）。
 */
import type { GitNetworkResult } from "@pibuddy/contract";

import { runGit } from "./git-cli.js";
import { assertSafeBranchName, assertSafeRemoteName, resolveRepoRoot } from "./git-repo.js";

const NOT_A_REPO: GitNetworkResult = { ok: false, message: "不是 git 仓库", output: null };
/** 网络操作超时给宽一点：clone/fetch 可能要拉不少字节。 */
const NETWORK_TIMEOUT_MS = 120_000;

function firstLine(bytes: Buffer): string {
  const text = bytes.toString("utf8").trim();
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

function truncate(text: string, max = 4096): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（输出已截断）`;
}

/** 把 git 的合并输出整理成 GitNetworkResult。 */
function toResult(res: { code: number; stdout: Buffer; stderr: Buffer }): GitNetworkResult {
  // fetch/pull/push 的进度与结论多在 stderr（git 惯例），两端都收进 output。
  const combined = `${res.stderr.toString("utf8")}${res.stdout.toString("utf8")}`.trim();
  const output = combined.length > 0 ? truncate(combined) : null;
  return res.code === 0
    ? { ok: true, message: null, output }
    : { ok: false, message: firstLine(res.stderr) || firstLine(res.stdout), output };
}

/** fetch。remote 省略时用 git 默认（当前分支的上游 remote）。 */
export async function fetch(workspaceId: string, remote: string | null): Promise<GitNetworkResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const argv = ["fetch"];
  if (remote !== null) {
    assertSafeRemoteName(remote);
    argv.push("--", remote);
  }
  return toResult(await runGit(repoRoot, argv, { timeoutMs: NETWORK_TIMEOUT_MS }));
}

/**
 * pull（fetch + 合并）。remote 与 branch 要么都给、要么都不给（git 的用法）。
 *
 * 冲突或未提交改动挡路时 git 自己会失败，如实把原因返回（那不是 PiBuddy 该替
 * 用户强行推进的场景）。
 */
export async function pull(
  workspaceId: string,
  remote: string | null,
  branch: string | null
): Promise<GitNetworkResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const argv = ["pull"];
  if (remote !== null && branch !== null) {
    assertSafeRemoteName(remote);
    assertSafeBranchName(branch);
    argv.push("--", remote, branch);
  } else if (remote !== null) {
    assertSafeRemoteName(remote);
    argv.push("--", remote);
  }
  return toResult(await runGit(repoRoot, argv, { timeoutMs: NETWORK_TIMEOUT_MS }));
}

/** push（普通推送，非 force）。setUpstream=true 时带 `-u`（第一次推新分支）。 */
export async function push(
  workspaceId: string,
  remote: string | null,
  branch: string | null,
  setUpstream: boolean
): Promise<GitNetworkResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const argv = ["push"];
  if (setUpstream) argv.push("-u");
  if (remote !== null && branch !== null) {
    assertSafeRemoteName(remote);
    assertSafeBranchName(branch);
    argv.push("--", remote, branch);
  } else if (remote !== null) {
    assertSafeRemoteName(remote);
    argv.push("--", remote);
  }
  return toResult(await runGit(repoRoot, argv, { timeoutMs: NETWORK_TIMEOUT_MS }));
}

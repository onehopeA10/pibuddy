/**
 * Git worktree（coding.git v2）：create / list / open / rename / compare / remove。
 *
 * ## 不透明 id，路径不外发
 *
 * 与全仓一贯口径一致：worktree 的真实绝对路径只活在主进程。worktree-list 给渲染
 * 进程的是 `id = sha256(worktreePath)`（复用 workspace-registry 的 `workspaceIdFor`），
 * open/rename/compare/remove 都用它回指；主进程每次重新 `git worktree list` 并按 id
 * 匹配路径——**不存任何映射**，因此没有可被 TOCTOU 攻击的陈旧状态。
 *
 * ## 落盘位置由主进程决定
 *
 * create 的 worktree 放在 `<userData>/git-worktrees/<workspaceId>/<name>`：不落在
 * 仓库自己的工作树里（否则 git 会把它当成一堆未跟踪文件显示），也不接受渲染进程
 * 给的任何路径——渲染进程只给一个受白名单校验的 name。
 *
 * ## remove 前的脏检查（任务点名）
 *
 * 默认 `force=false`：先 `git -C <worktree> status --porcelain` 看它有没有未提交
 * 改动 / 未跟踪文件 / 未合并冲突，脏就**拒绝**并如实说明，绝不无声删掉用户的活儿。
 * git worktree remove 自己也会拒绝删脏树，但我们先查一遍是为了给出一句能读懂的
 * 中文原因，而不是把 git 的英文错误抛给用户。用户在界面再次确认后才带 force 重试。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  GitActionResult,
  GitShowFile,
  GitWorktreeCompareResult,
  GitWorktreeEntry,
  GitWorktreeListResult,
  GitWorktreeOpenResult,
} from "@pibuddy/contract";

import { registerWorkspace, workspaceIdFor } from "../workspace-registry.js";
import { runGit } from "./git-cli.js";
import { assertSafeBranchName, resolveRepoRoot } from "./git-repo.js";

const NOT_A_REPO: GitActionResult = { ok: false, message: "不是 git 仓库" };

interface WorktreeRecord {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  bare: boolean;
}

function firstLine(bytes: Buffer): string {
  const text = bytes.toString("utf8").trim();
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(0, nl) : text;
}

/** 解析 `git worktree list --porcelain`：空行分隔一条记录。 */
function parseWorktreePorcelain(text: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let cur: Partial<WorktreeRecord> | null = null;
  const flush = (): void => {
    if (cur && typeof cur.path === "string") {
      records.push({
        path: cur.path,
        head: cur.head ?? "",
        branch: cur.branch ?? null,
        locked: cur.locked ?? false,
        bare: cur.bare ?? false,
      });
    }
    cur = null;
  };
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length) };
    } else if (cur) {
      if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
      else if (line === "bare") cur.bare = true;
      else if (line === "detached") cur.branch = null;
    }
  }
  flush();
  return records;
}

async function listRecords(repoRoot: string): Promise<WorktreeRecord[]> {
  const res = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (res.code !== 0) return [];
  return parseWorktreePorcelain(res.stdout.toString("utf8"));
}

/** 把 record 折成渲染侧 entry：id 不透明、name 是末段目录名、head 取短。 */
function toEntry(rec: WorktreeRecord, repoRoot: string): GitWorktreeEntry {
  return {
    id: workspaceIdFor(rec.path),
    name: path.basename(rec.path),
    branch: rec.branch,
    head: rec.head.slice(0, 12),
    isMain: samePath(rec.path, repoRoot),
    locked: rec.locked,
  };
}

/** 大小写 / 分隔符归一后的路径相等判定（Windows 友好）。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** 按不透明 id 找回 record（重新 list、匹配 workspaceIdFor）。 */
async function findById(repoRoot: string, id: string): Promise<WorktreeRecord | null> {
  for (const rec of await listRecords(repoRoot)) {
    if (workspaceIdFor(rec.path) === id) return rec;
  }
  return null;
}

export async function worktreeList(workspaceId: string): Promise<GitWorktreeListResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return { worktrees: [] };
  const records = await listRecords(repoRoot);
  return { worktrees: records.filter((r) => !r.bare).map((r) => toEntry(r, repoRoot)) };
}

/** create：worktree add 到主进程决定的位置。 */
export async function worktreeCreate(
  workspaceId: string,
  name: string,
  branch: string,
  newBranch: boolean
): Promise<GitActionResult> {
  assertSafeBranchName(name); // 目录名走同款白名单，挡路径穿越与选项注入
  assertSafeBranchName(branch);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;

  const baseDir = path.join(app.getPath("userData"), "git-worktrees", workspaceId);
  const target = path.join(baseDir, name);
  const targetExisted = fs.existsSync(target);
  fs.mkdirSync(baseDir, { recursive: true });

  const argv = ["worktree", "add"];
  if (newBranch) argv.push("-b", branch, target);
  else argv.push(target, branch);

  const res = await runGit(repoRoot, argv);
  if (res.code !== 0 && !targetExisted) {
    fs.rmSync(target, { recursive: true, force: true });
    try {
      fs.rmdirSync(baseDir);
    } catch {
      // 目录非空或已被并发使用时保留。
    }
  }
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/**
 * open：把 worktree 目录注册成一个工作区，回不透明 workspaceId 供渲染进程切过去。
 *
 * 与 dialog:choose-folder 同一形态（返回 workspaceId + displayPath）。绝对路径不
 * 外发——displayPath 仅供显示。
 */
export async function worktreeOpen(
  workspaceId: string,
  id: string
): Promise<GitWorktreeOpenResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) {
    return { opened: false, workspaceId: null, displayPath: null, message: "不是 git 仓库" };
  }
  const rec = await findById(repoRoot, id);
  if (rec === null) {
    return { opened: false, workspaceId: null, displayPath: null, message: "worktree 不存在（可能已被移除）" };
  }
  try {
    const record = registerWorkspace(rec.path);
    return { opened: true, workspaceId: record.workspaceId, displayPath: record.root, message: null };
  } catch (err) {
    return { opened: false, workspaceId: null, displayPath: null, message: (err as Error).message };
  }
}

/** rename：`git worktree move`。在同一父目录内改名，不动主工作树。 */
export async function worktreeRename(
  workspaceId: string,
  id: string,
  newName: string
): Promise<GitActionResult> {
  assertSafeBranchName(newName);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const rec = await findById(repoRoot, id);
  if (rec === null) return { ok: false, message: "worktree 不存在" };
  if (samePath(rec.path, repoRoot)) return { ok: false, message: "主工作树不能改名" };

  const target = path.join(path.dirname(rec.path), newName);
  const res = await runGit(repoRoot, ["worktree", "move", rec.path, target]);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

/** 解析 `--name-status` 行（与 git-history 同款）。 */
function parseNameStatus(text: string): GitShowFile[] {
  const files: GitShowFile[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const status = parts[0]?.trim() ?? "";
    if (status.length === 0) continue;
    const relativePath = parts[parts.length - 1] ?? "";
    if (relativePath.length === 0) continue;
    files.push({ status: status.slice(0, 3), relativePath });
  }
  return files;
}

/**
 * compare：比目标 worktree 的分支与基准分支（otherId 省略 = 当前工作区的分支）。
 *
 * ahead/behind 用 `rev-list --left-right --count base...target`；改动文件用
 * `diff --name-status base target`。detached 的 worktree 用其 HEAD sha 当 ref。
 */
export async function worktreeCompare(
  workspaceId: string,
  id: string,
  otherId: string | null
): Promise<GitWorktreeCompareResult> {
  const empty: GitWorktreeCompareResult = { ok: false, message: null, ahead: 0, behind: 0, files: [] };
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return { ...empty, message: "不是 git 仓库" };

  const target = await findById(repoRoot, id);
  if (target === null) return { ...empty, message: "worktree 不存在" };

  // 基准：otherId 指定的 worktree，或当前工作区分支（HEAD）。
  let baseRef = "HEAD";
  if (otherId !== null) {
    const other = await findById(repoRoot, otherId);
    if (other === null) return { ...empty, message: "对比目标 worktree 不存在" };
    baseRef = other.branch ?? other.head;
  }
  const targetRef = target.branch ?? target.head;
  if (baseRef.length === 0 || targetRef.length === 0) {
    return { ...empty, message: "无法确定对比的 ref" };
  }

  const countRes = await runGit(repoRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `${baseRef}...${targetRef}`,
  ]);
  let ahead = 0;
  let behind = 0;
  if (countRes.code === 0) {
    // 输出 `<behind>\t<ahead>`：left=base 独有（target 落后），right=target 独有（领先）。
    const [left, right] = countRes.stdout.toString("utf8").trim().split(/\s+/);
    behind = Number(left) || 0;
    ahead = Number(right) || 0;
  }

  const diffRes = await runGit(repoRoot, ["diff", "--name-status", baseRef, targetRef]);
  const files = diffRes.code === 0 ? parseNameStatus(diffRes.stdout.toString("utf8")) : [];

  return { ok: true, message: null, ahead, behind, files };
}

/**
 * remove：默认先脏检查再删，脏则拒绝（任务点名）。
 *
 * 脏 = `git -C <worktree> status --porcelain` 非空（涵盖未暂存改动 / 未跟踪文件 /
 * 未合并冲突三种）。clean 才 `git worktree remove`；force=true 时跳过脏检查直接
 * `--force` 删。主工作树永不可删。
 */
export async function worktreeRemove(
  workspaceId: string,
  id: string,
  force: boolean
): Promise<GitActionResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return NOT_A_REPO;
  const rec = await findById(repoRoot, id);
  if (rec === null) return { ok: false, message: "worktree 不存在" };
  if (samePath(rec.path, repoRoot)) return { ok: false, message: "主工作树不能移除" };

  if (!force) {
    // 脏检查：在目标 worktree 里问它自己的状态。路径来自 git 自己的 list 输出，
    // 是本仓库的合法 worktree，因此 cwd 用它是安全的（不是渲染进程给的路径）。
    const statusRes = await runGit(rec.path, ["status", "--porcelain"]);
    if (statusRes.code === 0 && statusRes.stdout.toString("utf8").trim().length > 0) {
      return {
        ok: false,
        message: "该 worktree 有未提交改动 / 未跟踪文件 / 未合并冲突，已拒绝移除；如仍要移除请强制删除",
      };
    }
  }

  const argv = ["worktree", "remove"];
  if (force) argv.push("--force");
  argv.push(rec.path);
  const res = await runGit(repoRoot, argv);
  return res.code === 0
    ? { ok: true, message: null }
    : { ok: false, message: firstLine(res.stderr) };
}

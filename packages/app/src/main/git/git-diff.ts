/**
 * Git 逐行 diff（coding.git / GIT-101）。
 *
 * ## 复用 changeset 的 review 原语，不另造一套
 *
 * ADR-0002「已知未决」把行级 hunk 的归属留到第二阶段，但渲染层的 diff 表示
 * **只能有一套**：workspace 变更审阅（FS-102）已经有 `ChangesetDiff` /
 * `ChangesetHunk`、逐行 LCS（`diffLines`）、二进制/超大降级判定
 * （`looksBinary`）。这里直接 import 它们，把 Git 的两端字节喂进去，产出
 * 同一种 hunk。两套并存的代价是「冲突状态」——同一份 diff 在两个面板里
 * 长得不一样、接受语义还不一致，因此宁可跨能力 import 也不重造。
 *
 * ## 两端从哪来
 *
 *   - 未暂存（staged=false）：before = index blob（`git show :path`），
 *     after = 工作树当前字节。回答「我还没 stage 的改动」。
 *   - 已暂存（staged=true）：before = HEAD blob（`git show HEAD:path`），
 *     after = index blob。回答「我 stage 了、即将提交的改动」。
 *
 * blob 取不到（新文件不在 index / HEAD）就当空串——那正是「整段新增」应有
 * 的样子。
 */
import type { ChangesetDiff } from "@pibuddy/contract";

import {
  CHANGESET_DIFF_MAX_BYTES,
  diffLines,
  looksBinary,
} from "../changeset/changeset-store.js";
import { runGit } from "./git-cli.js";
import { readWorktreeBytes, resolveInRepo, resolveRepoRoot } from "./git-repo.js";

const EMPTY = Buffer.alloc(0);

/** git 的 `:path` / `HEAD:path` ref 一律用正斜杠，即便本机是 Windows。 */
function toGitPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

/** 取某个 ref 下的 blob 字节；不存在（非零退出）返回空 Buffer。 */
async function showBlob(repoRoot: string, ref: string): Promise<Buffer> {
  const res = await runGit(repoRoot, ["show", ref]);
  return res.code === 0 ? res.stdout : EMPTY;
}

/**
 * 从两端字节构建一份 `ChangesetDiff`——**这是复用 changeset review 原语的
 * 那一步**：二进制/超大降级判定走 `looksBinary`，逐行 hunk 走 `diffLines`，
 * 产出的 hunk 形状与变更审阅面板完全一致。抽成纯函数是为了能脱离 git 子进程
 * 直接对拍：喂两段字节，断言 hunks 恰好等于 `diffLines(before, after)`。
 */
export function buildGitDiff(
  relativePath: string,
  beforeBytes: Buffer,
  afterBytes: Buffer
): ChangesetDiff {
  if (looksBinary(beforeBytes) || looksBinary(afterBytes)) {
    return { id: relativePath, relativePath, hunks: [], degraded: "二进制文件" };
  }
  const maxSide = Math.max(beforeBytes.byteLength, afterBytes.byteLength);
  if (maxSide > CHANGESET_DIFF_MAX_BYTES) {
    return {
      id: relativePath,
      relativePath,
      hunks: [],
      degraded: `文件过大（${Math.round(maxSide / 1024)}KB），只显示摘要`,
    };
  }
  const before = beforeBytes.toString("utf8").split("\n");
  const after = afterBytes.toString("utf8").split("\n");
  return { id: relativePath, relativePath, hunks: diffLines(before, after), degraded: null };
}

/**
 * 计算一条 Git diff，返回 changeset 的 `ChangesetDiff`。
 *
 * `id` 用 `relativePath`：面板据它做 key，一个仓库里同一路径在同一视图下
 * 唯一。仓库探测不到时返回一条 degraded 记录而不是抛错。
 */
export async function getDiff(
  workspaceId: string,
  relativePath: string,
  staged: boolean
): Promise<ChangesetDiff> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) {
    return { id: relativePath, relativePath, hunks: [], degraded: "不是 git 仓库" };
  }

  const gitPath = toGitPath(relativePath);
  let beforeBytes: Buffer;
  let afterBytes: Buffer;

  if (staged) {
    beforeBytes = await showBlob(repoRoot, `HEAD:${gitPath}`);
    afterBytes = await showBlob(repoRoot, `:${gitPath}`);
  } else {
    beforeBytes = await showBlob(repoRoot, `:${gitPath}`);
    // 工作树侧读磁盘字节（收容校验后）；文件被删时为空 Buffer。
    const abs = await resolveInRepo(repoRoot, relativePath);
    afterBytes = readWorktreeBytes(abs);
  }

  return buildGitDiff(relativePath, beforeBytes, afterBytes);
}

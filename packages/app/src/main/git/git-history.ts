/**
 * Git 历史（coding.git v2）：log（提交列表 / 文件历史）+ show（单提交详情）。
 *
 * 只读，但同样起 git 子进程，因此同样受 process.git 管辖（在 GIT_GATED_CHANNELS 里）。
 *
 * 解析用 `%x1f`（unit separator）+ `%x1e`（record separator）作字段 / 记录分隔：
 * 提交标题、作者名里可以合法地含空格、制表符乃至换行，按行 / 按空格切会切碎它们。
 */
import type {
  GitCommitSummary,
  GitLogResult,
  GitShowFile,
  GitShowResult,
} from "@pibuddy/contract";

import { runGit } from "./git-cli.js";
import { assertRepoRelPath, assertSafeRef, resolveRepoRoot } from "./git-repo.js";

const US = "\x1f"; // 字段分隔
const RS = "\x1e"; // 记录分隔

const EMPTY_LOG: GitLogResult = { commits: [] };
const EMPTY_SHOW: GitShowResult = {
  found: false,
  hash: "",
  author: "",
  date: "",
  subject: "",
  body: "",
  files: [],
};

/**
 * log。relativePath 非空时只看该文件的历史（`-- <path>`）。
 *
 * limit / skip 已在契约层夹住上界（max 500），这里再作为 `-n` / `--skip` 传入。
 */
export async function log(
  workspaceId: string,
  relativePath: string | null,
  limit: number,
  skip: number
): Promise<GitLogResult> {
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return EMPTY_LOG;

  const argv = [
    "log",
    `--max-count=${limit}`,
    `--skip=${skip}`,
    `--pretty=format:%H${US}%h${US}%an${US}%aI${US}%s${RS}`,
  ];
  if (relativePath !== null) {
    assertRepoRelPath(relativePath);
    argv.push("--", relativePath);
  }

  const res = await runGit(repoRoot, argv);
  if (res.code !== 0) return EMPTY_LOG;

  const commits: GitCommitSummary[] = [];
  for (const record of res.stdout.toString("utf8").split(RS)) {
    const trimmed = record.replace(/^\n/, "");
    if (trimmed.length === 0) continue;
    const [hash, shortHash, author, date, subject] = trimmed.split(US);
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: shortHash ?? "",
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
    });
  }
  return { commits };
}

/** 解析 `--name-status` 的一行：`M\tpath` / `R100\told\tnew`。 */
function parseNameStatus(text: string): GitShowFile[] {
  const files: GitShowFile[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const status = parts[0]?.trim() ?? "";
    if (status.length === 0) continue;
    // 重命名 / 复制：`R100  old  new` —— 取目标路径（最后一段）。
    const relativePath = parts[parts.length - 1] ?? "";
    if (relativePath.length === 0) continue;
    files.push({ status: status.slice(0, 3), relativePath });
  }
  return files;
}

/** show：某提交的元信息 + 改动的文件（`--name-status`）。 */
export async function show(workspaceId: string, ref: string): Promise<GitShowResult> {
  assertSafeRef(ref);
  const repoRoot = await resolveRepoRoot(workspaceId);
  if (repoRoot === null) return EMPTY_SHOW;

  // 元信息：一条记录，字段用 US 分隔（body 放最后，容许其中含换行）。
  const metaRes = await runGit(repoRoot, [
    "show",
    "-s",
    `--pretty=format:%H${US}%an${US}%aI${US}%s${US}%b`,
    ref,
  ]);
  if (metaRes.code !== 0) return EMPTY_SHOW;
  const [hash, author, date, subject, ...bodyParts] = metaRes.stdout.toString("utf8").split(US);
  if (!hash) return EMPTY_SHOW;

  // 改动文件：不带 patch，只要状态 + 路径。
  const filesRes = await runGit(repoRoot, [
    "show",
    "--name-status",
    "--pretty=format:",
    ref,
  ]);
  const files = filesRes.code === 0 ? parseNameStatus(filesRes.stdout.toString("utf8")) : [];

  return {
    found: true,
    hash,
    author: author ?? "",
    date: date ?? "",
    subject: subject ?? "",
    body: bodyParts.join(US).trim(),
    files,
  };
}

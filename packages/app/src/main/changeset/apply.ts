/**
 * 接受 / 拒绝一条变更（FS-102）。
 *
 * ## 接受之前必须重算 hash
 *
 * 从 Agent 写完到用户点「接受」，中间可能过去几分钟 —— 这几分钟里用户
 * 完全可能在 VS Code 里改了同一个文件。拿一份过期的 before 去覆盖，
 * 丢的是用户自己刚写的东西，而且**不会有任何提示**。因此落盘之前重新
 * 读磁盘算 sha256，与登记时的 before 不符就拒绝并给出三方比较所需的
 * current 快照。
 *
 * ## 接受之前必须留备份
 *
 * 「接受」是这条链路上唯一会覆盖用户文件的动作。备份写在
 * `<userData>/changeset-backup/<changeset_id>`，代价是一次文件复制，
 * 换来的是「点错了还能回去」。没有备份的撤销按钮是假的。
 *
 * ## 拒绝不写盘
 *
 * 拒绝只翻转数据库里的状态。任何一处「顺手把 before 再写一遍」都会让
 * 拒绝变成一次写入 —— 而如果磁盘上此刻的内容是用户手改的，那次写入就是
 * 一次静默覆盖。
 */
import { shell } from "electron";
import type { ChangesetApplyResult, ChangesetBatchResult } from "@pibuddy/contract";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../fs-atomic.js";
import { classifyWriteError, CONFLICT_PREVIEW_CHARS } from "../workspace/file-editor.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import {
  backupDir,
  changesetStore,
  diffOf,
  sha256Text,
  type ChangesetRecord,
} from "./changeset-store.js";

/**
 * 变更的目标绝对路径。
 *
 * 这里用 requireWorkspaceRoot + path.resolve 而不是 resolveInWorkspace：
 * 变更可能是「新建一个还不存在的文件」，而 resolveInWorkspace 会 realpath
 * 目标、对不存在的路径直接抛错。收容仍然成立 —— relative_path 是入库时由
 * resolveInWorkspace 校验过的相对路径，且这里再用 path.relative 复核一次
 * （不是字符串前缀比较）。
 */
function targetPathOf(record: ChangesetRecord): string {
  const root = requireWorkspaceRoot(record.workspaceId);
  const abs = path.resolve(root, record.relativePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`PATH_ESCAPES_WORKSPACE: ${record.relativePath}`);
  }
  return abs;
}

/** 磁盘当前内容与它的 hash；文件不存在时内容为空串、hash 为空串。 */
function readDisk(abs: string): { text: string; sha256: string; mtimeMs: number } {
  try {
    const text = fs.readFileSync(abs, "utf8");
    return { text, sha256: sha256Text(text), mtimeMs: fs.statSync(abs).mtimeMs };
  } catch {
    return { text: "", sha256: "", mtimeMs: 0 };
  }
}

/**
 * 接受一条变更。
 *
 * `hunkIndexes` 传入时只应用选中的那几段，其余保持 before —— 逐 hunk
 * 接受就是这样落地的，而不是先整文件写下去再让用户去撤。
 */
export async function acceptChange(
  id: string,
  hunkIndexes?: number[]
): Promise<ChangesetApplyResult> {
  const store = changesetStore();
  const record = store.get(id);
  if (!record) return { ok: false, errorCode: "missing", message: "变更不存在或已被清理" };

  // 重复接受短路：同一条变更绝不应用两次
  if (record.status === "applied") return { ok: true, alreadyApplied: true };
  if (record.status === "rejected") {
    return { ok: false, message: "这条变更已被拒绝，不能再接受" };
  }
  // before 快照缺失：禁止一键接受，必须人工看过
  if (record.status === "unverified") {
    return {
      ok: false,
      requiresManualReview: true,
      message: "没能抓到改动前的快照，需要你先人工比对再决定",
    };
  }

  const abs = targetPathOf(record);
  const disk = readDisk(abs);
  // 唯一权威是内容 hash：磁盘已经不是登记时的 before，就一个字节都不写
  if (disk.sha256 !== record.beforeSha256) {
    return {
      ok: false,
      conflict: true,
      errorCode: "conflict",
      current: {
        mtimeMs: disk.mtimeMs,
        sha256: disk.sha256,
        preview: disk.text.slice(0, CONFLICT_PREVIEW_CHARS),
      },
    };
  }

  const nextText = composeAccepted(record, hunkIndexes);

  try {
    // 备份先于写入：写到一半失败时备份必须已经在
    fs.mkdirSync(backupDir(), { recursive: true });
    writeFileAtomic(path.join(backupDir(), record.id), record.beforeContent ?? "");

    if (record.kind === "delete" && nextText === "") {
      // 删除走系统回收站，不做不可逆的 unlink
      const result = await shell.trashItem(abs);
      void result;
    } else {
      writeFileAtomic(abs, nextText);
    }
  } catch (err) {
    return { ok: false, ...classifyWriteError(err) };
  }

  store.setStatus(id, "applied");
  return { ok: true };
}

/**
 * 按选中的 hunk 拼出要落盘的内容。
 *
 * 不传 hunkIndexes = 整文件接受，直接用 after。传了就逐段拼：选中的段取
 * after 侧的行，没选中的段保留 before 侧的行。
 */
export function composeAccepted(record: ChangesetRecord, hunkIndexes?: number[]): string {
  const after = record.afterContent ?? "";
  if (!hunkIndexes || hunkIndexes.length === 0) return after;

  const beforeLines = (record.beforeContent ?? "").split("\n");
  const picked = new Set(hunkIndexes);
  // 复用 changeset-store 的 diff：两处各算一次 diff 会让「界面上选的那段」
  // 和「实际写下去的那段」对不上，而那种错位是用户完全看不出来的。
  const hunks = diffOf(record).hunks;

  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    while (cursor < hunk.beforeStart) out.push(beforeLines[cursor++]);
    if (picked.has(hunk.index)) out.push(...hunk.afterLines);
    else out.push(...hunk.beforeLines);
    cursor = hunk.beforeStart + hunk.beforeLines.length;
  }
  while (cursor < beforeLines.length) out.push(beforeLines[cursor++]);
  return out.join("\n");
}

/**
 * 拒绝一条变更。**不产生任何磁盘写**。
 */
export function rejectChange(id: string): ChangesetApplyResult {
  const store = changesetStore();
  const record = store.get(id);
  if (!record) return { ok: false, errorCode: "missing", message: "变更不存在或已被清理" };
  if (record.status === "applied") {
    return { ok: false, alreadyApplied: true, message: "这条变更已经生效，请用编辑器撤销" };
  }
  store.setStatus(id, "rejected");
  return { ok: true };
}

/**
 * 批量接受。
 *
 * unverified 条目**硬跳过并列出来** —— 静默跳过和静默接受一样糟：前者让
 * 用户以为已经处理完了，后者让用户丢文件。
 */
export async function acceptBatch(ids: string[]): Promise<ChangesetBatchResult> {
  const store = changesetStore();
  const out: ChangesetBatchResult = {
    applied: [],
    skippedUnverified: [],
    conflicted: [],
    failed: [],
  };
  for (const id of ids) {
    const record = store.get(id);
    if (record?.status === "unverified") {
      out.skippedUnverified.push(id);
      continue;
    }
    const result = await acceptChange(id);
    if (result.conflict) out.conflicted.push(id);
    else if (result.ok) out.applied.push(id);
    else out.failed.push(id);
  }
  return out;
}

/** 备份文件的字节（仅供单测与「撤销」入口）。 */
export async function backupBytesOf(id: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(path.join(backupDir(), id));
  } catch {
    return null;
  }
}

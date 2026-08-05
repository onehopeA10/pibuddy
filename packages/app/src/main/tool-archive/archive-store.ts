/**
 * 工具结果归档的文件旁路（tool-archive / 大结果护栏）。
 *
 * ## 为什么不复用 `common.artifacts` 的 ArtifactStore
 *
 * 读完 `main/artifacts/artifact-store.ts` 后**刻意不复用**，三条理由：
 *
 *   1. 那是**用户可见的产物库**：每写一条就会出现在「产物」列表里、带版本
 *      链、能重命名、能移入回收站。工具结果归档是纯机器件（模型读回用），
 *      把它们灌进产物库等于往用户的资料柜里倒日志。
 *   2. 那里的 `export_path` 是**工作区相对路径**，落盘落在用户工作目录里
 *      （`requireWorkspaceRoot` + relativePath）。归档是内部数据，不该往
 *      用户的文件夹里写东西。
 *   3. 它要求工作区**已注册**（`requireWorkspaceRoot` 未注册即抛）。归档
 *      发生在回包路径上，那条路上任何抛错都会把一次成功的工具调用变成失败
 *      ——护栏绝不能有这种副作用。
 *
 * 所以照参考实现里**不依赖 sqlite 的那一版**（harbor-cell：一条 JSON 记录
 * 一个文件 + 读回时逐项校验）做：`<userData>/tool-archive/<workspaceId>/<id>`。
 *
 * ## 隔离与校验
 *
 * 目录按 workspaceId 分层，读回时再逐项复验（workspace → kind/代际 → size
 * → sha256）。任何一项不符一律返回失败原因，**绝不静默返回错内容**——
 * 「读到了别人的归档」比「读不到」危险得多。
 *
 * ## 写是先 tmp 再 rename
 *
 * 撕裂的半个文件读回来会在 sha256 那一关被抓住（不会喂错内容给模型），
 * 但那是「检测到损坏」而不是「没有损坏」。rename 在同目录内是原子的，
 * 成本一次系统调用，没有不做的理由。
 */
import { app } from "electron";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { workspaceIdFor } from "../workspace-registry.js";

/** 归档记录的代际。改结构必须 +1，读回时 kind/version 不符即当作损坏。 */
export const TOOL_ARCHIVE_RECORD_VERSION = 1;

/** 记录的类别判别符（读回第二关：来源 kind）。 */
export const TOOL_ARCHIVE_RECORD_KIND = "pibuddy.tool_result_archive";

/** artifactId 的合法形态。既是文件名，也是**路径穿越的结构性挡板**。 */
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

/** 落盘目录名（userData 下）。 */
const ARCHIVE_DIR_NAME = "tool-archive";

/** 测试注入用；生产环境恒为 null，走 app.getPath("userData")。 */
let dataDirOverride: string | null = null;

/** 仅供单测：把归档根指向临时目录。 */
export function __setToolArchiveDir(dir: string | null): void {
  dataDirOverride = dir;
}

function archiveRoot(): string {
  return path.join(dataDirOverride ?? app.getPath("userData"), ARCHIVE_DIR_NAME);
}

/**
 * bridge 请求里的 cwd → 归档隔离域。
 *
 * 与 home-ipc 的 `workspaceIdOfCwd` 同一套派生（realpath → workspaceIdFor），
 * 但**不要求已注册**：这里只要一个稳定的隔离键，注册与否是权限面的事，
 * 已经在执行面判过了。解析不出来返回 null——调用方据此当作「归档不可用」。
 */
export function archiveScopeForCwd(cwd: string | null): string | null {
  if (cwd === null || cwd === "") return null;
  try {
    return workspaceIdFor(fs.realpathSync.native(cwd));
  } catch {
    return null;
  }
}

export interface ToolArchiveRecord {
  kind: typeof TOOL_ARCHIVE_RECORD_KIND;
  version: typeof TOOL_ARCHIVE_RECORD_VERSION;
  workspaceId: string;
  toolName: string;
  bodySha256: string;
  originalBytes: number;
  originalEstimatedTokens: number;
  serializedResult: string;
  createdAt: number;
}

export interface ToolArchiveWriteInput {
  workspaceId: string;
  toolName: string;
  bodySha256: string;
  originalBytes: number;
  originalEstimatedTokens: number;
  serializedResult: string;
}

export interface ToolArchiveIdentity {
  artifactId: string;
  workspaceId: string;
  bodySha256: string;
  originalBytes: number;
}

export type ToolArchiveReadFailureReason =
  | "not_allowed"
  | "not_found"
  | "corrupt"
  | "workspace_mismatch"
  | "size_mismatch"
  | "source_mismatch";

export type ToolArchiveReadOutcome =
  | { ok: true; serializedResult: string; toolName: string }
  | { ok: false; reason: ToolArchiveReadFailureReason };

function newArtifactId(): string {
  return `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}.json`;
}

/** 写一条归档。返回的 artifactId 是占位符里唯一的可恢复引用。 */
export async function writeToolResultArchive(
  input: ToolArchiveWriteInput
): Promise<{ artifactId: string }> {
  const dir = path.join(archiveRoot(), input.workspaceId);
  await fsp.mkdir(dir, { recursive: true });
  const artifactId = newArtifactId();
  const record: ToolArchiveRecord = {
    kind: TOOL_ARCHIVE_RECORD_KIND,
    version: TOOL_ARCHIVE_RECORD_VERSION,
    workspaceId: input.workspaceId,
    toolName: input.toolName,
    bodySha256: input.bodySha256,
    originalBytes: input.originalBytes,
    originalEstimatedTokens: input.originalEstimatedTokens,
    serializedResult: input.serializedResult,
    createdAt: Date.now(),
  };
  const target = path.join(dir, artifactId);
  const staging = `${target}.tmp`;
  await fsp.writeFile(staging, `${JSON.stringify(record)}\n`, "utf8");
  await fsp.rename(staging, target);
  return { artifactId };
}

function isToolArchiveRecord(value: unknown): value is ToolArchiveRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ToolArchiveRecord>;
  return (
    record.kind === TOOL_ARCHIVE_RECORD_KIND &&
    record.version === TOOL_ARCHIVE_RECORD_VERSION &&
    typeof record.workspaceId === "string" &&
    record.workspaceId.length > 0 &&
    typeof record.toolName === "string" &&
    typeof record.bodySha256 === "string" &&
    typeof record.originalBytes === "number" &&
    typeof record.serializedResult === "string"
  );
}

/**
 * 读回一条归档，**前四校验逐条走完**才返回内容：
 *
 *   1. workspace 隔离（记录里的 workspaceId 必须与请求方所在工作区逐字一致）
 *   2. 来源 kind / 代际
 *   3. size（记录声明的 originalBytes 与请求引用一致，且与实际内容一致）
 *   4. sha256（记录声明的与请求引用一致，且与实际内容重算一致）
 *
 * 3、4 各查两遍不是冗余：第一遍防「引用指向了另一条归档」，第二遍防
 * 「这条归档自己被改坏了」——两种失败在处置上都是「不可用」，但混为一谈
 * 就没法诊断。
 */
export async function readToolResultArchive(
  identity: ToolArchiveIdentity
): Promise<ToolArchiveReadOutcome> {
  if (!ARTIFACT_ID_RE.test(identity.artifactId)) return { ok: false, reason: "not_allowed" };
  if (!ARTIFACT_ID_RE.test(identity.workspaceId)) return { ok: false, reason: "not_allowed" };

  let raw: string;
  try {
    raw = await fsp.readFile(
      path.join(archiveRoot(), identity.workspaceId, identity.artifactId),
      "utf8"
    );
  } catch {
    return { ok: false, reason: "not_found" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (!isToolArchiveRecord(parsed)) return { ok: false, reason: "corrupt" };
  if (parsed.workspaceId !== identity.workspaceId) {
    return { ok: false, reason: "workspace_mismatch" };
  }
  if (parsed.originalBytes !== identity.originalBytes) {
    return { ok: false, reason: "size_mismatch" };
  }
  if (parsed.bodySha256 !== identity.bodySha256) return { ok: false, reason: "source_mismatch" };

  const actualBytes = Buffer.byteLength(parsed.serializedResult, "utf8");
  if (actualBytes !== identity.originalBytes) return { ok: false, reason: "size_mismatch" };
  const actualSha = createHash("sha256").update(parsed.serializedResult, "utf8").digest("hex");
  if (actualSha !== identity.bodySha256) return { ok: false, reason: "corrupt" };

  return { ok: true, serializedResult: parsed.serializedResult, toolName: parsed.toolName };
}

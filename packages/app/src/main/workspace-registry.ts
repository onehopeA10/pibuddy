/**
 * 工作目录注册表与全计划唯一的路径收容原语（SEC-003 / 裁定3 / CT-18）。
 *
 * ## workspaceId 为什么必须由路径派生而不是随机生成
 *
 * 进程级随机 id（UUID 那一类）只在本次运行内有效：应用一重启，同一个工作
 * 目录会拿到一个全新的 id。而 TASK-009 的 sessions 表把 workspace_id 声明为
 * NOT NULL 并据它过滤历史会话 —— 于是重启之后，用户的全部历史会话会一条都
 * 查不出来，**而且不报任何错**（查询本身是成功的，只是命中 0 行）。
 * 因此这里取 `sha256(canonical realpath)`：同一个目录，永远同一个 id。
 *
 * ## 为什么用 path.relative 判定收容而不是字符串前缀
 *
 *     "/work-evil".startsWith("/work")   // true —— 但 /work-evil 显然不在 /work 里
 *
 * 前缀比较把「兄弟目录名恰好以 root 开头」误判为「在 root 之内」。
 * `path.relative(root, target)` 得到的相对路径若以 `..` 开头或本身是绝对
 * 路径，才是真正的「在外面」。另外每次收容都重新 `realpath` 一次：符号链接
 * 可以在签发之后被换掉，只在入口校验一次等于给 TOCTOU 留门。
 */
import { app } from "electron";
import type { WorkspaceRef } from "@pibuddy/contract";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./fs-atomic.js";
import { normalizeWslUnc } from "./wsl-paths.js";

export interface WorkspaceRecord {
  workspaceId: string;
  /** canonical realpath —— 只存在于主进程，永不外发给渲染进程 */
  root: string;
  /** 首次注册时间（Unix ms），仅用于诊断 */
  registeredAt: number;
  /** 最近一次作为当前工作目录打开的时间（Unix ms）；0 = 从未（项目列表排序用） */
  lastOpenedAt: number;
}

/** 落盘文件名。跨重启的稳定性靠它保证。 */
const STORE_FILE = "workspaces.json";

/** 测试注入用的数据目录；生产环境恒为 null，走 app.getPath("userData")。 */
let dataDirOverride: string | null = null;

/** 仅供单测使用：把注册表落盘目录指向临时目录。 */
export function __setWorkspaceDataDir(dir: string | null): void {
  dataDirOverride = dir;
  cache = null;
}

function storePath(): string {
  const base = dataDirOverride ?? app.getPath("userData");
  return path.join(base, STORE_FILE);
}

/** workspaceId → 记录。首次访问时从磁盘惰性载入。 */
let cache: Map<string, WorkspaceRecord> | null = null;

function load(): Map<string, WorkspaceRecord> {
  if (cache) return cache;
  const map = new Map<string, WorkspaceRecord>();
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const rec = value as Partial<WorkspaceRecord>;
        if (typeof rec?.root !== "string" || !rec.root) continue;
        try {
          const root = fs.realpathSync.native(normalizeWslUnc(rec.root));
          if (!fs.statSync(root).isDirectory()) continue;
          // workspaceId 是 root 的派生身份，不是可由落盘 JSON 任意重新绑定的别名。
          if (workspaceIdFor(root) !== id) continue;
          map.set(id, {
            workspaceId: id,
            root,
            registeredAt: typeof rec.registeredAt === "number" ? rec.registeredAt : 0,
            lastOpenedAt: typeof rec.lastOpenedAt === "number" ? rec.lastOpenedAt : 0,
          });
        } catch {
          // root 已不存在、不可访问或不是合法工作区：忽略该条，绝不保留旧绑定。
        }
      }
    }
  } catch {
    // 文件不存在 / 被手改坏：当作空表重建。工作目录会在下一次 register 时补回。
  }
  cache = map;
  return map;
}

function persist(map: Map<string, WorkspaceRecord>): void {
  const out: Record<string, Omit<WorkspaceRecord, "workspaceId">> = {};
  for (const [id, rec] of map) {
    out[id] = { root: rec.root, registeredAt: rec.registeredAt, lastOpenedAt: rec.lastOpenedAt };
  }
  writeJsonAtomic(storePath(), out);
}

/**
 * canonical realpath → 稳定的不透明 id。
 *
 * 取 sha256 前 32 个十六进制字符：128 bit 的碰撞空间对「本机工作目录」这个
 * 量级绰绰有余，同时短到能塞进日志和 SQLite 主键而不难看。
 * Windows 下路径大小写不敏感，先统一小写再哈希，否则 `D:\Work` 与 `d:\work`
 * 会被算成两个不同的工作区。
 */
export function workspaceIdFor(canonicalRoot: string): string {
  const normalized =
    process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

/**
 * 注册（或复用）一个工作目录，返回不透明 id。
 *
 * 同一个 realpath 反复调用恒返回同一个 id，且首次注册即经 writeJsonAtomic
 * 落盘到 `<userData>/workspaces.json`，因此跨重启也稳定。
 */
export function registerWorkspace(absPath: string): WorkspaceRecord {
  if (!absPath || !path.isAbsolute(absPath)) {
    throw new Error(`WORKSPACE_INVALID_PATH: ${absPath}`);
  }
  // WSL UNC 先归一（R5.1）：`\\wsl$\X` 与 `\\wsl.localhost\X` 是同一个目录的
  // 两个名字，而 realpath 对两种形态都**原样返回**、不互相归一（Win11 + Node 24
  // 真机实测）。不在这里收敛的话，同一个 WSL 目录会派生出两个 workspaceId，
  // 各带一套 ignore 策略与历史会话。非 WSL 路径原样通过。
  const normalized = normalizeWslUnc(absPath);
  // realpathSync.native 交给操作系统做规范化：符号链接、8.3 短名、大小写
  // 全部在这一步收敛，JS 侧的字符串处理做不到这件事。
  const root = fs.realpathSync.native(normalized);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`WORKSPACE_NOT_A_DIRECTORY: ${absPath}`);

  const workspaceId = workspaceIdFor(root);
  const map = load();
  const existing = map.get(workspaceId);
  if (existing && existing.root === root) return existing;

  const record: WorkspaceRecord = { workspaceId, root, registeredAt: Date.now(), lastOpenedAt: 0 };
  map.set(workspaceId, record);
  persist(map);
  return record;
}

/**
 * 记一次「作为当前工作目录打开」。
 *
 * 与 registerWorkspace 分开：注册的来源很多（git worktree、测试夹具、附件
 * 收容……），只有用户真的切过去才算「打开」，项目列表按这个时间排序。
 */
export function touchWorkspace(workspaceId: string): void {
  const map = load();
  const record = map.get(workspaceId);
  if (!record) return;
  record.lastOpenedAt = Date.now();
  persist(map);
}

/**
 * 全部已注册的工作目录，最近打开的在前、从未打开的按注册时间倒序。
 *
 * load() 已把目录不存在的条目过滤掉，因此这里列出的都是此刻还在的目录。
 */
export function listWorkspaces(): WorkspaceRecord[] {
  return [...load().values()].sort(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt || b.registeredAt - a.registeredAt
  );
}

/**
 * 工作目录的**渲染侧视图**：不透明 id + 仅供显示的路径。
 *
 * 派生逻辑收在这里而不是各 handler 里 —— displayPath 是唯一被允许离开主进程
 * 的路径形态，它从哪来、长什么样，只能有一个说法。
 */
export function describeWorkspace(workspaceId: string): WorkspaceRef {
  return { workspaceId, displayPath: requireWorkspaceRoot(workspaceId) };
}

/** 已注册的工作目录；未注册返回 null（不抛错，供 workspace:current 使用）。 */
export function lookupWorkspace(workspaceId: string): WorkspaceRecord | null {
  return load().get(workspaceId) ?? null;
}

/** 取 canonical root，未注册即抛错。所有需要真实路径的主进程逻辑都走这里。 */
export function requireWorkspaceRoot(workspaceId: string): string {
  const record = lookupWorkspace(workspaceId);
  if (!record) throw new Error(`WORKSPACE_UNKNOWN: ${workspaceId}`);
  return record.root;
}

export interface ResolveOptions {
  /** 要求命中目标是普通文件（默认 false —— 空串即 root 自身，那是目录） */
  requireFile?: boolean;
}

export interface ResolvedPath {
  /** 收容校验通过后的 canonical 绝对路径 */
  realPath: string;
  /** 相对 root 的路径；空串表示 root 自身 */
  relativePath: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

/**
 * 全计划唯一的路径收容原语（CT-18）。
 *
 * 拒绝绝对路径与含 `..` 的输入，`realpath` 之后再用 `path.relative` 判定收容。
 * **`relativePath` 为空串（即 workspace root 自身）视为放行** —— 这是全计划
 * 唯一口径，后续任务不得另建一个拒绝 root 自身的原语。
 */
export async function resolveInWorkspace(
  workspaceId: string,
  relativePath: string,
  options: ResolveOptions = {}
): Promise<ResolvedPath> {
  const root = requireWorkspaceRoot(workspaceId);

  if (typeof relativePath !== "string") throw new Error("PATH_INVALID");
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`PATH_ABSOLUTE_REJECTED: ${relativePath}`);
  }
  // 先在字符串层面挡掉 `..`：这不是收容判据（下面的 path.relative 才是），
  // 只是让「明显在试探」的输入在触碰文件系统之前就被拒。
  if (relativePath.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new Error(`PATH_TRAVERSAL_REJECTED: ${relativePath}`);
  }

  const candidate = path.resolve(root, relativePath);
  // 每次都重新 realpath：签发之后目标可能被换成指向外部的符号链接。
  const realRoot = await fsp.realpath(root);
  const real = await fsp.realpath(candidate);

  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`PATH_ESCAPES_WORKSPACE: ${relativePath}`);
  }

  const stat = await fsp.stat(real);
  if (options.requireFile && !stat.isFile()) {
    throw new Error(`PATH_NOT_A_FILE: ${relativePath}`);
  }

  return {
    realPath: real,
    relativePath: rel,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
  };
}

/**
 * 判定一个**已经是绝对路径**的目标是否落在 root 之内。
 *
 * 与 resolveInWorkspace 共用同一套判据（realpath + path.relative），供
 * attachment-registry 在 resolve 时复核 token 指向的文件、以及会话文件的
 * 收容校验使用。
 */
export async function assertContained(root: string, absTarget: string): Promise<string> {
  const realRoot = await fsp.realpath(root);
  const real = await fsp.realpath(absTarget);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`PATH_ESCAPES_ROOT: ${absTarget}`);
  }
  return real;
}

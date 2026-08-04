/**
 * 能力包携带的 pi 资源的装卸（REQ-0001 R4.2 / R4.4）。
 *
 * ## 这个模块回答什么
 *
 * 「能力包 manifest 里声明的 prompts / skills / extensions，怎么变成 pi 真的
 * 会加载的文件？」答案是**物化**：启用的包，把 `capability-assets/<packId>/`
 * 下的资源文件复制到 pi 的用户级资源目录（`~/.pi/agent/{prompts,skills,extensions}/`，
 * 目录约定见 pi docs 的 prompt-templates.md / skills.md / extensions.md）；
 * 停用的包，把当初物化的那些收回来。
 *
 * ## 归属账本（ledger）：只删自己放的，绝不动用户的
 *
 * pi 的资源目录是**跨应用共享**的：用户自己手放的 prompt 和我们物化的 prompt
 * 躺在同一个目录里，靠文件名分不出谁是谁。因此在 `~/.pi/agent/` 下记一份
 * `pibuddy-assets.json`：每个包物化了哪些文件、写入时内容的 sha256。
 * 之后的一切判断都以它为准：
 *
 *   - **幂等**：目标在账、hash 没变、文件还在 → 一个字节都不写；
 *   - **升级**：源内容 hash 变了 → 覆盖（这就是「升级覆盖旧版本」的全部含义）；
 *   - **移除**：只删「在账且磁盘内容仍等于账上 hash」的文件。用户手放的
 *     （不在账）不碰；用户改过我们物化的（在账但 hash 对不上）也不删——
 *     那份文件已经是用户的了，只从账上除名；
 *   - **冲突**：目标已存在但不属于本包（用户的，或另一个包的）→ 拒绝覆盖，
 *     记进 report.conflicts。静默覆盖用户文件是这条通道最不可原谅的行为。
 *
 * ## 刻意不做的
 *
 *   - 不 import electron：资源根与 pi 目录都由调用方传进来，接线层
 *     （capability-assets-wiring.ts）负责在真实进程里把路径拼对。这样单测
 *     可以拿两个临时目录把物化 / 移除 / 升级全跑真，不需要给 electron 打桩。
 *   - 不碰权限：物化是内核动作（R4.3）。extension 工具的权限需求在 manifest
 *     校验期就被钉死（extensions 非空 ⇒ tools 非空 ⇒ tools[].permissions ⊆
 *     permissions），执行期走权限引擎的 5 闸，这里没有任何一行授予语义。
 *   - 不抛异常出去：单个文件失败折成 report.errors 里的一句中文，剩下的
 *     继续。装卸是启动路径上的旁路，让它把主进程拖崩是最坏的取舍。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { EMPTY_CAPABILITY_PI_RESOURCES, type CapabilityManifest } from "@pibuddy/contract";

/** extraResources 投递到 process.resourcesPath 下的目录名；dev 下在 resources/ 里同名。 */
export const CAPABILITY_ASSETS_DIR_NAME = "capability-assets";

/** 归属账本文件名，落在 pi 用户资源目录（~/.pi/agent/）根下。 */
export const ASSET_LEDGER_FILENAME = "pibuddy-assets.json";

export const ASSET_LEDGER_VERSION = 1;

/**
 * 文件系统操作面。抽成接口是 R4.4 的要求：幂等判据要能在单测里用临时目录
 * （或计数打桩）跑真。默认实现 `nodeAssetFileOps` 用 fs/promises。
 */
export interface AssetFileOps {
  /** 读文件；不存在返回 null */
  readFile(file: string): Promise<Buffer | null>;
  /** 写文件，自动创建父目录 */
  writeFile(file: string, data: Buffer): Promise<void>;
  /** 删文件；不存在静默 */
  deleteFile(file: string): Promise<void>;
  /** 递归列出 dir 下全部文件（相对 dir 的 posix 路径）；dir 不存在返回 null */
  listFiles(dir: string): Promise<string[] | null>;
  isFile(target: string): Promise<boolean>;
  isDirectory(target: string): Promise<boolean>;
  /** 删空目录；非空或不存在时静默不动 */
  removeDirIfEmpty(dir: string): Promise<void>;
}

export const nodeAssetFileOps: AssetFileOps = {
  async readFile(file) {
    try {
      return await fs.readFile(file);
    } catch {
      return null;
    }
  },
  async writeFile(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  },
  async deleteFile(file) {
    await fs.rm(file, { force: true });
  },
  async listFiles(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
      return null;
    }
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
  },
  async isFile(target) {
    try {
      return (await fs.stat(target)).isFile();
    } catch {
      return false;
    }
  },
  async isDirectory(target) {
    try {
      return (await fs.stat(target)).isDirectory();
    } catch {
      return false;
    }
  },
  async removeDirIfEmpty(dir) {
    try {
      await fs.rmdir(dir);
    } catch {
      // 非空 / 不存在都到这里：两种情况的正确动作都是「不动」
    }
  },
};

// ---------------------------------------------------------------- 账本

interface LedgerPack {
  packVersion: string;
  /** dest（相对 piAgentDir 的 posix 路径）→ 写入时内容的 sha256 */
  files: Record<string, string>;
}

interface AssetLedger {
  version: number;
  packs: Record<string, LedgerPack>;
}

function emptyLedger(): AssetLedger {
  return { version: ASSET_LEDGER_VERSION, packs: {} };
}

async function readLedger(file: string, ops: AssetFileOps, errors: string[]): Promise<AssetLedger> {
  const raw = await ops.readFile(file);
  if (raw === null) return emptyLedger();
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyLedger();
    const ledger = parsed as Partial<AssetLedger>;
    const packs: Record<string, LedgerPack> = {};
    for (const [id, entry] of Object.entries(ledger.packs ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const files: Record<string, string> = {};
      for (const [dest, hash] of Object.entries((entry as LedgerPack).files ?? {})) {
        if (typeof hash === "string") files[dest] = hash;
      }
      packs[id] = {
        packVersion:
          typeof (entry as LedgerPack).packVersion === "string"
            ? (entry as LedgerPack).packVersion
            : "0.0.0",
        files,
      };
    }
    return { version: ASSET_LEDGER_VERSION, packs };
  } catch (err) {
    // 账本坏了不等于可以乱删：读不出归属就**什么都不移除**（本次当空账处理，
    // 物化照常、移除只会作用于本次新记的账），坏账本身报出来。
    errors.push(`归属账本解析失败，已按空账处理（本次不移除任何旧文件）：${String(err)}`);
    return emptyLedger();
  }
}

// ---------------------------------------------------------------- 期望文件集

/** 一个待物化的文件：源绝对路径 + 目标（相对 piAgentDir 的 posix 路径）。 */
interface DesiredFile {
  source: string;
  dest: string;
}

const EXTENSION_FILE_SUFFIXES = [".ts", ".js", ".mjs"];

function posixJoin(...parts: string[]): string {
  return parts.join("/");
}

/**
 * 把一个包的 piResources 声明折成「应当存在于 pi 目录里的文件集合」。
 *
 * 目标路径的推导就是 pi 的发现规则本身（调研结论钉在这里）：
 *
 *   - prompt `x/y/review.md` → `prompts/review.md`（pi 的 prompts 目录非递归，
 *     文件名就是 `/review` 命令名）；
 *   - skill 目录 `skills/demo` → `skills/demo/**`（pi 递归找含 SKILL.md 的目录）；
 *     skill 单文件 `skills/quick.md` → `skills/quick.md`（根 .md 即技能）；
 *   - extension 文件 `ext/tool.ts` → `extensions/tool.ts`；extension 目录
 *     `ext/tool` → `extensions/tool/**`（pi 认 extensions/*.ts 与 extensions/星/index.ts）。
 */
async function desiredFilesFor(
  manifest: CapabilityManifest,
  assetsRoot: string,
  ops: AssetFileOps,
  errors: string[]
): Promise<DesiredFile[]> {
  const declared = manifest.piResources ?? EMPTY_CAPABILITY_PI_RESOURCES;
  const packRoot = path.join(assetsRoot, manifest.id);
  const out: DesiredFile[] = [];
  const seenDest = new Set<string>();

  const push = (source: string, dest: string): void => {
    // 同包内两条声明落到同一个目标（如 a/x.md 与 b/x.md 都想当 prompts/x.md）
    // 是声明错误，不是可以静默选边的事。
    if (seenDest.has(dest)) {
      errors.push(`${manifest.id}: 两条 piResources 声明落到同一目标 "${dest}"，后者被跳过`);
      return;
    }
    seenDest.add(dest);
    out.push({ source, dest });
  };

  for (const rel of declared.prompts) {
    const source = path.join(packRoot, rel);
    if (!(await ops.isFile(source))) {
      errors.push(`${manifest.id}: piResources.prompts "${rel}" 在 capability-assets 里不存在`);
      continue;
    }
    push(source, posixJoin("prompts", path.posix.basename(rel)));
  }

  for (const rel of declared.skills) {
    const source = path.join(packRoot, rel);
    const base = path.posix.basename(rel);
    if (await ops.isDirectory(source)) {
      const files = (await ops.listFiles(source)) ?? [];
      if (!files.includes("SKILL.md")) {
        errors.push(`${manifest.id}: piResources.skills "${rel}" 目录里没有 SKILL.md`);
        continue;
      }
      for (const f of files) push(path.join(source, f), posixJoin("skills", base, f));
    } else if (await ops.isFile(source)) {
      if (!rel.endsWith(".md")) {
        errors.push(`${manifest.id}: piResources.skills "${rel}" 是文件却不是 .md（单文件技能只认根 .md）`);
        continue;
      }
      push(source, posixJoin("skills", base));
    } else {
      errors.push(`${manifest.id}: piResources.skills "${rel}" 在 capability-assets 里不存在`);
    }
  }

  for (const rel of declared.extensions) {
    const source = path.join(packRoot, rel);
    const base = path.posix.basename(rel);
    if (await ops.isDirectory(source)) {
      const files = (await ops.listFiles(source)) ?? [];
      if (!files.some((f) => f === "index.ts" || f === "index.js")) {
        errors.push(`${manifest.id}: piResources.extensions "${rel}" 目录里没有 index.ts / index.js`);
        continue;
      }
      for (const f of files) push(path.join(source, f), posixJoin("extensions", base, f));
    } else if (await ops.isFile(source)) {
      if (!EXTENSION_FILE_SUFFIXES.some((s) => rel.endsWith(s))) {
        errors.push(`${manifest.id}: piResources.extensions "${rel}" 不是 .ts/.js/.mjs 文件`);
        continue;
      }
      push(source, posixJoin("extensions", base));
    } else {
      errors.push(`${manifest.id}: piResources.extensions "${rel}" 在 capability-assets 里不存在`);
    }
  }

  return out;
}

// ---------------------------------------------------------------- 装卸

export interface AssetSyncReport {
  /** 本轮真正写盘的目标（首次物化 + 升级覆盖 + 自愈重建） */
  written: string[];
  /** 本轮删掉的目标（停用 / 声明收窄 / 包从构建里消失） */
  removed: string[];
  /** 在账但用户改过、停用时保留下来的文件（只除名不删） */
  keptEdited: string[];
  /** 目标已被用户或别的包占着、拒绝覆盖的目标 */
  conflicts: string[];
  errors: string[];
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 把「本次构建的能力包 + 启用集合」同步进 pi 用户资源目录。
 *
 * 幂等、可重入：整个函数是「期望状态 vs 账本」的一次对账，重复调用不会
 * 重复落盘；中途断电留下半套文件，下一次调用会把缺的补上、多的收掉。
 * 启用/停用在本应用里都要重启才生效（通道注册同理），因此这里只需要在
 * 启动装配后跑一次——不存在「运行中途启停」的窗口。
 */
export async function syncCapabilityAssets(args: {
  packs: readonly { manifest: CapabilityManifest; enabled: boolean }[];
  /** capability-assets 根（dev: packages/app/resources/…；打包: resourcesPath/…） */
  assetsRoot: string;
  /** pi 用户资源目录（~/.pi/agent） */
  piAgentDir: string;
  ops?: AssetFileOps;
}): Promise<AssetSyncReport> {
  const ops = args.ops ?? nodeAssetFileOps;
  const report: AssetSyncReport = {
    written: [],
    removed: [],
    keptEdited: [],
    conflicts: [],
    errors: [],
  };

  const ledgerPath = path.join(args.piAgentDir, ASSET_LEDGER_FILENAME);
  const ledger = await readLedger(ledgerPath, ops, report.errors);
  const before = JSON.stringify(ledger);

  /** dest → 占有它的 packId（账上的 + 本轮已写的），冲突判定用 */
  const owner = new Map<string, string>();
  for (const [id, entry] of Object.entries(ledger.packs)) {
    for (const dest of Object.keys(entry.files)) owner.set(dest, id);
  }

  // 账上有、本次构建里已经没有的包 → 视同停用，一并收走
  const known = new Set(args.packs.map((p) => p.manifest.id));
  const vanished = Object.keys(ledger.packs).filter((id) => !known.has(id));

  for (const { manifest, enabled } of args.packs) {
    const desired = enabled ? await desiredFilesFor(manifest, args.assetsRoot, ops, report.errors) : [];
    const oldEntry = ledger.packs[manifest.id];
    const nextFiles: Record<string, string> = {};

    // ---- 物化 / 升级
    for (const { source, dest } of desired) {
      const data = await ops.readFile(source);
      if (data === null) {
        report.errors.push(`${manifest.id}: 读取资源失败 ${source}`);
        continue;
      }
      const wantHash = sha256(data);
      const owned = owner.get(dest);
      const ledgerHash = oldEntry?.files[dest];

      if (ledgerHash === undefined) {
        if (owned !== undefined && owned !== manifest.id) {
          report.conflicts.push(`${dest}（已属 ${owned}，${manifest.id} 拒绝覆盖）`);
          continue;
        }
        if (await ops.isFile(path.join(args.piAgentDir, dest))) {
          // 不在任何账上却已存在 = 用户手放的文件。绝不覆盖。
          report.conflicts.push(`${dest}（用户已有同名文件，${manifest.id} 拒绝覆盖）`);
          continue;
        }
        await ops.writeFile(path.join(args.piAgentDir, dest), data);
        report.written.push(dest);
      } else if (ledgerHash !== wantHash) {
        // 升级：源内容变了就覆盖。用户对旧版的手改随升级让位——账上 hash
        // 换成新版，之后停用时按新账判断。
        await ops.writeFile(path.join(args.piAgentDir, dest), data);
        report.written.push(dest);
      } else if (!(await ops.isFile(path.join(args.piAgentDir, dest)))) {
        // 在账、内容没变、文件却没了：自愈重建。包处于启用态，它声明的资源
        // 就该在；用户删文件的受支持做法是停用这个包。
        await ops.writeFile(path.join(args.piAgentDir, dest), data);
        report.written.push(dest);
      }
      nextFiles[dest] = wantHash;
      owner.set(dest, manifest.id);
    }

    // ---- 移除（停用的包走全量；启用的包走「声明收窄」差集）
    for (const [dest, ledgerHash] of Object.entries(oldEntry?.files ?? {})) {
      if (nextFiles[dest] !== undefined) continue;
      await removeOwnedFile(dest, ledgerHash, args.piAgentDir, ops, report);
      owner.delete(dest);
    }

    if (Object.keys(nextFiles).length > 0) {
      ledger.packs[manifest.id] = { packVersion: manifest.version, files: nextFiles };
    } else {
      delete ledger.packs[manifest.id];
    }
  }

  for (const id of vanished) {
    for (const [dest, ledgerHash] of Object.entries(ledger.packs[id].files)) {
      await removeOwnedFile(dest, ledgerHash, args.piAgentDir, ops, report);
    }
    delete ledger.packs[id];
  }

  // 账本只在有变化时写：什么都没发生的启动，pi 目录连 mtime 都不动。
  if (JSON.stringify(ledger) !== before) {
    await ops.writeFile(ledgerPath, Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, "utf8"));
  }

  return report;
}

/** 按账移除一个文件：内容仍是我们写的才删；用户改过就只除名。 */
async function removeOwnedFile(
  dest: string,
  ledgerHash: string,
  piAgentDir: string,
  ops: AssetFileOps,
  report: AssetSyncReport
): Promise<void> {
  const abs = path.join(piAgentDir, dest);
  const data = await ops.readFile(abs);
  if (data === null) {
    // 文件已不在：目标状态本来就是「没有」，除名即可
    return;
  }
  if (sha256(data) !== ledgerHash) {
    report.keptEdited.push(dest);
    return;
  }
  await ops.deleteFile(abs);
  report.removed.push(dest);
  // 收掉物化时建出来的子目录（skills/<name>/…、extensions/<name>/…）。
  // 只往上收到 kind 根为止：prompts/skills/extensions 三个根目录是 pi 的，
  // 空了也不归我们删。
  const segments = dest.split("/");
  for (let depth = segments.length - 1; depth >= 2; depth--) {
    await ops.removeDirIfEmpty(path.join(piAgentDir, ...segments.slice(0, depth)));
  }
}

// ---------------------------------------------------------------- 结构断言（R4.4）

/**
 * 「声明了的资源必须真实存在于 capability-assets」的可执行形态。
 *
 * 返回全部错误而不是第一条（与 validateCapabilityManifest 同一取舍）。
 * drift 测试拿 BUILT_IN_CAPABILITIES + 真实资源根跑它；单测拿 fixture
 * 分别验证「存在 → 空」与「指空 → 红」，防这条断言恒真。
 */
export async function verifyCapabilityAssets(
  manifests: readonly CapabilityManifest[],
  assetsRoot: string,
  ops: AssetFileOps = nodeAssetFileOps
): Promise<string[]> {
  const errors: string[] = [];
  for (const manifest of manifests) {
    const declared = manifest.piResources ?? EMPTY_CAPABILITY_PI_RESOURCES;
    if (
      declared.prompts.length === 0 &&
      declared.skills.length === 0 &&
      declared.extensions.length === 0
    ) {
      continue;
    }
    // desiredFilesFor 的存在性检查就是这条断言的实现：清单指空、目录缺
    // SKILL.md、extension 目录缺 index，全部折成错误。
    await desiredFilesFor(manifest, assetsRoot, ops, errors);
  }
  return errors;
}

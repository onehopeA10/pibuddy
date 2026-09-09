/**
 * 安装前的最后一道闸。
 *
 * ## 为什么不能只信 electron-updater
 *
 * electron-updater 自己会校验 sha512，但那层校验发生在下载器内部，
 * UpdateService 只能通过「有没有抛错」间接感知。这里再独立做一次，是因为
 * 本任务真正要保证的是一件更强的事：**quitAndInstall 只能在校验通过之后
 * 被调用**。把校验写成一个返回 ok:false 的纯函数，再由服务在 ok:false 时
 * 直接进 error 态，这条不变式就能被单测钉死（断言 quitAndInstall 的 spy
 * 调用次数为 0），而不是靠「相信下载器」。
 *
 * ## 版本单调
 *
 * candidate 必须**严格大于**当前版本。allowDowngrade 已经设成 false，但
 * 那是 updater 的配置项，改一行就没了；这里是第二道、也是能被断言的那道。
 */
import crypto from "node:crypto";
import fs from "node:fs";

import type { UpdateErrorCode } from "@pibuddy/contract";

import type { InstallCandidate, IntegrityResult } from "./update-types.js";

/** 统一的失败出口，保证 errorCode 一定是七类之一。 */
function fail(errorCode: UpdateErrorCode, reason: string): IntegrityResult {
  return { ok: false, errorCode, reason };
}

/**
 * 严格 semver 文法（semver.org 2.0.0 §9 / §10）。
 *
 * 两处曾经错过、且都不会以报错的形式暴露的细节：
 *
 *  1. **结尾锚 `$`**。没有它时 `1.2.3junk` 会被前缀匹配成 `1.2.3` 静默接受。
 *     畸形版本号恰恰是 feed 被投毒、或构建脚本把某段字符串拼错时最先出现的
 *     东西，而「接受了一个畸形版本」的下一步就是拿它去装。
 *  2. **数字段禁止前导零**。`01.0.0` 不是合法 semver；按 `Number()` 解析会
 *     让它与 `1.0.0` 判定相等，于是两份不同的产物拥有同一个"版本"。
 *
 * `v` 前缀刻意接受：git tag 是 `v1.2.3`，而 feed 里写的是 `1.2.3`。
 * build metadata（`+sha`）按 §10 解析后丢弃 —— 它不参与优先级比较。
 */
const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 纯数字标识符。`010` 被上面的文法挡在门外，这里只需判「全是数字」。 */
const NUMERIC_IDENTIFIER = /^\d+$/;

interface ParsedSemver {
  nums: [number, number, number];
  /** prerelease 的点分标识符；正式版为空数组 */
  pre: string[];
}

/** 解析 semver。不合法一律返回 null —— 绝不做"尽力而为"的部分解析。 */
function parseSemver(raw: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/**
 * 单个 prerelease 标识符的比较（semver.org §11 第 4 条）。
 *
 * **纯数字标识符按数值比**，不是按字符串比。这一行就是 `beta.10` 与
 * `beta.2` 的分界：按字符串比时 `"10" < "2"`，于是 beta.10 会被判成比
 * beta.2 旧，真实的新版本被当成降级拒掉，而日志里只有一句"不高于当前版本"。
 */
function compareIdentifier(a: string, b: string): number {
  const an = NUMERIC_IDENTIFIER.test(a);
  const bn = NUMERIC_IDENTIFIER.test(b);
  if (an && bn) return Number(a) - Number(b);
  // 数字标识符的优先级总是低于字母数字标识符
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** prerelease 序列的比较：逐项比，全等则字段多的更大（§11 第 4 条末段）。 */
function comparePrerelease(a: string[], b: string[]): number {
  // 有 prerelease 的版本小于同主体的正式版
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifier(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * semver 比较。返回 >0 表示 a 更新，NaN 表示至少一边不是合法 semver。
 *
 * 调用方**必须**先用 `Number.isNaN` 判 NaN：NaN 参与任何比较都是 false，
 * 直接写 `compareSemver(x, y) > 0` 会把"解析不了"静默当成"不更新"。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  return comparePrerelease(pa.pre, pb.pre);
}

/**
 * 该版本号是否带 prerelease 标记。
 *
 * stable 通道用它拒绝 beta 候选（见 UpdateService.matchesChannel）。
 * **不合法的版本号一律当作 prerelease 处理** —— 它绝不该进 stable 通道，
 * 而返回 false 会让畸形版本从这道闸门底下溜过去。
 */
export function isPrerelease(version: string): boolean {
  const parsed = parseSemver(version);
  return parsed === null || parsed.pre.length > 0;
}

/** 读文件算 sha512（base64，与 electron-builder 的 blockmap/latest.yml 口径一致）。 */
export function sha512OfFile(filePath: string): string {
  const hash = crypto.createHash("sha512");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("base64");
}

export interface VerifyOptions {
  /** 仅供单测替身：默认读真实文件 */
  readSha512?: (filePath: string) => string;
  /** 仅供单测替身：默认 fs.existsSync */
  exists?: (filePath: string) => boolean;
}

/**
 * 安装前校验。返回 ok:false 时**必须**中止安装。
 *
 * 三件事按代价从小到大排：先比版本（纯字符串），再看文件在不在，
 * 最后才去算几百 MB 的 sha512。
 */
export function verifyBeforeInstall(
  candidate: InstallCandidate,
  options: VerifyOptions = {}
): IntegrityResult {
  const { version, currentVersion } = candidate;

  if (!version) {
    return fail("metadata", "没有候选版本");
  }

  const cmp = compareSemver(version, currentVersion);
  if (Number.isNaN(cmp)) {
    return fail("metadata", `版本号无法解析：${version} / ${currentVersion}`);
  }
  if (cmp <= 0) {
    // 不是「新版本」就绝不安装。降级安装会让用户的数据被旧版本的迁移逻辑
    // 处理，这是本子系统里唯一会真的砸掉数据的路径。
    return fail("metadata", `候选版本 ${version} 不高于当前版本 ${currentVersion}`);
  }

  // 没给文件路径时只做版本校验（fake feed 与部分平台的 updater 不下发路径）
  if (!candidate.filePath) return { ok: true };

  const exists = options.exists ?? ((p: string) => fs.existsSync(p));
  if (!exists(candidate.filePath)) {
    return fail("disk", "下载好的安装包不见了");
  }

  if (!candidate.expectedSha512) {
    return fail("signature", "发布清单缺少 sha512，拒绝安装");
  }

  const readSha512 = options.readSha512 ?? sha512OfFile;
  let actual: string;
  try {
    actual = readSha512(candidate.filePath);
  } catch (err) {
    return fail("disk", (err as Error).message);
  }
  if (actual !== candidate.expectedSha512) {
    return fail("signature", "安装包 sha512 与发布清单不符");
  }
  return { ok: true };
}

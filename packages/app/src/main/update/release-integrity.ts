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

/** 把 semver 主体拆成 [major, minor, patch] + prerelease 串。 */
function parseSemver(raw: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
}

/**
 * semver 比较。返回 >0 表示 a 更新。
 *
 * prerelease 规则按 semver：有 prerelease 的版本小于同主体的正式版
 * （1.2.0-beta.1 < 1.2.0），两个 prerelease 之间按字典序 —— 这足够覆盖
 * PiBuddy 的 stable/beta 两条通道，不引入第三方 semver 依赖。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
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

  if (!candidate.expectedSha512) return { ok: true };

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

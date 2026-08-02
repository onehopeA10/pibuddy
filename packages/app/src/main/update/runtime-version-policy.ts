/**
 * bundled / external Pi 运行时的版本策略（UPD-007）。
 *
 * ## 内置 pi 的版本跟随应用版本，由 release 统一签名回归
 *
 * **绝不在用户机器上跑 `npm update` / `npm i -g`。** 那条路看起来很省事，
 * 实际后果是：
 *   1. 用户机器上的 pi 版本各不相同，任何一份报障日志都对不上一个可复现的
 *      组合，"在我这儿是好的"变成常态；
 *   2. 运行期装进来的代码没有经过发布签名，等于绕开了整条供应链验证；
 *   3. macOS 的 hardened runtime 与 Windows 的 per-user 安装目录都不保证
 *      可写，失败方式还各不相同。
 *
 * 内置 pi 的升级路径只有一条：随应用一起发新版，走同一次签名与回归。
 *
 * ## external Pi 只检测，不擅自改
 *
 * 用户显式指定了外部 pi 命令时，本模块只做**兼容范围判定并提示**，
 * 一行都不改用户的环境：不升级它、不降级它、也不在启动失败时静默切回内置
 * （静默切回等于替用户改了设置，而用户下次打开设置会发现自己没做过的改动）。
 */
import type { AppSettings } from "@pibuddy/contract";

/**
 * 内置运行时的兼容范围。
 *
 * 与 packages/app/package.json 里 `@earendil-works/pi-coding-agent` 的
 * 版本约束是同一件事的两面；改一处要一起改，因此这里写成常量而不是
 * 到处散落的字面量。
 */
export const PI_COMPAT_MIN = "0.83.0";
export const PI_COMPAT_MAX_EXCLUSIVE = "0.90.0";

/**
 * 代码库里**不允许出现**的运行期自升级调用。
 *
 * 这个数组本身不做任何事；它存在的意义是让「为什么不能这么写」有一处可读的
 * 答案，配套的结构断言在 packages/app/test/runtime-version-policy.spec.ts：
 *   rg -n "npm (update|i -g|install -g)" packages/app/src   # 必须无输出
 */
export const FORBIDDEN_RUNTIME_SELF_UPDATE = [
  "npm update",
  "npm i -g",
  "npm install -g",
] as const;

/**
 * 运行期自升级的显式否定。
 *
 * 调用它不会做任何事 —— 它是一处**可被断言的声明**：内置运行时的版本由
 * 发布流水线决定，运行期没有任何代码路径可以改变它。
 */
export function assertNoRuntimeNpmUpdate(): void {
  /* 故意为空。见文件头与 FORBIDDEN_RUNTIME_SELF_UPDATE。 */
}

function parseSemver(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export interface RuntimeCompatVerdict {
  compatible: boolean;
  /** 给用户看的一句话；compatible 时为空串 */
  message: string;
}

/**
 * 判定一个 external pi 的版本是否在兼容范围内。
 *
 * 判不出来（版本字符串认不得）时返回 compatible: true 并给一句提示 ——
 * 认不出来就拦，会把用户自己编译的 pi 一律挡在门外，而那是 external 模式
 * 存在的主要理由。
 */
export function checkExternalPiVersion(version: string | null): RuntimeCompatVerdict {
  if (!version) {
    return { compatible: true, message: "无法读取外部 pi 的版本，已按兼容处理。" };
  }
  const v = parseSemver(version);
  const min = parseSemver(PI_COMPAT_MIN)!;
  const max = parseSemver(PI_COMPAT_MAX_EXCLUSIVE)!;
  if (!v) {
    return { compatible: true, message: `认不出版本号「${version}」，已按兼容处理。` };
  }
  if (cmp(v, min) < 0) {
    return {
      compatible: false,
      message: `外部 pi 版本 ${version} 低于所需的 ${PI_COMPAT_MIN}。请自行升级，或在设置里切回内置运行时 —— PiBuddy 不会替你改动系统上的 pi。`,
    };
  }
  if (cmp(v, max) >= 0) {
    return {
      compatible: false,
      message: `外部 pi 版本 ${version} 高于本版 PiBuddy 验证过的范围（< ${PI_COMPAT_MAX_EXCLUSIVE}），可能出现协议不兼容。`,
    };
  }
  return { compatible: true, message: "" };
}

/** 当前设置下用的是不是内置运行时。 */
export function usesBundledRuntime(settings: Pick<AppSettings, "piRuntimeMode">): boolean {
  return (settings.piRuntimeMode ?? "bundled") === "bundled";
}

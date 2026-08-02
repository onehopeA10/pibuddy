/**
 * 自带 pi 运行时的清单读取与校验。
 *
 * 打包形态下应用**只**通过这份清单定位 pi：不再依赖 node_modules 布局、
 * 不再依赖 pnpm 的 symlink、也不再有「找不到就回退全局 pi」的隐式分支。
 * 清单缺失 / 损坏 / 协议版本不符一律抛出可读错误，让失败可见。
 *
 * 清单由构建期脚本 packages/app/scripts/prepare-pi-runtime.mjs 产出。
 */
import fs from "node:fs";
import path from "node:path";
import { PROTOCOL_VERSION } from "@pibuddy/contract";

/** 运行时根目录下的清单文件名（构建脚本与主进程共用同一个字面量）。 */
export const RUNTIME_MANIFEST_FILENAME = "runtime-manifest.json";

/** extraResources 投递到 process.resourcesPath 下的目录名。 */
export const RUNTIME_DIR_NAME = "pi-runtime";

export interface RuntimeManifest {
  /** npm 包名，固定为 @earendil-works/pi-coding-agent */
  name: string;
  /** 锁定的 pi 版本，如 0.83.0 */
  version: string;
  /** 相对运行时根目录的入口，固定为 dist/cli.js */
  entry: string;
  /** 构建时间（ISO 8601） */
  builtAt: string;
  /** 与 @pibuddy/contract 的 PROTOCOL_VERSION 对齐 */
  protocolVersion: number;
  /** 运行时具备的能力标记，供后续按能力降级 */
  capabilities: string[];
  /** entry 文件内容的 sha256，用于完整性校验 */
  sha256: string;
}

/**
 * 手写校验而不是用 zod：zod 是 @pibuddy/contract 的依赖、不是 @pibuddy/app 的
 * 直接依赖。在 main 里直接 import zod 既在 vitest 下解析不到，又会因为
 * externalizeDepsPlugin 的行为变化而影响打包产物是否内联 zod。清单是我们自己
 * 构建期产出的固定形状，几行字段检查足够，不值得为它引入依赖。
 */
function validateManifest(json: unknown): { ok: true; value: RuntimeManifest } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const o = (json ?? {}) as Record<string, unknown>;

  const str = (key: string, minLen = 1): void => {
    const v = o[key];
    if (typeof v !== "string" || v.length < minLen) {
      issues.push(`${key} 应为长度 >= ${minLen} 的字符串，实际 ${JSON.stringify(v)}`);
    }
  };
  str("name");
  str("version");
  str("entry");
  str("builtAt");
  str("sha256", 64);
  if (typeof o.sha256 === "string" && o.sha256.length !== 64) {
    issues.push(`sha256 长度应为 64，实际 ${o.sha256.length}`);
  }
  if (!Number.isInteger(o.protocolVersion)) {
    issues.push(`protocolVersion 应为整数，实际 ${JSON.stringify(o.protocolVersion)}`);
  }
  if (!Array.isArray(o.capabilities) || o.capabilities.some((c) => typeof c !== "string")) {
    issues.push("capabilities 应为字符串数组");
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: json as RuntimeManifest };
}

/** 运行时定位失败的统一错误码；日志与错误文案都带上它，便于检索。 */
export const PI_RUNTIME_RESOLVE_FAILED = "PI_RUNTIME_RESOLVE_FAILED";

export class PiRuntimeResolveError extends Error {
  readonly code = PI_RUNTIME_RESOLVE_FAILED;
  constructor(message: string) {
    super(`[${PI_RUNTIME_RESOLVE_FAILED}] ${message}`);
    this.name = "PiRuntimeResolveError";
  }
}

/** 读取并校验运行时清单；任何一步失败都抛 PiRuntimeResolveError。 */
export function readRuntimeManifest(runtimeRoot: string): RuntimeManifest {
  const manifestPath = path.join(runtimeRoot, RUNTIME_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new PiRuntimeResolveError(
      `无法读取内置运行时清单 ${manifestPath}：${(err as Error).message}`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PiRuntimeResolveError(
      `内置运行时清单 ${RUNTIME_MANIFEST_FILENAME} 不是合法 JSON：${(err as Error).message}`
    );
  }

  const parsed = validateManifest(json);
  if (!parsed.ok) {
    throw new PiRuntimeResolveError(
      `内置运行时清单 ${RUNTIME_MANIFEST_FILENAME} 字段不合法：${parsed.issues.join("; ")}`
    );
  }

  if (parsed.value.protocolVersion !== PROTOCOL_VERSION) {
    throw new PiRuntimeResolveError(
      `内置运行时协议版本不匹配：清单 ${parsed.value.protocolVersion}，应用要求 ${PROTOCOL_VERSION}`
    );
  }

  return parsed.value;
}

/**
 * 把清单里的 entry 解析成绝对路径，并确认：
 *  1. 落在运行时根目录内（拒绝 ../ 逃逸）
 *  2. 存在且是普通文件（不是目录、不是 symlink）
 */
export function resolveRuntimeEntry(runtimeRoot: string, manifest: RuntimeManifest): string {
  const root = path.resolve(runtimeRoot);
  const entry = path.resolve(root, manifest.entry);
  const rel = path.relative(root, entry);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PiRuntimeResolveError(
      `内置运行时入口 ${manifest.entry} 越出了运行时根目录 ${root}`
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entry);
  } catch (err) {
    throw new PiRuntimeResolveError(
      `内置运行时入口不存在 ${entry}：${(err as Error).message}`
    );
  }
  if (!stat.isFile()) {
    throw new PiRuntimeResolveError(`内置运行时入口不是普通文件：${entry}`);
  }

  return entry;
}

/**
 * 启动握手：比对清单声明的版本 / 协议版本与运行时实际观测到的值。
 * 不一致时抛出同时含两侧取值的错误，避免「版本对不上但静默继续」。
 */
export function assertRuntimeHandshake(
  expected: { runtimeVersion: string; protocolVersion: number },
  actual: { version: string; protocolVersion: number }
): void {
  if (expected.runtimeVersion !== actual.version) {
    throw new PiRuntimeResolveError(
      `pi 运行时版本握手失败：清单声明 ${expected.runtimeVersion}，实际运行时为 ${actual.version}`
    );
  }
  if (expected.protocolVersion !== actual.protocolVersion) {
    throw new PiRuntimeResolveError(
      `pi 运行时协议握手失败：清单声明 ${expected.protocolVersion}，实际为 ${actual.protocolVersion}`
    );
  }
  if (actual.protocolVersion !== PROTOCOL_VERSION) {
    throw new PiRuntimeResolveError(
      `pi 运行时协议版本 ${actual.protocolVersion} 与应用要求 ${PROTOCOL_VERSION} 不一致`
    );
  }
}

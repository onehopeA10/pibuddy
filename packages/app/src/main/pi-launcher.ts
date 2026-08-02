import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { PiSpawn } from "@pibuddy/pi-sdk";
import {
  PI_RUNTIME_RESOLVE_FAILED,
  PiRuntimeResolveError,
  RUNTIME_DIR_NAME,
  readRuntimeManifest,
  resolveRuntimeEntry,
  type RuntimeManifest,
} from "./pi-runtime-manifest.js";

export {
  PI_RUNTIME_RESOLVE_FAILED,
  PiRuntimeResolveError,
  assertRuntimeHandshake,
} from "./pi-runtime-manifest.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * 传给 pi 子进程的环境变量白名单。
 *
 * 子进程环境**不是**父进程环境的拷贝：只有这张表里的键会被继承，
 * 其余（NODE_OPTIONS、各类调试端口、LD_PRELOAD / DYLD_INSERT_LIBRARIES
 * 这类动态库注入变量）一律丢弃。ELECTRON_RUN_AS_NODE 刻意**不在**白名单里
 * ——它不能从父进程继承（父进程里的值可能是 "0"），而是在
 * buildChildEnv 里显式置为 "1"，让 Electron 以内置 Node 身份执行 pi 的 cli.js。
 */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/**
 * 白名单的模式补充。
 *
 * 只列固定键名会打断一条既有能力：pi 支持用 `ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` 等三十余个厂商变量登录（见 pi docs/providers.md），
 * 设置界面里也是这么写给用户的。逐个枚举既冗长又必然随 pi 升级过期，
 * 因此这里按模式放行。
 *
 * 这几条模式都匹配不到 NODE_OPTIONS / NODE_INSPECT_RESUME_ON_START /
 * LD_PRELOAD / DYLD_INSERT_LIBRARIES / ELECTRON_RUN_AS_NODE ——
 * 调试与注入类变量仍然一律被挡在外面。
 */
const ENV_ALLOWLIST_PATTERNS = [
  /^PI_[A-Z0-9_]+$/, // pi 自身配置：PI_OFFLINE / PI_CODING_AGENT_DIR / …
  /^[A-Z0-9]+(?:_[A-Z0-9]+)*_API_KEY$/, // 各模型厂商密钥
  /^[A-Z0-9]+(?:_[A-Z0-9]+)*_BASE_URL$/, // 自建/代理端点
  /^ANTHROPIC_AUTH_TOKEN$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^HF_TOKEN$/,
  /^CLOUDFLARE_(?:ACCOUNT|GATEWAY)_ID$/,
] as const;

/** 供 external 模式在 PATH 中查找命令时使用（Windows 需要补可执行后缀）。 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export interface LauncherLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface PiLauncherSettings {
  piRuntimeMode?: "bundled" | "external";
  piExternalCommand?: string;
}

export interface PiLauncherContext {
  /** 是否为打包形态；由调用方从 electron 的 app.isPackaged 传入 */
  packaged?: boolean;
  /** 打包形态下的资源根目录，默认取 process.resourcesPath */
  resourcesPath?: string;
  /** 过滤前的父进程环境，默认 process.env */
  env?: NodeJS.ProcessEnv;
  settings?: PiLauncherSettings;
  logger?: LauncherLogger;
  /** 仅供测试注入：覆盖开发形态下的 ESM 解析 */
  resolveDevEntry?: () => string;
}

export interface ResolvedPiRuntime {
  /** bundled = 应用自带；external = 用户在高级设置里显式指定 */
  source: "bundled" | "external";
  /** 实际交给 spawn 的可执行文件 */
  command: string;
  prefixArgs: string[];
  /** bundled 形态下自带的 pi 版本（开发形态未知时为 undefined） */
  bundledVersion?: string;
  /** bundled 形态下清单声明的协议版本 */
  protocolVersion?: number;
  /** bundled 形态下的运行时根目录 */
  runtimeRoot?: string;
}

/**
 * 构造 pi 子进程的环境变量。
 *
 * 显式构造一个全新对象，绝不做 `{ ...process.env }` 展开 —— 展开会把
 * 调试与注入类变量原样带进子进程。
 */
export function buildChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const key of Object.keys(base)) {
    if (key in env) continue;
    if (!ENV_ALLOWLIST_PATTERNS.some((re) => re.test(key))) continue;
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/** 从当前模块位置逐级向上找 node_modules 里的 pi 入口（ESM resolve 不可用时的兜底）。 */
function walkUpForPiEntry(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "node_modules", PI_PACKAGE, "dist", "cli.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new PiRuntimeResolveError(
        `从 ${start} 逐级向上未找到 node_modules/${PI_PACKAGE}/dist/cli.js`
      );
    }
    dir = parent;
  }
}

/**
 * 开发形态：用 ESM 解析拿到包的公开入口 dist/index.js，再取同级 dist/cli.js。
 *
 * 必须走 ESM 解析：该包 0.83.0 的 exports 只声明了 types 与 import 两个条件、
 * 没有 require，任何基于 CommonJS 解析的路径都会以
 * ERR_PACKAGE_PATH_NOT_EXPORTED 失败。
 */
function resolveDevEntryDefault(): string {
  const meta = import.meta as ImportMeta & { resolve?: (specifier: string) => string };
  if (typeof meta.resolve === "function") {
    const indexJs = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    return path.join(path.dirname(indexJs), "cli.js");
  }
  // vitest / vite-ssr 会把 import.meta 换成不带 resolve 的替身，此时退回目录遍历。
  return walkUpForPiEntry();
}

/**
 * 打包形态：只认 process.resourcesPath 下 pi-runtime/runtime-manifest.json。
 *
 * 这里没有、也不允许有「找不到就用系统上的全局 pi」的分支：内置运行时缺失
 * 属于产物损坏，必须抛错让用户看见，而不是悄悄跑一个版本未知的外部程序。
 */
function resolveBundledPackaged(resourcesPath: string): ResolvedPiRuntime {
  const runtimeRoot = path.join(resourcesPath, RUNTIME_DIR_NAME);
  const manifest: RuntimeManifest = readRuntimeManifest(runtimeRoot);
  const entry = resolveRuntimeEntry(runtimeRoot, manifest);
  return {
    source: "bundled",
    command: process.execPath,
    prefixArgs: [entry],
    bundledVersion: manifest.version,
    protocolVersion: manifest.protocolVersion,
    runtimeRoot,
  };
}

/** external 模式：显式路径优先，其次在 PATH 中查找，全程不依赖 shell 解析。 */
function resolveExternalCommand(raw: string, env: NodeJS.ProcessEnv): string {
  const wanted = raw.trim();
  if (!wanted) {
    throw new PiRuntimeResolveError("外部 pi 命令为空：请在高级设置中填写可执行文件路径");
  }

  const isWin = process.platform === "win32";
  const exts = isWin
    ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean)
    : [""];

  const probe = (base: string): string | null => {
    for (const c of [base, ...exts.map((e) => base + e)]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  };

  if (wanted.includes("/") || wanted.includes("\\")) {
    const hit = probe(path.resolve(wanted));
    if (hit) return hit;
    throw new PiRuntimeResolveError(
      `ENOENT: 外部 pi 命令不存在 "${wanted}"（已按显式路径查找）`
    );
  }

  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const hit = probe(path.join(dir, wanted));
    if (hit) return hit;
  }
  throw new PiRuntimeResolveError(
    `ENOENT: 在 PATH 中未找到外部 pi 命令 "${wanted}"`
  );
}

/** 定位 pi 运行时；失败一律抛 PiRuntimeResolveError，绝不静默降级。 */
export function resolvePiRuntime(ctx: PiLauncherContext = {}): ResolvedPiRuntime {
  const env = ctx.env ?? process.env;
  const mode = ctx.settings?.piRuntimeMode ?? "bundled";

  if (mode === "external") {
    const command = resolveExternalCommand(ctx.settings?.piExternalCommand ?? "", env);
    return { source: "external", command, prefixArgs: [] };
  }

  const packaged = ctx.packaged ?? false;
  if (packaged) {
    const resourcesPath =
      ctx.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath ?? "";
    if (!resourcesPath) {
      throw new PiRuntimeResolveError(
        "打包形态下 process.resourcesPath 为空，无法定位 pi-runtime/runtime-manifest.json"
      );
    }
    return resolveBundledPackaged(resourcesPath);
  }

  const entry = (ctx.resolveDevEntry ?? resolveDevEntryDefault)();
  if (!fs.existsSync(entry)) {
    throw new PiRuntimeResolveError(`开发形态定位到的 pi 入口不存在：${entry}`);
  }
  return { source: "bundled", command: process.execPath, prefixArgs: [entry] };
}

/**
 * 构造 pi 子进程的 spawn 描述。
 *
 * - 参数全部走 argv，shell 恒为 false（不给命令注入留缝）
 * - 环境变量走 ENV_ALLOWLIST 白名单，并显式补 ELECTRON_RUN_AS_NODE
 * - 定位失败抛错并记一条带 code 的 error 日志，不再吞异常回退
 */
export function buildPiSpawn(ctx: PiLauncherContext = {}): PiSpawn & { runtime: ResolvedPiRuntime } {
  let runtime: ResolvedPiRuntime;
  try {
    runtime = resolvePiRuntime(ctx);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.logger?.error("pi_runtime_resolve_failed", {
      code: PI_RUNTIME_RESOLVE_FAILED,
      mode: ctx.settings?.piRuntimeMode ?? "bundled",
      packaged: ctx.packaged ?? false,
      detail,
    });
    throw new Error(`[${PI_RUNTIME_RESOLVE_FAILED}] 无法定位 pi 运行时：${detail}`);
  }

  ctx.logger?.info("pi_runtime_resolved", {
    runtimeSource: runtime.source,
    selectedRuntime: runtime.source,
    bundledVersion: runtime.bundledVersion,
    protocolVersion: runtime.protocolVersion,
    command: runtime.command,
  });

  return {
    command: runtime.command,
    prefixArgs: runtime.prefixArgs,
    env: buildChildEnv(ctx.env ?? process.env),
    shell: false,
    runtime,
  };
}

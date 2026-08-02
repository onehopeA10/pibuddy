#!/usr/bin/env node
/**
 * 构建期配置注入（UPD-005）。
 *
 * ## 为什么镜像不能写在 electron-builder.yml 里
 *
 * 改前 `electronDownload.mirror` 是硬编码的 npmmirror。那意味着**正式发布
 * 产物的 Electron 二进制来自一个未经供应链审批的第三方镜像**，而且没有
 * 任何开关能在发布时把它关掉 —— 想关就得改文件，改了本地开发就慢回去。
 *
 * 现在的规则是单向的：默认走官方源，**只有**显式设置 PIBUDDY_USE_CN_MIRROR
 * 才注入镜像。CI 的 release job 不设该变量（并且 release.yml 里有一条回归
 * 守卫断言它不出现），因此正式包恒走官方源。
 *
 * ## 三种用法
 *
 *   node scripts/build-config.mjs                打印解析后的配置（JSON）
 *   node scripts/build-config.mjs --exec -- cmd  以注入后的环境变量执行 cmd
 *   import { resolveBuildEnv } from ...          供其它脚本复用
 */
import { spawn } from "node:child_process";
import process from "node:process";

/** 国内开发机加速用的 Electron 二进制镜像。**只在显式开启时生效**。 */
export const CN_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";

/**
 * 未配置 feed 时的占位地址。
 *
 * 不留空串：electron-builder 会把 publish.url 原样写进产物里的
 * app-update.yml，空串会让 electron-updater 在用户机器上拼出
 * `undefined/latest.yml` 这种请求，日志里只有一句 404。占位成一个明显
 * 不可用的本地地址，至少现场一眼能看出「这包没配 feed」。
 *
 * 真实地址必须由产品所有者提供（见 docs/product/RELEASE_SETUP.md）；
 * release.yml 在缺 PIBUDDY_UPDATE_FEED_URL 时 **失败关闭**，不会带着
 * 这个占位值发出去。
 */
export const UNCONFIGURED_FEED_URL = "https://feed.invalid/pibuddy-update-feed-not-configured";

function truthy(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/**
 * 解析出要注入给 electron-builder 的环境变量。
 *
 * 返回值只含**需要覆盖**的键；调用方 `{...process.env, ...resolveBuildEnv()}`。
 */
export function resolveBuildEnv(env = process.env) {
  const out = {};
  const useCnMirror = truthy(env.PIBUDDY_USE_CN_MIRROR);

  if (useCnMirror) {
    // @electron/get 原生认这个变量；不需要 electron-builder 配置项参与。
    out.ELECTRON_MIRROR = CN_ELECTRON_MIRROR;
    out.ELECTRON_BUILDER_BINARIES_MIRROR =
      "https://npmmirror.com/mirrors/electron-builder-binaries/";
  }

  out.PIBUDDY_UPDATE_FEED_URL = env.PIBUDDY_UPDATE_FEED_URL || UNCONFIGURED_FEED_URL;

  return out;
}

/** 供人读与供断言读的同一份视图。 */
export function describeBuildConfig(env = process.env) {
  const resolved = resolveBuildEnv(env);
  return {
    useCnMirror: truthy(env.PIBUDDY_USE_CN_MIRROR),
    electronMirror: resolved.ELECTRON_MIRROR ?? "(official)",
    updateFeedUrl: resolved.PIBUDDY_UPDATE_FEED_URL,
    updateFeedConfigured: resolved.PIBUDDY_UPDATE_FEED_URL !== UNCONFIGURED_FEED_URL,
    env: resolved,
  };
}

// ---------------------------------------------------------------- CLI

function isMain() {
  const entry = process.argv[1] ?? "";
  return entry.replace(/\\/g, "/").endsWith("scripts/build-config.mjs");
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const execAt = argv.indexOf("--exec");

  if (execAt === -1) {
    process.stdout.write(`${JSON.stringify(describeBuildConfig(), null, 2)}\n`);
    process.exit(0);
  }

  const rest = argv.slice(execAt + 1).filter((a) => a !== "--");
  if (rest.length === 0) {
    process.stderr.write("build-config: --exec 后面要跟一条命令\n");
    process.exit(2);
  }

  const injected = resolveBuildEnv();
  if (!injected.ELECTRON_MIRROR) {
    process.stderr.write("[build-config] Electron 二进制来源：官方源\n");
  } else {
    process.stderr.write(`[build-config] Electron 二进制来源：${injected.ELECTRON_MIRROR}\n`);
  }
  if (injected.PIBUDDY_UPDATE_FEED_URL === UNCONFIGURED_FEED_URL) {
    process.stderr.write(
      "[build-config] 警告：PIBUDDY_UPDATE_FEED_URL 未配置，产物内的更新源是占位地址，不可用于正式发布\n"
    );
  }

  const child = spawn(rest[0], rest.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...injected },
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    process.stderr.write(`build-config: 启动失败 ${String(err)}\n`);
    process.exit(1);
  });
}

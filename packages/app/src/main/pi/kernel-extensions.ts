/**
 * 内核级 pi extension 的定位与启动参数（随应用出厂，不物化进用户目录）。
 *
 * ## 与 capability-assets 的分工
 *
 * capability-assets 装的是**能力包**携带的资源：按启用集合物化到 `~/.pi/agent/`，
 * 有归属账本、可装卸。这里装的是**内核自己**的行为修正（比如按模型追加工具
 * 使用提示），不属于任何可关闭的能力包，也不该在用户目录留文件 —— 于是走
 * pi 的 `--extension <绝对路径>` 参数，直接指向随包投递的文件：
 *
 *   - 打包形态：`process.resourcesPath/kernel-extensions/`（electron-builder.yml
 *     的 extraResources，与 pi-runtime / capability-assets 同一投递面）
 *   - 开发形态：`packages/app/resources/kernel-extensions/`（app.getAppPath()）
 *
 * ## 为什么不走 buildPiSpawn 的 args
 *
 * `PiSpawn.args` 被 CT-11 钉死只放 trust 的一次性覆盖（trust-decision.test 断言
 * 它恒等于 trustArgs）。启动参数的通用追加口是 `PiClientOptions.extraArgs`，
 * 前台（pi-ipc）与后台池（pool-runtime-host）两处 `new PiRpcClient` 都从这里拿。
 *
 * ## 文件缺失 = 不传参 + 一条 warn
 *
 * 提示词修正是锦上添花：产物里少了这个文件，对话照常跑，只是 grok 又回到裸
 * 工具面。传一个不存在的路径给 pi 反而会让它启动时报扩展加载失败，那才是
 * 用户看得见的坏。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export const KERNEL_EXTENSIONS_DIR_NAME = "kernel-extensions";

/** 出厂的内核扩展文件名清单。新增一个扩展 = 在这里加一行 + 放文件进 resources/。 */
export const KERNEL_EXTENSION_FILES = ["model-tool-hints.ts"] as const;

interface KernelExtensionLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** kernel-extensions 根目录（dev / 打包两种形态）。 */
export function kernelExtensionsRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, KERNEL_EXTENSIONS_DIR_NAME)
    : path.join(app.getAppPath(), "resources", KERNEL_EXTENSIONS_DIR_NAME);
}

/**
 * 纯函数：给定根目录与文件清单，算出要追加给 pi 的 `--extension` 参数。
 * 缺失的文件跳过并记 warn；全缺时返回空数组。
 */
export function buildKernelExtensionArgs(
  root: string,
  files: readonly string[],
  logger?: KernelExtensionLogger
): string[] {
  const args: string[] = [];
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
      logger?.warn("pi_kernel_extension_missing", { path: full });
      continue;
    }
    args.push("--extension", full);
  }
  return args;
}

/** 供两处 `new PiRpcClient` 直接放进 `extraArgs`。 */
export function kernelExtensionArgs(logger?: KernelExtensionLogger): string[] {
  return buildKernelExtensionArgs(kernelExtensionsRoot(), KERNEL_EXTENSION_FILES, logger);
}

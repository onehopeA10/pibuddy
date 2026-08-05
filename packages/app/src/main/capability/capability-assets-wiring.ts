/**
 * 能力包 pi 资源装卸的接线层（REQ-0001 R4.2）。
 *
 * 物化器本体（capability-assets.ts）是纯逻辑：不 import electron，路径全部
 * 入参。本文件是那层薄接线——只负责在真实进程里回答三个问题：
 *
 *   1. 资源根在哪：打包后是 `process.resourcesPath/capability-assets`
 *      （electron-builder.yml 的 extraResources，与 pi-runtime 同一投递面）；
 *      dev 下是 `packages/app/resources/capability-assets`（app.getAppPath()）。
 *   2. pi 用户资源目录在哪：`~/.pi/agent`（与 pi-resources-ipc.ts 读
 *      settings.json 用的是同一根）。
 *   3. 本次装配启用了哪些包：capability-catalog 的 currentResolution()。
 *
 * 启停在本应用里都要重启才生效（通道注册同理，见 capability-catalog 的
 * restartRequired），因此装卸只需要在启动装配之后跑一次：启用的物化、
 * 停用的收回，两个方向都是同一次对账。失败记日志、不拦启动——装卸是
 * 启动路径上的旁路。
 */
import { app } from "electron";
import os from "node:os";
import path from "node:path";

import { log } from "../log.js";
import {
  CAPABILITY_ASSETS_DIR_NAME,
  syncCapabilityAssets,
} from "./capability-assets.js";
import {
  applyCapabilityResourceDecisions,
  capabilityRegistry,
  currentResolution,
} from "./capability-catalog.js";

/** capability-assets 根目录（dev / 打包两种形态）。 */
export function capabilityAssetsRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, CAPABILITY_ASSETS_DIR_NAME)
    : path.join(app.getAppPath(), "resources", CAPABILITY_ASSETS_DIR_NAME);
}

/**
 * 启动时的一次装卸对账。必须在 registerIpc()（内部完成能力装配）之后调用，
 * 否则 currentResolution() 还是 null——那种情况下什么都不做并记一条日志，
 * 而不是把「全部视为启用」这种测试用默认值物化到用户机器上。
 */
export async function syncCapabilityAssetsOnStartup(): Promise<void> {
  const resolution = currentResolution();
  if (resolution === null) {
    log().warn("capability_assets_skip", { reason: "尚未装配，没有可信的启用集合" });
    return;
  }
  const enabled = new Set(resolution.enabled);
  try {
    const report = await syncCapabilityAssets({
      packs: capabilityRegistry
        .list()
        .map((r) => ({ manifest: r.manifest, enabled: enabled.has(r.manifest.id) })),
      assetsRoot: capabilityAssetsRoot(),
      piAgentDir: path.join(os.homedir(), ".pi", "agent"),
    });
    // 决策报告进能力快照（R4.5）：capabilities:describe 之后能逐条回答
    // 「这个技能为什么没进 pi 上下文」。写在日志之前——日志失败也不该
    // 让快照丢掉这份事实。
    applyCapabilityResourceDecisions(report.decisions);
    // 无条件记一行：「没跑」与「跑了但无事可做」在日志上必须可分。
    log().info("capability_assets_sync", {
      written: report.written,
      removed: report.removed,
      keptEdited: report.keptEdited,
      conflicts: report.conflicts,
      errors: report.errors,
      // 未物化的那些才是要能查的：全物化时这一行是空数组。
      blocked: report.decisions
        .filter((d) => d.reason !== "materialized")
        .map((d) => `${d.capabilityId}/${d.kind}/${d.path}: ${d.reason}`),
    });
  } catch (err) {
    log().warn("capability_assets_sync_failed", { error: String(err) });
  }
}

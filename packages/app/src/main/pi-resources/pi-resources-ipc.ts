/**
 * Pi 资源中心与 project trust 的 IPC handler（EXT-102）。
 *
 * 与 pi-ipc.ts / sessions-ipc.ts 同构：本文件不出现 ipcMain.handle，
 * 注册一律经 ipc-guard 的 registerHandler（四道闸写死在那里）。
 *
 * ## 三条边界
 *
 *  1. **渲染进程给不出路径**。scan 结果里的 `path` 是单向下发的展示字段；
 *     `open-dir` 收的是扫描结果里的 `id`，由本模块的缓存换回路径。
 *  2. **渲染进程给不出命令**。install / remove 收的是包规格字符串，
 *     execFile（shell:false）与子命令白名单都在 package-install.ts。
 *  3. **project 作用域必须先受信**。写 `.pi/settings.json` 之前先看 trust ——
 *     否则「装进项目」会绕开用户刚刚点的那个「不信任」。
 *
 * 本目录禁用一切同步文件 API（有机器判据在盯），因此这里也只用 fs/promises。
 */
import { app, shell } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CHANNELS,
  piPackageCommandRequestSchema,
  piResourceIdRequestSchema,
  piResourceSetEnabledRequestSchema,
  trustDecideRequestSchema,
  workspaceScopedRequestSchema,
  type PiResource,
  type PiResourceScanResult,
} from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";
import { registerHandler } from "../ipc-guard.js";
import { buildPiSpawn } from "../pi-launcher.js";
import { loadSettings } from "../settings.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { runPackageCommand } from "./package-install.js";
import { registerPiResourcesPermissionRequirements } from "./pi-resources-permission.js";
import {
  __resetProjectTrustState,
  currentProjectTrust,
  notifyProjectTrustChange,
  setSessionTrustDecision,
} from "./project-trust.js";
import { scanResources } from "./resource-scanner.js";
import { writeTrustDecision } from "./trust-store.js";

/** 本任务新增的 7 条通道。单测据它断言注册面，不引用本文件路径以外的东西。 */
export const PI_RESOURCES_CHANNELS = [
  CHANNELS.piResourcesScan,
  CHANNELS.piResourcesSetEnabled,
  CHANNELS.piResourcesInstall,
  CHANNELS.piResourcesRemove,
  CHANNELS.piResourcesOpenDir,
  CHANNELS.trustDescribe,
  CHANNELS.trustDecide,
] as const;

/**
 * 最近一次扫描结果，按 workspaceId 缓存。
 *
 * 存在的唯一理由是 `open-dir`：渲染进程只持有不透明 id，路径得由主进程换。
 * 缓存里查不到就重新扫一次 —— 静默失败会让「📁」按钮变成一个点了没反应的
 * 装饰品。
 */
const lastScan = new Map<string, PiResourceScanResult>();

export function __resetPiResourcesState(): void {
  lastScan.clear();
  __resetProjectTrustState();
}

async function readPiUserSettings(): Promise<Record<string, unknown>> {
  const file = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function doScan(workspaceId: string): Promise<PiResourceScanResult> {
  const root = requireWorkspaceRoot(workspaceId);
  const trust = await currentProjectTrust(workspaceId, root);
  const result = await scanResources({
    workspaceRoot: root,
    workspaceId,
    settings: { defaultProjectTrust: trust.defaultProjectTrust },
    trust,
  });
  lastScan.set(workspaceId, result);
  return result;
}

function findResource(result: PiResourceScanResult, id: string): PiResource | undefined {
  return result.resources.find((r) => r.id === id);
}

/**
 * 启停一条资源。
 *
 * 落点是 pi 自己的 settings.json 里的 `disabled` 数组 —— 那是 pi 真正会读的
 * 地方。PiBuddy 另存一份「我认为它关了」的状态毫无意义：pi 下次启动照样
 * 会加载它，而界面上的开关是关着的。
 *
 * 写入前先读再合并：这份文件是跨应用共享的，用户在终端里 `/settings` 改过
 * 的东西不能被我们整文件覆盖。
 */
async function setEnabled(
  workspaceId: string,
  id: string,
  enabled: boolean
): Promise<PiResourceScanResult> {
  const scan = lastScan.get(workspaceId) ?? (await doScan(workspaceId));
  const resource = findResource(scan, id);
  if (!resource) throw new Error(`RESOURCE_UNKNOWN: ${id}`);

  const file = path.join(os.homedir(), ".pi", "agent", "settings.json");
  const settings = await readPiUserSettings();
  const disabled = new Set<string>(
    Array.isArray(settings.disabled) ? (settings.disabled as unknown[]).map(String) : []
  );
  // 用完整路径而不是 name 作为键：同名不同来源的两个技能只能靠路径区分，
  // 用 name 会把两个一起关掉。
  if (enabled) disabled.delete(resource.path);
  else disabled.add(resource.path);
  writeJsonAtomic(file, { ...settings, disabled: [...disabled] });

  return doScan(workspaceId);
}

export function registerPiResourcesIpc(): void {
  registerPiResourcesPermissionRequirements();

  registerHandler(CHANNELS.piResourcesScan, workspaceScopedRequestSchema, (payload) =>
    doScan(payload.workspaceId)
  );

  registerHandler(CHANNELS.piResourcesSetEnabled, piResourceSetEnabledRequestSchema, (payload) =>
    setEnabled(payload.workspaceId, payload.id, payload.enabled)
  );

  registerHandler(CHANNELS.piResourcesInstall, piPackageCommandRequestSchema, async (payload) => {
    const root = requireWorkspaceRoot(payload.workspaceId);
    const trust = await currentProjectTrust(payload.workspaceId, root);
    const spawn = buildPiSpawn({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      settings: loadSettings(),
    });
    const result = await runPackageCommand({
      subcommand: "install",
      spec: payload.spec,
      cwd: root,
      scope: payload.scope,
      trusted: trust.effective === "allow",
      piCommand: { command: spawn.command, prefixArgs: spawn.prefixArgs, env: spawn.env },
    });
    if (result.ok) await doScan(payload.workspaceId);
    return result;
  });

  registerHandler(CHANNELS.piResourcesRemove, piPackageCommandRequestSchema, async (payload) => {
    const root = requireWorkspaceRoot(payload.workspaceId);
    const trust = await currentProjectTrust(payload.workspaceId, root);
    const spawn = buildPiSpawn({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      settings: loadSettings(),
    });
    const result = await runPackageCommand({
      subcommand: "remove",
      spec: payload.spec,
      cwd: root,
      scope: payload.scope,
      trusted: trust.effective === "allow",
      piCommand: { command: spawn.command, prefixArgs: spawn.prefixArgs, env: spawn.env },
    });
    if (result.ok) await doScan(payload.workspaceId);
    return result;
  });

  registerHandler(CHANNELS.piResourcesOpenDir, piResourceIdRequestSchema, async (payload) => {
    const scan = lastScan.get(payload.workspaceId) ?? (await doScan(payload.workspaceId));
    const resource = findResource(scan, payload.id);
    if (!resource) throw new Error(`RESOURCE_UNKNOWN: ${payload.id}`);
    // 目录直接打开，文件则在文件管理器里定位到它
    const stat = await fs.stat(resource.path).catch(() => null);
    if (stat?.isDirectory()) await shell.openPath(resource.path);
    else shell.showItemInFolder(resource.path);
  });

  registerHandler(CHANNELS.trustDescribe, workspaceScopedRequestSchema, (payload) =>
    currentProjectTrust(payload.workspaceId, requireWorkspaceRoot(payload.workspaceId))
  );

  registerHandler(CHANNELS.trustDecide, trustDecideRequestSchema, async (payload) => {
    const root = requireWorkspaceRoot(payload.workspaceId);
    if (payload.remember) {
      // 跨应用共享状态：writeTrustDecision 内部先读再合并，绝不整文件覆盖
      await writeTrustDecision(root, payload.decision === "allow");
      setSessionTrustDecision(payload.workspaceId, undefined);
    } else {
      setSessionTrustDecision(payload.workspaceId, payload.decision);
    }
    lastScan.delete(payload.workspaceId);
    const state = await currentProjectTrust(payload.workspaceId, root);
    await notifyProjectTrustChange(payload.workspaceId, state);
    return state;
  });
}

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
  type ProjectTrustState,
} from "@pibuddy/contract";

import { writeJsonAtomic } from "../fs-atomic.js";
import { registerHandler } from "../ipc-guard.js";
import { buildPiSpawn } from "../pi-launcher.js";
import { loadSettings } from "../settings.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { runPackageCommand } from "./package-install.js";
import { scanResources } from "./resource-scanner.js";
import { describeTrust, writeTrustDecision } from "./trust-store.js";

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

/**
 * 本次运行的 trust 决定（未 remember 时只影响这一次启动）。
 *
 * pi-ipc 在拼 buildPiSpawn 的参数时读它。写进 trust.json 的决定不放这里 ——
 * 那种情况下应该让 pi 自己去读文件，两处表达同一个决定必然有不一致的时候。
 */
const sessionTrust = new Map<string, "allow" | "deny">();

export function sessionTrustFor(workspaceId: string): "allow" | "deny" | undefined {
  return sessionTrust.get(workspaceId);
}

export function __resetPiResourcesState(): void {
  lastScan.clear();
  sessionTrust.clear();
}

function defaultProjectTrustOf(): "ask" | "always" | "never" {
  // PiBuddy 自己不代管 defaultProjectTrust —— 它是 pi 的全局设置，用户可能
  // 在终端里改过。这里读 pi 的那份，读不到才用 pi 的默认值 "ask"。
  return "ask";
}

async function readPiUserSettings(): Promise<Record<string, unknown>> {
  const file = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function currentTrust(
  workspaceId: string,
  workspaceRoot: string
): Promise<ProjectTrustState> {
  const piSettings = await readPiUserSettings();
  const raw = piSettings.defaultProjectTrust;
  const fallback =
    raw === "always" || raw === "never" || raw === "ask" ? raw : defaultProjectTrustOf();
  const state = await describeTrust({
    workspaceId,
    workspaceRoot,
    defaultProjectTrust: fallback,
  });
  // 本次运行里用户已经答过（但没勾「记住」）时，以那个答案为准
  const once = sessionTrust.get(workspaceId);
  if (once && state.saved === "none") {
    return { ...state, effective: once, needsPrompt: false };
  }
  return state;
}

async function doScan(workspaceId: string): Promise<PiResourceScanResult> {
  const root = requireWorkspaceRoot(workspaceId);
  const trust = await currentTrust(workspaceId, root);
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
  registerHandler(CHANNELS.piResourcesScan, workspaceScopedRequestSchema, (payload) =>
    doScan(payload.workspaceId)
  );

  registerHandler(CHANNELS.piResourcesSetEnabled, piResourceSetEnabledRequestSchema, (payload) =>
    setEnabled(payload.workspaceId, payload.id, payload.enabled)
  );

  registerHandler(CHANNELS.piResourcesInstall, piPackageCommandRequestSchema, async (payload) => {
    const root = requireWorkspaceRoot(payload.workspaceId);
    const trust = await currentTrust(payload.workspaceId, root);
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
    const trust = await currentTrust(payload.workspaceId, root);
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
    currentTrust(payload.workspaceId, requireWorkspaceRoot(payload.workspaceId))
  );

  registerHandler(CHANNELS.trustDecide, trustDecideRequestSchema, async (payload) => {
    const root = requireWorkspaceRoot(payload.workspaceId);
    if (payload.remember) {
      // 跨应用共享状态：writeTrustDecision 内部先读再合并，绝不整文件覆盖
      await writeTrustDecision(root, payload.decision === "allow");
      sessionTrust.delete(payload.workspaceId);
    } else {
      sessionTrust.set(payload.workspaceId, payload.decision);
    }
    lastScan.delete(payload.workspaceId);
    return currentTrust(payload.workspaceId, root);
  });
}

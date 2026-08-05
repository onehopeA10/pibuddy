/**
 * 智能家居基座能力包的 IPC handler 与运行期装配（home.assistant，恰 5 条通道）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * ## 五条通道就是全部的主进程面
 *
 * 配置读写 + 测试连接 + 实体只读快照 + 运行状态。设备**控制**不在 IPC 面上
 * ——控制是 pi 回路内工具（home.assistant.call_service），经本文件装配的
 * tool bridge 进来：验一次性 token → 按 manifest.tools[].permissions 逐条
 * evaluate → 才到 HomeAssistantService（其中出站又要过 safeLocalFetch 的
 * 三道关）。渲染进程与 pi 子进程都表达不出「打到别的端点」。
 *
 * ## activate / deactivate
 *
 * registerHomeIpc（activate）：注册 5 条通道 + 起 tool bridge（named pipe
 * 入站监听）+ 把 bridge 的 env 贡献挂到 pi-launcher（此后 spawn 的 pi 子进程
 * 才带 PIBUDDY_HOME_BRIDGE / PIBUDDY_HOME_BRIDGE_TOKEN——包未启用时 activate
 * 一次都不调用，env 自然不注入）。disposeHomeResources（deactivate /
 * runtime.teardown:["listener"]）：摘 env 贡献、停 bridge、拆全部 WS 会话与
 * 缓存定时器、关 sqlite 句柄。配置与快照数据留在磁盘不动（D4 规则 5）。
 */
import fs from "node:fs";

import {
  CHANNELS,
  HOME_ASSISTANT_CAPABILITY_ID,
  HOME_BRIDGE_TOOLS,
  haConfigGetRequestSchema,
  haConfigSetRequestSchema,
  haEntitiesRequestSchema,
  haStatusRequestSchema,
  haTestConnectionRequestSchema,
  type CapabilityGrant,
  type HaConfigState,
  type HaEntitiesResult,
  type HaStatusResult,
  type HaTestConnectionResult,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { createLogger, type Logger } from "../logger.js";
import { NETWORK_LOCAL_PERMISSION } from "../net/outbound-local-guard.js";
import { describePermissions, permissionEngine } from "../permission/permission-store.js";
import { setPiChildEnvContribution } from "../pi-launcher.js";
import { lookupWorkspace, workspaceIdFor } from "../workspace-registry.js";
import { homeAssistantCapability } from "../capability/manifests/home-assistant.manifest.js";
import {
  describeHaToken,
  loadHaConfig,
  loadHaToken,
  saveHaConfig,
  saveHaToken,
  type HaEndpointConfig,
} from "./ha-config.js";
import { closeHomeStore, homeStore } from "./ha-store.js";
import { HomeAssistantService } from "./home-service.js";
import { HomeToolBridge } from "./tool-bridge.js";

/** 本能力注册的全部通道。导出成常量供对账「恰 5 条」。 */
export const HOME_CHANNELS = [
  CHANNELS.haConfigGet,
  CHANNELS.haConfigSet,
  CHANNELS.haTestConnection,
  CHANNELS.haEntities,
  CHANNELS.haStatus,
] as const;

let logger: Logger | null = null;
function log(): Logger {
  if (!logger) logger = createLogger("home");
  return logger;
}

// ---------------------------------------------------------------- 服务装配

let serviceInstance: HomeAssistantService | null = null;

function service(): HomeAssistantService {
  if (!serviceInstance) {
    serviceInstance = new HomeAssistantService({
      config: (workspaceId) => {
        const config = loadHaConfig(workspaceId);
        return config === null ? null : { host: config.host, port: config.port };
      },
      token: (workspaceId) => loadHaToken(workspaceId),
      // 授权依赖 = 真实 PermissionEngine（上界 + grant 判定），workspace 上下文
      // 在这里闭包进来。once 档授权在 evaluate 命中时用后即焚——正确语义。
      authDeps: (workspaceId) => ({
        isDeclared: (capabilityId, permission) =>
          permissionEngine().isDeclared(capabilityId, permission),
        evaluate: (query) => permissionEngine().evaluate({ ...query, workspaceId }),
      }),
      loadSnapshot: (workspaceId) => homeStore().loadRegistry(workspaceId),
      saveSnapshot: (workspaceId, rows) => homeStore().saveRegistry(workspaceId, rows),
    });
  }
  return serviceInstance;
}

/**
 * 【追加（home.automation）】上层家居包取同一台域服务的入口：共享实体缓存 /
 * WS 会话 / 出站纪律（executeTool 内部每次都重过 authorizeLocalEndpoint）。
 * automation 依赖本基座（manifest.dependencies），基座未启用时它根本不会被
 * activate，因此这里不需要「基座还没装配」的分支。
 */
export function homeAssistantService(): HomeAssistantService {
  return service();
}

// ---------------------------------------------------------------- tool bridge

let bridge: HomeToolBridge | null = null;

/**
 * bridge 请求里的 cwd（pi 子进程的工作目录）→ workspaceId。
 *
 * 只认**已注册**的工作区：一个不在注册表里的目录换不到任何配置与授权。
 * realpath 用系统实现做规范化，与 workspace-registry 的注册口径一致。
 */
function workspaceIdOfCwd(cwd: string | null): string {
  if (cwd === null) throw new Error("HA_BRIDGE_NO_CWD: bridge 请求缺少工作目录");
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    throw new Error("HA_BRIDGE_BAD_CWD: 工作目录不存在");
  }
  const workspaceId = workspaceIdFor(real);
  if (lookupWorkspace(workspaceId) === null) {
    throw new Error("HA_BRIDGE_UNKNOWN_WORKSPACE: 工作目录不是已注册的工作区");
  }
  return workspaceId;
}

/**
 * bridge 的执行面：manifest.tools[].permissions 逐条 evaluate（network.local
 * 绑定当前配置的 host:port 资源），全过才到 HomeAssistantService——那里面的
 * 出站还会再过一遍 authorizeLocalEndpoint 三道关（纵深，不是冗余：工具权限
 * 表达的是「这个工具允许做这类事」，三道关表达的是「这次出站确实落在授权
 * 端点与私网段上」）。
 */
async function executeBridgeTool(tool: string, args: unknown, cwd: string | null): Promise<unknown> {
  if (!(HOME_BRIDGE_TOOLS as readonly string[]).includes(tool)) {
    throw new Error(`HA_UNKNOWN_TOOL: ${tool}`);
  }
  const workspaceId = workspaceIdOfCwd(cwd);
  const declaration = homeAssistantCapability.tools.find((t) => t.name === tool);
  const config = loadHaConfig(workspaceId);
  for (const permission of declaration?.permissions ?? []) {
    const resource =
      permission === NETWORK_LOCAL_PERMISSION && config !== null
        ? `${config.host}:${config.port}`
        : null;
    const decision = permissionEngine().evaluate({
      capabilityId: HOME_ASSISTANT_CAPABILITY_ID,
      permission,
      resource,
      workspaceId,
    });
    if (!decision.allowed) {
      throw new Error(
        `HA_PERMISSION_DENIED: ${permission}${decision.reason ? `（${decision.reason}）` : ""}`
      );
    }
  }
  return service().executeTool(tool, args, workspaceId);
}

// ---------------------------------------------------------------- 状态视图

/**
 * 授权态展示。刻意**不走 engine.evaluate**：evaluate 会消费 allow-once 授权
 * （用后即焚），状态展示不该吃掉用户仅有的一次放行。这里只看 workspace /
 * session 两档 grant 的逐字命中（once 档本来就只该被真实出站消费）。
 */
function isEndpointAuthorized(workspaceId: string, config: HaEndpointConfig | null): boolean {
  if (config === null) return false;
  const resource = `${config.host}:${config.port}`;
  const covers = (g: CapabilityGrant): boolean =>
    g.capabilityId === HOME_ASSISTANT_CAPABILITY_ID &&
    g.permission === NETWORK_LOCAL_PERMISSION &&
    g.resource === resource;
  const state = describePermissions(workspaceId);
  return state.workspaceGrants.some(covers) || state.sessionGrants.some(covers);
}

function configState(workspaceId: string): HaConfigState {
  const config = loadHaConfig(workspaceId);
  return {
    workspaceId,
    configured: config !== null,
    host: config?.host ?? null,
    port: config?.port ?? null,
    token: describeHaToken(workspaceId),
    authorized: isEndpointAuthorized(workspaceId, config),
  };
}

// ---------------------------------------------------------------- 装配 / 拆卸

/** 禁用 / 退出时的拆卸（runtime.teardown:["listener"]）。数据留在磁盘不动。 */
export function disposeHomeResources(): void {
  setPiChildEnvContribution(null);
  if (bridge) {
    void bridge.stop();
    bridge = null;
  }
  if (serviceInstance) {
    serviceInstance.dispose();
    serviceInstance = null;
  }
  closeHomeStore();
}

export function registerHomeIpc(): void {
  // tool bridge：入站 named pipe 监听 + pi 子进程 env 贡献。只在本能力
  // activate 时发生——未启用的构建里这两样都不存在。
  bridge = new HomeToolBridge(executeBridgeTool);
  const active = bridge;
  active
    .start()
    .then(() => {
      setPiChildEnvContribution(() => (bridge === active ? active.env() : {}));
      log().info("home_bridge_started", {});
    })
    .catch((err: unknown) => {
      log().warn("home_bridge_start_failed", {
        detail: err instanceof Error ? err.message : String(err),
      });
    });

  registerHandler(
    CHANNELS.haConfigGet,
    haConfigGetRequestSchema,
    async (payload): Promise<HaConfigState> => configState(payload.workspaceId)
  );

  registerHandler(
    CHANNELS.haConfigSet,
    haConfigSetRequestSchema,
    async (payload): Promise<HaConfigState> => {
      saveHaConfig(payload.workspaceId, payload.host, payload.port);
      // token 只进不出：空串 = 不改动既有 token（密钥输入框永远从空开始）。
      if (payload.token !== "") saveHaToken(payload.workspaceId, payload.token);
      return configState(payload.workspaceId);
    }
  );

  registerHandler(
    CHANNELS.haTestConnection,
    haTestConnectionRequestSchema,
    async (payload): Promise<HaTestConnectionResult> =>
      service().testConnection(payload.workspaceId)
  );

  registerHandler(
    CHANNELS.haEntities,
    haEntitiesRequestSchema,
    async (payload): Promise<HaEntitiesResult> => {
      if (loadHaConfig(payload.workspaceId) === null) {
        return { entities: [], total: 0, stale: true, source: "snapshot" };
      }
      return service().entities(payload.workspaceId, payload.limit);
    }
  );

  registerHandler(
    CHANNELS.haStatus,
    haStatusRequestSchema,
    async (payload): Promise<HaStatusResult> => {
      const config = loadHaConfig(payload.workspaceId);
      const cacheStatus = service().status(payload.workspaceId);
      return {
        configured: config !== null,
        authorized: isEndpointAuthorized(payload.workspaceId, config),
        tokenConfigured: describeHaToken(payload.workspaceId).configured,
        wsStatus: cacheStatus.wsStatus,
        consumers: cacheStatus.consumers,
        entityCount: cacheStatus.entityCount,
        lastEventAt: cacheStatus.lastEventAt,
      };
    }
  );
}

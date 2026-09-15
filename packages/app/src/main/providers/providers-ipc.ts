/**
 * Provider 中心与用量页的 IPC handler（PROV-101）。
 *
 * 本文件不出现 `ipcMain.handle`：注册一律经 ipc-guard 的 registerHandler
 * （四道闸写死在那里）。密钥**只进不出** —— 这里没有任何一条能把 auth.json
 * 里的 key 送回渲染进程的路径，`providers:list` 回来的只有
 * `{configured, last4}`，与 settings:describe-secret 同一口径。
 */
import {
  CHANNELS,
  providerCustomRequestSchema,
  providerIdRequestSchema,
  providerModelInputRequestSchema,
  providerSaveKeyRequestSchema,
  setScopeDefaultRequestSchema,
  usageExportRequestSchema,
  usageQuerySchema,
  usageRecordRequestSchema,
  voidRequestSchema,
  type AppSettings,
  type InvokeChannel,
  type ProviderListResult,
  type ProviderModel,
  type ProviderView,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { loadSettings, publicSettings, saveSettings } from "../settings.js";
import { localDay, usageStore } from "../usage/usage-store.js";
import { describeWorkspace, requireWorkspaceRoot } from "../workspace-registry.js";
import {
  authKindOf,
  canEnforcePermissions,
  last4Of,
  readAuthFile,
  writeCredential,
} from "./auth-store.js";
import { testProvider } from "./connectivity.js";
import {
  CUSTOM_PROVIDER_PLACEHOLDER_KEY,
  discoverModels,
  listCustomProviders,
  removeCustomProvider,
  setCustomModelInput,
  upsertCustomProvider,
} from "./models-store.js";
import { PROVIDER_CATALOG, catalogEntry } from "./provider-catalog.js";

/**
 * 本域注册的全部通道。
 *
 * 导出成常量供单测断言注册面：漏挂一条的表现是「点了没反应」，
 * 而那种失败在三大门禁上一律绿。
 */
export const PROVIDERS_CHANNELS: InvokeChannel[] = [
  CHANNELS.providersList,
  CHANNELS.providersSaveKey,
  CHANNELS.providersRemove,
  CHANNELS.providersAddCustom,
  CHANNELS.providersTest,
  CHANNELS.providersDiscoverModels,
  CHANNELS.providersSetModelInput,
  CHANNELS.providersSetScopeDefault,
];

export const USAGE_CHANNELS: InvokeChannel[] = [
  CHANNELS.usageQuery,
  CHANNELS.usageExport,
  CHANNELS.usageRecord,
  CHANNELS.usageSessions,
];

/**
 * 组装渲染进程可见的 provider 全量快照。
 *
 * 内置目录 + auth.json 里出现过的其它 id（用户可能在终端里 `/login` 过一个
 * 我们目录里没有的服务商 —— 那条凭据必须显示出来，否则界面会声称「你还
 * 没配任何账号」而实际上 pi 跑得好好的）+ models.json 的自定义端点。
 */
export function listProviders(): ProviderListResult {
  const auth = readAuthFile();
  const custom = listCustomProviders();
  const permissionEnforced = canEnforcePermissions();

  const seen = new Set<string>();
  const providers: ProviderView[] = [];

  const push = (view: ProviderView): void => {
    if (seen.has(view.id)) return;
    seen.add(view.id);
    providers.push(view);
  };

  for (const entry of PROVIDER_CATALOG) {
    const cred = auth[entry.id];
    push({
      id: entry.id,
      name: entry.name,
      // 已有凭据时以**实际形态**为准：目录里写着 api_key，但用户可能是用
      // /login 存的 OAuth，那时候界面必须说「订阅账号」而不是「已填 key」。
      authKind: cred ? authKindOf(cred) : entry.authKind,
      configured: cred !== undefined,
      last4: last4Of(cred),
      custom: false,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      models: [],
      permissionEnforced,
    });
  }

  // auth.json 里有、目录里没有的（终端 /login 过的服务商）
  for (const [id, cred] of Object.entries(auth)) {
    push({
      id,
      name: catalogEntry(id)?.name ?? id,
      authKind: authKindOf(cred),
      configured: true,
      last4: last4Of(cred),
      custom: false,
      models: [],
      permissionEnforced,
    });
  }

  for (const [id, entry] of Object.entries(custom)) {
    const cred = auth[id];
    const models: ProviderModel[] = (entry.models ?? []).map((m) => ({
      id: m.id,
      provider: id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.input ? { input: m.input } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    }));

    // models.json 的条目**自带 apiKey 字段**，而 pi 会用它。只看 auth.json
    // 的话，一个明明能跑的自定义端点会在界面上显示成「未配置」——用户于是
    // 去填一遍 key，把一份本来好好的配置改坏。这不是假设：本机 models.json
    // 里三个 provider 全是这种形态。
    //
    // 我们自己为无鉴权的本地服务写的占位值不算数（那本来就不是一把密钥）。
    const inlineKey = typeof entry.apiKey === "string" ? entry.apiKey : "";
    const hasInlineKey = inlineKey !== "" && inlineKey !== CUSTOM_PROVIDER_PLACEHOLDER_KEY;

    // 自定义端点覆盖同名内置条目：用户显式写了 baseUrl，那份配置说了算
    const existing = providers.findIndex((p) => p.id === id);
    const view: ProviderView = {
      id,
      // 显示名优先级：条目自己的 name → 内置目录里的正式名 → 裸 id。
      // 直接落到 id 会让界面上出现一串全小写的 "anthropic"，看着像没配好。
      name:
        typeof entry.name === "string" && entry.name !== ""
          ? entry.name
          : (catalogEntry(id)?.name ?? id),
      authKind: "api_key",
      configured: cred !== undefined || hasInlineKey,
      // auth.json 的凭据优先（它的优先级也确实高于 models.json）
      last4: cred ? last4Of(cred) : hasInlineKey ? inlineKey.slice(-4) : "",
      custom: true,
      baseUrl: entry.baseUrl,
      models,
      permissionEnforced,
    };
    if (existing >= 0) providers[existing] = view;
    else push(view);
  }

  return { providers, permissionEnforced };
}

export function registerProvidersIpc(): void {
  registerHandler(CHANNELS.providersList, voidRequestSchema, () => listProviders());

  // 密钥**只进不出**：写进 ~/.pi/agent/auth.json（合并 + 备份 + 0600），
  // 返回的是全量快照，里面没有 key 字段。
  registerHandler(CHANNELS.providersSaveKey, providerSaveKeyRequestSchema, (payload) => {
    writeCredential(payload.providerId, {
      type: "api_key",
      key: payload.key,
      ...(payload.env ? { env: payload.env } : {}),
    });
    return listProviders();
  });

  registerHandler(CHANNELS.providersRemove, providerIdRequestSchema, (payload) => {
    // 两处都要清：auth.json 里的凭据与 models.json 里的自定义端点。
    // 只清一处的表现是「删掉了还在列表里」或「删掉了但 key 还在磁盘上」。
    writeCredential(payload.providerId, { type: "api_key", key: "" });
    removeCustomProvider(payload.providerId);
    return listProviders();
  });

  registerHandler(CHANNELS.providersAddCustom, providerCustomRequestSchema, async (payload) => {
    await upsertCustomProvider(payload);
    return listProviders();
  });

  registerHandler(CHANNELS.providersTest, providerIdRequestSchema, (payload) =>
    testProvider(payload.providerId)
  );

  registerHandler(
    CHANNELS.providersDiscoverModels,
    providerIdRequestSchema,
    async (payload) => {
      const cred = readAuthFile()[payload.providerId];
      const key = typeof cred?.key === "string" ? cred.key : undefined;
      await discoverModels(payload.providerId, key);
      return listProviders();
    }
  );

  // 只对 models.json 里的自定义端点生效：内置 provider 的模型能力表归 pi。
  registerHandler(CHANNELS.providersSetModelInput, providerModelInputRequestSchema, (payload) => {
    setCustomModelInput(payload.providerId, payload.modelId, payload.input);
    return listProviders();
  });

  // workspace 层的 key 是不透明 workspaceId，但必须先确认它真的指向一个
  // 已注册的工作目录 —— 否则渲染进程可以往设置里塞任意键值对。
  registerHandler(CHANNELS.providersSetScopeDefault, setScopeDefaultRequestSchema, (payload) => {
    if (payload.scope === "global") {
      return publicSettings(
        saveSettings({ provider: payload.provider, modelId: payload.modelId })
      );
    }
    if (!payload.workspaceId) {
      throw new Error("WORKSPACE_REQUIRED: 设置项目默认模型需要先选好工作文件夹");
    }
    // 抛 WORKSPACE_UNKNOWN 而不是静默忽略：静默忽略的表现是「点了保存，
    // 下次打开还是原来那个模型」。
    requireWorkspaceRoot(payload.workspaceId);
    const current = loadSettings();
    const next: AppSettings["workspaceDefaults"] = {
      ...current.workspaceDefaults,
      [payload.workspaceId]: { provider: payload.provider, modelId: payload.modelId },
    };
    return publicSettings(saveSettings({ workspaceDefaults: next }));
  });
}

export function registerUsageIpc(): void {
  registerHandler(CHANNELS.usageQuery, usageQuerySchema, (filter) =>
    usageStore().query(filter)
  );

  registerHandler(CHANNELS.usageSessions, usageQuerySchema, (filter) =>
    usageStore().querySessions(filter)
  );

  registerHandler(CHANNELS.usageExport, usageExportRequestSchema, (request) => {
    const { format, ...filter } = request;
    // 不透明 workspaceId 换成显示名再导出：一张全是 sha256 前缀的表
    // 对用户没有任何意义。
    const names: Record<string, string> = {};
    for (const row of usageStore().query(filter)) {
      if (row.workspace === "" || names[row.workspace]) continue;
      try {
        names[row.workspace] = describeWorkspace(row.workspace).displayPath;
      } catch {
        /* 工作目录已被删掉：保留原 id，总比整行消失好 */
      }
    }
    // 用本地日期而不是 toISOString()（UTC）：东八区的用户在 8 月 3 日凌晨
    // 导出，拿到的文件会叫 8 月 2 日，而表里第一行写着 8 月 3 日。
    const stamp = localDay();
    return format === "csv"
      ? { filename: `pibuddy-usage-${stamp}.csv`, content: usageStore().exportCsv(filter, names) }
      : {
          filename: `pibuddy-usage-${stamp}.json`,
          content: usageStore().exportJson(filter, names),
        };
  });

  registerHandler(CHANNELS.usageRecord, usageRecordRequestSchema, (payload) => {
    usageStore().record(payload);
  });
}

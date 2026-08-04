/**
 * 智能家居基座能力包的契约（home.assistant / connector tier，智能家居 Phase B）。
 *
 * ## 这个文件在回答什么
 *
 * `home.assistant` 对外声明的五条窄通道：端点配置读写、测试连接、实体快照、
 * 运行状态。它是 dashboard / automation / advisor 三个上层家居包的公共地基，
 * IPC 面刻意收得很小——设备控制**不在**这里：控制走 pi 回路内工具
 * （`home.assistant.call_service` 等，经主进程 tool bridge → safeLocalFetch），
 * 面板拿到的只是只读快照。
 *
 * ## 为什么配置通道里没有「授权」动作
 *
 * `ha:config-set` 只落 host/port（token 进 secret-store，只进不出）。授权是
 * 另一条既有内核通道（`permission:decide`，disposition=allow-workspace）——
 * `network.local` 属危险权限，持久化必过主进程原生确认框，渲染进程伪造不了。
 * 配置与授权分开，`ha:config-get` 的 `authorized` 字段如实回报引擎判定，
 * 界面据此显示「已配置但未授权」这种中间态，而不是假装配置完就能用。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

export const HOME_ASSISTANT_CAPABILITY_ID = "home.assistant";

// ---------------------------------------------------------------- 回路内工具

/**
 * 常驻工具恰 3 个（上下文预算核心：实体 id 参数化，绝不每设备一工具），外加
 * 1 个 setup 引导工具（端点未配置时 extension 只注册它，3→1）。
 *
 * 名字带 capabilityId 前缀是 manifest 校验的硬性要求（D4 规则 6）；extension
 * （resources/capability-assets/home.assistant/extensions/ha-tools.ts）与
 * manifest.tools 的声明必须逐字一致，一致性由 home-assistant-e2e.spec 对账。
 */
export const HOME_TOOL_LIST_ENTITIES = "home.assistant.list_entities";
export const HOME_TOOL_GET_STATE = "home.assistant.get_state";
export const HOME_TOOL_CALL_SERVICE = "home.assistant.call_service";
export const HOME_TOOL_SETUP = "home.assistant.setup";

/** 经 tool bridge 转发执行的三个常驻工具（setup 是纯文本引导，不过桥）。 */
export const HOME_BRIDGE_TOOLS = [
  HOME_TOOL_LIST_ENTITIES,
  HOME_TOOL_GET_STATE,
  HOME_TOOL_CALL_SERVICE,
] as const;

/**
 * pi-launcher 注入给 pi 子进程的环境变量名（tool bridge 的接头暗号）。
 *
 * 只在 home.assistant 启用（bridge 已起）时注入；extension 侧 env 缺失即知
 * 「包未启用 / 未配置」，只注册 setup 引导工具。token 是 bridge 每次启动
 * 随机生成的一次性值，不落盘、不进日志。
 */
export const HOME_BRIDGE_ENV_PATH = "PIBUDDY_HOME_BRIDGE";
export const HOME_BRIDGE_ENV_TOKEN = "PIBUDDY_HOME_BRIDGE_TOKEN";

/** 工具入参上界（与 extension 的 typebox schema、bridge 的 zod 校验三方一致）。 */
export const HOME_LIST_ENTITIES_MAX = 50;
export const HOME_GET_STATE_MAX_IDS = 20;

/** `home.assistant.list_entities` 的入参（bridge 侧二次校验用）。 */
export const homeListEntitiesArgsSchema = z
  .object({
    domain: z.string().max(64).optional(),
    area: z.string().max(128).optional(),
    query: z.string().max(128).optional(),
    limit: z.number().int().positive().max(HOME_LIST_ENTITIES_MAX).default(HOME_LIST_ENTITIES_MAX),
  })
  .strict();
export type HomeListEntitiesArgs = z.infer<typeof homeListEntitiesArgsSchema>;

/** `home.assistant.get_state` 的入参。 */
export const homeGetStateArgsSchema = z
  .object({
    entity_ids: z.array(z.string().min(1).max(255)).min(1).max(HOME_GET_STATE_MAX_IDS),
  })
  .strict();
export type HomeGetStateArgs = z.infer<typeof homeGetStateArgsSchema>;

/**
 * `home.assistant.call_service` 的入参。
 *
 * domain / service 的字符形态被钉死为 HA 的标识符习惯（小写字母数字下划线）：
 * 它们会拼进 REST 路径 `/api/services/<domain>/<service>`，形态校验就是
 * 路径注入的结构性挡板（`/`、`..`、空白在这里写不出来）。
 */
export const HA_SERVICE_IDENT_RE = /^[a-z0-9_]{1,64}$/;
export const homeCallServiceArgsSchema = z
  .object({
    domain: z.string().regex(HA_SERVICE_IDENT_RE),
    service: z.string().regex(HA_SERVICE_IDENT_RE),
    entity_id: z.string().min(1).max(255).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type HomeCallServiceArgs = z.infer<typeof homeCallServiceArgsSchema>;

// ---------------------------------------------------------------- 配置

/** token 的渲染侧视图：配没配 + 尾四位。明文只进不出（与 stt 密钥同口径）。 */
export const haTokenDescriptorSchema = z
  .object({ configured: z.boolean(), last4: z.string() })
  .strict();
export type HaTokenDescriptor = z.infer<typeof haTokenDescriptorSchema>;

export const haConfigStateSchema = z
  .object({
    workspaceId: z.string(),
    /** host + port 是否已配置 */
    configured: z.boolean(),
    host: z.string().nullable(),
    port: z.number().int().nullable(),
    token: haTokenDescriptorSchema,
    /** 该端点是否已获 `network.local` 授权（引擎实时判定，不是缓存） */
    authorized: z.boolean(),
  })
  .strict();
export type HaConfigState = z.infer<typeof haConfigStateSchema>;

export const haConfigGetRequestSchema = z.object({ workspaceId: z.string().min(1) }).strict();
export type HaConfigGetRequest = z.infer<typeof haConfigGetRequestSchema>;

/**
 * 写配置。host:port 的合法形态由主进程按 LOCAL_ENDPOINT_RESOURCE_RE 复验；
 * `token` 为空串表示不改动既有 token（密钥输入框永远从空开始的另一半约定）。
 */
export const haConfigSetRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    token: z.string().max(4096).default(""),
  })
  .strict();
export type HaConfigSetRequest = z.infer<typeof haConfigSetRequestSchema>;

// ---------------------------------------------------------------- 测试连接

export const haTestConnectionRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type HaTestConnectionRequest = z.infer<typeof haTestConnectionRequestSchema>;

/** 结果只有一句给人看的话：失败原因已经在主进程脱敏过。 */
export const haTestConnectionResultSchema = z
  .object({ ok: z.boolean(), message: z.string() })
  .strict();
export type HaTestConnectionResult = z.infer<typeof haTestConnectionResultSchema>;

// ---------------------------------------------------------------- 实体快照

export const haEntityRowSchema = z
  .object({
    /** HA entity_id（`light.living_room`） */
    id: z.string(),
    /** 显示名（registry / friendly_name；都没有时回落 entity_id） */
    name: z.string(),
    /** entity_id 的 domain 段（`light`） */
    domain: z.string(),
    /** 当前状态；快照来源没有状态（冷启动）时为 null */
    state: z.string().nullable(),
    area: z.string().nullable(),
  })
  .strict();
export type HaEntityRow = z.infer<typeof haEntityRowSchema>;

export const haEntitiesRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** 面板一屏用不了 500 行；实体可能上千，响应必须有界 */
    limit: z.number().int().positive().max(500).default(200),
  })
  .strict();
export type HaEntitiesRequest = z.infer<typeof haEntitiesRequestSchema>;

export const haEntitiesResultSchema = z
  .object({
    entities: z.array(haEntityRowSchema),
    /** 缓存里的实体总数（entities 只是其中一段） */
    total: z.number().int().nonnegative(),
    /** true = 断线后未 resync（数据可能过期），或只有冷启动快照 */
    stale: z.boolean(),
    /** live = 来自 REST/WS 的活数据；snapshot = sqlite 冷启动快照（无状态值） */
    source: z.enum(["live", "snapshot"]),
  })
  .strict();
export type HaEntitiesResult = z.infer<typeof haEntitiesResultSchema>;

// ---------------------------------------------------------------- 运行状态

export const haStatusRequestSchema = z.object({ workspaceId: z.string().min(1) }).strict();
export type HaStatusRequest = z.infer<typeof haStatusRequestSchema>;

export const haStatusResultSchema = z
  .object({
    configured: z.boolean(),
    authorized: z.boolean(),
    tokenConfigured: z.boolean(),
    /** idle = 无消费者无连接；connecting / connected 是 WS 会话态；stale = 断线未恢复 */
    wsStatus: z.enum(["idle", "connecting", "connected", "stale"]),
    /** 当前引用计数消费者数（面板 / 工具滑动窗口） */
    consumers: z.number().int().nonnegative(),
    entityCount: z.number().int().nonnegative(),
    /** 最近一条 state_changed 的到达时间（Unix ms）；从未收到为 null */
    lastEventAt: z.number().int().nullable(),
  })
  .strict();
export type HaStatusResult = z.infer<typeof haStatusResultSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `home.assistant` 的全部五条通道。
 *
 * 分片 id 是 capabilityId 的第二段（`home.assistant` → `assistant`），drift
 * test 据此把「manifest 声明的通道」与「本分片的键集合」逐条对账。
 */
export const homeAssistantContractShard = defineContractShard("assistant", {
  [CHANNELS.haConfigGet]: {
    request: haConfigGetRequestSchema,
    response: haConfigStateSchema,
  },
  [CHANNELS.haConfigSet]: {
    request: haConfigSetRequestSchema,
    response: haConfigStateSchema,
  },
  [CHANNELS.haTestConnection]: {
    request: haTestConnectionRequestSchema,
    response: haTestConnectionResultSchema,
  },
  [CHANNELS.haEntities]: {
    request: haEntitiesRequestSchema,
    response: haEntitiesResultSchema,
  },
  [CHANNELS.haStatus]: {
    request: haStatusRequestSchema,
    response: haStatusResultSchema,
  },
});

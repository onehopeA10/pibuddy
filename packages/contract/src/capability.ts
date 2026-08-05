/**
 * 能力包契约（ADR-0002 第一阶段）。
 *
 * ## 这个文件在回答什么
 *
 * 「一个能力包对外声明了什么」——通道、工具、UI 贡献、配置键、数据代际、
 * 它**申请**哪些权限、它的资产怎么装。声明是一份纯数据，因此它可以被
 * 校验、被 diff、被 grep；而「运行期注册」的东西只能在崩溃时被发现。
 * ADR-0002 的贯穿性观察就是这一条：凡有「声明 → 校验 → 投影」三段结构的
 * 地方，冲突静态可查。
 *
 * ## 为什么 manifest 里没有、也不能有「已授予」
 *
 * ADR-0002 D3：**能力只能申请权限，不能自行授予**。如果 manifest 里存在
 * 任何形态的 `granted` / `autoGrant` / `permissionsGranted`，那么「谁批准的」
 * 这件事的答案就变成了「它自己」——权限模型在第一行就塌了。这里用两道
 * 结构性手段挡住：
 *
 *   1. `capabilityManifestSchema` 全链路 `.strict()`，多一个键直接抛错；
 *   2. `CAPABILITY_GRANT_FORBIDDEN_KEYS` 显式点名一批授予语义的键名，
 *      `validateCapabilityManifest` 逐层扫描，命中即报错。
 *
 * 第 2 条不是第 1 条的冗余：strict 只能挡住**已知形状**上的多余键，而一个
 * 新加的嵌套对象（比如日后某人给 `runtime` 加一段 `runtime.grants`）会在
 * schema 演进时被顺手放行。点名黑名单是那种情况下唯一还在岗的判据。
 *
 * ## 为什么 tier 里没有 kernel
 *
 * 平台内核不可关闭（ADR-0002 四层边界表）。让它成为一个「能力」，就等于
 * 承认存在一份「禁用内核」的配置——那份配置的行为没有任何人定义过。
 */
import { z } from "zod";

import { defineContractShard, voidRequestSchema } from "./channel-contract.js";
import { CHANNELS, PUSH_CHANNELS } from "./channels.js";

/** manifest 结构自身的代际。改字段语义要 +1 并在宿主侧补兼容分支。 */
export const CAPABILITY_MANIFEST_VERSION = 1;

/**
 * 宿主向能力包承诺的契约代际。
 *
 * 能力包用 `compatibility.contract` 声明它能接受的区间；宿主在装配期比对。
 * 与 `CAPABILITY_MANIFEST_VERSION` 分开：manifest 的形状和宿主暴露的
 * 通道/事件面是两件会各自演进的事。
 */
export const CAPABILITY_HOST_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------- 权限

/**
 * 无参权限（ADR-0002 D3 初始集）。
 *
 * 这里**只有申请动作的名字**，没有任何「已批准」的位置。授权决策由核心
 * PermissionEngine 按 workspace / agent / profile 做，不在 manifest 里。
 */
export const CAPABILITY_PERMISSION_ATOMS = [
  "workspace.read",
  "workspace.write",
  "process.git",
  "process.shell",
  "external.open",
  // local-network 受控出站车道（SEC-004 扩展）：声明「本能力需要访问用户确认
  // 过的私网 host:port」。它是无参原子——具体端点不写在 manifest 里，而是在
  // 授权时绑进 grant.resource（形态由 permission.ts 的 LOCAL_ENDPOINT_RESOURCE_RE
  // 强制，null-resource 通配在 decidePermission 里被结构性挡死）。
  "network.local",
] as const;
export type CapabilityPermissionAtom = (typeof CAPABILITY_PERMISSION_ATOMS)[number];

/** 带参数的权限前缀：`network:<domain>` 与 `secret:<slot>`。 */
export const CAPABILITY_PERMISSION_PREFIXES = ["network", "secret"] as const;
export type CapabilityPermissionPrefix = (typeof CAPABILITY_PERMISSION_PREFIXES)[number];

/**
 * 一条权限申请的字符串形态（`workspace.read` / `network:api.openai.com`）。
 *
 * ## 与 `PermissionRule`（ipc-contract.ts:97）不是同一件事
 *
 * 那个类型是**单条 IPC 通道的准入配额**（channel / maxBytes / windowMs /
 * maxPerWindow），`ipc-guard` 的 CHANNEL_MAX_BYTES 与 RateLimiter 是它的运行时
 * 投影；`workspace-store.ts:57` 落盘的 `permissionRules` 存的就是它，DDL 在 `:69`。
 *
 * 本类型是**能力级的权限申请**（ADR-0002 D3），轴完全不同：前者回答「这条通道
 * 一次能收多大、10 秒能来几次」，后者回答「这个能力被允许做哪一类事」。
 *
 * 因此本轮**不把 `permissionRules` 接成能力权限的决策数据源** —— 那会把一张
 * 按 channel 索引的配额表当成按 capability 索引的授权表来读，两边的键都对不上，
 * 接起来只能靠一层猜测性的映射。真正的接法是在 PermissionEngine 落地时，
 * 让 `WorkspaceProfile` 多一张按 capabilityId 索引的授权表，与现有的
 * `permissionRules` 并列而不是复用它。那属于「权限引擎的实际决策逻辑」，
 * 本轮明确不做（只做声明与校验）。
 */
export type CapabilityPermission = string;

export interface ParsedCapabilityPermission {
  /** 无参权限为其自身；带参权限为前缀 */
  kind: CapabilityPermissionAtom | CapabilityPermissionPrefix;
  /** 带参权限的参数（域名 / 槽位名）；无参权限为 null */
  argument: string | null;
}

/**
 * 域名 / 槽位名的字符形态。
 *
 * `network:*` 这种通配一律不接受：一条通配等于「任意出站」，而 main 侧
 * 唯一的出站原语 `net/outbound-guard.ts` 的全部意义就是不存在这种东西。
 */
const PERMISSION_ARGUMENT_RE = /^[a-z0-9][a-z0-9.-]*$/i;

/** 解析一条权限申请；非法形态返回 null（而不是抛错——校验器要收集全部错误）。 */
export function parseCapabilityPermission(raw: string): ParsedCapabilityPermission | null {
  if ((CAPABILITY_PERMISSION_ATOMS as readonly string[]).includes(raw)) {
    return { kind: raw as CapabilityPermissionAtom, argument: null };
  }
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const prefix = raw.slice(0, sep);
  const argument = raw.slice(sep + 1);
  if (!(CAPABILITY_PERMISSION_PREFIXES as readonly string[]).includes(prefix)) return null;
  if (!PERMISSION_ARGUMENT_RE.test(argument)) return null;
  return { kind: prefix as CapabilityPermissionPrefix, argument };
}

export function isCapabilityPermission(raw: string): boolean {
  return parseCapabilityPermission(raw) !== null;
}

// ---------------------------------------------------------------- UI 插槽

/**
 * 固定插槽集合（ADR-0002 D5）。
 *
 * 是枚举而不是自由字符串：自由字符串意味着一个拼错的插槽名表现为
 * 「这块 UI 就是不出现」，没有任何报错——那正是 pi 的 `ctx.ui.*` 现状。
 */
export const CAPABILITY_UI_SLOTS = [
  "sidebar.section",
  "drawer.tab",
  "composer.action",
  "composer.suggestion",
  "composer.attachment-type",
  "message.renderer",
  "extension.widget",
  "settings.section",
  "command",
  "workflow.template",
] as const;
export type CapabilityUiSlot = (typeof CAPABILITY_UI_SLOTS)[number];

// ---------------------------------------------------------------- 子结构

/**
 * 版本兼容区间。
 *
 * 用 `{min,max}` 而不是 semver range 字符串：range 语法需要一个解析器，
 * 而契约包目前一个运行时依赖都没有（除 zod）。数字段比较足够表达
 * 「>=x 且 <y」，且读的人不需要记住 `^` 与 `~` 的区别。
 */
export const capabilityCompatibilitySchema = z
  .object({
    /** 最低宿主应用版本（含） */
    appMin: z.string().min(1),
    /** 最高宿主应用版本（不含）；省略表示无上界 */
    appBelow: z.string().min(1).optional(),
    /** 可接受的宿主契约代际区间（闭区间） */
    contractMin: z.number().int().nonnegative(),
    contractMax: z.number().int().nonnegative(),
  })
  .strict();
export type CapabilityCompatibility = z.infer<typeof capabilityCompatibilitySchema>;

/**
 * 一个能被 LLM 调用的工具的声明。
 *
 * `name` 必须带 capabilityId 前缀（D4 规则 6）。这条规则的代价是实测过的：
 * pi 的裸 `Map.set` 无命名空间，同名 Tool 冲突让 RPC 直接启动失败，而宿主
 * 只能用三条硬编码关键词猜是哪两个在打架。
 */
export const capabilityToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    /** 该工具运行时会用到的权限，必须是 manifest.permissions 的子集 */
    permissions: z.array(z.string()).readonly().default([]),
  })
  .strict();
export type CapabilityTool = z.infer<typeof capabilityToolSchema>;

/**
 * 一条 UI 贡献。
 *
 * `module` / `host` 不是文档，是 **drift test 的 grep 目标**：module 是实现
 * 该贡献的组件文件，host 是挂载它的宿主文件。手法与 CodePilot
 * `capability-contract.ts:178-217` 的 `exposure.module/factory` 相同——
 * 声明与实现之间必须有一条机器能走的路，否则声明就是注释。
 */
export const capabilityUiContributionSchema = z
  .object({
    slot: z.enum(CAPABILITY_UI_SLOTS),
    /** 贡献 id，必须带 capabilityId 前缀（D4 规则 6） */
    id: z.string().min(1),
    title: z.string().min(1),
    /** 实现模块，相对 packages/app/src 的 posix 路径 */
    module: z.string().min(1),
    /** 挂载点模块，相对 packages/app/src 的 posix 路径 */
    host: z.string().min(1),
  })
  .strict();
export type CapabilityUiContribution = z.infer<typeof capabilityUiContributionSchema>;

/** 一个配置项的声明。`key` 必须带 capabilityId 前缀（D4 规则 6）。 */
export const capabilitySettingSchema = z
  .object({
    key: z.string().min(1),
    type: z.enum(["boolean", "number", "string", "enum"]),
    description: z.string().min(1),
    /** enum 类型的取值集合 */
    options: z.array(z.string()).readonly().optional(),
  })
  .strict();
export type CapabilitySetting = z.infer<typeof capabilitySettingSchema>;

/**
 * 禁用时必须被拆掉的运行期资源种类（D4 规则 4）。
 *
 * 声明它的意义是：禁用路径上「什么都不用做」与「忘了做」在代码里长得
 * 一模一样。写出来之后，前者是 `teardown: []`，后者是一条可以被质问的
 * 声明。**数据不在此列**——规则 5：卸载与删数据是两个动作。
 */
export const CAPABILITY_TEARDOWN_KINDS = [
  "worker",
  "listener",
  "watcher",
  "child-process",
] as const;
export type CapabilityTeardownKind = (typeof CAPABILITY_TEARDOWN_KINDS)[number];

/**
 * 资产装配方式（ADR-0002 D2）。
 *
 * D2 允许能力包携带自己的重依赖（编码包已获准单独引入 monaco-editor），
 * 前提是三条连带约束，其中两条钉在这里：
 *
 *   - **必须懒加载**：带重依赖就必须 `loading: "lazy"` 且给出 `entry`，
 *     未启用不得进包；
 *   - **必须有预算**：允许重依赖不等于允许无上界，`bundleBudgetKb` 必填。
 *
 * 这两条由 `validateCapabilityManifest` 强制，不是靠人自觉。
 */
export const capabilityRuntimeSchema = z
  .object({
    /** inline = 随内核 bundle 一起装；lazy = 独立 chunk，启用时才加载 */
    loading: z.enum(["inline", "lazy"]),
    /** lazy 时的动态 import 入口，相对 packages/app/src 的 posix 路径 */
    entry: z.string().min(1).optional(),
    /** 该 chunk 的字节预算（KB）。带重依赖时必填，做成可断言闸门 */
    bundleBudgetKb: z.number().int().positive().optional(),
    /** 本包独占的重依赖（如 monaco-editor）。为空表示只用内核已有的依赖 */
    heavyDependencies: z.array(z.string()).readonly().default([]),
    /** 禁用时必须拆掉的运行期资源 */
    teardown: z.array(z.enum(CAPABILITY_TEARDOWN_KINDS)).readonly().default([]),
  })
  .strict();
export type CapabilityRuntime = z.infer<typeof capabilityRuntimeSchema>;

/**
 * 随包携带的 pi 资源声明（REQ-0001 R4.1）。
 *
 * 能力包可以带一批 **pi 原生格式**的资源（prompts / skills / extensions），
 * 随应用经 electron-builder extraResources 分发到
 * `resources/capability-assets/<capabilityId>/` 下；启用时由内核物化到 pi 的
 * 用户级资源目录（`~/.pi/agent/{prompts,skills,extensions}/`，目录约定见
 * pi docs 的 prompt-templates.md / skills.md / extensions.md），停用时收回。
 *
 * 三个数组里存的都是**相对 `capability-assets/<capabilityId>/` 的 posix 路径**：
 *
 *   - `prompts`：`.md` 文件（pi 的 prompts 目录非递归、只认 .md）；
 *   - `skills`：含 `SKILL.md` 的目录，或单个根 `.md` 文件（skills.md 的两种发现形态）；
 *   - `extensions`：`.ts`/`.js`/`.mjs` 文件，或含 `index.ts`/`index.js` 的目录。
 *
 * 这里只有**声明**，没有目标路径：落到哪里由物化器按 pi 的目录约定推导，
 * manifest 写不出「把文件放到任意绝对路径」这种话——路径形态由
 * `validateCapabilityManifest` 强制（相对、posix、不含 `..`）。
 *
 * R4.3 的结构性钉子也在校验器里：声明了 `extensions`（回路内工具）的包，
 * `tools` 必须非空——工具的权限需求经由 tools[].permissions ⊆ permissions
 * 的既有规则进入权限引擎（5 闸），资源物化本身不开任何权限旁路。
 */
export const capabilityPiResourcesSchema = z
  .object({
    /** pi prompt 模板：`.md` 文件相对路径 */
    prompts: z.array(z.string().min(1)).readonly().default([]),
    /** pi skill：含 SKILL.md 的目录或单个 `.md` 文件的相对路径 */
    skills: z.array(z.string().min(1)).readonly().default([]),
    /** pi extension：`.ts`/`.js`/`.mjs` 文件或含 index.ts 的目录的相对路径 */
    extensions: z.array(z.string().min(1)).readonly().default([]),
  })
  .strict();
export type CapabilityPiResources = z.infer<typeof capabilityPiResourcesSchema>;

/**
 * 缺省的空声明。单独导出给「未声明任何资源」的读取方兜底用。
 *
 * freeze 不是仪式：zod v4 的 `.default()` 短路返回**这同一个对象引用**，
 * 所有未声明资源的 manifest 会共享它——可变的话，改一份等于改全部。
 */
export const EMPTY_CAPABILITY_PI_RESOURCES: CapabilityPiResources = Object.freeze({
  prompts: Object.freeze([]) as readonly string[],
  skills: Object.freeze([]) as readonly string[],
  extensions: Object.freeze([]) as readonly string[],
});

/** `piResources` 的三个键。门控声明按 `kind + path` 定位到其中恰一条。 */
export const CAPABILITY_PI_RESOURCE_KINDS = ["prompts", "skills", "extensions"] as const;
export type CapabilityPiResourceKind = (typeof CAPABILITY_PI_RESOURCE_KINDS)[number];

/**
 * 一条 pi 资源的**宿主门控**声明（REQ-0001 R4.5）。
 *
 * ## 它解决的缺口
 *
 * `home.advisor` 的 `home-scene-advisor` 技能，其操作规程的最后一步要调
 * `home.automation.manage_rule`。automation 包关着时，这个技能照样被物化、
 * 照样进 pi 的技能目录、照样把 name+description 塞进每一轮上下文，而模型
 * 照着规程走下去会调一个不存在的工具。原先的兜底是在 SKILL.md 正文里写一句
 * 「工具不可用时如实告知用户去启用」——**散文兜底**：它只在模型真的读到、
 * 真的照做时才生效，而且上下文成本已经付掉了。这里换成机制兜底：门控不满足
 * 的资源**根本不物化**，pi 看不见它，零上下文浪费、零失败工具调用。
 *
 * ## 三层模型（照 maka `skills-context.ts:61-70, 204-222`）
 *
 *   - `manifest.tools[]` —— **仅信息性**的声明面（maka 的 `allowedTools`）：
 *     它说的是「本包提供哪些工具」，不构成任何门控判据；
 *   - `requiredTools` —— 所需工具在本次装配的宿主工具面里缺席 → **硬门控**；
 *   - `requiredCapabilities` —— 所需能力包本次未启用 → **硬门控**。
 *
 * ## 与 `manifest.dependencies` 的分工：整包级 vs 单资源级
 *
 * `dependencies` 是**整包**判据，在装配期由 `CapabilityRegistry.resolve()` 跑到
 * 不动点：不满足时整个包拒绝启用，一条通道都不注册、一个资源都不物化。
 * 本字段是**单个资源条目**级判据，在物化层生效：包本身正常启用、其余资源
 * 照常物化，只有声明了门控的那一条缺席。
 *
 * `home.advisor` 同时用到两者，而且**不重复**：整包 `dependencies:
 * ["home.assistant"]`（两个技能都以基座的三个只读/控制工具为前提，没有基座
 * 时本包毫无意义）；`home-scene-advisor` 这一条**额外**要 `home.automation`
 * （没有它，建议照样能给，只是落不了地——把它提到整包 dependencies 会把
 * 「只想要建议」的用户一起拦在门外）。两级的判据集合被
 * `validateCapabilityManifest` 强制互斥：已经在 `dependencies` 里的能力再写进
 * `requiredCapabilities` 是恒真的噪声，直接报错。
 */
export const capabilityResourceGateSchema = z
  .object({
    /** 被门控的声明落在 piResources 的哪个键下 */
    kind: z.enum(CAPABILITY_PI_RESOURCE_KINDS),
    /** 被门控的声明本身，必须逐字等于 `piResources[kind]` 里的某一条 */
    path: z.string().min(1),
    /** 所需能力包（capabilityId）。任一未启用 → 本条资源不物化 */
    requiredCapabilities: z.array(z.string()).readonly().default([]),
    /** 所需工具（带 capabilityId 前缀的全名）。任一缺席 → 本条资源不物化 */
    requiredTools: z.array(z.string()).readonly().default([]),
  })
  .strict();
export type CapabilityResourceGate = z.infer<typeof capabilityResourceGateSchema>;

// ------------------------------------------------------- 资源级装配决策报告

/**
 * 一条资源**没进（或进了）pi 上下文**的确切原因（照 maka `SkillSelectionReport`
 * / `skills-context.ts:83-104`）。
 *
 * 对比现状：pi 对同名技能的策略是「先加载的赢」且**静默**——用户看到的只是
 * 「这个技能怎么不在」。我们自己物化的这一部分至少要可解释，因此每条声明在
 * 每次启动对账里都恰好落一个 reason，没有「不知道为什么」这一档。
 *
 *   - `materialized`            —— 已落盘到 `~/.pi/agent/` 下
 *   - `capability_disabled`     —— 所属能力包本次未启用（整包级）
 *   - `required_capability_missing` —— 门控要的能力包未启用（单资源级）
 *   - `required_tool_missing`   —— 门控要的工具在本次宿主工具面里缺席
 *   - `invalid`                 —— 声明指空 / 目录缺 SKILL.md / 读不出来
 *   - `shadowed`                —— 目标被用户文件或另一个包占着，拒绝覆盖
 */
export const CAPABILITY_RESOURCE_DECISION_REASONS = [
  "materialized",
  "capability_disabled",
  "required_capability_missing",
  "required_tool_missing",
  "invalid",
  "shadowed",
] as const;
export type CapabilityResourceDecisionReason =
  (typeof CAPABILITY_RESOURCE_DECISION_REASONS)[number];

export const capabilityResourceDecisionSchema = z
  .object({
    capabilityId: z.string(),
    kind: z.enum(CAPABILITY_PI_RESOURCE_KINDS),
    /** manifest 里那条声明的原文（相对 capability-assets/<id>/ 的 posix 路径） */
    path: z.string(),
    reason: z.enum(CAPABILITY_RESOURCE_DECISION_REASONS),
    /**
     * reason 的确切依据：缺的能力 id / 工具名、占位的包、失败的那句话。
     * 没有额外依据时为 null——`materialized` 就是这一类。
     */
    detail: z.string().nullable().default(null),
    /** `materialized` 时该条声明名下落盘的文件数；其余 reason 恒 0 */
    fileCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type CapabilityResourceDecision = z.infer<typeof capabilityResourceDecisionSchema>;

/**
 * 主进程侧暴露点。
 *
 * 同样是 drift test 的 grep 目标：`register` 是装配期被调用的注册函数名，
 * drift test 据它去 `module` 里数「这个函数体里到底注册了哪几条通道」，
 * 再和 `manifest.channels` 对账。没有这一段的话，「manifest 说它有 9 条
 * 通道」就只是一句话。
 */
export const capabilityExposureSchema = z
  .object({
    /** 注册函数所在模块，相对 packages/app/src 的 posix 路径 */
    module: z.string().min(1),
    /** 注册函数名 */
    register: z.string().min(1),
    /** 禁用 / 退出时的拆卸函数名；`runtime.teardown` 非空时必填 */
    dispose: z.string().min(1).optional(),
  })
  .strict();
export type CapabilityExposure = z.infer<typeof capabilityExposureSchema>;

// ---------------------------------------------------------------- manifest

/** capabilityId 形态：`<namespace>.<name>`，两段都是小写短横线命名。 */
export const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 版本号形态：三段数字。 */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 授予语义的键名黑名单。
 *
 * 见文件头：strict schema 挡不住「日后新增的嵌套对象里混进一个授予字段」，
 * 这张表是那种情况下唯一还在岗的判据。命中即报错，不做「警告」——警告
 * 在 CI 里等于没有。
 */
export const CAPABILITY_GRANT_FORBIDDEN_KEYS = [
  "granted",
  "grants",
  "grant",
  "grantedpermissions",
  "autogrant",
  "permissionsgranted",
  "approved",
  "authorized",
] as const;

export const capabilityManifestSchema = z
  .object({
    manifestVersion: z.number().int().positive(),
    id: z.string().min(1),
    version: z.string().min(1),
    /** 四层边界里可关闭的三层。kernel 不在此列——它不可关闭 */
    tier: z.enum(["common", "vertical", "connector"]),
    displayName: z.string().min(1),
    description: z.string().min(1),
    compatibility: capabilityCompatibilitySchema,
    /** 依赖的其它 capabilityId。不满足时**拒绝启用**，不静默降级 */
    dependencies: z.array(z.string()).readonly().default([]),
    /** 申请的权限。只是申请 */
    permissions: z.array(z.string()).readonly().default([]),
    /** 该能力注册的 invoke 通道 */
    channels: z.array(z.string()).readonly().default([]),
    /** 该能力使用的推送通道 */
    pushChannels: z.array(z.string()).readonly().default([]),
    tools: z.array(capabilityToolSchema).readonly().default([]),
    uiContributions: z.array(capabilityUiContributionSchema).readonly().default([]),
    settingsSchema: z.array(capabilitySettingSchema).readonly().default([]),
    /**
     * 该能力自有数据的代际（D4 规则 3：数据按 capabilityId + workspaceId +
     * agentId 分区）。升级时按它决定要不要迁移；禁用不动数据，卸载才谈删。
     */
    dataSchemaVersion: z.number().int().nonnegative(),
    runtime: capabilityRuntimeSchema,
    exposure: capabilityExposureSchema,
    /**
     * 随包携带的 pi 资源（REQ-0001 R4.1）。可选、缺省全空——既有 manifest
     * 一字不改仍合法；zod 的 default 在 parse 时补齐三个空数组。
     */
    piResources: capabilityPiResourcesSchema.default(EMPTY_CAPABILITY_PI_RESOURCES),
    /**
     * 单个资源条目的宿主门控（REQ-0001 R4.5）。可选、缺省空数组。
     *
     * ## 为什么放在 manifest 顶层，而不是塞进 `piResources` 的元素里
     *
     *   1. **两个轴**：`piResources` 回答「这个包里装了什么」（一份静态清单，
     *      随包出厂就定死）；门控回答「宿主处于什么状态时它才该出现」（每次
     *      装配现算）。塞进同一个数组等于把两件各自演进的事绑在一个形状上。
     *   2. **不动既有形状**：内联的写法要把 `skills: string[]` 变成
     *      `(string | {path, ...})[]`，于是每一个读取点都要先窄化一次类型；
     *      而现在 19 个不带资源的 manifest 的 `piResources` 仍然逐字节等于
     *      三个空数组，`EMPTY_CAPABILITY_PI_RESOURCES` 的共享冻结语义不变。
     *   3. **引用完整性可校验**：平铺一层的代价是「path 可能指向一条不存在的
     *      声明」，而这恰恰是可以被校验器抓住并给出确切错误的——比一个悄悄
     *      没生效的内联字段好。
     */
    piResourceGates: z.array(capabilityResourceGateSchema).readonly().default([]),
  })
  .strict();

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

/** 递归扫描一个纯数据对象里有没有授予语义的键名。 */
function findGrantKeys(value: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => findGrantKeys(item, `${path}[${i}]`, out, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    if ((CAPABILITY_GRANT_FORBIDDEN_KEYS as readonly string[]).includes(lowered)) {
      out.push(`${path}.${key}`);
    }
    findGrantKeys(item, `${path}.${key}`, out, depth + 1);
  }
}

const KNOWN_INVOKE_CHANNELS = new Set<string>(Object.values(CHANNELS));
const KNOWN_PUSH_CHANNELS = new Set<string>(Object.values(PUSH_CHANNELS));

/**
 * 装配期校验。返回**全部**错误（不是第一条）——一次改完好过改一条跑一遍。
 *
 * 校验的是声明自身的自洽性；跨能力的冲突（重复 id、通道被两个能力抢）
 * 由 `CapabilityRegistry` 负责，那需要看到全集。
 */
export function validateCapabilityManifest(manifest: CapabilityManifest): string[] {
  const errors: string[] = [];
  const { id } = manifest;

  if (manifest.manifestVersion !== CAPABILITY_MANIFEST_VERSION) {
    errors.push(
      `manifestVersion 必须是 ${CAPABILITY_MANIFEST_VERSION}，实际 ${manifest.manifestVersion}`
    );
  }
  if (!CAPABILITY_ID_RE.test(id)) {
    errors.push(`id "${id}" 不是 <namespace>.<name> 形态`);
  }
  if (!VERSION_RE.test(manifest.version)) {
    errors.push(`version "${manifest.version}" 不是 x.y.z 形态`);
  }

  // ---- 依赖
  const seenDeps = new Set<string>();
  for (const dep of manifest.dependencies) {
    if (dep === id) errors.push(`dependencies 不得包含自身 "${id}"`);
    if (seenDeps.has(dep)) errors.push(`dependencies 重复声明 "${dep}"`);
    seenDeps.add(dep);
    if (!CAPABILITY_ID_RE.test(dep)) errors.push(`dependencies "${dep}" 不是合法 capabilityId`);
  }

  // ---- 权限：只申请，不授予
  const seenPerms = new Set<string>();
  for (const perm of manifest.permissions) {
    if (!isCapabilityPermission(perm)) errors.push(`permissions "${perm}" 不是合法的权限申请`);
    if (seenPerms.has(perm)) errors.push(`permissions 重复声明 "${perm}"`);
    seenPerms.add(perm);
  }
  const grantKeys: string[] = [];
  findGrantKeys(manifest, "manifest", grantKeys);
  for (const key of grantKeys) {
    errors.push(`${key} 带有授予语义（ADR-0002 D3：能力只能申请，不能自行授予）`);
  }

  // ---- 通道
  const seenChannels = new Set<string>();
  for (const channel of manifest.channels) {
    if (!KNOWN_INVOKE_CHANNELS.has(channel)) errors.push(`channels "${channel}" 不是已声明的通道`);
    if (seenChannels.has(channel)) errors.push(`channels 重复声明 "${channel}"`);
    seenChannels.add(channel);
  }
  for (const channel of manifest.pushChannels) {
    if (!KNOWN_PUSH_CHANNELS.has(channel)) {
      errors.push(`pushChannels "${channel}" 不是已声明的推送通道`);
    }
  }

  // ---- 命名空间强制（D4 规则 6）
  for (const tool of manifest.tools) {
    if (!tool.name.startsWith(`${id}.`)) {
      errors.push(`tools "${tool.name}" 缺少 capabilityId 前缀 "${id}."`);
    }
    for (const perm of tool.permissions) {
      if (!manifest.permissions.includes(perm)) {
        errors.push(`tools "${tool.name}" 用到未申请的权限 "${perm}"`);
      }
    }
  }
  for (const contribution of manifest.uiContributions) {
    if (!contribution.id.startsWith(`${id}.`)) {
      errors.push(`uiContributions "${contribution.id}" 缺少 capabilityId 前缀 "${id}."`);
    }
  }
  for (const setting of manifest.settingsSchema) {
    if (!setting.key.startsWith(`${id}.`)) {
      errors.push(`settingsSchema "${setting.key}" 缺少 capabilityId 前缀 "${id}."`);
    }
    if (setting.type === "enum" && (setting.options?.length ?? 0) === 0) {
      errors.push(`settingsSchema "${setting.key}" 是 enum 但没有 options`);
    }
  }

  // ---- 兼容区间
  const { compatibility: compat } = manifest;
  if (compat.contractMin > compat.contractMax) {
    errors.push(`compatibility 契约区间倒挂：${compat.contractMin} > ${compat.contractMax}`);
  }

  // ---- 资产装配（D2 的两条连带约束）
  const { runtime } = manifest;
  if (runtime.heavyDependencies.length > 0) {
    if (runtime.loading !== "lazy") {
      errors.push(
        `runtime 带重依赖 [${runtime.heavyDependencies.join(", ")}] 却不是 lazy（D2：必须懒加载）`
      );
    }
    if (runtime.bundleBudgetKb === undefined) {
      errors.push("runtime 带重依赖却没有 bundleBudgetKb（D2：允许重依赖不等于允许无上界）");
    }
  }
  if (runtime.loading === "lazy" && runtime.entry === undefined) {
    errors.push("runtime.loading 为 lazy 却没有 entry：没有入口就无从懒加载");
  }
  if (runtime.loading === "inline" && runtime.entry !== undefined) {
    errors.push("runtime.loading 为 inline 却给了 entry：inline 资产没有独立入口");
  }
  if (runtime.teardown.length > 0 && manifest.exposure.dispose === undefined) {
    errors.push(
      `runtime.teardown 声明了 [${runtime.teardown.join(", ")}] 却没有 exposure.dispose（D4 规则 4）`
    );
  }

  // ---- 随包 pi 资源（R4.1 / R4.3）
  //
  // `??` 兜底不是多余：单测会绕过 zod 直接把手搓对象喂进来（sneaky 场景），
  // 那种对象上没有 default 补出来的空声明。
  const piResources = manifest.piResources ?? EMPTY_CAPABILITY_PI_RESOURCES;
  const assetEntries: readonly (readonly [kind: string, rel: string])[] = [
    ...piResources.prompts.map((p) => ["prompts", p] as const),
    ...piResources.skills.map((p) => ["skills", p] as const),
    ...piResources.extensions.map((p) => ["extensions", p] as const),
  ];
  const seenAssets = new Set<string>();
  for (const [kind, rel] of assetEntries) {
    // 相对 posix、不出目录：manifest 能写出的路径只能落在
    // capability-assets/<id>/ 里面，写不出「物化到任意绝对路径」这句话。
    if (!isSafeAssetRelativePath(rel)) {
      errors.push(
        `piResources.${kind} "${rel}" 不是安全的相对 posix 路径（不得含 \\、盘符、开头 /、"." 或 ".." 段）`
      );
      continue;
    }
    if (seenAssets.has(rel)) errors.push(`piResources 重复声明 "${rel}"`);
    seenAssets.add(rel);
  }
  for (const rel of piResources.prompts) {
    if (isSafeAssetRelativePath(rel) && !rel.endsWith(".md")) {
      errors.push(`piResources.prompts "${rel}" 必须是 .md 文件（pi 的 prompts 目录只认 .md）`);
    }
  }
  // R4.3：携带 extension 就是携带回路内工具，工具的权限需求必须经 tools 声明
  // （tools[].permissions ⊆ permissions 由上方既有规则强制）。物化通道因此
  // 不构成权限旁路：落盘是内核动作，工具的执行动作仍走权限引擎的 5 闸。
  if (piResources.extensions.length > 0 && manifest.tools.length === 0) {
    errors.push(
      "piResources.extensions 非空却没有 tools：携带回路内工具必须在 tools 里声明其权限需求（R4.3）"
    );
  }

  // ---- 资源级门控（R4.5）
  //
  // 门控是一条**会让资源消失**的判据，因此它自身的每一种「写了等于没写」的
  // 形态都必须报错，而不是静默生效成一扇恒开的门。
  const gates = manifest.piResourceGates ?? [];
  const ownTools = new Set(manifest.tools.map((tool) => tool.name));
  const declaredDeps = new Set(manifest.dependencies);
  const seenGateKeys = new Set<string>();
  for (const gate of gates) {
    const where = `piResourceGates.${gate.kind} "${gate.path}"`;
    // 引用完整性：指向一条不存在的声明的门控什么都门不住，却看上去很像在门。
    if (!piResources[gate.kind].includes(gate.path)) {
      errors.push(`${where} 没有对应的 piResources.${gate.kind} 声明`);
    }
    const key = `${gate.kind}:${gate.path}`;
    if (seenGateKeys.has(key)) errors.push(`${where} 被声明了两次`);
    seenGateKeys.add(key);

    if (gate.requiredCapabilities.length === 0 && gate.requiredTools.length === 0) {
      errors.push(`${where} 既没有 requiredCapabilities 也没有 requiredTools：空门控是噪声`);
    }

    const seenCaps = new Set<string>();
    for (const cap of gate.requiredCapabilities) {
      if (!CAPABILITY_ID_RE.test(cap)) {
        errors.push(`${where} requiredCapabilities "${cap}" 不是合法 capabilityId`);
      }
      if (cap === id) errors.push(`${where} requiredCapabilities 不得包含自身 "${id}"`);
      // 整包级已经拦过的，单资源级再拦一次是恒真判据（依赖不满足时整个包
      // 都不会启用，本条资源根本走不到门控）。两级分工必须互斥。
      if (declaredDeps.has(cap)) {
        errors.push(
          `${where} requiredCapabilities "${cap}" 已是整包 dependencies：` +
            "整包级不满足时本包直接拒绝启用，单资源级再写一遍恒真"
        );
      }
      if (seenCaps.has(cap)) errors.push(`${where} requiredCapabilities 重复声明 "${cap}"`);
      seenCaps.add(cap);
    }

    const seenTools = new Set<string>();
    for (const tool of gate.requiredTools) {
      // 工具名带 capabilityId 前缀是 D4 规则 6 的硬性要求，因此一个不含点的
      // 名字必定指向一个永远不会存在的工具——那扇门永远关着。
      if (!tool.includes(".") || /\s/.test(tool)) {
        errors.push(`${where} requiredTools "${tool}" 不是带 capabilityId 前缀的工具全名`);
      }
      // 自家的工具随包同生共死：包启用时它必在，包不启用时资源本来就不物化。
      if (ownTools.has(tool)) {
        errors.push(`${where} requiredTools "${tool}" 是本包自己的工具：包启用时它必在，恒真`);
      }
      if (seenTools.has(tool)) errors.push(`${where} requiredTools 重复声明 "${tool}"`);
      seenTools.add(tool);
    }
  }

  return errors;
}

/**
 * capability-assets 内相对路径的合法形态。
 *
 * 不用正则一把梭：`..` 这种判断按段做才不会把 `a..b` 误伤，而误伤的代价是
 * 有人换个写法绕过去。
 */
function isSafeAssetRelativePath(rel: string): boolean {
  if (rel.length === 0) return false;
  if (rel.includes("\\")) return false;
  if (rel.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  return rel.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** 校验并抛错的形态，给装配期用。 */
export function assertValidCapabilityManifest(manifest: CapabilityManifest): void {
  const errors = validateCapabilityManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`CAPABILITY_MANIFEST_INVALID: ${manifest.id}\n  - ${errors.join("\n  - ")}`);
  }
}

/**
 * 定义一个 manifest。
 *
 * 走一遍 `capabilityManifestSchema.parse` 而不是直接 `as const`：strict 的
 * 拒绝多余键这件事只有在真的 parse 过一次之后才发生。类型层的 satisfies
 * 挡不住一个 `granted: true`——多余属性检查在对象字面量以外的位置不生效。
 */
export function defineCapability(manifest: unknown): CapabilityManifest {
  const parsed = capabilityManifestSchema.parse(manifest);
  assertValidCapabilityManifest(parsed);
  return Object.freeze(parsed);
}

// ---------------------------------------------------------------- Profile

/**
 * 一组能力的具名集合（ADR-0002：「编码模式」「财务模式」是 Profile，
 * 不是互相隔离的独立应用）。
 *
 * 切换 Profile = 改变启用集合。用户可以在 Profile 之上再逐个开关，
 * 那部分是 overrides，不属于 Profile 自身。
 */
export const agentProfileSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().min(1),
    /** 本 Profile 默认启用的 capabilityId 集合 */
    capabilityIds: z.array(z.string()).readonly(),
  })
  .strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;

// ---------------------------------------------------------------- 对外快照

/**
 * 下发给渲染进程的能力描述。
 *
 * 逐字段挑出来而不是把 manifest 整个外发：`exposure` 是主进程的模块路径与
 * 符号名，那是实现细节，没有任何理由送到渲染进程去。
 */
export const capabilityDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  tier: z.enum(["common", "vertical", "connector"]),
  version: z.string(),
  /** 本次进程装配时是否启用 */
  enabled: z.boolean(),
  /** 未启用的原因（依赖不满足 / 兼容区间不符 / 用户关闭）；启用时为 null */
  reason: z.string().nullable(),
  permissions: z.array(z.string()),
  dependencies: z.array(z.string()),
  uiContributions: z.array(
    z.object({ slot: z.enum(CAPABILITY_UI_SLOTS), id: z.string(), title: z.string() })
  ),
  /**
   * 本次启动对账里，本能力每条 pi 资源声明的**装配决策**（R4.5）。
   *
   * 空数组的含义是「本进程还没跑过启动对账」（单测、或对账在 describe 之前
   * 尚未完成），不是「没有资源」——两者在渲染层都表现为无可展示的决策，但
   * 前者会在对账跑完后的下一次 describe 里填上。声明了资源却拿到空决策，
   * 说明对账没跑成，那本身就是要看见的事实。
   */
  resourceDecisions: z.array(capabilityResourceDecisionSchema).default([]),
});
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;

export const capabilityStateSchema = z.object({
  activeProfileId: z.string(),
  profiles: z.array(agentProfileSchema),
  capabilities: z.array(capabilityDescriptorSchema),
  /**
   * 主进程侧的启用集合与当前偏好是否已经对不上。
   *
   * 通道注册发生在启动装配期，运行期改偏好**不会**凭空补注册一条通道——
   * 那需要在 `ipcMain.handle` 已经绑过的名字上再绑一次，Electron 直接抛错。
   * 因此这里如实告诉界面「要重启才生效」，而不是假装已经生效。
   */
  restartRequired: z.boolean(),
});
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const capabilityProfileRequestSchema = z.object({ profileId: z.string().min(1) }).strict();
export const capabilityToggleRequestSchema = z
  .object({ capabilityId: z.string().min(1), enabled: z.boolean() })
  .strict();
export type CapabilityProfileRequest = z.infer<typeof capabilityProfileRequestSchema>;
export type CapabilityToggleRequest = z.infer<typeof capabilityToggleRequestSchema>;

// ---------- 通道契约分片（ADR-0002：各分片各自声明，宿主合并时封口） ----------
//
// 能力注册表本身属**平台内核**（四层边界表第一行），因此这三条通道恒注册，
// 不受任何能力开关影响——否则「把能力包全关掉」会连带关掉那个用来把它们
// 打开的入口，而那种状态在界面上只表现为一个再也点不开的开关。
export const capabilitiesContractShard = defineContractShard("kernel-capabilities", {
  [CHANNELS.capabilitiesDescribe]: {
    request: voidRequestSchema,
    response: capabilityStateSchema,
  },
  [CHANNELS.capabilitiesSetProfile]: {
    request: capabilityProfileRequestSchema,
    response: capabilityStateSchema,
  },
  [CHANNELS.capabilitiesSetEnabled]: {
    request: capabilityToggleRequestSchema,
    response: capabilityStateSchema,
  },
});

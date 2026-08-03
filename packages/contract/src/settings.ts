/**
 * 应用设置的唯一定义。
 *
 * 收敛前此形状同时存在于 packages/app/src/main/settings.ts:5-13 与
 * packages/app/src/preload/index.d.ts:28-36 —— 两份声明必然漂移。
 *
 * ## SEC-004：这里不再有任何密钥字段
 *
 * 早先本 schema 有一个字符串形态的转写密钥字段，它同时意味着两件事：
 *   1. 密钥以明文写进 userData/settings.json（settings.ts:30 的 JSON.stringify）
 *   2. `settings:get` 把明文原样回传给渲染进程
 * 只要密钥还在这个 schema 里，这两件事就删不掉。因此 TASK-008 把密钥整体
 * 移出设置：落盘交给 main/secret-store.ts（safeStorage 加密），渲染进程只
 * 看得到 `sttApiKeyConfigured` 与 `sttApiKeyLast4` 这两个**不可逆**的展示位。
 */
import { z } from "zod";

export const appSettingsSchema = z.object({
  /**
   * 设置文件的 schema 代际；旧文件由 main/settings.ts 的 migrate() 补齐。
   *
   * 代际常量 `SETTINGS_SCHEMA_VERSION` 由 main/settings.ts 持有（迁移逻辑在
   * 那里，代际归它管），契约包只声明这个字段的存在与默认值。契约包不能
   * 反向 import app 包，所以这里是一个字面量 —— 改代际时两处一起改。
   */
  schemaVersion: z.number().int().default(2),
  /** 工作目录绝对路径 */
  workspace: z.string().optional(),
  /**
   * 会话 jsonl 的存放目录（等价于 pi 的 --session-dir）。
   * 留空时按 resolveSessionDir 的四级优先链推断；一旦设置，主进程枚举与
   * pi 写入都以它为准，二者不允许各自推断。
   */
  sessionDir: z.string().optional(),
  provider: z.string().optional(),
  modelId: z.string().optional(),
  thinkingLevel: z.string().optional(),
  /**
   * OpenAI 兼容语音转写端点的展示地址。
   *
   * 它**只用于显示与再编辑**：真正发请求时主进程按 `sttEndpointId` 从
   * endpoints.ts 取已校验过的地址，渲染进程无法在一次调用里同时指定
   * 「往哪发」和「带哪把密钥」。写入本字段会先过 normalizeEndpointUrl +
   * assertPublicAddress，不合格直接拒绝、不半落盘。
   */
  sttBaseUrl: z.string().optional(),
  /** 由主进程签发的不透明端点 id；渲染进程只能把它原样回传 */
  sttEndpointId: z.string().optional(),
  /** 是否已配置转写密钥。密钥本体在 secret-store，永不出现在本对象里 */
  sttApiKeyConfigured: z.boolean().default(false),
  /** 已配置密钥的尾四位，仅供界面辨认是哪一把 */
  sttApiKeyLast4: z.string().default(""),
  sttModel: z.string().optional(),
  /**
   * Pi 运行时来源（高级设置）。
   * - bundled：使用应用自带的 pi 运行时（默认，且是唯一被保证可用的形态）
   * - external：使用用户显式指定的外部 pi 命令，失败时**不会**自动回退，
   *   由界面提示用户手动「切回内置」，避免静默改写用户设置。
   *
   * ## SEC-005：本字段与下面的 piExternalCommand **不在渲染进程可写集合里**
   *
   * 它们最终会走到 pi-launcher 的 spawn。只要 `settings:set` 还能写它们，
   * 渲染进程里的任意 JS（XSS / 恶意扩展内容）就等价于「让主进程启动我指定
   * 的任意本机程序」。因此 ipc-contract.ts 的 rendererSettingsPatchSchema
   * 把两项一起 omit 掉，改由 `settings:set-pi-runtime` 承接 —— 那条通道的
   * 入参只有一个 mode 枚举，路径由主进程弹原生文件选择框当面取得。
   *
   * 它们仍留在 APP_SETTINGS_PUBLIC_KEYS 里：那是**只读展示**（设置页要显示
   * 当前用的是哪个运行时、哪个路径），可读与可写是两件事。
   */
  piRuntimeMode: z.enum(["bundled", "external"]).default("bundled"),
  /**
   * external 模式下实际会被 spawn 的可执行文件。
   *
   * 落盘的是**已解析的绝对路径**（用户在原生文件选择框里挑中、并在确认框
   * 里看到的那一个），不是一个待查找的命令名 —— 存命令名的话，用户确认过
   * 的东西和日后真正被执行的东西可以因为 PATH 变化而不是同一个文件。
   */
  piExternalCommand: z.string().optional(),
  /**
   * 崩溃转储的隐私选择（OBS-101）。
   *
   * 默认 `unset`：**没问过就当没同意**。crash dump 是进程内存的快照，里面
   * 可能有用户刚打的任何一个字，脱敏对二进制转储不成立，因此它只在用户
   * 显式选了 allow 之后才会被收进诊断包。
   */
  crashDumpConsent: z.enum(["unset", "allow", "deny"]).default("unset"),

  // ---------------------------------------------- 模型作用域（PROV-101）
  //
  // `provider` / `modelId` 这两个老字段就是**全局默认**，保持原样不动
  // （改名会让所有老设置文件的模型选择在一次升级里凭空消失）。这里只加
  // workspace 层：键是 workspaceId（sha256(canonical realpath) 派生的
  // 不透明 id），不是绝对路径 —— 设置文件里躺一堆真实路径既是隐私泄漏，
  // 也会在用户移动文件夹后全部失配。
  //
  // session 层不在这里：它记在会话文件自己身上，由 pi 负责，PiBuddy 只
  // 负责「不要去覆盖它」。
  workspaceDefaults: z
    .record(z.string(), z.object({ provider: z.string(), modelId: z.string() }))
    .default({}),

  // ------------------------------------------------ 首次启动向导（UX-101）
  //
  // 分成「走到第几步」与「什么时候走完」两个字段，而不是一个布尔：
  // 用户在第 4 步关掉应用再打开时，要从第 4 步继续，而不是从头再来一遍，
  // 也不能被当成「已完成」直接放进主界面（那时候连 provider 都还没配）。
  onboardingStep: z.number().int().min(0).default(0),
  /** 只在最后一步完成时写入。未写入 = 向导没走完，AppShell 不渲染主界面 */
  onboardingCompletedAt: z.number().optional(),
  /** 任务完成后是否发系统通知 */
  notificationsEnabled: z.boolean().default(true),
  /** 是否在输入区显示语音按钮（向导里的可选项） */
  voiceEnabled: z.boolean().default(false),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * 允许下发给渲染进程的设置键（CT-09 的唯一口径）。
 *
 * `settings:get` 的返回值由主进程按本数组挑选字段构造，而不是把 loadSettings()
 * 的结果直接外发 —— 后者一旦将来又混进什么敏感字段，会静默地跟着流出去。
 * 本数组里**没有**任何密钥字段，加一个进来会立刻违反 TASK-008 的收敛断言。
 */
export const APP_SETTINGS_PUBLIC_KEYS = [
  "schemaVersion",
  "workspace",
  "sessionDir",
  "provider",
  "modelId",
  "thinkingLevel",
  "sttBaseUrl",
  "sttEndpointId",
  "sttApiKeyConfigured",
  "sttApiKeyLast4",
  "sttModel",
  "piRuntimeMode",
  "piExternalCommand",
  "crashDumpConsent",
  "workspaceDefaults",
  "onboardingStep",
  "onboardingCompletedAt",
  "notificationsEnabled",
  "voiceEnabled",
] as const;

/**
 * `settings:get` 的返回类型（CT-09 的类型层投影）。
 *
 * 键集合与 `APP_SETTINGS_PUBLIC_KEYS` 由 `Pick` 绑死：往白名单里加一个键，
 * 这个类型自动跟着变；往 schema 里加一个键却忘了加进白名单，那个键就永远
 * 到不了渲染进程 —— 后者是我们要的默认行为（新字段默认不外发）。
 *
 * 主进程侧的构造函数**逐键写出**（包括值为 undefined 的可选键），因此
 * `Object.keys(settings.get())` 是一个与白名单等长的稳定集合，可以被单测
 * 逐项比对；写成「有值才放进去」的话，这个断言会随用户设了哪几项而飘。
 */
export type AppSettingsPublic = Pick<
  AppSettings,
  (typeof APP_SETTINGS_PUBLIC_KEYS)[number]
>;

/** settings:set 的入参：任意子集。 */
export const appSettingsPatchSchema = appSettingsSchema.partial();
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

/**
 * 宽松读取磁盘上的设置：未知字段直接丢弃，单个字段类型不符时回落到 {}。
 * 设置文件被手改坏不应该让应用起不来。
 */
export function parseAppSettings(raw: unknown): AppSettings {
  const parsed = appSettingsSchema.safeParse(raw);
  // 回落到「全部取默认值」而不是 {}：piRuntimeMode 有默认值，
  // 返回裸 {} 会让类型与运行时对不上。
  return parsed.success ? parsed.data : appSettingsSchema.parse({});
}

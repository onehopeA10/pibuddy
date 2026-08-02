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
  schemaVersion: z.number().int().default(1),
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
   */
  piRuntimeMode: z.enum(["bundled", "external"]).default("bundled"),
  /** external 模式下的命令：绝对/相对路径优先，否则在 PATH 中查找 */
  piExternalCommand: z.string().optional(),
  /**
   * 崩溃转储的隐私选择（OBS-101）。
   *
   * 默认 `unset`：**没问过就当没同意**。crash dump 是进程内存的快照，里面
   * 可能有用户刚打的任何一个字，脱敏对二进制转储不成立，因此它只在用户
   * 显式选了 allow 之后才会被收进诊断包。
   */
  crashDumpConsent: z.enum(["unset", "allow", "deny"]).default("unset"),
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
] as const;

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

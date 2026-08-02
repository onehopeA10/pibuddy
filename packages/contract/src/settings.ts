/**
 * 应用设置的唯一定义。
 *
 * 收敛前此形状同时存在于 packages/app/src/main/settings.ts:5-13 与
 * packages/app/src/preload/index.d.ts:28-36 —— 两份声明必然漂移。
 */
import { z } from "zod";

export const appSettingsSchema = z.object({
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
  /** OpenAI 兼容语音转写端点 */
  sttBaseUrl: z.string().optional(),
  sttApiKey: z.string().optional(),
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
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

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

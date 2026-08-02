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
  provider: z.string().optional(),
  modelId: z.string().optional(),
  thinkingLevel: z.string().optional(),
  /** OpenAI 兼容语音转写端点 */
  sttBaseUrl: z.string().optional(),
  sttApiKey: z.string().optional(),
  sttModel: z.string().optional(),
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
  return parsed.success ? parsed.data : {};
}

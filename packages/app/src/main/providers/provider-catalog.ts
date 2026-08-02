/**
 * 内置服务商目录（PROV-101）。
 *
 * ## 这里**只有服务商**，没有一个模型名
 *
 * 模型列表的唯一来源是 pi 的 `get_available_models`（rpc.md:259）。把模型
 * 名单硬编码进来会产生一类不报错的故障：pi 侧新增一个支持图片的模型之后，
 * PiBuddy 仍按旧名单把它判成「不支持图片」，用户拖进去的图被拦住，而
 * typecheck、单测、构建全绿。结构性断言把这件事钉死：
 *
 *     rg -c '<模型名模式>' packages/app/src/main/providers/ \
 *        packages/app/src/renderer/src/stores/providers.ts | wc -l   # 必须为 0
 *
 * 本表回答的是另一个问题：「用户在界面上能看到哪些服务商可以填 key，
 * 填了之后往哪个地址发探测请求」。这两件事 pi 的 RPC 协议不提供，只能
 * 按 docs/providers.md 的对照表落成常量。
 *
 * 表里的 id 与 `~/.pi/agent/auth.json` 的键**必须逐字相同** —— 写错一个字
 * 的后果是「界面显示已配置、pi 那边完全读不到」。
 */
import type { ProviderAuthKind } from "@pibuddy/contract";

export interface CatalogEntry {
  id: string;
  name: string;
  /** api_key 可以在 PiBuddy 里直接配；oauth 必须去终端 `pi` 里 `/login` */
  authKind: ProviderAuthKind;
  /** 连通性探测的基地址；没有可探测端点时缺席 */
  baseUrl?: string;
  /** 申请 key 的页面，界面上给一个「去哪拿 key」的链接 */
  docsUrl?: string;
}

/**
 * 界面上默认展示的服务商。
 *
 * 刻意只放最常用的一批：providers.md 里有三十多个，全列出来会让第一次
 * 打开 Provider 中心的用户面对一堵墙。用户真正需要别的服务商时，「自定义
 * OpenAI 兼容端点」那条路是通的，而且不需要我们改代码。
 */
export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    authKind: "api_key",
    baseUrl: "https://api.anthropic.com/v1",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    authKind: "api_key",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    name: "Google AI Studio",
    authKind: "api_key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    authKind: "api_key",
    baseUrl: "https://api.deepseek.com/v1",
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    authKind: "api_key",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    name: "Groq",
    authKind: "api_key",
    baseUrl: "https://api.groq.com/openai/v1",
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "xai",
    name: "xAI",
    authKind: "api_key",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://console.x.ai",
  },
  {
    id: "mistral",
    name: "Mistral",
    authKind: "api_key",
    baseUrl: "https://api.mistral.ai/v1",
    docsUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "zai",
    name: "Z.AI Coding Plan",
    authKind: "api_key",
    baseUrl: "https://api.z.ai/api/paas/v4",
    docsUrl: "https://z.ai",
  },
  {
    id: "kimi-coding",
    name: "Kimi For Coding",
    authKind: "api_key",
    docsUrl: "https://platform.moonshot.cn",
  },
];

/** id → 探测基地址。没有可探测端点的服务商不在表里。 */
export const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = Object.fromEntries(
  PROVIDER_CATALOG.filter((p) => p.baseUrl).map((p) => [p.id, p.baseUrl!])
);

export function catalogEntry(providerId: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === providerId);
}

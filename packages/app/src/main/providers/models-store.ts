/**
 * `~/.pi/agent/models.json` 里的自定义 provider（PROV-101）。
 *
 * 形状取自 pi 的 docs/models.md：
 *
 *     { "providers": { "<id>": { baseUrl, api, apiKey, models: [{id}, …] } } }
 *
 * 与 auth-store 同一条纪律：**先读再合并**。这份文件里可能已经有用户为
 * Ollama / vLLM / LM Studio 手写的条目，整文件覆盖会让那些本地模型在下一次
 * 开终端跑 pi 时全部消失。
 *
 * ## baseUrl 一律先过 endpoints.ts
 *
 * 渲染进程提交的地址在**落盘之前**经 registerEndpoint
 * （normalizeEndpointUrl + assertPublicAddress）校验并换成不透明 endpointId；
 * provider 允许公网 http / https，内网和云元数据仍拦。被拒的地址一个字节
 * 都不会写进 models.json。没有这一步的话，Provider 中心的「自定义端点」
 * 输入框就是一条把请求（连同 Authorization 头）定向到 `169.254.169.254`
 * 的通用旁路。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderCustomRequest, ProviderModel } from "@pibuddy/contract";

import { registerEndpoint } from "../endpoints.js";
import { writeJsonAtomic } from "../fs-atomic.js";
import { safeFetch } from "../net/outbound-guard.js";
import { backupDir, providerLogger } from "./auth-store.js";

/** models.json 里一个 provider 条目（只建模我们会读写的字段，其余原样保留）。 */
export interface CustomProvider {
  baseUrl: string;
  api: string;
  apiKey?: string;
  models?: { id: string; name?: string; input?: string[]; contextWindow?: number }[];
  [extra: string]: unknown;
}

export interface ModelsFile {
  providers?: Record<string, CustomProvider>;
  [extra: string]: unknown;
}

/** 唯一支持的自定义 API 形态。加第二种要先过一遍威胁模型。 */
export const CUSTOM_PROVIDER_API = "openai-completions";

/**
 * 无鉴权本地服务（Ollama / LM Studio / vLLM）的占位 apiKey。
 *
 * models.md：「keyless local servers should keep a dummy value」——pi 要求
 * 模型在出现在 /model 之前必须有凭据。这个值**不是密钥**，因此界面上不能
 * 因为它存在就把 provider 显示成「已配置」。
 */
export const CUSTOM_PROVIDER_PLACEHOLDER_KEY = "pibuddy-placeholder";

let homeOverride: string | null = null;

/** 仅供单测：把 `~/.pi` 指到临时目录。 */
export function __setModelsStoreHome(dir: string | null): void {
  homeOverride = dir;
}

export function modelsFilePath(): string {
  return path.join(homeOverride ?? os.homedir(), ".pi", "agent", "models.json");
}

/**
 * 覆盖 models.json 前留一份备份，与 auth-store 同一条纪律。
 *
 * 这不是防御性编程，是一次实测事故的修复：真机验证时一条
 * `providers:remove('openai')` 把用户 models.json 里那个 provider 连同它的
 * baseUrl 与内联 apiKey 一起删掉了，而当时**没有任何退路** —— 只是因为
 * 手头恰好留了一份手工副本才恢复回来。
 *
 * models.json 和 auth.json 一样属于用户终端里的 pi：里面可能有为 Ollama /
 * vLLM 手写的本地端点。删错一条的代价是用户得凭记忆把地址和密钥重打一遍。
 *
 * 备份失败**必须抛**：写不出备份就不该动这个文件。
 */
function backupModelsFile(now: number): string | null {
  const source = modelsFilePath();
  if (!fs.existsSync(source)) return null;
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `models.${now}.json`);
  fs.copyFileSync(source, target);
  return target;
}

/** models.json 的唯一写入口：先备份，再原子写。 */
function writeModelsFile(next: ModelsFile, now: number = Date.now()): void {
  const backup = backupModelsFile(now);
  writeJsonAtomic(modelsFilePath(), next);
  providerLogger().info("models_file_written", {
    backedUp: backup !== null,
    providerCount: Object.keys(next.providers ?? {}).length,
  });
}

export function readModelsFile(): ModelsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(modelsFilePath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as ModelsFile;
  } catch {
    return {};
  }
}

/** 全部自定义 provider（id → 条目）。 */
export function listCustomProviders(): Record<string, CustomProvider> {
  const file = readModelsFile();
  const providers = file.providers;
  if (!providers || typeof providers !== "object") return {};
  const out: Record<string, CustomProvider> = {};
  for (const [id, value] of Object.entries(providers)) {
    if (value && typeof value === "object" && typeof value.baseUrl === "string") {
      out[id] = value;
    }
  }
  return out;
}

/**
 * 新增 / 覆盖一个自定义 OpenAI 兼容 provider。
 *
 * `apiKey` 写一个占位串（models.md：「keyless local servers should keep a
 * dummy value」），真正的密钥仍然走 auth.json —— 两份文件各管一件事，
 * 把密钥写进 models.json 会让它在用户分享配置时一起漏出去。
 */
export async function upsertCustomProvider(
  input: ProviderCustomRequest
): Promise<CustomProvider> {
  // 先校验再落盘：被拒的地址一个字节都不写
  const endpoint = await registerEndpoint({ kind: "provider", baseUrl: input.baseUrl });

  const file = readModelsFile();
  const providers = { ...(file.providers ?? {}) };
  const previous = providers[input.id];
  const previousById = new Map((previous?.models ?? []).map((m) => [m.id, m] as const));
  // 编辑时模型列表留空 = 不改已有条目（避免一次保存把 input / 别名抹掉）。
  // 新加端点且没填模型，才允许先落一条空列表，随后用「发现模型」补。
  const modelIds =
    input.models.length > 0 ? input.models : (previous?.models ?? []).map((m) => m.id);
  const entry: CustomProvider = {
    ...(previous ?? {}),
    baseUrl: endpoint.baseUrl,
    api: CUSTOM_PROVIDER_API,
    apiKey: previous?.apiKey ?? CUSTOM_PROVIDER_PLACEHOLDER_KEY,
    name: input.name,
    models: modelIds.map((id) => previousById.get(id) ?? { id }),
  };
  providers[input.id] = entry;
  writeModelsFile({ ...file, providers });
  return entry;
}

/**
 * 标注自定义端点某个模型接受的输入模态（文 / 图 / 图文）：写回该条目的 `input`。
 *
 * 中转 / 自建端点的 `/models` 只回 id，pi 对缺省的 `input` 补成 `["text"]`，
 * 一个明明能看图的模型就被判成「不支持图片」。能力判据仍然只有 `input`
 * （不引入模型名单），这里只是让用户把真实能力写进去。
 *
 * 只动 `text` / `image` 两项：其它模态（audio 之类）用户手写的照样保留。
 * provider / model 不存在时抛错而不是静默 —— 静默的表现是「改了，图还是
 * 发不出去」。
 */
export function setCustomModelInput(
  providerId: string,
  modelId: string,
  modalities: ("text" | "image")[]
): void {
  if (modalities.length === 0) throw new Error("MODEL_INPUT_EMPTY: 至少保留一种输入");
  const file = readModelsFile();
  const providers = { ...(file.providers ?? {}) };
  const entry = providers[providerId];
  if (!entry || typeof entry !== "object" || typeof entry.baseUrl !== "string") {
    throw new Error("PROVIDER_NOT_FOUND: 这个自定义端点已经不在了，请重新添加");
  }
  const models = entry.models ?? [];
  const index = models.findIndex((m) => m.id === modelId);
  if (index < 0) {
    throw new Error(`MODEL_NOT_FOUND: 端点「${providerId}」下没有模型「${modelId}」`);
  }
  const current = models[index];
  const kept = (current.input ?? ["text"]).filter((k) => k !== "image" && k !== "text");
  const ordered = (["text", "image"] as const).filter((k) => modalities.includes(k));
  const input = [...ordered, ...kept];
  const nextModels = models.slice();
  nextModels[index] = { ...current, input };
  providers[providerId] = { ...entry, models: nextModels };
  writeModelsFile({ ...file, providers });
  providerLogger().info("provider_model_input_set", { providerId, modelId, input });
}

/** 删除一个自定义 provider。不存在时是 no-op（不抛）。 */
export function removeCustomProvider(providerId: string): void {
  const file = readModelsFile();
  if (!file.providers || !(providerId in file.providers)) return;
  const providers = { ...file.providers };
  delete providers[providerId];
  writeModelsFile({ ...file, providers });
}

/**
 * 向自定义端点问一次 `GET {baseUrl}/models`，把结果写回 models.json。
 *
 * 出站走 safeFetch（全仓唯一的出站原语）。返回的是**发现到的模型**，
 * 不是一份硬编码名单 —— 名单写进代码之后，用户在自己的 vLLM 上加载一个
 * 新模型，界面会静默地看不见它。
 */
export async function discoverModels(
  providerId: string,
  apiKey?: string
): Promise<ProviderModel[]> {
  const entry = listCustomProviders()[providerId];
  if (!entry) throw new Error("PROVIDER_NOT_FOUND: 这个自定义端点已经不在了，请重新添加");

  const base = entry.baseUrl.replace(/\/+$/, "");
  const resp = await safeFetch(`${base}/models`, {
    method: "GET",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    allowHttp: true,
  });
  if (!resp.ok) {
    throw new Error(`DISCOVER_FAILED: 端点返回 HTTP ${resp.status}`);
  }

  let ids: string[] = [];
  try {
    const json = JSON.parse(resp.bodyText) as { data?: { id?: unknown }[] };
    ids = (json.data ?? [])
      .map((m) => (typeof m?.id === "string" ? m.id : ""))
      .filter((id) => id !== "");
  } catch {
    throw new Error("DISCOVER_FAILED: 端点返回的不是 OpenAI 兼容的模型列表");
  }

  const file = readModelsFile();
  const providers = { ...(file.providers ?? {}) };
  // 保留已有条目里手写的 input / contextWindow 等能力字段：发现到的列表
  // 只有 id，直接覆盖会把用户标注过的多模态能力抹掉。
  const previousById = new Map(
    (providers[providerId]?.models ?? []).map((m) => [m.id, m] as const)
  );
  providers[providerId] = {
    ...(providers[providerId] as CustomProvider),
    models: ids.map((id) => previousById.get(id) ?? { id }),
  };
  writeModelsFile({ ...file, providers });
  providerLogger().info("provider_models_discovered", { providerId, count: ids.length });

  return ids.map((id) => {
    const known = previousById.get(id);
    return {
      id,
      provider: providerId,
      ...(known?.name ? { name: known.name } : {}),
      ...(known?.input ? { input: known.input } : {}),
      ...(known?.contextWindow ? { contextWindow: known.contextWindow } : {}),
    };
  });
}

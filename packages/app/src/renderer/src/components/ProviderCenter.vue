<script setup lang="ts">
/**
 * Provider 与模型中心（PROV-101）。
 *
 * 这个面板存在的全部理由：**让用户不必打开终端**。收敛前设置页里写的是
 * 「在终端里运行 pi 后用 /login」—— 对一个装了桌面应用的人来说，那句话
 * 等价于「这个功能没做」。
 *
 * 三件事在这里是硬约束：
 *   1. key 输入框**只写不回显**，且永远从空开始（留空保存 = 不改动）；
 *   2. OAuth 订阅账号如实显示「需要在终端完成 /login」，不摆一个点了没
 *      反应的按钮；
 *   3. 「测试连接」的失败文案必须带 HTTP 状态码或 errno —— 「连接失败」
 *      对排查毫无帮助。
 */
import { computed, ref, watch } from "vue";
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from "naive-ui";
import type { ModelInputModality, ProviderModel, ProviderTestResult } from "@contract";
import { adviseModelError } from "../model-error-advice";
import { useProvidersStore } from "../stores/providers";
import { useAppStore } from "../stores/app";
import PanelFrame from "./PanelFrame.vue";

defineProps<{ embedded?: boolean }>();

const providers = useProvidersStore();
const app = useAppStore();
const message = useMessage();

/** 正在写回的 `providerId/modelId`；期间所有选项禁用，避免并发写同一个文件。 */
const togglingModel = ref("");

/** 模型接受的输入：文 / 图 / 图文。与 models.json 的 `input` 数组一一对应。 */
type Modality = "text" | "image" | "both";
const MODALITY_OPTIONS: { key: Modality; label: string; title: string }[] = [
  { key: "text", label: "文", title: "只接受文字" },
  { key: "image", label: "图", title: "只接受图片" },
  { key: "both", label: "图文", title: "文字和图片都接受" },
];

function modalityOf(m: ProviderModel): Modality {
  const input = m.input ?? ["text"];
  const text = input.includes("text");
  const image = input.includes("image");
  if (text && image) return "both";
  if (image) return "image";
  return "text";
}

function modalityToInput(key: Modality): ModelInputModality[] {
  if (key === "both") return ["text", "image"];
  return [key];
}

/**
 * 改一个模型接受的输入：写回 models.json，再让 pi 重新载入模型表。
 *
 * pi 只在启动时读 models.json（运行中不监听文件），所以光写盘不会让当前
 * 会话的判定变化 —— 用户改完拖图进来照样被拦，且看不出为什么。
 * 因此写盘成功后原地重启一次运行时（带着当前会话继续）；正在生成时不能
 * 打断，退化为提示「下次开始任务时生效」。
 */
async function setModality(
  providerId: string,
  modelId: string,
  model: ProviderModel,
  key: Modality
): Promise<void> {
  if (modalityOf(model) === key) return;
  togglingModel.value = `${providerId}/${modelId}`;
  try {
    const ok = await providers.setModelInput(providerId, modelId, modalityToInput(key));
    if (!ok) return;
    const label = MODALITY_OPTIONS.find((o) => o.key === key)?.label ?? key;
    if (app.started && !app.streaming) {
      message.info("已保存，正在重新载入模型表…");
      const reloaded = await app.reloadRuntime();
      if (reloaded) {
        message.success(`「${modelId}」现在接受：${label}`);
      } else {
        message.warning(`已保存，但重新载入失败：${app.startError || "未知原因"}`);
      }
    } else {
      message.success("已保存，下次开始任务时生效");
    }
  } finally {
    togglingModel.value = "";
  }
}

/** providerId → 当前输入框里的明文。**不持久化**，关面板即丢。 */
const keyInputs = ref<Record<string, string>>({});
const savingId = ref("");
/** 正在等待二次确认的 providerId。删除是不可逆的，不给二次确认就是在设陷阱。 */
const confirmingId = ref("");

const tab = ref<"official" | "api">("official");

/** 官方：目录里的 API Key 服务商。订阅账号（OAuth）不是这种形态，不混进来。 */
const officialProviders = computed(() =>
  providers.providers.filter((p) => !p.custom && p.authKind === "api_key")
);
/** API 格式：写在 models.json 里的 OpenAI 兼容端点，可改地址 / 模型列表。 */
const apiProviders = computed(() => providers.providers.filter((p) => p.custom));
const oauthProviders = computed(() =>
  providers.providers.filter((p) => !p.custom && p.authKind === "oauth")
);

interface ApiDraft {
  name: string;
  baseUrl: string;
  modelsText: string;
  key: string;
}
const drafts = ref<Record<string, ApiDraft>>({});

function emptyDraft(p: { name: string; baseUrl?: string; models: { id: string }[] }): ApiDraft {
  return {
    name: p.name,
    baseUrl: p.baseUrl ?? "",
    modelsText: p.models.map((m) => m.id).join("\n"),
    key: "",
  };
}

function draftOf(id: string): ApiDraft {
  return drafts.value[id] ?? emptyDraft({ name: "", models: [] });
}

function officialModels(providerId: string): string[] {
  return app.models.filter((m) => m.provider === providerId).map((m) => m.id);
}

const OFFICIAL_DOCS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/apikey",
  deepseek: "https://platform.deepseek.com/api_keys",
  openrouter: "https://openrouter.ai/keys",
  groq: "https://console.groq.com/keys",
  xai: "https://console.x.ai",
  mistral: "https://console.mistral.ai/api-keys",
  zai: "https://z.ai",
  "kimi-coding": "https://platform.moonshot.cn",
};

async function reloadAfterWrite(saved: string): Promise<void> {
  if (app.started && !app.streaming) {
    message.info(`${saved}，正在让 pi 重新读配置…`);
    const reloaded = await app.reloadRuntime();
    if (reloaded) message.success(`${saved}，已生效`);
    else message.warning(`${saved}，但重新载入失败：${app.startError || "未知原因"}`);
    return;
  }
  message.success(`${saved}，下次开始任务时生效`);
}

async function doRemove(providerId: string): Promise<void> {
  confirmingId.value = "";
  await providers.remove(providerId);
}

// 自定义 OpenAI 兼容端点
const customId = ref("");
const customName = ref("");
const customBaseUrl = ref("");
const customModels = ref("");
const addingCustom = ref(false);

watch(
  () => providers.panelOpen,
  (open) => {
    if (!open) {
      // 明文一律不跨面板存活
      keyInputs.value = {};
      drafts.value = {};
      return;
    }
    void providers.refresh();
  },
  { immediate: true }
);

watch(
  () => providers.providers,
  (list) => {
    const next = { ...drafts.value };
    for (const p of list.filter((x) => x.custom)) {
      if (!next[p.id]) next[p.id] = emptyDraft(p);
    }
    drafts.value = next;
  },
  { immediate: true }
);

async function saveKey(providerId: string): Promise<void> {
  const value = (keyInputs.value[providerId] ?? "").trim();
  if (value === "") return;
  savingId.value = providerId;
  const ok = await providers.saveKey(providerId, value);
  savingId.value = "";
  if (ok) {
    keyInputs.value = { ...keyInputs.value, [providerId]: "" };
    // 存完立刻测一次：用户填错一个字符时，最有用的反馈是马上告诉他，
    // 而不是等到他发出第一条消息才报 401。
    await providers.test(providerId);
  }
}

async function saveOfficial(providerId: string): Promise<void> {
  const ok = await saveKey(providerId);
  if (ok) await reloadAfterWrite("已写入 ~/.pi/agent/auth.json");
}

async function addCustom(): Promise<void> {
  addingCustom.value = true;
  const ok = await providers.addCustom({
    id: customId.value.trim(),
    name: customName.value.trim() || customId.value.trim(),
    baseUrl: customBaseUrl.value.trim(),
    models: customModels.value
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  });
  addingCustom.value = false;
  if (ok) {
    customId.value = "";
    customName.value = "";
    customBaseUrl.value = "";
    customModels.value = "";
    await reloadAfterWrite("已写入 ~/.pi/agent/models.json");
  }
}

async function discoverAndSync(providerId: string): Promise<void> {
  const ok = await providers.discoverModels(providerId);
  if (!ok) return;
  const fresh = providers.providers.find((p) => p.id === providerId);
  if (!fresh) return;
  drafts.value = {
    ...drafts.value,
    [providerId]: { ...draftOf(providerId), modelsText: fresh.models.map((m) => m.id).join("\n") },
  };
}

async function saveApi(providerId: string): Promise<void> {
  const draft = draftOf(providerId);
  if (!draft.baseUrl.trim()) return;
  savingId.value = providerId;
  const written = await providers.addCustom({
    id: providerId,
    name: draft.name.trim() || providerId,
    baseUrl: draft.baseUrl.trim(),
    models: draft.modelsText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  });
  if (written && draft.key.trim()) {
    await providers.saveKey(providerId, draft.key.trim());
    drafts.value = { ...drafts.value, [providerId]: { ...draft, key: "" } };
  }
  savingId.value = "";
  if (written) {
    await providers.test(providerId);
    await reloadAfterWrite("已写入 ~/.pi/agent/models.json");
  }
}

/**
 * 失败 errorCode → 一句可操作的中文。
 *
 * **不在这里另写一张表**：errorCode 除 `model` 外逐字就是 `ModelErrorKind`
 *（见契约里 PROVIDER_TEST_ERROR_CODES 的说明），因此直接问 model-error-advice
 * 要那句话。两边词汇一旦分叉，下面这行 `adviseModelError(code)` 编译不过 ——
 * 这是本文件里唯一能防住「同一个错误在两个界面上被说成两件事」的机制。
 *
 * `title` 说的是**发生了什么**，`hint` 说的是**现在该做什么**。测试连接的结果
 * 行两句都要：只给前者等于回到「连接失败」那种没内容的话。
 */
function testHint(code: ProviderTestResult["errorCode"]): string {
  if (!code) return "未知问题";
  // 探测路径特有的一类，不在 ModelErrorKind 里
  if (code === "model") return "端点地址或模型名不对——检查 baseUrl 与模型名";
  const advice = adviseModelError(code);
  return `${advice.title}——${advice.hint}`;
}

/**
 * 「测试连接」的结果文案。
 *
 * 成功时必须含「成功」，失败时必须含 HTTP 状态码或 errno —— 这两条是
 * 可证伪的验收判据，也是用户真正需要的信息。
 */
function testText(providerId: string): string {
  const state = providers.tests[providerId];
  if (!state || state.pending) return "";
  const result = state.result;
  if (!result) return "";
  if (result.ok) return `连接成功（${result.latencyMs}ms）`;
  const detail = result.redactedMessage ?? "";
  return `连接失败：${testHint(result.errorCode)}${detail ? ` · ${detail}` : ""}`;
}

/** 当前模型能力标签，展示 context 与单价，供用户判断该不该用它。 */
const currentCapabilities = computed(() => {
  const model = app.currentModel;
  if (!model) return null;
  return {
    id: model.id,
    image: (model.input ?? []).includes("image"),
    modality: MODALITY_OPTIONS.find((o) => o.key === modalityOf(model))?.label ?? "文",
    reasoning: model.reasoning === true,
    contextWindow: model.contextWindow ?? 0,
    cost: model.cost,
  };
});
</script>

<template>
  <PanelFrame
    :embedded="embedded"
    :show="providers.panelOpen"
    title="模型"
    width="720px"
    @update:show="providers.panelOpen = $event"
  >
    <p id="provider-center-title" class="intro">
      只支持两种配法：官方服务商的 API Key，或 OpenAI 兼容的接口地址。
      保存后写入本机 <code>~/.pi/agent/auth.json</code> 与
      <code>~/.pi/agent/models.json</code>，pi 下次读配置就会用到。
    </p>

    <n-alert
      v-if="!providers.permissionEnforced"
      type="warning"
      title="此平台无法限制文件权限"
      style="margin-bottom: 12px"
    >
      Windows 上无法把密钥文件收紧到「仅本人可读」（0600 对 NTFS 权限无效）。
      如果这台电脑有其他账户，请留意 <code>~/.pi/agent/auth.json</code> 可能被他们读到。
    </n-alert>

    <n-alert v-if="providers.lastError" type="error" title="操作被拒绝" style="margin-bottom: 12px">
      <p style="white-space: pre-wrap; margin: 0">{{ providers.lastError }}</p>
    </n-alert>

    <div v-if="currentCapabilities" class="caps" data-testid="model-capabilities">
      <span class="caps-label">当前模型</span>
      <n-tag size="small" :bordered="false">{{ currentCapabilities.id }}</n-tag>
      <n-tag size="small" :bordered="false" :type="currentCapabilities.image ? 'success' : 'default'">
        输入：{{ currentCapabilities.modality }}
      </n-tag>
      <n-tag v-if="currentCapabilities.reasoning" size="small" :bordered="false" type="info">
        支持深度思考
      </n-tag>
      <n-tag v-if="currentCapabilities.contextWindow" size="small" :bordered="false">
        记忆容量 {{ Math.round(currentCapabilities.contextWindow / 1000) }}K
      </n-tag>
      <n-tag v-if="currentCapabilities.cost?.input" size="small" :bordered="false">
        输入 ${{ currentCapabilities.cost.input }}/M
      </n-tag>
    </div>

    <n-tabs v-model:value="tab" type="segment" size="small" class="kind-tabs">
      <n-tab-pane name="official" tab="官方">
        <article v-for="p in officialProviders" :key="p.id" class="kind-card">
          <header class="kind-head">
            <strong>{{ p.name }}</strong>
            <n-tag v-if="p.configured" size="small" type="success" :bordered="false">
              已配置 ····{{ p.last4 || "????" }}
            </n-tag>
            <n-tag v-else size="small" :bordered="false">未配置</n-tag>
            <a v-if="OFFICIAL_DOCS[p.id]" class="docs" :href="OFFICIAL_DOCS[p.id]" target="_blank" rel="noreferrer">
              申请 Key
            </a>
          </header>
          <n-form label-placement="left" label-width="88">
            <n-form-item label="接口">
              <span class="path-text">{{ p.baseUrl || "官方默认地址" }}</span>
            </n-form-item>
            <n-form-item label="API Key">
              <n-input
                v-model:value="keyInputs[p.id]"
                type="password"
                show-password-on="click"
                :placeholder="p.configured ? '留空则不改动' : '粘贴你的 API Key'"
                :aria-label="`${p.name} 的 API Key`"
              />
            </n-form-item>
          </n-form>
          <n-space justify="end">
            <n-button
              size="small"
              :disabled="!p.configured"
              :title="'只清除这个服务商的 API Key（删除前会自动备份）'"
              @click="confirmingId = confirmingId === p.id ? '' : p.id"
            >
              清除 Key
            </n-button>
            <template v-if="confirmingId === p.id">
              <span class="confirm-hint" :data-testid="`confirm-${p.id}`">确定要清除这把 Key 吗？</span>
              <n-button size="small" type="error" @click="doRemove(p.id)">确定删除</n-button>
            </template>
            <n-button
              size="small"
              :disabled="!p.configured"
              :loading="providers.tests[p.id]?.pending"
              @click="providers.test(p.id)"
            >
              测试连接
            </n-button>
            <n-button
              size="small"
              type="primary"
              :loading="savingId === p.id"
              :disabled="!(keyInputs[p.id] ?? '').trim()"
              @click="saveOfficial(p.id)"
            >
              保存
            </n-button>
          </n-space>
          <p
            v-if="testText(p.id)"
            class="test-result"
            :data-testid="`test-result-${p.id}`"
            :class="{ ok: providers.tests[p.id]?.result?.ok }"
          >
            {{ testText(p.id) }}
          </p>
          <p v-if="officialModels(p.id).length" class="models">
            可用模型：{{ officialModels(p.id).join("、") }}
          </p>
        </article>
        <p v-if="oauthProviders.length" class="oauth-note">
          订阅账号（{{ oauthProviders.map((p) => p.name).join("、") }}）桌面里还不能直接登录。
          打开终端输入 pi，再输入 /login。
        </p>
      </n-tab-pane>

      <n-tab-pane name="api" tab="API 接口">
        <p class="intro">
          OpenAI 兼容格式。改地址或模型列表会写入
          <code>~/.pi/agent/models.json</code>，Key 写入
          <code>~/.pi/agent/auth.json</code>。http / https 都可以，但不能指向内网。
        </p>
        <article v-for="p in apiProviders" :key="p.id" class="kind-card">
          <header class="kind-head">
            <strong>{{ p.name }}</strong>
            <n-tag size="small" type="info" :bordered="false">{{ p.id }}</n-tag>
            <n-tag v-if="p.configured" size="small" type="success" :bordered="false">
              已配置 ····{{ p.last4 || "????" }}
            </n-tag>
            <n-tag v-else size="small" :bordered="false">未配置</n-tag>
          </header>
          <n-form label-placement="left" label-width="88">
            <n-form-item label="显示名">
              <n-input :value="draftOf(p.id).name" @update:value="drafts[p.id] = { ...draftOf(p.id), name: $event }" />
            </n-form-item>
            <n-form-item label="接口地址">
              <n-input
                :value="draftOf(p.id).baseUrl"
                placeholder="https://example.com/v1 或 http://host:port/v1"
                @update:value="drafts[p.id] = { ...draftOf(p.id), baseUrl: $event }"
              />
            </n-form-item>
            <n-form-item label="API Key">
              <n-input
                :value="draftOf(p.id).key"
                type="password"
                show-password-on="click"
                :placeholder="p.configured ? '留空则不改动' : '粘贴 API Key'"
                @update:value="drafts[p.id] = { ...draftOf(p.id), key: $event }"
              />
            </n-form-item>
            <n-form-item label="模型列表">
              <n-input
                :value="draftOf(p.id).modelsText"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 8 }"
                placeholder="每行一个模型 id；留空再保存则保留现有列表"
                @update:value="drafts[p.id] = { ...draftOf(p.id), modelsText: $event }"
              />
            </n-form-item>
          </n-form>
          <n-space justify="end">
            <n-button
              size="small"
              :title="'会一并删掉这个自定义端点的地址与模型列表（删除前会自动备份）'"
              @click="confirmingId = confirmingId === p.id ? '' : p.id"
            >
              删除这个端点
            </n-button>
            <template v-if="confirmingId === p.id">
              <span class="confirm-hint" :data-testid="`confirm-${p.id}`">
                确定要删掉这个自定义端点吗？地址和模型列表会一起消失。
              </span>
              <n-button size="small" type="error" @click="doRemove(p.id)">确定删除</n-button>
            </template>
            <n-button size="small" :loading="providers.tests[p.id]?.pending" @click="providers.test(p.id)">
              测试连接
            </n-button>
            <n-button size="small" @click="discoverAndSync(p.id)">发现模型</n-button>
            <n-button
              size="small"
              type="primary"
              :loading="savingId === p.id"
              :disabled="!draftOf(p.id).baseUrl.trim()"
              @click="saveApi(p.id)"
            >
              保存到 pi
            </n-button>
          </n-space>
          <p
            v-if="testText(p.id)"
            class="test-result"
            :data-testid="`test-result-${p.id}`"
            :class="{ ok: providers.tests[p.id]?.result?.ok }"
          >
            {{ testText(p.id) }}
          </p>
          <div v-if="p.models.length" class="model-list" :data-testid="`models-${p.id}`">
            <div class="model-list-head">
              <span>已写入的模型</span>
              <span class="model-list-hint">输入</span>
            </div>
            <div v-for="m in p.models" :key="m.id" class="model-row">
              <span class="model-id" :title="m.name ? `${m.name}（${m.id}）` : m.id">
                {{ m.id }}
                <span v-if="m.name && m.name !== m.id" class="model-name">{{ m.name }}</span>
              </span>
              <div
                class="modality-seg"
                role="radiogroup"
                :aria-label="`${m.id} 接受的输入`"
                :class="{ busy: togglingModel === `${p.id}/${m.id}` }"
              >
                <button
                  v-for="opt in MODALITY_OPTIONS"
                  :key="opt.key"
                  type="button"
                  role="radio"
                  class="modality-opt"
                  :class="{ on: modalityOf(m) === opt.key }"
                  :aria-checked="modalityOf(m) === opt.key"
                  :disabled="togglingModel !== ''"
                  :title="opt.title"
                  @click="setModality(p.id, m.id, m, opt.key)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>
          </div>
        </article>

        <article class="kind-card add-card">
          <header class="kind-head"><strong>添加 API 接口</strong></header>
          <n-form label-placement="left" label-width="88">
            <n-form-item label="标识">
              <n-input v-model:value="customId" placeholder="my-endpoint（小写字母、数字、- _ .）" />
            </n-form-item>
            <n-form-item label="显示名">
              <n-input v-model:value="customName" placeholder="我的中转服务" />
            </n-form-item>
            <n-form-item label="接口地址">
              <n-input v-model:value="customBaseUrl" placeholder="https://example.com/v1 或 http://host:port/v1" />
            </n-form-item>
            <n-form-item label="模型列表">
              <n-input
                v-model:value="customModels"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 5 }"
                placeholder="每行一个模型名，留空则保存后点「发现模型」"
              />
            </n-form-item>
            <n-space justify="end">
              <n-button
                type="primary"
                size="small"
                :loading="addingCustom"
                :disabled="!customId.trim() || !customBaseUrl.trim()"
                @click="addCustom"
              >
                添加并写入 pi
              </n-button>
            </n-space>
          </n-form>
        </article>
      </n-tab-pane>
    </n-tabs>

    <n-space v-if="!embedded" justify="end" style="margin-top: 12px">
      <n-button @click="providers.panelOpen = false">关闭</n-button>
    </n-space>
  </PanelFrame>
</template>

<style scoped>
.intro {
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
  margin: 0 0 12px;
  line-height: 1.6;
}
.kind-tabs {
  margin-top: 4px;
}
.kind-card {
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  padding: 14px 16px;
  margin-bottom: 12px;
}
.kind-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.docs {
  margin-left: auto;
  font-size: var(--font-ui-12);
  color: var(--accent);
  text-decoration: none;
}
.docs:hover {
  text-decoration: underline;
}
.path-text {
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
  word-break: break-all;
}
.oauth-note {
  font-size: var(--font-ui-12);
  color: var(--text-tertiary);
  line-height: 1.6;
}
.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 12px;
}
.caps-label {
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
}
.confirm-hint {
  font-size: var(--font-ui-12);
  color: var(--status-error);
  align-self: center;
}
.test-result {
  margin: 8px 0 0;
  font-size: var(--font-ui-12);
  color: var(--status-error);
  white-space: pre-wrap;
}
.test-result.ok {
  color: var(--status-success);
}
.models {
  margin: 8px 0 0;
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
}
.model-list {
  margin: 10px 0 0;
  border-top: var(--border-w) solid var(--border-subtle);
  padding-top: 6px;
}
.model-list-head {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-ui-11);
  color: var(--text-tertiary);
  padding: 2px 0 4px;
}
.model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  font-size: var(--font-ui-12);
  color: var(--text-primary);
}
.model-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-name {
  margin-left: 6px;
  color: var(--text-tertiary);
}
.modality-seg {
  display: inline-flex;
  flex-shrink: 0;
  border: var(--border-w) solid var(--border-subtle);
  border-radius: 999px;
  overflow: hidden;
}
.modality-seg.busy {
  opacity: 0.6;
}
.modality-opt {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-ui-12);
  padding: 2px 10px;
  cursor: pointer;
}
.modality-opt + .modality-opt {
  border-left: var(--border-w) solid var(--border-subtle);
}
.modality-opt:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.modality-opt.on {
  background: var(--accent-subtle);
  color: var(--accent);
}
.modality-opt:disabled {
  cursor: default;
}
</style>

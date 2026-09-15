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
  NCollapse,
  NCollapseItem,
  NForm,
  NFormItem,
  NInput,
  NSpace,
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
      return;
    }
    void providers.refresh();
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
    title="账号与模型"
    width="720px"
    @update:show="providers.panelOpen = $event"
  >
    <p id="provider-center-title" class="intro">
      在这里填写 AI 服务商的 API Key，填好就能直接用 —— 不需要打开终端。
      密钥保存在你自己电脑上的 <code>~/.pi/agent/auth.json</code>，PiBuddy 不会上传它。
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

    <n-collapse accordion>
      <n-collapse-item
        v-for="p in providers.providers"
        :key="p.id"
        :name="p.id"
      >
        <template #header>
          <n-space align="center" :size="8">
            <strong>{{ p.name }}</strong>
            <n-tag v-if="p.configured" size="small" type="success" :bordered="false">
              已配置 ····{{ p.last4 || "????" }}
            </n-tag>
            <n-tag v-else size="small" :bordered="false">未配置</n-tag>
            <n-tag v-if="p.custom" size="small" type="info" :bordered="false">自定义端点</n-tag>
            <n-tag v-if="p.authKind === 'oauth'" size="small" type="warning" :bordered="false">
              订阅账号
            </n-tag>
          </n-space>
        </template>

        <!--
          OAuth 订阅（Claude Pro/Max、Codex、Copilot…）本轮**不支持端内登录**：
          那是 pi 的交互式 TUI 流程，RPC 协议里没有对应命令。如实说明，而不是
          摆一个点了没反应的「登录」按钮 —— 后者会让用户以为是自己操作错了。
        -->
        <n-alert v-if="p.authKind === 'oauth'" type="info" :bordered="false">
          {{ p.name }} 用的是订阅账号，桌面里还不能直接弹出登录页。按这三步即可：
          打开系统终端，输入 pi 回车，再输入 /login 并选 {{ p.name }}。
          登完回到这里点刷新，就会变成已配置。
        </n-alert>

        <n-form v-else label-placement="left" label-width="88">
          <n-form-item label="API Key">
            <n-input
              v-model:value="keyInputs[p.id]"
              type="password"
              show-password-on="click"
              :placeholder="p.configured ? '留空则不改动' : '粘贴你的 API Key'"
              :aria-label="`${p.name} 的 API Key`"
            />
          </n-form-item>
          <n-space justify="end">
            <!--
              删除对自定义端点来说是**连 baseUrl 一起删**（那条记录整个从
              models.json 里消失）。按钮文案必须说清楚这件事：真机验证时
              一次误点就把本机 models.json 里的一个 provider 连同地址与密钥
              一起删掉了。现在写盘前会留备份，但文案仍然要诚实。
            -->
            <n-button
              size="small"
              :disabled="!p.configured && !p.custom"
              :title="
                p.custom
                  ? '会一并删掉这个自定义端点的地址与模型列表（删除前会自动备份）'
                  : '只清除这个服务商的 API Key（删除前会自动备份）'
              "
              @click="confirmingId = confirmingId === p.id ? '' : p.id"
            >
              {{ p.custom ? "删除这个端点" : "清除 Key" }}
            </n-button>
            <template v-if="confirmingId === p.id">
              <span class="confirm-hint" :data-testid="`confirm-${p.id}`">
                {{
                  p.custom
                    ? "确定要删掉这个自定义端点吗？地址和模型列表会一起消失。"
                    : "确定要清除这把 Key 吗？"
                }}
              </span>
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
              v-if="p.custom"
              size="small"
              @click="providers.discoverModels(p.id)"
            >
              发现模型
            </n-button>
            <n-button
              size="small"
              type="primary"
              :loading="savingId === p.id"
              :disabled="!(keyInputs[p.id] ?? '').trim()"
              @click="saveKey(p.id)"
            >
              保存
            </n-button>
          </n-space>
        </n-form>

        <p
          v-if="testText(p.id)"
          class="test-result"
          :data-testid="`test-result-${p.id}`"
          :class="{ ok: providers.tests[p.id]?.result?.ok }"
        >
          {{ testText(p.id) }}
        </p>

        <!--
          自定义端点的模型逐条列出并带「能收图片」开关：中转 / 自建端点的
          /models 只回 id，pi 对缺省的 input 补成 ["text"]，一个明明能看图的
          grok / gpt 中转模型就会被判成「不支持图片」。开关写回的是 models.json
          里那条模型的 input —— 能力判据仍然只有 Model.input，不另存名单。
        -->
        <div v-if="p.custom && p.models.length" class="model-list" :data-testid="`models-${p.id}`">
          <div class="model-list-head">
            <span>可用模型</span>
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
        <p v-else-if="p.models.length" class="models">
          可用模型：{{ p.models.map((m) => m.id).join("、") }}
        </p>
      </n-collapse-item>
    </n-collapse>

    <n-collapse style="margin-top: 12px">
      <n-collapse-item title="添加自定义接口（OpenAI 兼容）" name="custom">
        <p class="intro">
          适用于 Ollama、vLLM、LM Studio 或任何 OpenAI 兼容的中转服务。
          地址必须是 https，且不能指向内网 —— 否则会被安全策略拒绝。
        </p>
        <n-form label-placement="left" label-width="88">
          <n-form-item label="标识">
            <n-input v-model:value="customId" placeholder="my-endpoint（小写字母、数字、- _ .）" />
          </n-form-item>
          <n-form-item label="显示名">
            <n-input v-model:value="customName" placeholder="我的中转服务" />
          </n-form-item>
          <n-form-item label="接口地址">
            <n-input v-model:value="customBaseUrl" placeholder="https://example.com/v1" />
          </n-form-item>
          <n-form-item label="模型列表">
            <n-input
              v-model:value="customModels"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              placeholder="每行一个模型名，留空则保存后点「发现模型」自动获取"
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
              添加
            </n-button>
          </n-space>
        </n-form>
      </n-collapse-item>
    </n-collapse>

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
  border-radius: var(--radius-m);
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

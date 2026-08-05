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
  NModal,
  NSpace,
  NTag,
} from "naive-ui";
import type { ProviderTestResult } from "@contract";
import { adviseModelError } from "../model-error-advice";
import { useProvidersStore } from "../stores/providers";
import { useAppStore } from "../stores/app";

const providers = useProvidersStore();
const app = useAppStore();

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
    reasoning: model.reasoning === true,
    contextWindow: model.contextWindow ?? 0,
    cost: model.cost,
  };
});
</script>

<template>
  <n-modal
    v-model:show="providers.panelOpen"
    preset="card"
    style="max-width: 720px"
    title="账号与模型"
    role="dialog"
    aria-labelledby="provider-center-title"
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
        {{ currentCapabilities.image ? "支持图片" : "不支持图片" }}
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
          这是订阅制账号，登录流程需要在终端里完成：运行 <code>pi</code> 后输入
          <code>/login</code> 并选择 {{ p.name }}。登录后回到这里就会显示为已配置。
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

        <p v-if="p.models.length" class="models">
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

    <n-space justify="end" style="margin-top: 12px">
      <n-button @click="providers.panelOpen = false">关闭</n-button>
    </n-space>
  </n-modal>
</template>

<style scoped>
.intro {
  font-size: 12.5px;
  color: #8a8f98;
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
  font-size: 12px;
  color: #8a8f98;
}
.confirm-hint {
  font-size: 12px;
  color: #d03050;
  align-self: center;
}
.test-result {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: #d03050;
  white-space: pre-wrap;
}
.test-result.ok {
  color: #18a058;
}
.models {
  margin: 8px 0 0;
  font-size: 12px;
  color: #8a8f98;
}
</style>

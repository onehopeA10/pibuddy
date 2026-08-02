<script setup lang="ts">
import { ref, watch } from "vue";
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NRadio,
  NRadioGroup,
  NSpace,
  useMessage,
} from "naive-ui";
import { useAppStore } from "../stores/app";
import { useProvidersStore } from "../stores/providers";
import UpdateSettingsPanel from "./UpdateSettingsPanel.vue";
import DiagnosticsPanel from "./DiagnosticsPanel.vue";

const store = useAppStore();
const providers = useProvidersStore();
const message = useMessage();

/**
 * 打开账号中心 / 用量页。
 *
 * 先关设置弹窗再开另一个 —— 两层 modal 叠在一起时，Esc 只关得掉最上面
 * 那个，而焦点会回到一个已经被遮住的元素上。
 */
function openProviders(): void {
  store.settingsOpen = false;
  providers.panelOpen = true;
}

function openUsage(): void {
  store.settingsOpen = false;
  providers.usagePanelOpen = true;
}

const sttBaseUrl = ref("");
/**
 * 密钥输入框**永远从空开始**。
 *
 * 早先它是 `store.settings.sttApiKey ?? ""` —— 那要求 settings:get 把明文
 * 回传给渲染进程，也就是 SEC-004 的缺口本身。现在渲染进程拿不到明文，
 * 只用下面的 secretHint 显示「已配置 ····尾四位」。留空保存 = 不改动密钥。
 */
const sttApiKeyInput = ref("");
const secretHint = ref("");
const sttModel = ref("");
const piRuntimeMode = ref<"bundled" | "external">("bundled");
const piExternalCommand = ref("");

watch(
  () => store.settingsOpen,
  (open) => {
    if (open) {
      sttBaseUrl.value = store.settings.sttBaseUrl ?? "";
      sttApiKeyInput.value = "";
      secretHint.value = store.settings.sttApiKeyConfigured
        ? `已配置 ····${store.settings.sttApiKeyLast4 || "????"}（留空则不改动）`
        : "";
      sttModel.value = store.settings.sttModel ?? "";
      piRuntimeMode.value = store.settings.piRuntimeMode ?? "bundled";
      piExternalCommand.value = store.settings.piExternalCommand ?? "";
    }
  }
);

const saveError = ref("");

async function save(): Promise<void> {
  saveError.value = "";
  try {
    // 端点先保存：地址不合格（非 HTTPS / 指向内网）时这一步就抛，
    // 密钥与其余字段一个都不会落盘。
    await store.saveSettings({
      sttBaseUrl: sttBaseUrl.value.trim(),
      sttModel: sttModel.value.trim(),
      piRuntimeMode: piRuntimeMode.value,
      piExternalCommand: piExternalCommand.value.trim(),
    });
    if (sttApiKeyInput.value.trim() !== "") {
      await store.saveSttSecret(sttApiKeyInput.value.trim());
    }
  } catch (err) {
    // 主进程的 OUTBOUND_BLOCKED / SECRET_STORE_UNAVAILABLE 消息本身就是
    // 给人看的，原样展示，不要换成一句「保存失败」。
    saveError.value = err instanceof Error ? err.message : String(err);
    message.error(saveError.value);
    return;
  }
  message.success("设置已保存");
  store.settingsOpen = false;
}

/** 只有点这个按钮才会把 piRuntimeMode 写回 bundled —— 启动失败本身不写设置。 */
async function backToBundled(): Promise<void> {
  piRuntimeMode.value = "bundled";
  await store.switchToBundledRuntime();
  message.success("已切回内置运行时");
  store.settingsOpen = false;
}
</script>

<template>
  <n-modal
    v-model:show="store.settingsOpen"
    preset="card"
    style="max-width: 560px"
    title="设置"
  >
    <n-form label-placement="left" label-width="110">
      <n-form-item label="工作文件夹">
        <n-space align="center">
          <span style="font-size: 13px; color: #4b5563">{{ store.workspace || "未选择" }}</span>
          <n-button size="small" @click="store.chooseWorkspace()">更换</n-button>
        </n-space>
      </n-form-item>

      <div style="margin: 4px 0 12px; font-size: 12.5px; color: #8a8f98">
        语音识别（可选）：填写任意 OpenAI 兼容的转写接口，配置后即可用麦克风说话输入。
        例如 OpenAI（whisper-1）、SiliconFlow、Groq 等。
      </div>

      <n-form-item label="接口地址">
        <n-input v-model:value="sttBaseUrl" placeholder="https://api.openai.com/v1" />
      </n-form-item>
      <n-form-item label="API Key">
        <n-input
          v-model:value="sttApiKeyInput"
          type="password"
          show-password-on="click"
          placeholder="sk-…"
        />
      </n-form-item>
      <div
        v-if="secretHint"
        style="margin: -8px 0 12px 110px; font-size: 12px; color: #8a8f98"
      >
        {{ secretHint }}
      </div>
      <n-form-item label="识别模型">
        <n-input v-model:value="sttModel" placeholder="whisper-1" />
      </n-form-item>

      <div style="margin: 12px 0 8px; font-size: 12.5px; color: #8a8f98">
        高级：Pi 运行时。默认使用应用自带的版本，不需要在电脑上单独安装 pi。
        只有明确知道自己在做什么时才改成「外部命令」。
      </div>

      <n-form-item label="Pi 运行时">
        <n-radio-group v-model:value="piRuntimeMode">
          <n-space>
            <n-radio value="bundled">内置（推荐）</n-radio>
            <n-radio value="external">外部命令</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>

      <n-form-item v-if="piRuntimeMode === 'external'" label="命令路径">
        <n-input
          v-model:value="piExternalCommand"
          placeholder="例如 D:\\tools\\pi\\bin\\pi 或 PATH 中的命令名"
        />
      </n-form-item>
    </n-form>

    <n-alert v-if="saveError" type="error" title="保存被拒绝" style="margin-bottom: 12px">
      <p style="white-space: pre-wrap; margin: 0">{{ saveError }}</p>
    </n-alert>

    <n-alert
      v-if="store.startError && store.settings.piRuntimeMode === 'external'"
      type="error"
      title="外部 Pi 运行时启动失败"
      style="margin-bottom: 12px"
    >
      <p style="white-space: pre-wrap; margin: 0 0 8px">{{ store.startError }}</p>
      <n-button size="small" type="primary" @click="backToBundled">切回内置</n-button>
    </n-alert>

    <!--
      收敛前这里写的是「对话模型的账号在终端里运行 pi 后用 /login 配置」。
      对一个装了桌面应用的人来说，那句话等价于「这个功能没做」——
      PROV-101 的核心价值就是消灭这一步。现在给的是两个能点的入口。
    -->
    <n-space style="margin: 4px 0 16px">
      <n-button @click="openProviders">🔑 账号与模型</n-button>
      <n-button @click="openUsage">📊 用量与花费</n-button>
    </n-space>

    <update-settings-panel />

    <!-- 「关于与更新」下的诊断区块：出问题时用户从这里一键导出诊断包 -->
    <diagnostics-panel />

    <n-space justify="end" style="margin-top: 12px">
      <n-button @click="store.settingsOpen = false">取消</n-button>
      <n-button type="primary" @click="save">保存</n-button>
    </n-space>
  </n-modal>
</template>

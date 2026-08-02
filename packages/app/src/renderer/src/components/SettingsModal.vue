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

const store = useAppStore();
const message = useMessage();

const sttBaseUrl = ref("");
const sttApiKey = ref("");
const sttModel = ref("");
const piRuntimeMode = ref<"bundled" | "external">("bundled");
const piExternalCommand = ref("");

watch(
  () => store.settingsOpen,
  (open) => {
    if (open) {
      sttBaseUrl.value = store.settings.sttBaseUrl ?? "";
      sttApiKey.value = store.settings.sttApiKey ?? "";
      sttModel.value = store.settings.sttModel ?? "";
      piRuntimeMode.value = store.settings.piRuntimeMode ?? "bundled";
      piExternalCommand.value = store.settings.piExternalCommand ?? "";
    }
  }
);

async function save(): Promise<void> {
  await store.saveSettings({
    sttBaseUrl: sttBaseUrl.value.trim(),
    sttApiKey: sttApiKey.value.trim(),
    sttModel: sttModel.value.trim(),
    piRuntimeMode: piRuntimeMode.value,
    piExternalCommand: piExternalCommand.value.trim(),
  });
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
          v-model:value="sttApiKey"
          type="password"
          show-password-on="click"
          placeholder="sk-…"
        />
      </n-form-item>
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

    <n-alert
      v-if="store.startError && store.settings.piRuntimeMode === 'external'"
      type="error"
      title="外部 Pi 运行时启动失败"
      style="margin-bottom: 12px"
    >
      <p style="white-space: pre-wrap; margin: 0 0 8px">{{ store.startError }}</p>
      <n-button size="small" type="primary" @click="backToBundled">切回内置</n-button>
    </n-alert>

    <div style="font-size: 12px; color: #b0b4bc; margin-bottom: 12px">
      对话模型的账号在终端里运行 <code>pi</code> 后用 <code>/login</code> 配置，
      或设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量。
    </div>

    <n-space justify="end">
      <n-button @click="store.settingsOpen = false">取消</n-button>
      <n-button type="primary" @click="save">保存</n-button>
    </n-space>
  </n-modal>
</template>

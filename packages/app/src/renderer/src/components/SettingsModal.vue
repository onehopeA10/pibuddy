<script setup lang="ts">
import { ref, watch } from "vue";
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  useMessage,
} from "naive-ui";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const message = useMessage();

const sttBaseUrl = ref("");
const sttApiKey = ref("");
const sttModel = ref("");

watch(
  () => store.settingsOpen,
  (open) => {
    if (open) {
      sttBaseUrl.value = store.settings.sttBaseUrl ?? "";
      sttApiKey.value = store.settings.sttApiKey ?? "";
      sttModel.value = store.settings.sttModel ?? "";
    }
  }
);

async function save(): Promise<void> {
  await store.saveSettings({
    sttBaseUrl: sttBaseUrl.value.trim(),
    sttApiKey: sttApiKey.value.trim(),
    sttModel: sttModel.value.trim(),
  });
  message.success("设置已保存");
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
    </n-form>

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

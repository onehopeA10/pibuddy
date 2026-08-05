<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
import { useCapabilitiesStore } from "../stores/capabilities";
import UpdateSettingsPanel from "./UpdateSettingsPanel.vue";
import DiagnosticsPanel from "./DiagnosticsPanel.vue";
import BackupPanel from "./BackupPanel.vue";
import HomeAssistantSettings from "./HomeAssistantSettings.vue";

const store = useAppStore();
const providers = useProvidersStore();
const capabilities = useCapabilitiesStore();
const message = useMessage();

// 智能家居区块的 UI 门控（home.assistant 的 settings.section 贡献）：判据来自
// 主进程能力快照——「启用」= 五条 ha:* 通道已注册，未启用时区块整个不出现。
const homeAssistantEnabled = computed(() => capabilities.isEnabled("home.assistant"));

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
    }
  }
);

const saveError = ref("");

async function save(): Promise<void> {
  saveError.value = "";
  try {
    // 端点先保存：地址不合格（非 HTTPS / 指向内网）时这一步就抛，
    // 密钥与其余字段一个都不会落盘。
    //
    // **这里没有、也不许有 piRuntimeMode / piExternalCommand**（SEC-005）：
    // 那两项最终是 spawn 的 argv[0]，走 changeRuntime() 那条需要主进程当面
    // 确认的通道。放回来一行，这个界面就重新成了一条任意程序执行的入口。
    await store.saveSettings({
      sttBaseUrl: sttBaseUrl.value.trim(),
      sttModel: sttModel.value.trim(),
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

const runtimeBusy = ref(false);

/**
 * 切换运行时来源。
 *
 * 与其余设置项不同，它**不跟随「保存」按钮**：这一步会弹主进程的文件选择框
 * 与确认框，必须当场完成、当场落盘，混进批量保存里的话，用户在对话框上点的
 * 「确认」到底确认了什么就说不清了。
 */
async function changeRuntime(mode: "bundled" | "external"): Promise<void> {
  if (mode === (store.settings.piRuntimeMode ?? "bundled") && mode === "bundled") return;
  runtimeBusy.value = true;
  try {
    const applied = await store.setPiRuntime(mode);
    if (applied) {
      message.success(mode === "external" ? "已切换到外部 Pi 运行时" : "已切回内置运行时");
    } else {
      message.info("已取消，运行时设置未改动");
    }
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
    message.error(saveError.value);
  } finally {
    runtimeBusy.value = false;
  }
}

/** 只有点这个按钮才会把 piRuntimeMode 写回 bundled —— 启动失败本身不写设置。 */
async function backToBundled(): Promise<void> {
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
        只有明确知道自己在做什么时才改成「外部命令」——
        选「外部命令」会打开一个文件选择框，由你亲自挑那个可执行文件。
      </div>

      <!--
        这一组是**立即生效**的，不跟随下面的「保存」按钮：切到外部命令会弹
        主进程的文件选择框与确认框（SEC-005）。界面这边给不出、也不传任何
        路径 —— 一旦这里出现一个能填路径的输入框，渲染进程就重新拥有了
        「让主进程执行任意本机程序」的表达能力。
      -->
      <n-form-item label="Pi 运行时">
        <n-radio-group
          :value="store.settings.piRuntimeMode ?? 'bundled'"
          :disabled="runtimeBusy"
          @update:value="(v: 'bundled' | 'external') => changeRuntime(v)"
        >
          <n-space>
            <n-radio value="bundled">内置（推荐）</n-radio>
            <n-radio value="external">外部命令…</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>

      <n-form-item v-if="store.settings.piRuntimeMode === 'external'" label="当前命令">
        <n-space vertical size="small" style="width: 100%">
          <span style="font-size: 12.5px; word-break: break-all; color: #4b5563">
            {{ store.settings.piExternalCommand || "未选择" }}
          </span>
          <n-button size="small" :disabled="runtimeBusy" @click="changeRuntime('external')">
            重新选择…
          </n-button>
        </n-space>
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
      <n-button @click="openUsage">📊 用量与花费（仅本地统计）</n-button>
    </n-space>

    <!-- 智能家居（home.assistant 能力包的 settings.section 贡献；能力关闭时不渲染） -->
    <home-assistant-settings v-if="homeAssistantEnabled" />

    <update-settings-panel />

    <!-- 「关于与更新」下的诊断区块：出问题时用户从这里一键导出诊断包 -->
    <diagnostics-panel />

    <!-- 备份与恢复（BKP-101，内核设施，不受 Profile 影响） -->
    <backup-panel />

    <n-space justify="end" style="margin-top: 12px">
      <n-button @click="store.settingsOpen = false">取消</n-button>
      <n-button type="primary" @click="save">保存</n-button>
    </n-space>
  </n-modal>
</template>

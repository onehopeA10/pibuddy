<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NRadio,
  NRadioGroup,
  NSelect,
  NSpace,
  NSwitch,
  useMessage,
} from "naive-ui";
import type { AppCloseAction, AppTheme } from "@contract";
import { useAppStore } from "../stores/app";
import { useCapabilitiesStore } from "../stores/capabilities";
import UpdateSettingsPanel from "./UpdateSettingsPanel.vue";
import DiagnosticsPanel from "./DiagnosticsPanel.vue";
import BackupPanel from "./BackupPanel.vue";
import HomeAssistantSettings from "./HomeAssistantSettings.vue";
import SessionImportPanel from "./SessionImportPanel.vue";
import RemotePanel from "./RemotePanel.vue";
import PanelFrame from "./PanelFrame.vue";

type SettingsSection =
  | "general"
  | "memory"
  | "remote"
  | "capabilities"
  | "data"
  | "about";

const props = defineProps<{ embedded?: boolean }>();

const store = useAppStore();
const capabilities = useCapabilitiesStore();
const message = useMessage();
const section = ref<SettingsSection>("general");

const homeAssistantEnabled = computed(() => capabilities.isEnabled("home.assistant"));
const remoteEnabled = computed(() => capabilities.isEnabled("connector.remote"));

const sections = computed(() => {
  const items: { id: SettingsSection; label: string }[] = [
    { id: "general", label: "通用" },
    { id: "memory", label: "记忆" },
  ];
  if (remoteEnabled.value) items.push({ id: "remote", label: "远程访问" });
  items.push(
    { id: "capabilities", label: "能力" },
    { id: "data", label: "数据" },
    { id: "about", label: "关于" }
  );
  return items;
});

const profileOptions = computed(() =>
  capabilities.profiles.map((p) => ({ label: p.displayName, value: p.id }))
);

const sttBaseUrl = ref("");
const sttApiKeyInput = ref("");
const secretHint = ref("");
const sttModel = ref("");

function loadLocalFields(): void {
  sttBaseUrl.value = store.settings.sttBaseUrl ?? "";
  sttApiKeyInput.value = "";
  secretHint.value = store.settings.sttApiKeyConfigured
    ? `已配置 ····${store.settings.sttApiKeyLast4 || "????"}（留空则不改动）`
    : "";
  sttModel.value = store.settings.sttModel ?? "";
}

watch(
  () => store.settingsOpen || props.embedded,
  (open) => {
    if (open) loadLocalFields();
  },
  { immediate: true }
);

const saveError = ref("");

async function save(): Promise<void> {
  saveError.value = "";
  try {
    await store.saveSettings({
      sttBaseUrl: sttBaseUrl.value.trim(),
      sttModel: sttModel.value.trim(),
    });
    if (sttApiKeyInput.value.trim() !== "") {
      await store.saveSttSecret(sttApiKeyInput.value.trim());
    }
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
    message.error(saveError.value);
    return;
  }
  message.success("设置已保存");
  if (!props.embedded) store.settingsOpen = false;
}

const themeBusy = ref(false);

/** 配色即点即生效（不等「保存」）：预览就是结果，没有第二步可确认。 */
async function changeTheme(theme: AppTheme): Promise<void> {
  if (theme === (store.settings.theme ?? "dark")) return;
  themeBusy.value = true;
  try {
    await store.saveSettings({ theme });
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
    message.error(saveError.value);
  } finally {
    themeBusy.value = false;
  }
}

const runtimeBusy = ref(false);

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

async function backToBundled(): Promise<void> {
  await store.switchToBundledRuntime();
  message.success("已切回内置运行时");
  if (!props.embedded) store.settingsOpen = false;
}
</script>

<template>
  <PanelFrame
    :embedded="embedded"
    :show="store.settingsOpen"
    title="设置"
    width="840px"
    @update:show="store.settingsOpen = $event"
  >
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">
        <button
          v-for="item in sections"
          :key="item.id"
          type="button"
          class="settings-nav-item"
          :class="{ active: section === item.id }"
          @click="section = item.id"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="settings-body">
        <section v-show="section === 'general'">
          <n-form label-placement="left" label-width="110">
            <n-form-item label="外观">
              <n-radio-group
                :value="store.settings.theme ?? 'dark'"
                :disabled="themeBusy"
                data-testid="theme-picker"
                @update:value="(v: AppTheme) => changeTheme(v)"
              >
                <n-space>
                  <n-radio value="dark">深色</n-radio>
                  <n-radio value="light">浅色</n-radio>
                </n-space>
              </n-radio-group>
            </n-form-item>

            <n-form-item label="关闭窗口">
              <n-radio-group
                :value="store.settings.closeAction ?? 'ask'"
                data-testid="close-action-picker"
                @update:value="(v: AppCloseAction) => void store.saveSettings({ closeAction: v })"
              >
                <n-space>
                  <n-radio value="ask">每次询问</n-radio>
                  <n-radio value="tray">缩小到托盘</n-radio>
                  <n-radio value="quit">退出</n-radio>
                </n-space>
              </n-radio-group>
            </n-form-item>
            <p class="hint">点右上角关闭时可选退出，或缩小到托盘让后台继续跑。</p>

            <n-form-item label="工作文件夹">
              <n-space align="center">
                <span class="path-text">{{ store.workspace || "未选择" }}</span>
                <n-button size="small" @click="store.chooseWorkspace()">更换</n-button>
              </n-space>
            </n-form-item>

            <p class="hint">
              默认使用应用自带的 Pi 运行时。只有明确知道自己在做什么时才改成「外部命令」。
            </p>
            <n-form-item label="Pi 运行时">
              <n-radio-group
                :value="store.settings.piRuntimeMode ?? 'bundled'"
                :disabled="runtimeBusy"
                data-testid="pi-runtime-picker"
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
                <span class="path-text">{{ store.settings.piExternalCommand || "未选择" }}</span>
                <n-button size="small" :disabled="runtimeBusy" @click="changeRuntime('external')">
                  重新选择…
                </n-button>
              </n-space>
            </n-form-item>
            <n-alert
              v-if="store.startError && store.settings.piRuntimeMode === 'external'"
              type="error"
              title="外部 Pi 运行时启动失败"
              style="margin-bottom: 12px"
            >
              <p class="alert-copy">{{ store.startError }}</p>
              <n-button size="small" type="primary" @click="backToBundled">切回内置</n-button>
            </n-alert>

            <p class="hint">
              语音识别（可选）：填写任意 OpenAI 兼容的转写接口，配置后即可用麦克风说话输入。
            </p>

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
            <p v-if="secretHint" class="hint indent">{{ secretHint }}</p>
            <n-form-item label="识别模型">
              <n-input v-model:value="sttModel" placeholder="whisper-1" />
            </n-form-item>
          </n-form>
        </section>

        <section v-show="section === 'memory'">
          <p class="hint">从旧会话导入记忆，或到左侧「记忆」里管理长期记忆。</p>
          <session-import-panel />
        </section>

        <section v-if="remoteEnabled" v-show="section === 'remote'">
          <RemotePanel />
        </section>

        <section v-show="section === 'capabilities'">
          <n-form label-placement="left" label-width="110">
            <n-form-item label="工作模式">
              <n-select
                :value="capabilities.activeProfileId"
                :options="profileOptions"
                size="small"
                style="width: 240px"
                @update:value="(v: string) => capabilities.setProfile(v)"
              />
            </n-form-item>
          </n-form>
          <p v-if="capabilities.restartRequired" class="hint">部分能力变更需要重启后完全生效。</p>
          <p v-if="capabilities.lastError" class="error-line">{{ capabilities.lastError }}</p>
          <ul class="cap-list">
            <li v-for="cap in capabilities.items" :key="cap.id" class="cap-row">
              <div class="cap-meta">
                <strong>{{ cap.displayName }}</strong>
                <span class="hint">{{ cap.description }}</span>
                <span v-if="cap.reason" class="error-line">{{ cap.reason }}</span>
              </div>
              <n-switch
                :value="cap.enabled"
                size="small"
                @update:value="(v: boolean) => capabilities.setEnabled(cap.id, v)"
              />
            </li>
          </ul>
          <home-assistant-settings v-if="homeAssistantEnabled" />
        </section>

        <section v-show="section === 'data'">
          <backup-panel />
        </section>

        <section v-show="section === 'about'">
          <update-settings-panel />
          <diagnostics-panel />
        </section>

        <n-alert v-if="saveError" type="error" title="保存被拒绝" style="margin-top: 12px">
          <p class="alert-copy">{{ saveError }}</p>
        </n-alert>

        <n-space justify="end" style="margin-top: 16px">
          <n-button v-if="!embedded" @click="store.settingsOpen = false">取消</n-button>
          <n-button type="primary" @click="save">保存</n-button>
        </n-space>
      </div>
    </div>
  </PanelFrame>
</template>

<style scoped>
.settings-layout {
  display: flex;
  min-height: 420px;
  gap: var(--space-4);
  padding: var(--space-2) 0;
}
.settings-nav {
  width: 180px;
  flex-shrink: 0;
  padding-right: var(--space-3);
  border-right: var(--border-w) solid var(--border-subtle);
}
.settings-nav-item {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  border-radius: var(--radius-l);
  padding: 9px 12px;
  font-size: var(--font-ui-13);
  cursor: pointer;
}
.settings-nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.settings-nav-item.active {
  background: var(--accent-subtle);
  color: var(--accent);
}
.settings-body {
  flex: 1;
  min-width: 0;
  padding-left: var(--space-5);
  max-width: 640px;
}
.path-text {
  font-size: var(--font-ui-13);
  color: var(--text-secondary);
  word-break: break-all;
}
.hint {
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
  margin: 0 0 12px;
}
.hint.indent {
  margin: -8px 0 12px 110px;
}
.alert-copy {
  white-space: pre-wrap;
  margin: 0 0 8px;
}
.error-line {
  color: var(--status-error);
  font-size: var(--font-ui-12);
}
.cap-list {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
}
.cap-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 12px 14px;
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  margin-bottom: 8px;
}
.cap-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.cap-meta strong {
  font-size: var(--font-ui-13);
  font-weight: 500;
}
</style>

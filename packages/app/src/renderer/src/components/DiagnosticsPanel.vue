<script setup lang="ts">
/**
 * 诊断面板（OBS-101）。
 *
 * ## 为什么一定要先预览
 *
 * 诊断包会被发到聊天窗口、贴进工单、转给不认识的人。用户有权在按下按钮
 * **之前**知道自己要交出去的是哪些文件、多大、有没有脱敏。因此这里的顺序
 * 写死为：点「生成诊断包」→ 看清单 → 确认 → 导出 → 在文件夹中显示。
 * 没有「一键直接导出」的快捷路径。
 *
 * ## 崩溃转储单独问
 *
 * 日志与设置副本是文本，可以逐字脱敏；crash dump 是进程内存的二进制快照，
 * 脱敏对它不成立。所以它有独立的开关，默认关，且在清单里以「未脱敏」分组
 * 单列 —— 混进「已脱敏」那一栏就是在骗用户。
 */
import { computed, ref } from "vue";
import { NAlert, NButton, NRadio, NRadioGroup, NSpace, NSpin, useMessage } from "naive-ui";
import type { BundleEntry, BundlePreview } from "@contract";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const message = useMessage();

const preview = ref<BundlePreview | null>(null);
const loading = ref(false);
const exporting = ref(false);
const error = ref("");

const consent = computed({
  get: () => store.settings.crashDumpConsent ?? "unset",
  set: (value: "unset" | "allow" | "deny") => {
    void store.saveSettings({ crashDumpConsent: value }).then(() => refresh());
  },
});

const redactedEntries = computed<BundleEntry[]>(() =>
  (preview.value?.entries ?? []).filter((e) => e.redacted)
);
const rawEntries = computed<BundleEntry[]>(() =>
  (preview.value?.entries ?? []).filter((e) => !e.redacted)
);

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    preview.value = await window.piBuddy.diagnostics.previewBundle();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function doExport(): Promise<void> {
  exporting.value = true;
  try {
    const result = await window.piBuddy.diagnostics.exportBundle(true);
    if (!result.path) {
      message.info("已取消");
      return;
    }
    message.success(`已导出 ${result.entryCount} 个文件`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    message.error(error.value);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div style="margin-top: 12px; border-top: 1px solid #eceef2; padding-top: 12px">
    <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px">诊断</div>
    <div style="font-size: 12.5px; color: #8a8f98; margin-bottom: 8px">
      遇到问题时，可以导出一份诊断包发给我们。导出前你会先看到将要包含哪些文件。
      日志里的密钥、对话正文与你的用户目录路径都会被替换掉。
    </div>

    <n-space align="center" style="margin-bottom: 8px">
      <n-button size="small" :loading="loading" @click="refresh">生成诊断包</n-button>
      <n-button
        v-if="preview"
        size="small"
        type="primary"
        :loading="exporting"
        @click="doExport"
      >
        确认导出并在文件夹中显示
      </n-button>
    </n-space>

    <n-alert v-if="error" type="error" title="诊断失败" style="margin-bottom: 8px">
      <p style="white-space: pre-wrap; margin: 0">{{ error }}</p>
    </n-alert>

    <n-spin v-if="loading" size="small" />

    <div v-if="preview" style="font-size: 12.5px">
      <div style="margin-bottom: 4px; color: #4b5563">
        共 {{ preview.entries.length }} 个文件，约 {{ humanSize(preview.totalBytes) }}
      </div>

      <div style="margin-bottom: 6px">
        <div style="color: #16a34a; margin-bottom: 2px">已脱敏</div>
        <ul style="margin: 0; padding-left: 20px; color: #6b7280">
          <li v-for="e in redactedEntries" :key="e.path">
            {{ e.path }} · {{ humanSize(e.sizeBytes) }} —— {{ e.description }}
          </li>
        </ul>
      </div>

      <div v-if="rawEntries.length" style="margin-bottom: 6px">
        <div style="color: #dc2626; margin-bottom: 2px">未脱敏（你已明确同意包含）</div>
        <ul style="margin: 0; padding-left: 20px; color: #6b7280">
          <li v-for="e in rawEntries" :key="e.path">
            {{ e.path }} · {{ humanSize(e.sizeBytes) }} —— {{ e.description }}
          </li>
        </ul>
      </div>
    </div>

    <div style="margin-top: 10px">
      <div style="font-size: 12.5px; color: #4b5563; margin-bottom: 4px">
        <!-- 这里曾经写成 Markdown 的 **粗体**，而模板不做 Markdown 解析，
             用户看到的就是两个星号 —— 恰好出现在最需要被看清的那句话上。 -->
        崩溃转储：是进程内存的快照，可能包含你刚打的任何内容，<strong>无法脱敏</strong>。
        只有你选「包含」时才会进诊断包。
      </div>
      <n-radio-group v-model:value="consent" size="small">
        <n-space>
          <n-radio value="unset">还没决定</n-radio>
          <n-radio value="deny">不包含（推荐）</n-radio>
          <n-radio value="allow">包含</n-radio>
        </n-space>
      </n-radio-group>
    </div>
  </div>
</template>

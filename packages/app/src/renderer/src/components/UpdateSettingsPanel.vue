<script setup lang="ts">
/**
 * 设置 →「关于与更新」。
 *
 * 与横幅的分工：横幅只在需要用户决定时短暂出现，这里**始终**可见 ——
 * 用户点过「稍后」之后，唯一还能找到「有新版本」这件事的地方就是这儿。
 *
 * 这里同样只做 mustache 插值：发布说明是不可信内容，不走任何原始 HTML
 * 注入指令。
 */
import { computed, onMounted } from "vue";
import { NButton, NSpace, NSwitch, NRadio, NRadioGroup, NTag } from "naive-ui";
import { UPDATE_ERROR_MESSAGES } from "@contract";
import { useUpdateStore } from "../stores/update";

const store = useUpdateStore();
const s = computed(() => store.state);

onMounted(() => {
  void store.init();
});

const lastCheckedText = computed(() => {
  if (!s.value.lastCheckedAt) return "还没检查过";
  return new Date(s.value.lastCheckedAt).toLocaleString();
});

const statusText = computed(() => {
  switch (s.value.status) {
    case "unsupported":
      return "当前运行方式不支持签名自动更新（开发模式或未打包）";
    case "checking":
      return "正在检查…";
    case "available":
      return `有新版本 ${s.value.candidateVersion} 可用`;
    case "not-available":
      return "已是最新版本";
    case "downloading":
      return `正在下载 ${Math.round(s.value.percent)}%`;
    case "downloaded":
      return `${s.value.candidateVersion} 已下载完成，重启即可安装`;
    case "waiting-for-agent":
      return "等当前任务结束后自动安装";
    case "installing":
      return "正在安装…";
    case "error":
      return s.value.errorCode ? UPDATE_ERROR_MESSAGES[s.value.errorCode] : "更新失败";
    default:
      return "等待检查";
  }
});

const busy = computed(() =>
  ["checking", "downloading", "installing"].includes(s.value.status)
);

/** 一键复制诊断信息：出问题时让用户能把有用的东西一次性贴给我们。 */
async function copyDiagnostics(): Promise<void> {
  const lines = [
    `version=${s.value.currentVersion}`,
    `candidate=${s.value.candidateVersion ?? "-"}`,
    `channel=${s.value.channel}`,
    `status=${s.value.status}`,
    `errorCode=${s.value.errorCode ?? "-"}`,
    `lastChecked=${lastCheckedText.value}`,
    `stateSequence=${s.value.stateSequence}`,
  ];
  await navigator.clipboard.writeText(lines.join("\n"));
}
</script>

<template>
  <section class="update-panel">
    <h3>关于与更新</h3>

    <div class="row">
      <span class="k">当前版本</span>
      <span class="v">{{ s.currentVersion || "—" }}</span>
    </div>

    <div class="row">
      <span class="k">状态</span>
      <span class="v">
        {{ statusText }}
        <n-tag v-if="s.status === 'error'" size="small" type="error">出错</n-tag>
      </span>
    </div>

    <h4>签名自动更新</h4>
    <p class="hint">以下检查、下载与重启安装只针对已签名更新源，不包含 GitHub 预览版。</p>

    <div class="row">
      <span class="k">更新通道</span>
      <span class="v">
        <n-radio-group
          :value="s.channel"
          :disabled="busy"
          @update:value="(c: 'stable' | 'beta') => store.setChannel(c)"
        >
          <n-space>
            <n-radio value="stable">稳定版</n-radio>
            <n-radio value="beta">尝鲜版</n-radio>
          </n-space>
        </n-radio-group>
      </span>
    </div>

    <div class="row">
      <span class="k">自动检查</span>
      <span class="v">
        <n-switch
          :value="s.autoCheck"
          @update:value="(v: boolean) => store.setAutoCheck(v)"
        />
      </span>
    </div>

    <div class="row">
      <span class="k">自动下载</span>
      <span class="v">
        <n-switch
          :value="s.autoDownload"
          @update:value="(v: boolean) => store.setAutoDownload(v)"
        />
        <span class="hint">关闭时会先让你看到版本说明与体积</span>
      </span>
    </div>

    <div class="row">
      <span class="k">上次检查</span>
      <span class="v">{{ lastCheckedText }}</span>
    </div>

    <div v-if="s.releaseNotes" class="notes">{{ s.releaseNotes }}</div>

    <n-space>
      <n-button
        size="small"
        type="primary"
        :disabled="busy || s.status === 'unsupported'"
        @click="store.checkNow()"
      >
        检查签名更新
      </n-button>
      <n-button
        v-if="s.status === 'available'"
        size="small"
        @click="store.download()"
      >
        下载更新
      </n-button>
      <n-button
        v-if="s.status === 'downloaded'"
        size="small"
        type="primary"
        @click="store.install('now')"
      >
        重启安装
      </n-button>
      <n-button size="small" quaternary @click="copyDiagnostics">复制诊断信息</n-button>
    </n-space>

    <div class="preview-release">
      <h4>GitHub 预览版（未签名）</h4>
      <p class="hint">预览版需从发布页手动下载并安装；不会出现在上方的签名更新检查结果中。</p>
      <n-button
        size="small"
        tag="a"
        href="https://github.com/onehopeA10/pibuddy/releases"
        target="_blank"
        rel="noreferrer"
      >
        查看 GitHub 发布页
      </n-button>
    </div>
  </section>
</template>

<style scoped>
.update-panel {
  border-top: var(--border-w) solid var(--border-subtle);
  padding-top: 12px;
  margin-top: 4px;
}
.update-panel h3 {
  margin: 0 0 10px;
  font-size: var(--font-ui-13);
  color: var(--text-secondary);
}
.update-panel h4 {
  margin: 12px 0 6px;
  font-size: var(--font-ui-13);
  color: var(--text-primary);
}
.update-panel p.hint {
  margin: 0 0 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: var(--font-ui-13);
}
.k {
  width: 102px;
  flex: none;
  color: var(--text-tertiary);
}
.v {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
}
.hint {
  font-size: var(--font-ui-12);
  color: var(--text-tertiary);
}
.preview-release {
  border-top: var(--border-w) solid var(--border-subtle);
  margin-top: 14px;
  padding-top: 2px;
}
.notes {
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
  background: var(--bg-input);
  border-radius: var(--radius-l);
  padding: 8px 10px;
  margin-bottom: 10px;
}
</style>

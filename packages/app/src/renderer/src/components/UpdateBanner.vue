<script setup lang="ts">
/**
 * 全局更新横幅。
 *
 * ## 只在需要用户做决定的时候出现
 *
 * checking / not-available / idle / unsupported 这些状态弹横幅是纯噪声：
 * 用户没有任何可做的动作，横幅唯一的效果是把主界面往下顶 48px。
 * 因此渲染判据只有四个状态：
 *   available   —— 要不要下载？
 *   downloading —— 正在下（进度 + 可取消），这是用户刚点过下载的直接反馈
 *   downloaded  —— 现在重启还是待会儿？
 *   error       —— 出错了，要不要重试？
 *
 * ## release notes 一律纯文本
 *
 * 发布说明来自远端 feed，是不可信内容。主进程已经用 sanitizeReleaseNotes
 * 把它剥成纯文本，这里**只做 mustache 插值**，绝不用任何形式的原始 HTML
 * 注入指令 —— 那等于把 XSS 入口开在一个开着 contextBridge 的窗口上，
 * 而窗户后面是 window.piBuddy 的全部能力。结构断言见 update-banner.test.ts。
 *
 * ## 取消按钮按能力位渲染
 *
 * `cancelSupported` 由主进程按 electron-updater 是否导出 CancellationToken
 * 决定。不支持就根本不渲染 —— 放一个点了没反应的按钮比没有按钮更糟。
 */
import { computed } from "vue";
import { UPDATE_ERROR_MESSAGES } from "@contract";
import { useUpdateStore } from "../stores/update";

const store = useUpdateStore();

const s = computed(() => store.state);

const errorMessage = computed(() =>
  s.value.errorCode ? UPDATE_ERROR_MESSAGES[s.value.errorCode] : ""
);

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

const sizeText = computed(() =>
  s.value.totalBytes > 0 ? `约 ${formatBytes(s.value.totalBytes)}` : ""
);

const progressText = computed(
  () =>
    `${formatBytes(s.value.bytesTransferred)} / ${formatBytes(s.value.totalBytes)}` +
    (s.value.bytesPerSecond > 0 ? ` · ${formatBytes(s.value.bytesPerSecond)}/s` : "")
);

const releaseDateText = computed(() => {
  if (!s.value.releaseDate) return "";
  const d = new Date(s.value.releaseDate);
  return Number.isNaN(d.getTime()) ? "" : `发布于 ${d.toLocaleDateString()}`;
});
</script>

<template>
  <div v-if="store.bannerVisible" class="update-banner" :class="`is-${s.status}`">
    <!-- 发现新版本 -->
    <template v-if="s.status === 'available'">
      <div class="body">
        <strong>发现新版本 {{ s.candidateVersion }}</strong>
        <span class="meta">{{ releaseDateText }} {{ sizeText }}</span>
        <p v-if="s.releaseNotes" class="notes">{{ s.releaseNotes }}</p>
      </div>
      <div class="actions">
        <button class="primary" @click="store.download()">下载更新</button>
        <button @click="store.dismiss()">稍后</button>
      </div>
    </template>

    <!-- 下载中 -->
    <template v-else-if="s.status === 'downloading'">
      <div class="body">
        <strong>正在下载 {{ s.candidateVersion }}（{{ Math.round(s.percent) }}%）</strong>
        <span class="meta">{{ progressText }}</span>
        <div class="bar"><i :style="{ width: `${s.percent}%` }"></i></div>
      </div>
      <div class="actions">
        <button v-if="store.cancelSupported" @click="store.cancelDownload()">取消下载</button>
      </div>
    </template>

    <!-- 下载完成 -->
    <template v-else-if="s.status === 'downloaded'">
      <div class="body">
        <strong>{{ s.candidateVersion }} 已下载完成</strong>
        <span class="meta">重启后即可用上新版本</span>
      </div>
      <div class="actions">
        <button class="primary" @click="store.install('now')">立即重启安装</button>
        <button @click="store.dismiss()">稍后</button>
      </div>
    </template>

    <!-- 出错 -->
    <template v-else-if="s.status === 'error'">
      <div class="body">
        <strong>更新失败</strong>
        <span class="meta">{{ errorMessage }}</span>
      </div>
      <div class="actions">
        <button v-if="s.retryable" class="primary" @click="store.checkNow()">重试</button>
        <button @click="store.bannerClosed = true">关闭</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: var(--info-bg);
  border-bottom: var(--border-w) solid var(--border-subtle);
  font-size: var(--font-ui-13);
  color: var(--text-primary);
}
.update-banner.is-error {
  background: var(--danger-bg);
  border-bottom-color: var(--status-error);
}
.body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.meta {
  font-size: 12px;
  color: var(--text-tertiary);
}
.notes {
  margin: 4px 0 0;
  max-height: 72px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
}
.bar {
  margin-top: 6px;
  width: 260px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-hover);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.actions {
  display: flex;
  gap: 8px;
  flex: none;
}
.actions button {
  padding: 4px 12px;
  border-radius: 4px;
  border: var(--border-w) solid var(--border-strong);
  background: var(--bg-surface-raised);
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-ui-13);
}
.actions button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
}
</style>

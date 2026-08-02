<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { NButton, NInput, NSpin, useMessage } from "naive-ui";
import type { ImageContent } from "@sdk";
import type { AttachmentRef } from "@contract";
import { useAppStore } from "../stores/app";
import { VoiceRecorder } from "../stt";

interface ImageAttachment extends ImageContent {
  name: string;
}

const store = useAppStore();
const message = useMessage();

const images = ref<ImageAttachment[]>([]);
const files = ref<AttachmentRef[]>([]);
const sending = ref(false);

// ---------- 附件 ----------

function addImageFromFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result as string;
    const [head, data] = url.split(",");
    const mimeType = head.match(/data:(.*?);/)?.[1] ?? "image/png";
    images.value.push({ type: "image", data, mimeType, name: file.name || "剪贴板图片" });
  };
  reader.readAsDataURL(file);
}

function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items ?? [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        addImageFromFile(file);
        e.preventDefault();
      }
    }
  }
}

async function onWindowDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  const dropped = e.dataTransfer?.files;
  if (!dropped) return;
  for (const file of Array.from(dropped)) {
    if (file.type.startsWith("image/")) {
      addImageFromFile(file);
      continue;
    }
    try {
      // 绝对路径在 preload 内部就被换成短期能力凭证，渲染进程拿不到它
      files.value.push(await window.piBuddy.file.fromDrop(file));
    } catch {
      message.warning(`无法读取文件：${file.name}`);
    }
  }
}

async function pickFiles(): Promise<void> {
  const picked = await window.piBuddy.dialog.chooseFiles();
  for (const f of picked) {
    if (f.kind === "image") {
      // 凭证换 base64：主进程重做收容、大小与 magic bytes 校验后才给数据
      try {
        const img = await window.piBuddy.file.readImage(f.token);
        images.value.push({ type: "image", ...img, name: f.name });
      } catch (err) {
        message.warning(
          err instanceof Error ? `${f.name}：${err.message}` : `无法读取图片：${f.name}`
        );
      }
    } else {
      files.value.push(f);
    }
  }
}

// ---------- 语音 ----------

const recorder = new VoiceRecorder();
const recording = ref(false);
const transcribing = ref(false);

async function toggleVoice(): Promise<void> {
  if (transcribing.value) return;
  if (!recording.value) {
    const s = store.settings;
    // 密钥本体在主进程的 safeStorage 里，渲染进程只看得到「配没配」这一位
    if (!s.sttApiKeyConfigured || !s.sttEndpointId) {
      message.warning("请先在「设置」里配置语音识别服务（OpenAI 兼容接口）");
      store.settingsOpen = true;
      return;
    }
    try {
      await recorder.start();
      recording.value = true;
    } catch {
      message.error("无法使用麦克风，请检查系统权限");
    }
    return;
  }
  recording.value = false;
  transcribing.value = true;
  try {
    const { audio, mimeType } = await recorder.stop();
    // 只交出端点 id：地址、模型、密钥全部由主进程按 id 查出来
    const result = await window.piBuddy.stt.transcribe({
      endpointId: store.settings.sttEndpointId!,
      audio,
      mimeType,
    });
    if (result.text.trim()) {
      store.editorText = store.editorText
        ? `${store.editorText} ${result.text.trim()}`
        : result.text.trim();
    } else {
      message.info("没有听清，请再说一次");
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "语音转写失败");
  } finally {
    transcribing.value = false;
  }
}

// ---------- 发送 ----------

async function submit(): Promise<void> {
  if (sending.value) return;
  const text = store.editorText;
  if (!text.trim() && images.value.length === 0 && files.value.length === 0) return;
  sending.value = true;
  try {
    // 只有 RPC 已经接受（success:true）才允许清空 composer。
    // 早先这里无条件清空，一次发送失败就把文字、图片、文件附件一起抹掉。
    const payload = {
      text,
      images: images.value.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
      attachments: files.value,
    };
    if (await store.send(payload)) {
      store.editorText = "";
      images.value = [];
      files.value = [];
    }
  } catch (err) {
    // 没有这个 catch，`void submit()` 路径下抛出的异常就是一条静默的
    // unhandled rejection：用户只看到发送键转完一圈，什么提示都没有。
    message.error(
      err instanceof Error ? `${err.message}（内容已为你保留）` : "发送失败，内容已为你保留"
    );
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
}

function handleWindowDrop(e: DragEvent): void {
  void onWindowDrop(e);
}

onMounted(() => window.addEventListener("drop", handleWindowDrop));
onBeforeUnmount(() => window.removeEventListener("drop", handleWindowDrop));
</script>

<template>
  <div class="composer-wrap">
    <div v-if="store.streaming || store.busyStatus" class="status-line">
      <span v-if="store.streaming" class="pulse-dot" />
      <span v-if="store.streaming">正在努力工作中… 你可以随时输入新指令插话，或点「停止」</span>
      <span v-if="store.queue.steering.length">（已排队 {{ store.queue.steering.length }} 条插话）</span>
      <span v-if="store.busyStatus">{{ store.busyStatus }}</span>
    </div>

    <div class="composer" @paste="onPaste">
      <div v-if="images.length || files.length" class="attachment-row">
        <span v-for="(img, i) in images" :key="`img-${i}`" class="attach-chip">
          <img :src="`data:${img.mimeType};base64,${img.data}`" alt="" />
          <span class="name">{{ img.name }}</span>
          <span class="close" @click="images.splice(i, 1)">✕</span>
        </span>
        <span v-for="(f, i) in files" :key="`file-${i}`" class="attach-chip">
          <span>{{ f.kind === "video" ? "🎬" : "📎" }}</span>
          <span class="name">{{ f.name }}</span>
          <span class="close" @click="files.splice(i, 1)">✕</span>
        </span>
      </div>

      <n-input
        v-model:value="store.editorText"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 8 }"
        :bordered="false"
        placeholder="告诉我要做什么…（可粘贴/拖入图片和文件，Enter 发送，Shift+Enter 换行）"
        :disabled="!store.started"
        @keydown="onKeydown"
      />

      <div class="composer-actions">
        <n-button quaternary size="small" :disabled="!store.started" @click="pickFiles">
          📎 文件
        </n-button>
        <n-button
          quaternary
          size="small"
          :type="recording ? 'error' : 'default'"
          :disabled="!store.started"
          @click="toggleVoice"
        >
          <template v-if="transcribing"><n-spin :size="14" style="margin-right: 4px" />识别中…</template>
          <template v-else-if="recording">🔴 说完了，点我</template>
          <template v-else>🎤 语音</template>
        </n-button>
        <span class="composer-hint" v-if="recording">正在听你说…</span>
        <div style="flex: 1" />
        <n-button
          v-if="store.streaming"
          size="small"
          type="error"
          secondary
          @click="store.abortRun()"
        >
          ⏹ 停止
        </n-button>
        <n-button
          type="primary"
          size="small"
          :loading="sending"
          :disabled="!store.started"
          @click="submit"
        >
          发送 ↩
        </n-button>
      </div>
    </div>
  </div>
</template>

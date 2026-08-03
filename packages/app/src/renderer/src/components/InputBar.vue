<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NButton, NInput, NSpin, useMessage } from "naive-ui";
import { useAppStore, type ComposerImage, type SendMode } from "../stores/app";
import { imageCapableModels, supportsImage } from "../stores/model-capability";
import { VoiceRecorder } from "../stt";
import QueuePanel from "./QueuePanel.vue";
import ExtensionWidgetHost from "./ExtensionWidgetHost.vue";

const store = useAppStore();
const message = useMessage();

/**
 * 图片与文件附件**归 store 的 composer 所有**，这里只是同名代理。
 *
 * 早先它们是组件级 `ref([])`。组件不随会话重建 —— 在 A 会话贴的图、拖进来
 * 的文件，切到 B 之后原样留在输入框里，一按发送就发进了 B。改成按会话存放
 * 之后，切走再切回来内容还在，切到别的会话则一张都不会跟过去。
 */
const images = computed<ComposerImage[]>({
  get: () => store.draftImages,
  set: (v) => {
    store.draftImages = v;
  },
});
const files = computed({
  get: () => store.draftAttachments,
  set: (v) => {
    store.draftAttachments = v;
  },
});
const sending = ref(false);

/**
 * 助手正在输出时，这条新指令的产品语义。
 *
 * 默认「立即插话」——用户在助手跑的时候打字，绝大多数是想纠正当前这一轮。
 */
const sendMode = ref<SendMode>("steer");

// ---------- 图片能力（PROV-101） ----------
//
// 判据是当前模型的 `Model.input` 是否含 "image"，来自 get_available_models。
// 拦截发生在两层：这里（界面上就看得见，附件条目变灰、发送键禁用）与
// store.send() 的最前面（真正保证「一次 RPC 都不发」）。两层都要有 ——
// 只有 UI 层的话，任何绕过按钮的调用路径都能把图片发出去；只有 store 层
// 的话，用户会一直点一个看起来正常的发送键然后收到一句提示。

/** 当前模型收不收图。没有选中模型时按「收不下」保守处理。 */
const modelTakesImages = computed(() => supportsImage(store.currentModel));

/** 有图片、但当前模型收不下 —— 界面进入受阻状态。 */
const imagesBlocked = computed(() => images.value.length > 0 && !modelTakesImages.value);

const currentModelId = computed(() => store.currentModel?.id ?? "(未选择模型)");

/**
 * 可以切过去的模型：只列 `input` 含 image 的。空列表时不显示切换入口。
 *
 * 刻意用一段普通 DOM 而不是 n-dropdown 渲染：这个列表要被逐项断言
 * （每一项的 `data-model-input` 都必须 contains "image"），而 teleport 出去的
 * 弹层会让「列表里有什么」变成一个取决于挂载位置与打开时机的问题。
 */
const imageCapableOptions = computed(() =>
  imageCapableModels(store.models).map((m) => ({
    label: `${m.name || m.id}（${m.provider}）`,
    modelId: m.id,
    provider: m.provider,
    inputs: (m.input ?? []).join(","),
  }))
);

/** 切换模型的候选列表是否展开。 */
const switcherOpen = ref(false);

async function switchToImageModel(provider: string, modelId: string): Promise<void> {
  switcherOpen.value = false;
  await store.setModel(provider, modelId);
}

/**
 * 每次输入变化就重排一次草稿写入（store 里 debounce 500ms）。
 *
 * 不防抖的话，长输入是「每按一个键一次 IPC + 一次 SQLite 写」，界面上没有
 * 任何征兆。
 */
function onDraftChanged(): void {
  // 附件已经直接住在 composer 里，这里不再往回搬一次 —— 早先那句
  // `store.draftAttachments = [...files.value]` 是两处状态互相同步的接缝，
  // 而正是它让「组件里还留着上一会话的附件」被原样写进新会话的草稿。
  store.scheduleSaveDraft();
}

/**
 * 草稿的触发源是**状态变化**，不是键盘事件。
 *
 * 早先只挂在 @keydown 上：语音转写、扩展的 set_editor_text、粘贴图片、
 * 拖入文件全都不经过键盘，那些内容一个字都存不下来。
 */
watch([() => store.editorText, images, files], onDraftChanged, { deep: true });

/**
 * 取走文件树推过来的附件。
 *
 * `immediate: true` 是必需的：用户完全可能在 InputBar 挂载之前就从文件树
 * 点了「加入输入框附件」（面板是可折叠的，挂载顺序不固定）。少了它，
 * 那一次点击会静默丢失 —— 三大门禁全绿，只有真机点一遍才看得出来。
 */
watch(
  () => store.inboundAttachments,
  (list) => {
    if (list.length === 0) return;
    files.value = [...files.value, ...list];
    store.inboundAttachments = [];
  },
  { immediate: true, deep: true }
);

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

async function submit(mode?: SendMode): Promise<void> {
  if (sending.value) return;
  const text = store.editorText;
  if (!text.trim() && images.value.length === 0 && files.value.length === 0) return;
  sending.value = true;
  try {
    // 只有 RPC 已经接受（success:true）才允许清空 composer。
    // 早先这里无条件清空，一次发送失败就把文字、图片、文件附件一起抹掉。
    // streaming 时 mode 必填：store.send 在缺失时抛错且一次 RPC 都不发。
    const payload = {
      text,
      images: images.value.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
      attachments: files.value,
      ...(store.streaming ? { mode: mode ?? sendMode.value } : {}),
    };
    if (await store.send(payload)) {
      store.editorText = "";
      images.value = [];
      files.value = [];
      onDraftChanged();
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

/** 把当前输入放进本地未发送队列（不发给 pi，因而随时可改可删）。 */
function queueLocally(): void {
  const text = store.editorText.trim();
  if (!text) return;
  store.enqueueLocal(text, sendMode.value);
  store.editorText = "";
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
    return;
  }
  onDraftChanged();
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

    <QueuePanel />

    <!-- 扩展 widget（rpc.md:1275）：aboveEditor 在输入框之上，belowEditor 在其下。
         改造前这两个位置都不存在，setWidget 落进 default 分支被静默丢弃。 -->
    <ExtensionWidgetHost placement="aboveEditor" />

    <div class="composer" @paste="onPaste">
      <div v-if="images.length || files.length" class="attachment-row">
        <span
          v-for="(img, i) in images"
          :key="`img-${i}`"
          class="attach-chip"
          :class="{ blocked: imagesBlocked }"
          data-testid="image-attachment"
          :aria-disabled="imagesBlocked ? 'true' : 'false'"
          :title="
            imagesBlocked
              ? `当前模型 ${currentModelId} 不支持图片`
              : img.name
          "
        >
          <img :src="`data:${img.mimeType};base64,${img.data}`" alt="" />
          <span class="name">{{ img.name }}</span>
          <span class="close" @click="images.splice(i, 1)">✕</span>
        </span>
        <span v-for="(f, i) in files" :key="`file-${i}`" class="attach-chip">
          <span>{{ f.kind === "video" ? "🎬" : "📎" }}</span>
          <!-- 有相对路径就显示相对路径：同名文件靠它区分，而绝对路径
               从主进程起就没有出口 -->
          <span class="name" :title="f.relativePath ?? f.name">{{ f.relativePath ?? f.name }}</span>
          <span class="close" @click="files.splice(i, 1)">✕</span>
        </span>
      </div>

      <!--
        受阻说明 + 切换入口（PROV-101）。
        说明文本必须含当前模型 id —— 「不支持图片」不告诉用户是哪个模型
        不支持，他就不知道该换掉什么。
      -->
      <div v-if="imagesBlocked" class="image-blocked" role="alert" data-testid="image-blocked-hint">
        <span data-testid="image-blocked-text">
          当前模型「{{ currentModelId }}」不支持图片，发送前请切换模型或移除图片。
        </span>
        <n-button
          v-if="imageCapableOptions.length"
          size="tiny"
          type="primary"
          data-testid="switch-image-model"
          :aria-expanded="switcherOpen ? 'true' : 'false'"
          @click="switcherOpen = !switcherOpen"
        >
          切换到支持图片的模型
        </n-button>
        <span v-else class="muted">（当前没有支持图片的模型可选）</span>

        <ul
          v-if="switcherOpen && imageCapableOptions.length"
          class="model-switcher"
          role="listbox"
          aria-label="支持图片的模型"
          data-testid="image-model-list"
        >
          <li
            v-for="opt in imageCapableOptions"
            :key="`${opt.provider}::${opt.modelId}`"
            role="option"
            tabindex="0"
            :aria-selected="opt.modelId === currentModelId ? 'true' : 'false'"
            :data-model-input="opt.inputs"
            :data-model-id="opt.modelId"
            @click="switchToImageModel(opt.provider, opt.modelId)"
            @keydown.enter="switchToImageModel(opt.provider, opt.modelId)"
          >
            {{ opt.label }}
          </li>
        </ul>
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
        <!--
          助手在跑的时候，「现在就打断」和「等它做完这一轮」是两件事，
          必须让用户自己选，不能替他决定。两者都走 prompt 命令，
          区别只在 streamingBehavior 取值。
        -->
        <template v-if="store.streaming">
          <!--
            先攒着、待会儿再说。攒下的条目留在**本地**队列里，可以改可以删；
            一旦交给 pi 就撤不回来了（协议没有撤回命令）。
          -->
          <n-button
            size="small"
            quaternary
            :disabled="!store.started || !store.editorText.trim()"
            aria-label="先加入队列稍后再发"
            @click="queueLocally"
          >
            先攒着
          </n-button>
          <n-button
            size="small"
            type="primary"
            :loading="sending"
            :disabled="!store.started"
            aria-label="立即插话"
            @click="submit('steer')"
          >
            立即插话
          </n-button>
          <n-button
            size="small"
            secondary
            :loading="sending"
            :disabled="!store.started"
            aria-label="下一轮处理"
            @click="submit('followUp')"
          >
            下一轮处理
          </n-button>
        </template>
        <n-button
          v-else
          type="primary"
          size="small"
          :loading="sending"
          :disabled="!store.started || imagesBlocked"
          data-testid="send-button"
          :title="
            imagesBlocked
              ? `当前模型 ${currentModelId} 不支持图片，无法发送`
              : '发送'
          "
          @click="submit()"
        >
          发送 ↩
        </n-button>
      </div>
    </div>

    <ExtensionWidgetHost placement="belowEditor" />
  </div>
</template>

<style scoped>
/* 受阻的图片附件：视觉上一眼可辨，同时 aria-disabled 让辅助技术也读得到 */
.attach-chip.blocked {
  opacity: 0.55;
  outline: 1px dashed rgba(208, 48, 80, 0.6);
}
.image-blocked {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: #d03050;
}
.image-blocked .muted {
  color: #8a8f98;
}
.model-switcher {
  list-style: none;
  margin: 4px 0 0;
  padding: 4px;
  width: 100%;
  max-height: 200px;
  overflow: auto;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
  background: #fff;
}
.model-switcher li {
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  color: #333;
}
.model-switcher li:hover,
.model-switcher li:focus-visible {
  background: rgba(24, 160, 88, 0.12);
  outline: none;
}

/* 尊重系统的「减少动态效果」设置 */
@media (prefers-reduced-motion: reduce) {
  .attach-chip,
  .image-blocked {
    transition: none !important;
    animation: none !important;
  }
}
</style>

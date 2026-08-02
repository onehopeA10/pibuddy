<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useMessage, NButton, NSpin } from "naive-ui";
import { useAppStore } from "../stores/app";
import Sidebar from "./Sidebar.vue";
import TopBar from "./TopBar.vue";
import ChatView from "./ChatView.vue";
import InputBar from "./InputBar.vue";
import ExtensionUiHost from "./ExtensionUiHost.vue";
import SettingsModal from "./SettingsModal.vue";
import UpdateBanner from "./UpdateBanner.vue";
import InstallBlockerDialog from "./InstallBlockerDialog.vue";
import { useUpdateStore } from "../stores/update";

const store = useAppStore();
const updateStore = useUpdateStore();
const message = useMessage();
store.setNotifier(message);

const dragging = ref(0);

onMounted(() => {
  void store.init();
  // 先取快照再订阅：窗口 reload 之后进度必须从 main 的快照原样恢复，
  // 而不是回到 idle。
  void updateStore.init();
});

function onDragEnter(e: DragEvent): void {
  if (e.dataTransfer?.types.includes("Files")) dragging.value++;
}
function onDragLeave(): void {
  dragging.value = Math.max(0, dragging.value - 1);
}
function onDrop(): void {
  dragging.value = 0;
}
</script>

<template>
  <!-- 首次使用：选择工作文件夹 -->
  <div v-if="store.booting" class="onboarding">
    <n-spin size="large" />
  </div>

  <div v-else-if="!store.workspace" class="onboarding">
    <div class="logo">π</div>
    <h1>你好，我是 PiBuddy</h1>
    <p>
      我是你的 AI 办公小助手：整理文件、分析表格、写文档、处理图片和视频，
      都可以直接用一句话交给我。<br />
      先选一个「工作文件夹」，我只会在这个文件夹里帮你干活，其他地方不动。
    </p>
    <n-button type="primary" size="large" @click="store.chooseWorkspace()">
      📁 选择工作文件夹
    </n-button>
  </div>

  <!-- 主界面 -->
  <div
    v-else
    class="app-shell"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 布局契约（TASK-009 定义，M3-M5 各任务只往这四个具名插槽里注入内容，
         不得改动插槽名集合）：banner 顶部通条 / sidebar 侧栏 / main 主区 /
         overlay 浮层。默认内容即当前形态，不传插槽时渲染结果与改造前一致。 -->
    <slot name="banner"><UpdateBanner /></slot>

    <slot name="sidebar"><Sidebar /></slot>
    <div class="main-col">
      <TopBar />

      <template v-if="store.startError">
        <div class="onboarding">
          <h1>😥 启动失败</h1>
          <p style="white-space: pre-wrap; max-width: 640px">{{ store.startError }}</p>
          <n-button type="primary" @click="store.start()">重试</n-button>
          <n-button
            v-if="store.settings.piRuntimeMode === 'external'"
            @click="store.switchToBundledRuntime()"
          >
            切回内置
          </n-button>
          <n-button quaternary @click="store.chooseWorkspace()">换个文件夹</n-button>
        </div>
      </template>
      <template v-else>
        <slot name="main">
          <ChatView />
          <InputBar />
        </slot>
      </template>
    </div>

    <div v-if="dragging > 0" class="drop-mask">把图片或文件拖到这里交给我</div>
    <slot name="overlay">
      <ExtensionUiHost />
      <SettingsModal />
      <InstallBlockerDialog />
    </slot>
  </div>
</template>

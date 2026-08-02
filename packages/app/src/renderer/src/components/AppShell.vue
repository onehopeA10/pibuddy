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

const store = useAppStore();
const message = useMessage();
store.setNotifier(message);

const dragging = ref(0);

onMounted(() => {
  void store.init();
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
    <Sidebar />
    <div class="main-col">
      <TopBar />

      <template v-if="store.startError">
        <div class="onboarding">
          <h1>😥 启动失败</h1>
          <p style="white-space: pre-wrap; max-width: 640px">{{ store.startError }}</p>
          <n-button type="primary" @click="store.start()">重试</n-button>
          <n-button quaternary @click="store.chooseWorkspace()">换个文件夹</n-button>
        </div>
      </template>
      <template v-else>
        <ChatView />
        <InputBar />
      </template>
    </div>

    <div v-if="dragging > 0" class="drop-mask">把图片或文件拖到这里交给我</div>
    <ExtensionUiHost />
    <SettingsModal />
  </div>
</template>

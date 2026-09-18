<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../stores/app";

const store = useAppStore();

const workspaceName = computed(() => {
  const ws = store.workspace;
  return ws.split(/[\\/]/).filter(Boolean).pop() ?? ws ?? "工作区";
});

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
});

const cards = [
  {
    icon: "",
    name: "整理文件",
    desc: "按类型 / 日期把杂乱的文件分类归档",
    prompt: "帮我把工作文件夹里的文件整理一下：按文件类型分类放进子文件夹，整理完列一份清单给我。",
  },
  {
    icon: "",
    name: "分析表格",
    desc: "读取 Excel / CSV，统计汇总并给出结论",
    prompt: "帮我分析工作文件夹里的表格文件：统计关键数据，总结趋势和异常，用通俗的语言告诉我结论。",
  },
  {
    icon: "",
    name: "写文档",
    desc: "根据资料起草报告、周报、PPT 大纲",
    prompt: "根据工作文件夹里的资料，帮我起草一份文档（比如周报或汇报大纲），先列提纲给我确认。",
  },
  {
    icon: "",
    name: "处理图片 / 视频",
    desc: "批量重命名、格式转换、截图抽帧",
    prompt: "帮我处理工作文件夹里的图片或视频：告诉我你能做什么（批量改名、转格式、压缩、抽帧等），我再选。",
  },
];

function useCard(prompt: string): void {
  store.editorText = prompt;
}
</script>

<template>
  <div class="welcome">
    <div class="workspace-name">{{ workspaceName }}</div>
    <h1>{{ greeting }}，需要我帮你做点什么？</h1>
    <p class="sub">
      直接用一句话描述任务就行，也可以拖入文件、粘贴截图、按住麦克风说话。<br />
      我只会在你的工作文件夹里操作，重要动作会先征求你的同意。
    </p>
    <div class="card-grid">
      <div
        v-for="card in cards"
        :key="card.name"
        class="task-card"
        @click="useCard(card.prompt)"
      >
        <div class="icon">{{ card.icon }}</div>
        <div class="name">{{ card.name }}</div>
        <div class="desc">{{ card.desc }}</div>
      </div>
    </div>
  </div>
</template>

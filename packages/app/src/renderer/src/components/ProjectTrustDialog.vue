<script setup lang="ts">
/**
 * Project trust 对话框（EXT-102）。
 *
 * ## 为什么产品必须自己做这个
 *
 * pi 在 RPC 模式下**不弹 trust 提示**（docs/security.md:30）。没有已保存
 * 决定时，`defaultProjectTrust` 的默认值 `"ask"` 在非交互模式下等同于
 * `"never"` —— 也就是说，用户放在 `.pi/skills/` 下的技能会**毫无提示地
 * 不被加载**，界面上没有任何线索，用户只会觉得「我的技能怎么不好使了」。
 *
 * ## 三条不能省的信息
 *
 *  1. **来源**：这些资源来自哪个目录；
 *  2. **将要加载什么**：逐条列出，而不是一句「这个项目包含配置」；
 *  3. **信任不等于工具权限**：security.md 第一句就是 project trust
 *     "is not a sandbox and it does not restrict what the model can ask
 *     tools to do"。把它显示成安全开关是对用户的误导 —— 拒绝信任并不会
 *     让助手变得不能改你的文件。
 *
 * remember 勾选会写 `~/.pi/agent/trust.json`，那是**跨应用共享**的状态，
 * 用户在终端里跑 pi 时也会读到，所以文案里必须说清楚。
 */
import { computed, ref } from "vue";
import { NButton, NCheckbox, NModal, NSpace, NTag, NText } from "naive-ui";
import { TRUST_NOT_PERMISSION_NOTE } from "@contract";
import { useAppStore } from "../stores/app";
import { usePiResourcesStore } from "../stores/piResources";

const store = useAppStore();
const piRes = usePiResourcesStore();
const remember = ref(true);

const trust = computed(() => piRes.trust);
const resources = computed(() => trust.value?.resources ?? []);

async function decide(decision: "allow" | "deny"): Promise<void> {
  await piRes.decideTrust(store.workspaceId, decision, remember.value);
  // 信任决定影响的是 pi 启动时加载哪些资源，因此必须重启 runtime 才生效。
  // 不重启的话，用户点了「信任」却发现技能还是没有，会以为按钮没用。
  if (decision === "allow") await store.start();
}
</script>

<template>
  <n-modal
    :show="piRes.trustOpen"
    preset="card"
    style="max-width: 560px"
    title="要信任这个项目里的设置和技能吗？"
    role="dialog"
    aria-label="项目信任确认"
    :mask-closable="false"
    :closable="false"
  >
    <p class="lead">
      文件夹 <b>{{ store.workspace }}</b> 里带着一些只有「受信任」时才会被加载的东西：
    </p>

    <ul class="res-list">
      <li v-for="r in resources" :key="r.path">
        <n-tag size="small" :bordered="false">{{ r.label }}</n-tag>
        <span class="path">{{ r.path }}</span>
      </li>
      <li v-if="resources.length === 0" class="path">（没有检测到需要信任的项目资源）</li>
    </ul>

    <!-- 固定文案，与契约里的常量同源：改了这句话，测试会立刻发现 -->
    <p class="note">{{ TRUST_NOT_PERMISSION_NOTE }}</p>

    <n-checkbox v-model:checked="remember">
      记住这个选择（会写入 pi 的 trust.json，你在终端里用 pi 时也会生效）
    </n-checkbox>

    <template #footer>
      <n-space justify="end">
        <n-button @click="decide('deny')">不信任，先跳过这些</n-button>
        <n-button type="primary" @click="decide('allow')">信任这个项目</n-button>
      </n-space>
      <n-text depth="3" class="hint">
        选「不信任」时项目里的这些设置与技能不会被加载，其余功能一切照常。
      </n-text>
    </template>
  </n-modal>
</template>

<style scoped>
.lead {
  margin: 0 0 12px;
  word-break: break-all;
}
.res-list {
  margin: 0 0 16px;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.res-list .path {
  margin-left: 8px;
  font-size: 12px;
  opacity: 0.7;
  word-break: break-all;
}
.note {
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(240, 160, 32, 0.12);
  font-size: 13px;
  line-height: 1.7;
}
.hint {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  text-align: right;
}
</style>

<script setup lang="ts">
/**
 * 用量页（PROV-101）。
 *
 * 回答一个具体问题：**我每天花了多少钱**。数据全部来自本地 SQLite
 * （main/usage/usage-store.ts），没有任何上报路径。
 *
 * 导出的 CSV 经 csvCell 做过公式前缀转义 —— workspace 显示名是用户可控的
 * 文件夹名，一份「用 Excel 打开就执行命令」的导出文件是典型的静默风险。
 */
import { computed, ref, watch } from "vue";
import { NButton, NDatePicker, NEmpty, NModal, NSpace, NStatistic } from "naive-ui";
import { useProvidersStore } from "../stores/providers";
import { useAppStore } from "../stores/app";

const providers = useProvidersStore();
const app = useAppStore();

/** [起, 止] 时间戳；null 表示不限。 */
const range = ref<[number, number] | null>(null);
const onlyThisWorkspace = ref(true);

function toDay(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function applyFilter(): Promise<void> {
  await providers.refreshUsage({
    ...(range.value ? { fromDay: toDay(range.value[0]), toDay: toDay(range.value[1]) } : {}),
    ...(onlyThisWorkspace.value && app.workspaceId ? { workspaceId: app.workspaceId } : {}),
  });
}

watch(
  () => providers.usagePanelOpen,
  (open) => {
    if (open) void applyFilter();
  },
  { immediate: true }
);

watch([range, onlyThisWorkspace], () => void applyFilter());

const rows = computed(() => providers.usageRows);
</script>

<template>
  <n-modal
    v-model:show="providers.usagePanelOpen"
    preset="card"
    style="max-width: 860px"
    title="用量与花费"
    role="dialog"
    aria-labelledby="usage-panel-title"
  >
    <p id="usage-panel-title" class="intro">
      按天统计每个模型用掉的 token 与花费。数据只保存在你自己的电脑上。
    </p>

    <n-space align="center" style="margin-bottom: 12px">
      <n-date-picker
        v-model:value="range"
        type="daterange"
        clearable
        size="small"
        aria-label="按日期筛选"
      />
      <n-button
        size="small"
        :type="onlyThisWorkspace ? 'primary' : 'default'"
        @click="onlyThisWorkspace = !onlyThisWorkspace"
      >
        {{ onlyThisWorkspace ? "只看当前文件夹" : "全部文件夹" }}
      </n-button>
      <div style="flex: 1" />
      <n-button size="small" @click="providers.exportUsage('csv')">导出 CSV</n-button>
      <n-button size="small" @click="providers.exportUsage('json')">导出 JSON</n-button>
    </n-space>

    <n-space style="margin-bottom: 12px">
      <n-statistic label="总花费" :value="`$${providers.totalCost.toFixed(4)}`" />
      <n-statistic label="失败次数" :value="providers.totalFailures" />
      <n-statistic label="记录条数" :value="rows.length" />
    </n-space>

    <!--
      刻意用原生 table 而不是 n-data-table：这张表需要被 DOM 断言逐格检查
      （日期 / 服务商 / 模型 / token / 花费 / 失败数），虚拟滚动组件会让
      「表里有没有这一行」变成一个取决于滚动位置的问题。
    -->
    <table v-if="rows.length" class="usage-table" data-testid="usage-table">
      <thead>
        <tr>
          <th scope="col">日期</th>
          <th scope="col">服务商</th>
          <th scope="col">模型</th>
          <th scope="col">输入</th>
          <th scope="col">输出</th>
          <th scope="col">记忆占用</th>
          <th scope="col">花费</th>
          <th scope="col">失败</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="`${row.day}-${row.provider}-${row.model}-${i}`">
          <td>{{ row.day }}</td>
          <td>{{ row.provider }}</td>
          <td>{{ row.model }}</td>
          <td>{{ row.inputTokens.toLocaleString() }}</td>
          <td>{{ row.outputTokens.toLocaleString() }}</td>
          <td>{{ row.contextTokens.toLocaleString() }}</td>
          <td>${{ row.cost.toFixed(4) }}</td>
          <td>{{ row.failures }}</td>
        </tr>
      </tbody>
    </table>

    <n-empty v-else description="这个时间段还没有用量记录" style="margin: 24px 0" />

    <n-space justify="end" style="margin-top: 12px">
      <n-button @click="providers.usagePanelOpen = false">关闭</n-button>
    </n-space>
  </n-modal>
</template>

<style scoped>
.intro {
  font-size: 12.5px;
  color: #8a8f98;
  margin: 0 0 12px;
}
.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.usage-table th,
.usage-table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.18);
  text-align: right;
}
.usage-table th:nth-child(-n + 3),
.usage-table td:nth-child(-n + 3) {
  text-align: left;
}
.usage-table thead th {
  color: #8a8f98;
  font-weight: 500;
}
</style>

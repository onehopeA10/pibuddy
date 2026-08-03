<script setup lang="ts">
/**
 * 定时任务面板（Durable Tasks，AUT-101 的界面出口）。
 *
 * 一处集齐：建任务（一次 / 每天 / 每周 / cron / 事件，带时区、错过策略、并发
 * 策略、失败重试、预算、超时）、列表（保存时显示时区 / 下一次运行 / workspace /
 * Agent / Provider / 权限 / 预算 / 超时 / 失败策略）、以及 pause / resume /
 * run now / duplicate / delete，展开一条任务看它的 run（cancel / retry）。
 *
 * ## 为什么把「缺哪些预授权」画出来
 *
 * 无人值守的定时 run 只认 workspace 预授权，绝不继承交互会话的 allow-once。
 * 缺授权的危险任务不会静默失败，而是被登记为「等待授权」——这块 UI 把它摊开，
 * 用户据此知道要去权限中心给这个工作区补 allow-workspace（危险权限会弹原生框）。
 */
import { computed, ref, watch } from "vue";
import {
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTag,
  NCheckboxGroup,
  NCheckbox,
} from "naive-ui";
import { useAppStore } from "../stores/app";
import { useTasksStore } from "../stores/tasks";
import type { RunStatus, TaskSchedule } from "@contract";

const app = useAppStore();
const store = useTasksStore();

const workspaceId = computed(() => app.workspaceId ?? "");

watch(
  () => [store.panelOpen, workspaceId.value] as const,
  ([open, wid]) => {
    if (open && wid) void store.refresh(wid);
  }
);

// ------------------------------------------------------------ 展示辅助

function fmt(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function scheduleText(s: TaskSchedule): string {
  switch (s.kind) {
    case "once":
      return `一次：${new Date(s.at).toLocaleString()}`;
    case "daily":
      return `每天 ${s.time}`;
    case "weekly": {
      const names = ["日", "一", "二", "三", "四", "五", "六"];
      return `每周${s.weekdays.map((d) => names[d]).join("、")} ${s.time}`;
    }
    case "cron":
      return `cron：${s.expression}`;
    case "event":
      return `事件：${s.event}`;
  }
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};
const RUN_STATUS_TYPE: Record<RunStatus, "default" | "info" | "success" | "error" | "warning"> = {
  pending: "default",
  running: "info",
  succeeded: "success",
  failed: "error",
  cancelled: "warning",
  skipped: "warning",
};

// ------------------------------------------------------------ 建任务表单

const showForm = ref(false);
const fName = ref("");
const fKind = ref<TaskSchedule["kind"]>("daily");
const fOnceAt = ref<number>(Date.now() + 3600_000);
const fTime = ref("09:00");
const fWeekdays = ref<number[]>([1, 2, 3, 4, 5]);
const fCron = ref("0 9 * * *");
const fEvent = ref("");
const fTimezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const fProvider = ref("");
const fModel = ref("");
const fPrompt = ref("");
const fPermissions = ref("");
const fBudget = ref<number | null>(null);
const fTimeout = ref<number | null>(null);
const fMisfire = ref<"skip" | "run-once" | "catch-up">("skip");
const fConcurrency = ref<"allow" | "forbid" | "queue">("forbid");
const fRetry = ref(false);
const fMaxAttempts = ref(3);
const fBackoff = ref(60000);

const kindOptions = [
  { label: "一次", value: "once" },
  { label: "每天", value: "daily" },
  { label: "每周", value: "weekly" },
  { label: "cron 表达式", value: "cron" },
  { label: "事件驱动", value: "event" },
];
const weekdayOptions = [
  { label: "周日", value: 0 },
  { label: "周一", value: 1 },
  { label: "周二", value: 2 },
  { label: "周三", value: 3 },
  { label: "周四", value: 4 },
  { label: "周五", value: 5 },
  { label: "周六", value: 6 },
];
const tzOptions = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  fTimezone.value,
]
  .filter((v, i, a) => a.indexOf(v) === i)
  .map((v) => ({ label: v, value: v }));
const misfireOptions = [
  { label: "跳过错过的（skip）", value: "skip" },
  { label: "最多补一次（run-once）", value: "run-once" },
  { label: "逐个补跑（catch-up，仅幂等）", value: "catch-up" },
];
const concurrencyOptions = [
  { label: "禁止并发（forbid）", value: "forbid" },
  { label: "排队（queue）", value: "queue" },
  { label: "允许并发（allow）", value: "allow" },
];

function buildSchedule(): TaskSchedule {
  switch (fKind.value) {
    case "once":
      return { kind: "once", at: fOnceAt.value };
    case "daily":
      return { kind: "daily", time: fTime.value };
    case "weekly":
      return { kind: "weekly", weekdays: [...fWeekdays.value].sort(), time: fTime.value };
    case "cron":
      return { kind: "cron", expression: fCron.value.trim() };
    case "event":
      return { kind: "event", event: fEvent.value.trim() };
  }
}

async function submit(): Promise<void> {
  if (!fName.value.trim() || !fPrompt.value.trim() || !workspaceId.value) return;
  const permissions = fPermissions.value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const ok = await store.create({
    workspaceId: workspaceId.value,
    name: fName.value.trim(),
    schedule: buildSchedule(),
    timezone: fTimezone.value,
    agent: { provider: fProvider.value.trim(), model: fModel.value.trim(), prompt: fPrompt.value.trim() },
    requiredPermissions: permissions,
    budgetUsd: fBudget.value,
    timeoutMs: fTimeout.value,
    misfirePolicy: fMisfire.value,
    concurrencyPolicy: fConcurrency.value,
    failurePolicy: {
      retry: fRetry.value,
      maxAttempts: fRetry.value ? fMaxAttempts.value : 1,
      backoffMs: fBackoff.value,
    },
  });
  if (ok) {
    showForm.value = false;
    fName.value = "";
    fPrompt.value = "";
  }
}
</script>

<template>
  <n-modal
    v-model:show="store.panelOpen"
    preset="card"
    title="⏰ 定时任务"
    style="width: 860px; max-width: 92vw"
  >
    <div class="tasks-toolbar">
      <n-button size="small" type="primary" @click="showForm = !showForm">
        {{ showForm ? "收起" : "＋ 新建任务" }}
      </n-button>
      <n-button size="small" quaternary @click="store.refresh(workspaceId)">刷新</n-button>
      <span v-if="store.lastError" class="err">{{ store.lastError }}</span>
    </div>

    <!-- 建任务表单 -->
    <div v-if="showForm" class="form">
      <div class="row">
        <n-input v-model:value="fName" placeholder="任务名称" />
      </div>
      <div class="row">
        <n-select v-model:value="fKind" :options="kindOptions" style="width: 160px" />
        <n-select v-model:value="fTimezone" :options="tzOptions" filterable tag style="width: 200px" />
        <n-input v-if="fKind === 'daily' || fKind === 'weekly'" v-model:value="fTime" placeholder="HH:MM" style="width: 100px" />
        <n-input v-if="fKind === 'cron'" v-model:value="fCron" placeholder="分 时 日 月 周" style="width: 200px" />
        <n-input v-if="fKind === 'event'" v-model:value="fEvent" placeholder="事件名" style="width: 200px" />
        <n-input-number
          v-if="fKind === 'once'"
          v-model:value="fOnceAt"
          :show-button="false"
          style="width: 200px"
        />
      </div>
      <div v-if="fKind === 'weekly'" class="row">
        <n-checkbox-group v-model:value="fWeekdays">
          <n-checkbox v-for="o in weekdayOptions" :key="o.value" :value="o.value" :label="o.label" />
        </n-checkbox-group>
      </div>
      <div class="row">
        <n-input v-model:value="fProvider" placeholder="Provider（留空用默认）" style="width: 200px" />
        <n-input v-model:value="fModel" placeholder="模型（留空用默认）" style="width: 200px" />
      </div>
      <div class="row">
        <n-input
          v-model:value="fPrompt"
          type="textarea"
          placeholder="要交给 Agent 的提示词"
          :autosize="{ minRows: 2, maxRows: 6 }"
        />
      </div>
      <div class="row">
        <n-input
          v-model:value="fPermissions"
          placeholder="需要的权限（逗号分隔，如 process.git）"
          style="width: 320px"
        />
        <n-input-number v-model:value="fBudget" placeholder="预算 $" :min="0" style="width: 130px" />
        <n-input-number v-model:value="fTimeout" placeholder="超时 ms" :min="1" style="width: 140px" />
      </div>
      <div class="row">
        <n-select v-model:value="fMisfire" :options="misfireOptions" style="width: 230px" />
        <n-select v-model:value="fConcurrency" :options="concurrencyOptions" style="width: 180px" />
      </div>
      <div class="row">
        <span>失败重试</span>
        <n-switch v-model:value="fRetry" />
        <template v-if="fRetry">
          <n-input-number v-model:value="fMaxAttempts" :min="1" :max="10" style="width: 110px" />
          <n-input-number v-model:value="fBackoff" :min="0" style="width: 140px" placeholder="退避 ms" />
        </template>
        <n-button size="small" type="primary" @click="submit">保存</n-button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div v-if="store.items.length === 0" class="empty">还没有定时任务。</div>
    <div v-for="item in store.items" :key="item.task.id" class="task-card">
      <div class="task-head">
        <b>{{ item.task.name }}</b>
        <n-tag size="small" :type="item.task.status === 'active' ? 'success' : 'default'">
          {{ item.task.status === "active" ? "启用" : "已暂停" }}
        </n-tag>
        <n-tag v-if="item.lastRunStatus" size="small" :type="RUN_STATUS_TYPE[item.lastRunStatus]">
          最近：{{ RUN_STATUS_LABEL[item.lastRunStatus] }}
        </n-tag>
        <n-tag v-if="item.missingPermissions.length" size="small" type="error">
          等待授权：{{ item.missingPermissions.join("、") }}
        </n-tag>
      </div>
      <div class="task-meta">
        <span>{{ scheduleText(item.task.schedule) }}</span>
        <span>时区 {{ item.task.timezone }}</span>
        <span>下次 {{ fmt(item.task.nextRunAt) }}</span>
        <span v-if="item.task.agent.provider">Provider {{ item.task.agent.provider }}</span>
        <span v-if="item.task.agent.model">模型 {{ item.task.agent.model }}</span>
        <span v-if="item.task.budgetUsd !== null">预算 ${{ item.task.budgetUsd }}</span>
        <span v-if="item.task.timeoutMs !== null">超时 {{ item.task.timeoutMs }}ms</span>
        <span>错过 {{ item.task.misfirePolicy }}</span>
        <span>并发 {{ item.task.concurrencyPolicy }}</span>
        <span v-if="item.task.failurePolicy.retry">重试 ×{{ item.task.failurePolicy.maxAttempts }}</span>
        <span v-if="item.task.requiredPermissions.length">权限 {{ item.task.requiredPermissions.join("、") }}</span>
      </div>
      <div class="task-actions">
        <n-button size="tiny" type="primary" @click="store.runNow(workspaceId, item.task.id)">立即运行</n-button>
        <n-button
          v-if="item.task.status === 'active'"
          size="tiny"
          @click="store.pause(workspaceId, item.task.id)"
        >
          暂停
        </n-button>
        <n-button v-else size="tiny" @click="store.resume(workspaceId, item.task.id)">恢复</n-button>
        <n-button size="tiny" @click="store.select(workspaceId, item.task.id)">运行记录</n-button>
        <n-button size="tiny" quaternary @click="store.duplicate(workspaceId, item.task.id)">复制</n-button>
        <n-button size="tiny" quaternary type="error" @click="store.remove(workspaceId, item.task.id)">删除</n-button>
      </div>

      <!-- 展开的 run 列表 -->
      <div v-if="store.selectedId === item.task.id && store.detail" class="runs">
        <div v-if="store.detail.runs.length === 0" class="empty">还没有运行记录。</div>
        <div v-for="run in store.detail.runs" :key="run.id" class="run-row">
          <n-tag size="small" :type="RUN_STATUS_TYPE[run.status]">{{ RUN_STATUS_LABEL[run.status] }}</n-tag>
          <span>#{{ run.attempt }}</span>
          <span>计划 {{ fmt(run.scheduledFor) }}</span>
          <span v-if="run.startedAt">起 {{ fmt(run.startedAt) }}</span>
          <span v-if="run.finishedAt">止 {{ fmt(run.finishedAt) }}</span>
          <span v-if="run.costUsd !== null">${{ run.costUsd }}</span>
          <span v-if="run.error" class="err" :title="run.error">{{ run.error }}</span>
          <n-button
            v-if="run.status === 'pending' || run.status === 'running'"
            size="tiny"
            @click="store.cancelRun(workspaceId, item.task.id, run.id)"
          >
            取消
          </n-button>
          <n-button
            v-if="run.status === 'failed' || run.status === 'cancelled'"
            size="tiny"
            @click="store.retryRun(workspaceId, item.task.id, run.id)"
          >
            重试
          </n-button>
          <span v-if="run.log.length" class="run-log" :title="run.log.join('\n')">日志 {{ run.log.length }}</span>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.tasks-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
.err {
  color: #d03050;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}
.form {
  border: 1px solid var(--n-border-color, #eee);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.form .row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.task-card {
  border: 1px solid var(--n-border-color, #eee);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.task-head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.task-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #888;
  margin-bottom: 8px;
}
.task-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.runs {
  margin-top: 10px;
  border-top: 1px dashed var(--n-border-color, #eee);
  padding-top: 8px;
}
.run-row {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  padding: 3px 0;
  flex-wrap: wrap;
}
.run-log {
  color: #888;
  cursor: help;
}
.empty {
  color: #999;
  font-size: 13px;
  padding: 8px 0;
}
</style>

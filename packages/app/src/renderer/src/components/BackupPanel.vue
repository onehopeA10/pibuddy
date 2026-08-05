<script setup lang="ts">
/**
 * 备份 / 恢复区块（BKP-101）。
 *
 * ## 界面上的三句话都不许含糊
 *
 *   1. **不是原子快照**。12 个数据库是逐个依次快照的，各自内部完整，跨库
 *      一致性是尽力而为。这句话必须出现在按钮旁边，而不是藏在文档里 ——
 *      用户是在一次事故之后才会去读文档的，那时说什么都晚了。
 *   2. **不含设置、凭据、产物文件本体**。用户以为「备份」就是全都备份了，
 *      而这三样恰好是他最可能以为已经备份了的。
 *   3. **恢复要重启才生效**，且会覆盖现有数据、不可撤销。数据库此刻正被
 *      应用打开着，当场换文件在 Windows 上根本做不到。
 *
 * ## 校验结论逐条展示
 *
 * 「备份无效」这四个字对运维毫无价值。sha256 不符、完整性坏了、缺表、
 * 代际不符要查的方向完全不同，因此 reasons 是一个列表，一条一行原样显示。
 */
import { onMounted, ref } from "vue";
import { NAlert, NButton, NSpace, useMessage } from "naive-ui";
import type { BackupStatus, BackupValidation } from "@contract";

const message = useMessage();

const status = ref<BackupStatus | null>(null);
const validation = ref<BackupValidation | null>(null);
const busy = ref("");
const error = ref("");

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function humanTime(at: number): string {
  return new Date(at).toLocaleString();
}

async function refresh(): Promise<void> {
  try {
    status.value = await window.piBuddy.backup.describe();
    validation.value = status.value.lastValidation;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function run(kind: "create" | "validate" | "restore"): Promise<void> {
  busy.value = kind;
  error.value = "";
  try {
    if (kind === "create") {
      const result = await window.piBuddy.backup.create();
      if (!result.path) {
        message.info("已取消");
        return;
      }
      validation.value = result.validation;
      message.success("备份已完成并通过自校验");
    } else if (kind === "validate") {
      const result = await window.piBuddy.backup.validate();
      validation.value = result;
      if (result.reasons.length === 1 && result.reasons[0] === "已取消") {
        message.info("已取消");
        return;
      }
      if (result.ok) message.success("这份备份可用");
      else message.error("这份备份不可用，原因见下方");
    } else {
      const result = await window.piBuddy.backup.restore();
      if (!result.staged) {
        message.info("已取消");
        return;
      }
      validation.value = result.validation;
      message.warning("恢复已就绪，下次启动应用时生效");
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    message.error(error.value);
  } finally {
    busy.value = "";
    await refresh();
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div style="margin-top: 12px; border-top: 1px solid #eceef2; padding-top: 12px">
    <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px">备份与恢复</div>
    <div style="font-size: 12.5px; color: #8a8f98; margin-bottom: 8px">
      把本机的 {{ status?.storeIds.length ?? 0 }} 个数据库（会话索引、记忆、任务、工作流、
      用量统计等）连同工作区注册表复制到你选的文件夹。
      <strong>不是同一瞬间的整体快照</strong>：各个数据库是依次备份的，每个自己完整，
      跨库之间可能相差几百毫秒——建议在空闲时做。
      <br />
      备份<strong>不含</strong>设置、账号凭据与产物文件本体（后者是你工作区里的普通文件）。
    </div>

    <n-space align="center" style="margin-bottom: 8px">
      <n-button size="small" :loading="busy === 'create'" @click="run('create')">
        备份到文件夹…
      </n-button>
      <n-button size="small" :loading="busy === 'validate'" @click="run('validate')">
        校验一份备份…
      </n-button>
      <n-button size="small" type="warning" :loading="busy === 'restore'" @click="run('restore')">
        从备份恢复…
      </n-button>
    </n-space>

    <div v-if="status?.lastBackup" style="font-size: 12.5px; color: #4b5563; margin-bottom: 6px">
      上次备份：{{ humanTime(status.lastBackup.at) }} ·
      {{ status.lastBackup.fileCount }} 个文件 ·
      {{ humanSize(status.lastBackup.totalBytes) }}
      <div style="color: #8a8f98; word-break: break-all">{{ status.lastBackup.path }}</div>
    </div>
    <div v-else style="font-size: 12.5px; color: #8a8f98; margin-bottom: 6px">还没有备份过。</div>

    <n-alert
      v-if="status?.pendingRestore"
      type="warning"
      title="有一份恢复等待生效"
      style="margin-bottom: 8px"
    >
      <p style="margin: 0">
        副本已经校验通过并落到暂存区。<strong>重启应用后</strong>才会真正覆盖现有数据库——
        数据库此刻正被应用打开着，当场替换做不到。
      </p>
    </n-alert>

    <n-alert v-if="error" type="error" title="操作失败" style="margin-bottom: 8px">
      <p style="white-space: pre-wrap; margin: 0">{{ error }}</p>
    </n-alert>

    <div v-if="validation" style="font-size: 12.5px">
      <div :style="{ color: validation.ok ? '#16a34a' : '#dc2626', marginBottom: '2px' }">
        上次校验（{{ humanTime(validation.checkedAt) }}）：{{ validation.ok ? "通过" : "未通过" }}
        <span v-if="validation.ok">
          · {{ validation.stores.length }} 个库 · {{ validation.fileCount }} 个文件 ·
          {{ humanSize(validation.totalBytes) }}
        </span>
      </div>
      <ul
        v-if="validation.reasons.length"
        style="margin: 0 0 6px; padding-left: 20px; color: #dc2626"
      >
        <li v-for="(reason, i) in validation.reasons" :key="i">{{ reason }}</li>
      </ul>
      <div v-if="validation.artifacts" style="color: #6b7280">
        产物对账（仅供参考，不影响备份是否可用）：已核对
        {{ validation.artifacts.checked }} 条 · 文件已不在
        {{ validation.artifacts.missing }} 条 · 大小对不上
        {{ validation.artifacts.sizeMismatch }} 条 · 工作区已不在注册表
        {{ validation.artifacts.unresolvedWorkspaces }} 条。
      </div>
    </div>
  </div>
</template>

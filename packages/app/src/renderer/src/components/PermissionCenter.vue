<script setup lang="ts">
/**
 * 授权中心（ADR-0002 D3 / SEC-003：加审计与撤销）。
 *
 * 最小可用版：列出当前工作区落盘的授权（allow-workspace）与本次运行的
 * 授权（allow-session），每条给一个「撤销」；下面是一段审计流水。撤销是
 * SEC-003 的明确要求——授权一旦给出去，用户必须能随时收回，且收回这件事
 * 本身也进审计。
 */
import { computed, onMounted } from "vue";
import { NButton, NDrawer, NDrawerContent, NEmpty, NList, NListItem, NTag, NText, NSpace } from "naive-ui";
import type { CapabilityGrant, PermissionAuditEntry } from "@contract";
import { usePermissionStore } from "../stores/permission";

const store = usePermissionStore();

const workspaceGrants = computed<CapabilityGrant[]>(() => store.workspaceGrants);
const sessionGrants = computed<CapabilityGrant[]>(() => store.sessionGrants);
const audit = computed<PermissionAuditEntry[]>(() => [...store.audit].reverse());

onMounted(() => {
  void store.refresh();
});

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <n-drawer :show="store.centerOpen" :width="420" placement="right" @update:show="(v) => (store.centerOpen = v)">
    <n-drawer-content title="授权中心" closable>
      <n-space vertical size="large">
        <div>
          <n-text strong>工作区授权（持久）</n-text>
          <n-empty v-if="workspaceGrants.length === 0" description="无" size="small" style="margin-top: 8px" />
          <n-list v-else bordered style="margin-top: 8px">
            <n-list-item v-for="(g, i) in workspaceGrants" :key="'w' + i">
              <n-space vertical size="small">
                <n-space size="small">
                  <n-tag size="small" :bordered="false">{{ g.capabilityId }}</n-tag>
                  <n-tag size="small" type="warning" :bordered="false">{{ g.permission }}</n-tag>
                </n-space>
                <n-text v-if="g.resource" depth="3">{{ g.resource }}</n-text>
              </n-space>
              <template #suffix>
                <n-button size="tiny" @click="store.revoke(g, 'workspace')">撤销</n-button>
              </template>
            </n-list-item>
          </n-list>
        </div>

        <div>
          <n-text strong>本次运行授权（重启即失效）</n-text>
          <n-empty v-if="sessionGrants.length === 0" description="无" size="small" style="margin-top: 8px" />
          <n-list v-else bordered style="margin-top: 8px">
            <n-list-item v-for="(g, i) in sessionGrants" :key="'s' + i">
              <n-space size="small">
                <n-tag size="small" :bordered="false">{{ g.capabilityId }}</n-tag>
                <n-tag size="small" type="warning" :bordered="false">{{ g.permission }}</n-tag>
              </n-space>
              <template #suffix>
                <n-button size="tiny" @click="store.revoke(g, 'session')">撤销</n-button>
              </template>
            </n-list-item>
          </n-list>
        </div>

        <div>
          <n-text strong>审计</n-text>
          <n-empty v-if="audit.length === 0" description="无" size="small" style="margin-top: 8px" />
          <n-list v-else style="margin-top: 8px">
            <n-list-item v-for="(a, i) in audit" :key="'a' + i">
              <n-space size="small" align="center">
                <n-tag
                  size="small"
                  :type="a.kind === 'granted' ? 'success' : a.kind === 'blocked' || a.kind === 'denied' ? 'error' : 'default'"
                  :bordered="false"
                >
                  {{ a.kind }}
                </n-tag>
                <n-text depth="3">{{ fmt(a.at) }}</n-text>
                <n-text>{{ a.permission }}</n-text>
              </n-space>
            </n-list-item>
          </n-list>
        </div>
      </n-space>
    </n-drawer-content>
  </n-drawer>
</template>

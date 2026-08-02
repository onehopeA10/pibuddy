<script setup lang="ts">
/**
 * Pi 资源中心（EXT-102 第一版）。
 *
 * 枚举 user / project / package 三来源的 package / extension / skill /
 * prompt / theme，显示路径、版本、来源、启用状态、冲突与诊断，并提供
 * 安装 / 卸载 / 启停 / 刷新 / 打开目录。
 *
 * ## 这里没有输入命令的地方
 *
 * 输入框收的是**包规格**（`npm:@foo/bar@1.0.0` / `git:host/user/repo@v1` /
 * 本地路径），主进程侧以 shell:false 的方式跑白名单子命令 install /
 * remove，并对入参做 shell 元字符校验。渲染进程在结构上表达不出
 * 「执行这条命令」—— pi 的包管理跑的是 npm 和 git，留一条通用转发口
 * 等于把本机命令行挂在界面上。
 *
 * ## MCP 明确标为未实现
 *
 * MCP 的增删改查、启停、连接测试、OAuth 状态、工具列表本轮**没有做**。
 * 这里写出这句话，而不是渲染一个空列表 —— 空列表在同一块像素上表达的是
 * 「你还没配过 MCP」，那是另一件完全不同的事。
 */
import { computed, ref, watch } from "vue";
import {
  NAlert,
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  NText,
} from "naive-ui";
import { useAppStore } from "../stores/app";
import { usePiResourcesStore } from "../stores/piResources";

const store = useAppStore();
const piRes = usePiResourcesStore();

const KIND_LABEL: Record<string, string> = {
  skill: "技能",
  extension: "扩展",
  package: "包",
  prompt: "提示词",
  theme: "主题",
};
const SOURCE_LABEL: Record<string, string> = {
  user: "全局",
  project: "项目",
  package: "来自包",
};

const specInput = ref("");
const scope = ref<"user" | "project">("user");
const scopeOptions = [
  { label: "只装给我自己（全局）", value: "user" },
  { label: "装进这个项目（需要项目受信任）", value: "project" },
];

const groups = computed(() =>
  (["skill", "extension", "package", "prompt", "theme"] as const)
    .map((kind) => ({ kind, items: piRes.byKind.get(kind) ?? [] }))
    .filter((g) => g.items.length > 0)
);

const trustBlocked = computed(
  () => piRes.trust !== null && piRes.trust.hasProjectResources && piRes.trust.effective !== "allow"
);

watch(
  () => piRes.panelOpen,
  (open) => {
    if (open) void piRes.refresh(store.workspaceId);
  }
);

async function doInstall(): Promise<void> {
  const spec = specInput.value.trim();
  if (!spec) return;
  const result = await piRes.install(store.workspaceId, spec, scope.value);
  if (result.ok) specInput.value = "";
}
</script>

<template>
  <n-drawer v-model:show="piRes.panelOpen" :width="560" placement="right">
    <n-drawer-content title="Pi 资源" closable>
      <n-space vertical size="large">
        <!-- 项目信任提示 -->
        <n-alert v-if="trustBlocked" type="warning" title="这个项目还没有被信任">
          项目里的技能与扩展暂时不会被加载。
          <n-button text type="primary" @click="piRes.trustOpen = true">现在处理</n-button>
        </n-alert>

        <!-- 安装 -->
        <div>
          <n-text depth="3" class="section-hint">
            安装一个技能或扩展包。填 pi 的包规格，例如
            <code>npm:@scope/pkg@1.0.0</code> 或 <code>git:github.com/user/repo@v1</code>。
          </n-text>
          <n-space :wrap="false" style="margin-top: 8px">
            <n-input
              v-model:value="specInput"
              placeholder="npm:@scope/pkg@1.0.0"
              aria-label="包规格"
              @keydown.enter="doInstall"
            />
            <n-select
              v-model:value="scope"
              :options="scopeOptions"
              style="width: 220px"
              :consistent-menu-width="false"
            />
            <n-button
              type="primary"
              :loading="piRes.busySpec !== ''"
              :disabled="!specInput.trim()"
              @click="doInstall"
            >
              安装
            </n-button>
          </n-space>
        </div>

        <n-space>
          <n-button size="small" :loading="piRes.loading" @click="piRes.refresh(store.workspaceId)">
            🔄 刷新
          </n-button>
        </n-space>

        <n-alert v-if="piRes.lastError" type="error" closable @close="piRes.lastError = ''">
          <pre class="err">{{ piRes.lastError }}</pre>
        </n-alert>

        <n-alert v-for="(e, i) in piRes.scanErrors" :key="i" type="warning" :bordered="false">
          {{ e }}
        </n-alert>

        <n-spin :show="piRes.loading">
          <n-empty v-if="groups.length === 0" description="还没有发现任何 Pi 资源" />

          <section v-for="g in groups" :key="g.kind" class="group">
            <h4>{{ KIND_LABEL[g.kind] ?? g.kind }}（{{ g.items.length }}）</h4>
            <div v-for="r in g.items" :key="r.id" class="row">
              <div class="row-main">
                <div class="row-title">
                  <span class="name">{{ r.name }}</span>
                  <n-tag size="tiny" :bordered="false">{{ SOURCE_LABEL[r.source] }}</n-tag>
                  <n-tag v-if="r.version" size="tiny" type="info" :bordered="false">
                    v{{ r.version }}
                  </n-tag>
                  <n-tag v-if="r.pinned" size="tiny" type="success" :bordered="false">
                    版本已锁定
                  </n-tag>
                  <n-tag
                    v-if="r.conflictWith.length > 0"
                    size="tiny"
                    type="warning"
                    :bordered="false"
                  >
                    与 {{ r.conflictWith.length }} 个同名资源冲突
                  </n-tag>
                </div>
                <div class="path">{{ r.path }}</div>
                <div v-for="(d, i) in r.diagnostics" :key="i" class="diag">⚠ {{ d }}</div>
              </div>
              <div class="row-actions">
                <n-switch
                  size="small"
                  :value="r.enabled"
                  :aria-label="`启用 ${r.name}`"
                  @update:value="(v: boolean) => piRes.setEnabled(store.workspaceId, r.id, v)"
                />
                <n-button
                  size="tiny"
                  quaternary
                  aria-label="打开所在目录"
                  @click="piRes.openDir(store.workspaceId, r.id)"
                >
                  📁
                </n-button>
                <n-button
                  v-if="r.spec"
                  size="tiny"
                  quaternary
                  type="error"
                  :loading="piRes.busySpec === r.spec"
                  @click="piRes.remove(store.workspaceId, r.spec, r.source === 'project' ? 'project' : 'user')"
                >
                  卸载
                </n-button>
              </div>
            </div>
          </section>
        </n-spin>

        <!-- MCP：本轮未实现，明说 -->
        <n-alert type="default" title="MCP 服务器管理">
          {{ piRes.mcpNote || "MCP 管理（增删改查、启停、连接测试、OAuth 状态、工具列表）本轮尚未实现" }}
        </n-alert>
      </n-space>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.section-hint {
  font-size: 12px;
}
.group h4 {
  margin: 16px 0 8px;
  font-size: 13px;
  opacity: 0.7;
}
.row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 8px 0;
  border-top: 1px solid rgba(128, 128, 128, 0.16);
}
.row-main {
  flex: 1;
  min-width: 0;
}
.row-title {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.name {
  font-weight: 600;
}
.path {
  margin-top: 2px;
  font-size: 11px;
  opacity: 0.6;
  word-break: break-all;
}
.diag {
  margin-top: 2px;
  font-size: 11px;
  color: #d08700;
}
.row-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.err {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}
</style>

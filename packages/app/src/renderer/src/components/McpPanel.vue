<script setup lang="ts">
/**
 * MCP 服务器管理面板（能力包 common.mcp）。
 *
 * 枚举 user / project 两来源的 MCP 服务器，显示传输方式、来源、活进程状态、
 * env / header 键名（值已在主进程脱敏，不下发）、OAuth 声明与诊断；提供
 * 新建 / 编辑 / 删除、连接测试、启动、停止。
 *
 * ## 这里没有输入命令行的地方
 *
 * 表单收的是**结构化配置**（command + args 分开填），主进程侧以
 * `spawn(shell:false)` 直接把 command 当 argv[0] 执行——args 里的 shell
 * 元字符只是普通字符串。启停 / 测试按钮发出去的是不透明的服务器 id，
 * 主进程按 id 从磁盘配置查出命令再跑，渲染进程表达不出「执行这条命令」。
 *
 * ## http / OAuth 明确标为未实现
 *
 * http / 远程 MCP 的连接测试与 OAuth 授权流程本轮**没做**（safeFetch 阻断
 * 私网且仅放行 HTTPS，任意用户主机又无法用 network:<domain> 表达）。诊断里
 * 照实写出这句话，不伪装成「已连接」——与 TASK-012 对 MCP 整体「未实现」的
 * 诚实处理同口径。
 */
import { computed, reactive, ref, watch } from "vue";
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
} from "naive-ui";
import type { McpScope, McpServerInput, McpTransport } from "@contract";
import { parseMcpImport } from "../../../lib/mcp-import";
import { useAppStore } from "../stores/app";
import { useMcpStore } from "../stores/mcp";

const app = useAppStore();
const mcp = useMcpStore();

const TRANSPORT_LABEL: Record<string, string> = { stdio: "stdio（本地进程）", http: "http（远程）" };
const SCOPE_LABEL: Record<string, string> = { user: "全局", project: "项目" };

const scopeOptions = [
  { label: "只给我自己（全局，~/.pi/agent/mcp.json）", value: "user" },
  { label: "装进这个项目（<项目>/.pi/mcp.json）", value: "project" },
];
const transportOptions = [
  { label: "stdio（本地进程）", value: "stdio" },
  { label: "http（远程，本轮仅枚举展示）", value: "http" },
];

/** 新建 / 编辑表单。args / env 用多行文本，落盘前拆成数组 / 键值对。 */
const form = reactive({
  scope: "user" as McpScope,
  name: "",
  transport: "stdio" as McpTransport,
  command: "",
  argsText: "",
  envText: "",
  url: "",
  oauth: false,
});
const showForm = ref(false);
const showPaste = ref(false);
const pasteText = ref("");
const pasteNotice = ref("");
const saving = ref(false);
const formError = ref("");
let submitSeq = 0;

function resetForm(): void {
  form.scope = "user";
  form.name = "";
  form.transport = "stdio";
  form.command = "";
  form.argsText = "";
  form.envText = "";
  form.url = "";
  form.oauth = false;
  formError.value = "";
}

function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

async function submit(): Promise<void> {
  formError.value = "";
  if (form.name.trim() === "") {
    formError.value = "请填写服务器名";
    return;
  }
  if (form.transport === "stdio" && form.command.trim() === "") {
    formError.value = "stdio 服务器需要填写启动命令";
    return;
  }
  if (form.transport === "http" && form.url.trim() === "") {
    formError.value = "http 服务器需要填写 URL";
    return;
  }
  const workspaceId = app.workspaceId;
  if (!workspaceId) {
    formError.value = "请先选择工作文件夹";
    return;
  }
  const config: McpServerInput = {
    name: form.name.trim(),
    transport: form.transport,
    command: form.transport === "stdio" ? form.command.trim() : undefined,
    args: form.transport === "stdio" ? parseArgs(form.argsText) : [],
    env: form.transport === "stdio" ? parseEnv(form.envText) : {},
    url: form.transport === "http" ? form.url.trim() : undefined,
    headers: {},
    oauth: form.oauth,
  };
  const my = ++submitSeq;
  saving.value = true;
  try {
    const ok = await mcp.save(workspaceId, form.scope, config);
    if (my !== submitSeq || app.workspaceId !== workspaceId) return;
    if (ok) {
      showForm.value = false;
      resetForm();
    } else {
      formError.value = mcp.permissionDenied ? "" : mcp.lastError || "保存失败";
    }
  } finally {
    if (my === submitSeq && app.workspaceId === workspaceId) saving.value = false;
  }
}

async function importPasted(): Promise<void> {
  pasteNotice.value = "";
  const parsed = parseMcpImport(pasteText.value);
  if (parsed.servers.length === 0) {
    pasteNotice.value = parsed.skipped[0] || "没认出任何服务器";
    return;
  }
  const workspaceId = app.workspaceId;
  if (!workspaceId) {
    pasteNotice.value = "请先选择工作文件夹";
    return;
  }
  let saved = 0;
  let blocked = 0;
  for (const server of parsed.servers) {
    if (server.transport !== "stdio") {
      blocked += 1;
      continue;
    }
    const config: McpServerInput = {
      name: server.name,
      transport: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
      headers: {},
      oauth: false,
    };
    const ok = await mcp.save(workspaceId, "user", config);
    if (ok) saved += 1;
  }
  const bits = [`已写入 ${saved} 台本地工具`];
  if (blocked) bits.push(`${blocked} 台远程/登录工具这轮还接不上`);
  if (parsed.skipped.length) bits.push(parsed.skipped[0]);
  pasteNotice.value = bits.join("。");
  if (saved > 0) {
    showPaste.value = false;
    pasteText.value = "";
  }
}

const hasServers = computed(() => mcp.servers.length > 0);

watch(
  () => app.workspaceId,
  (id) => {
    submitSeq += 1;
    saving.value = false;
    showForm.value = false;
    resetForm();
    mcp.setWorkspace(id);
    if (id) void mcp.refresh(id);
  },
  { immediate: true }
);
</script>

<template>
  <div class="mcp">
    <n-space vertical size="medium">
      <div class="head">
        <n-text depth="3" class="hint">
          把外部工具接进对话。本机启动的工具可以马上测；网上的远程工具和登录授权这轮还接不上，名单里看得到，但连不上。
        </n-text>
        <n-space size="small">
          <n-button size="small" :loading="mcp.loading" @click="mcp.refresh(app.workspaceId)">
            🔄 刷新
          </n-button>
          <n-button size="small" @click="showPaste = !showPaste">粘贴导入</n-button>
          <n-button
            size="small"
            type="primary"
            @click="((showForm = !showForm), showForm && resetForm())"
          >
            {{ showForm ? "收起" : "＋ 新建服务器" }}
          </n-button>
        </n-space>
      </div>

      <n-card v-if="showPaste" size="small" title="粘贴别人给的工具配置" class="form-card">
        <n-input
          v-model:value="pasteText"
          type="textarea"
          :rows="6"
          placeholder='{"mcpServers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}}}'
        />
        <n-text depth="3" style="display: block; margin: 8px 0">
          认 Claude / Cursor 那种 mcpServers JSON。远程网址和需要登录的会跳过。
        </n-text>
        <n-alert v-if="pasteNotice" type="info" :bordered="false" style="margin-bottom: 8px">
          {{ pasteNotice }}
        </n-alert>
        <n-space>
          <n-button type="primary" size="small" :loading="mcp.loading" @click="importPasted">
            认一下并写入
          </n-button>
          <n-button size="small" @click="showPaste = false">取消</n-button>
        </n-space>
      </n-card>

      <!-- 新建 / 编辑表单 -->
      <n-card v-if="showForm" size="small" title="新建 MCP 服务器" class="form-card">
        <n-form label-placement="top" size="small">
          <n-form-item label="作用域">
            <n-select v-model:value="form.scope" :options="scopeOptions" />
          </n-form-item>
          <n-form-item label="名称">
            <n-input v-model:value="form.name" placeholder="filesystem" aria-label="服务器名" />
          </n-form-item>
          <n-form-item label="传输方式">
            <n-select v-model:value="form.transport" :options="transportOptions" />
          </n-form-item>

          <template v-if="form.transport === 'stdio'">
            <n-form-item label="启动命令">
              <n-input v-model:value="form.command" placeholder="npx 或 node（不经 shell 解析）" aria-label="命令" />
            </n-form-item>
            <n-form-item label="参数（每行一个）">
              <n-input
                v-model:value="form.argsText"
                type="textarea"
                :rows="3"
                placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;."
                aria-label="参数"
              />
            </n-form-item>
            <n-form-item label="环境变量（每行 KEY=VALUE）">
              <n-input
                v-model:value="form.envText"
                type="textarea"
                :rows="2"
                placeholder="API_KEY=sk-...&#10;PORT=8080"
                aria-label="环境变量"
              />
            </n-form-item>
          </template>

          <template v-else>
            <n-form-item label="URL">
              <n-input v-model:value="form.url" placeholder="https://mcp.example.com" aria-label="URL" />
            </n-form-item>
            <n-form-item label="需要 OAuth">
              <n-switch v-model:value="form.oauth" />
            </n-form-item>
          </template>

          <n-alert v-if="formError" type="error" :bordered="false" style="margin-bottom: 8px">
            {{ formError }}
          </n-alert>
          <n-space>
            <n-button type="primary" size="small" :loading="saving" @click="submit">保存</n-button>
            <n-button size="small" @click="showForm = false">取消</n-button>
          </n-space>
        </n-form>
      </n-card>

      <n-alert
        v-if="mcp.permissionDenied"
        type="warning"
        title="需要授权才能运行这台 MCP 服务器"
        closable
        @close="mcp.clearDenied()"
      >
        <pre class="err">{{ mcp.deniedNotice }}</pre>
        <n-space size="small" style="margin-top: 8px">
          <n-button size="tiny" type="primary" @click="mcp.authorize()">去授权</n-button>
          <n-button size="tiny" @click="mcp.openPermissionCenter()">授权中心</n-button>
        </n-space>
      </n-alert>

      <n-alert v-if="mcp.lastError" type="error" closable @close="mcp.lastError = ''">
        <pre class="err">{{ mcp.lastError }}</pre>
      </n-alert>
      <n-alert v-for="(e, i) in mcp.scanErrors" :key="i" type="warning" :bordered="false">
        {{ e }}
      </n-alert>

      <n-text v-if="!hasServers" depth="3" class="hint">
        还没有配置任何 MCP 服务器。点「新建服务器」添加一台，或直接编辑
        <code>~/.pi/agent/mcp.json</code>。
      </n-text>

      <div v-for="s in mcp.servers" :key="s.id" class="row">
        <div class="row-main">
          <div class="row-title">
            <span class="name">{{ s.name }}</span>
            <n-tag size="tiny" :bordered="false">{{ SCOPE_LABEL[s.scope] }}</n-tag>
            <n-tag size="tiny" type="info" :bordered="false">{{ TRANSPORT_LABEL[s.transport] }}</n-tag>
            <n-tag v-if="s.running" size="tiny" type="success" :bordered="false">运行中</n-tag>
            <n-tag v-if="s.oauthRequired" size="tiny" type="warning" :bordered="false">需要 OAuth</n-tag>
          </div>
          <div v-if="s.command" class="mono">{{ s.command }} {{ s.args.join(" ") }}</div>
          <div v-if="s.url" class="mono">{{ s.url }}</div>
          <div v-if="s.envKeys.length" class="keys">env：{{ s.envKeys.join(", ") }}（值已脱敏）</div>
          <div class="path">{{ s.source }}</div>
          <div v-for="(d, i) in s.diagnostics" :key="i" class="diag">⚠ {{ d }}</div>

          <!-- 连接测试 / 启动结果 -->
          <div v-if="mcp.results[s.id]" class="result">
            <n-tag size="tiny" :type="mcp.results[s.id].ok ? 'success' : 'error'" :bordered="false">
              {{ mcp.results[s.id].ok ? "连接成功" : "连接失败" }}
            </n-tag>
            <span v-if="mcp.results[s.id].serverInfo" class="server-info">
              {{ mcp.results[s.id].serverInfo?.name }}
              {{ mcp.results[s.id].serverInfo?.version }}
              <template v-if="mcp.results[s.id].protocolVersion">
                · 协议 {{ mcp.results[s.id].protocolVersion }}
              </template>
            </span>
            <div v-if="mcp.results[s.id].tools.length" class="tools">
              工具（{{ mcp.results[s.id].tools.length }}）：
              <n-tag
                v-for="t in mcp.results[s.id].tools"
                :key="t.name"
                size="tiny"
                :bordered="false"
                :title="t.description"
              >
                {{ t.name }}
              </n-tag>
            </div>
            <div v-for="(d, i) in mcp.results[s.id].diagnostics" :key="i" class="diag">· {{ d }}</div>
          </div>
        </div>

        <div class="row-actions">
          <n-button
            size="tiny"
            :loading="mcp.busyId === s.id"
            :disabled="s.transport !== 'stdio'"
            @click="mcp.test(app.workspaceId, s.id)"
          >
            测试
          </n-button>
          <n-button
            v-if="!s.running"
            size="tiny"
            type="primary"
            :loading="mcp.busyId === s.id"
            :disabled="s.transport !== 'stdio'"
            @click="mcp.start(app.workspaceId, s.id)"
          >
            启动
          </n-button>
          <n-button
            v-else
            size="tiny"
            type="warning"
            :loading="mcp.busyId === s.id"
            @click="mcp.stop(app.workspaceId, s.id)"
          >
            停止
          </n-button>
          <n-button
            size="tiny"
            quaternary
            type="error"
            @click="mcp.remove(app.workspaceId, s.scope, s.name)"
          >
            删除
          </n-button>
        </div>
      </div>
    </n-space>
  </div>
</template>

<style scoped>
.hint {
  font-size: 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.form-card {
  margin: 4px 0;
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
.mono {
  margin-top: 2px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  opacity: 0.8;
  word-break: break-all;
}
.keys {
  margin-top: 2px;
  font-size: 11px;
  opacity: 0.6;
}
.path {
  margin-top: 2px;
  font-size: 11px;
  opacity: 0.5;
  word-break: break-all;
}
.diag {
  margin-top: 2px;
  font-size: 11px;
  color: #d08700;
}
.result {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.08);
  font-size: 12px;
}
.server-info {
  margin-left: 6px;
  opacity: 0.8;
}
.tools {
  margin-top: 4px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}
.row-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.err {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}
</style>

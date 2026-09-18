<script setup lang="ts">
/**
 * 远程访问管理面板（connector.remote / REM-101）—— 主机侧。
 *
 * 存在的理由：让 owner 能在**主机上**掌控这个唯一对外开网络监听的能力——开关
 * 服务、看清「谁能连」（loopback 对外零暴露 / LAN 显示实际地址）、配一台设备
 * （一次性 QR/短码）、逐台撤销 / 轮换、按设备现开现关那四个默认全关的危险 scope。
 *
 * 面板只发意图；网络监听、token 铸造与校验、hash 存储都在主进程。设备列表里
 * 一个 token 字段都没有，配对返回的一次性 url/code 只用于当场显示。
 */
import { computed, onMounted } from "vue";
import { NAlert, NButton, NSwitch, NTag } from "naive-ui";
import { useRemoteStore } from "../stores/remote";
import type { RemoteDangerousScope } from "@contract";

const remote = useRemoteStore();

const DANGEROUS: { key: RemoteDangerousScope; label: string; hint: string }[] = [
  { key: "terminal", label: "终端", hint: "允许远程开 shell —— 高危" },
  { key: "workspace.write", label: "写工作区", hint: "允许远程修改本机文件 —— 高危" },
  { key: "permission.approve", label: "批准权限", hint: "允许远程替你批准 Agent 权限 —— 高危" },
  { key: "admin", label: "管理", hint: "允许远程管理其它设备 —— 高危" },
];

const pairing = computed(() => remote.pairing);

onMounted(() => {
  void remote.refresh();
});

function hasScope(scopes: string[], s: string): boolean {
  return scopes.indexOf(s) >= 0;
}

async function copyPairing(): Promise<void> {
  if (pairing.value) {
    try {
      await navigator.clipboard.writeText(pairing.value.url);
    } catch {
      /* 剪贴板不可用时用户可手动选 */
    }
  }
}
</script>

<template>
  <div class="remote-panel">
    <header class="rp-head">
      <span class="rp-title">远程访问</span>
      <span class="rp-sub">默认只绑 127.0.0.1（对外零暴露）。LAN 需主动开启。</span>
    </header>

    <section class="rp-row">
      <n-switch
        :value="remote.enabled"
        :loading="remote.busy"
        @update:value="(v: boolean) => remote.setEnabled(v)"
      />
      <span class="rp-label">{{ remote.enabled ? "已开启" : "已关闭" }}</span>
      <n-tag v-if="remote.listening" size="small" :type="remote.lanExposed ? 'warning' : 'success'">
        监听 {{ remote.state.address }}
      </n-tag>
    </section>

    <n-alert v-if="remote.lanExposed" type="warning" :show-icon="true" class="rp-alert">
      正在 LAN 监听 {{ remote.state.address }}：同一网段的设备都能尝试连接（仍需配对 +
      token）。不用时请一键关闭。
    </n-alert>

    <section class="rp-row">
      <span class="rp-label">监听范围</span>
      <n-button
        size="tiny"
        :type="remote.bindScope === 'loopback' ? 'primary' : 'default'"
        @click="remote.setBindScope('loopback')"
      >
        仅本机 (loopback)
      </n-button>
      <n-button
        size="tiny"
        :type="remote.bindScope === 'lan' ? 'warning' : 'default'"
        @click="remote.setBindScope('lan')"
      >
        局域网 (LAN)
      </n-button>
    </section>

    <p v-if="remote.lastError" class="rp-error">{{ remote.lastError }}</p>

    <!-- 配对 -->
    <section class="rp-pair">
      <div class="rp-row">
        <n-button size="small" type="primary" :loading="remote.busy" @click="remote.createPairing()">
          生成配对码
        </n-button>
        <n-button v-if="pairing" size="small" @click="remote.cancelPairing()">取消配对</n-button>
      </div>
      <div v-if="pairing" class="rp-pairing">
        <p class="rp-sub">在设备上打开此链接完成配对（一次性、短时有效）：</p>
        <code class="rp-url">{{ pairing.url }}</code>
        <div class="rp-row">
          <n-button size="tiny" @click="copyPairing">复制链接</n-button>
          <span class="rp-sub">或手动输入配对码：<code>{{ pairing.code }}</code></span>
        </div>
      </div>
    </section>

    <!-- 设备列表 -->
    <section class="rp-devices">
      <h4 class="rp-h4">已配对设备（{{ remote.devices.length }}）</h4>
      <p v-if="remote.devices.length === 0" class="rp-sub">还没有配对任何设备。</p>
      <div v-for="d in remote.devices" :key="d.id" class="rp-device">
        <div class="rp-device-head">
          <span class="rp-name">{{ d.name }}</span>
          <n-tag size="tiny" :type="d.online ? 'success' : 'default'">
            {{ d.online ? "在线" : "离线" }}
          </n-tag>
          <span class="rp-spacer" />
          <n-button size="tiny" @click="remote.rotateDevice(d.id)">轮换</n-button>
          <n-button size="tiny" type="error" @click="remote.revokeDevice(d.id)">撤销</n-button>
        </div>
        <div class="rp-scopes">
          <span class="rp-sub">危险权限（默认全关）：</span>
          <label v-for="ds in DANGEROUS" :key="ds.key" class="rp-scope" :title="ds.hint">
            <n-switch
              size="small"
              :value="hasScope(d.scopes, ds.key)"
              @update:value="(v: boolean) => remote.setDeviceScope(d.id, ds.key, v)"
            />
            <span>{{ ds.label }}</span>
          </label>
        </div>
      </div>
    </section>

    <!-- 审计 -->
    <section v-if="remote.audit.length" class="rp-audit">
      <h4 class="rp-h4">安全审计（脱敏，不含 token）</h4>
      <div v-for="(a, i) in remote.audit" :key="i" class="rp-audit-row">
        <span class="rp-audit-ev">{{ a.event }}</span>
        <span class="rp-sub">{{ a.detail }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.remote-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
}
.rp-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rp-title {
  font-weight: 600;
}
.rp-sub {
  font-size: 12px;
  color: var(--text-tertiary);
}
.rp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rp-label {
  font-size: 13px;
}
.rp-alert {
  font-size: 12px;
}
.rp-error {
  color: var(--status-error);
  font-size: 12px;
}
.rp-pairing {
  margin-top: 6px;
  padding: 12px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-l);
}
.rp-url {
  display: block;
  word-break: break-all;
  font-size: 12px;
  margin: 4px 0;
}
.rp-h4 {
  margin: 4px 0;
  font-size: 13px;
}
.rp-device {
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  padding: 12px 14px;
  margin-bottom: 8px;
}
.rp-device-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rp-spacer {
  flex: 1;
}
.rp-name {
  font-weight: 600;
  font-size: 13px;
}
.rp-scopes {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.rp-scope {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.rp-audit-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}
.rp-audit-ev {
  color: var(--accent);
  min-width: 120px;
}
</style>

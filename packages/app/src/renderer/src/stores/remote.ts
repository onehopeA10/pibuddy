/**
 * 远程访问能力的渲染侧状态（connector.remote / REM-101）—— 主机侧管理面。
 *
 * 渲染进程只做两件事：**把远程服务态与设备列表画出来**、**把 owner 的意图交给
 * 主进程**（开关 / 配对 / 撤销 / 授危险 scope）。真正的网络监听、token 铸造与
 * 校验都在主进程。本 store 从不持有任何设备 token——列表里的设备一个 token 字段
 * 都没有，配对返回的一次性 url/code 只用于当场显示（渲染 QR / 让用户复制）。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { RemoteBindScope, RemoteDangerousScope, RemoteState } from "@contract";

const EMPTY: RemoteState = {
  enabled: false,
  bindScope: "loopback",
  listening: false,
  address: null,
  port: null,
  devices: [],
  pairing: null,
  audit: [],
};

export const useRemoteStore = defineStore("remote", () => {
  const state = ref<RemoteState>(EMPTY);
  const busy = ref(false);
  const lastError = ref("");

  const enabled = computed(() => state.value.enabled);
  const listening = computed(() => state.value.listening);
  const bindScope = computed(() => state.value.bindScope);
  const devices = computed(() => state.value.devices);
  const pairing = computed(() => state.value.pairing);
  const audit = computed(() => state.value.audit);
  /** LAN 监听 = 对外可达；界面据此显示警示 + 实际地址。 */
  const lanExposed = computed(() => state.value.listening && state.value.bindScope === "lan");

  async function run(action: () => Promise<RemoteState>): Promise<boolean> {
    busy.value = true;
    try {
      state.value = await action();
      lastError.value = "";
      return true;
    } catch (err) {
      lastError.value = (err as Error)?.message ?? String(err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  const refresh = () => run(() => window.piBuddy.remote.describe());
  const setEnabled = (v: boolean) => run(() => window.piBuddy.remote.setEnabled(v));
  const setBindScope = (scope: RemoteBindScope) =>
    run(() => window.piBuddy.remote.setBindScope(scope));
  const createPairing = () => run(() => window.piBuddy.remote.createPairing());
  const cancelPairing = () => run(() => window.piBuddy.remote.cancelPairing());
  const revokeDevice = (id: string) => run(() => window.piBuddy.remote.revokeDevice(id));
  const rotateDevice = (id: string) => run(() => window.piBuddy.remote.rotateDevice(id));
  const setDeviceScope = (id: string, scope: RemoteDangerousScope, granted: boolean) =>
    run(() => window.piBuddy.remote.setDeviceScope(id, scope, granted));

  return {
    state,
    busy,
    lastError,
    enabled,
    listening,
    bindScope,
    devices,
    pairing,
    audit,
    lanExposed,
    refresh,
    setEnabled,
    setBindScope,
    createPairing,
    cancelPairing,
    revokeDevice,
    rotateDevice,
    setDeviceScope,
  };
});

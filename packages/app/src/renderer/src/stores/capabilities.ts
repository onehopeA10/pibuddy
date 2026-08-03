/**
 * 能力启用态的渲染侧快照（ADR-0002 第一阶段的 UI 门控）。
 *
 * ## 为什么门控读的是主进程的快照，而不是本地的一个布尔
 *
 * 「这个能力是否启用」在主进程侧的含义是「它的通道有没有被注册」。渲染侧
 * 自己维护一份的话，两者会在依赖被拒、兼容区间不符这类情况上分叉 —— 表现
 * 是面板照常出现，点下去每一个动作都报「未知通道」。
 *
 * ## 未取到快照时**默认全开**
 *
 * `describe()` 是一次异步 IPC，它返回之前界面已经在渲染了。默认全关的表现是
 * 每次启动都先闪一下「什么面板都没有」，然后突然全冒出来。默认全开的代价则
 * 只是：某个真被禁用的面板会在头一帧多显示一瞬 —— 而那一瞬里它的通道本来
 * 就没注册，用户点了会拿到一个明确的错误，不会造成任何静默的错事。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { AgentProfile, CapabilityDescriptor } from "@contract";

export const useCapabilitiesStore = defineStore("capabilities", () => {
  const items = shallowRef<CapabilityDescriptor[]>([]);
  const profiles = shallowRef<AgentProfile[]>([]);
  const activeProfileId = ref("");
  const restartRequired = ref(false);
  /** describe() 是否已经回来过一次。未回来时 isEnabled 一律为 true */
  const loaded = ref(false);
  const lastError = ref("");

  const disabledIds = computed(
    () => new Set(items.value.filter((c) => !c.enabled).map((c) => c.id))
  );

  function apply(state: {
    activeProfileId: string;
    profiles: AgentProfile[];
    capabilities: CapabilityDescriptor[];
    restartRequired: boolean;
  }): void {
    items.value = state.capabilities;
    profiles.value = state.profiles;
    activeProfileId.value = state.activeProfileId;
    restartRequired.value = state.restartRequired;
    loaded.value = true;
  }

  async function refresh(): Promise<void> {
    try {
      apply(await window.piBuddy.capabilities.describe());
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function setProfile(profileId: string): Promise<void> {
    try {
      apply(await window.piBuddy.capabilities.setProfile(profileId));
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  async function setEnabled(capabilityId: string, enabled: boolean): Promise<void> {
    try {
      apply(await window.piBuddy.capabilities.setEnabled(capabilityId, enabled));
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    }
  }

  /** UI 门控的唯一判据。见文件头：快照未到时默认放行。 */
  function isEnabled(capabilityId: string): boolean {
    if (!loaded.value) return true;
    return !disabledIds.value.has(capabilityId);
  }

  return {
    items,
    profiles,
    activeProfileId,
    restartRequired,
    loaded,
    lastError,
    refresh,
    setProfile,
    setEnabled,
    isEnabled,
  };
});

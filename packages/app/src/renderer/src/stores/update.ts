/**
 * 更新子系统的渲染侧视图。**只读 + 转发动作，没有第二份状态源。**
 *
 * ## 挂载顺序：先快照，再订阅
 *
 * renderer 是后挂载的（窗口 reload 之后尤其明显）。如果只订阅事件不取快照，
 * 用户按一次 Ctrl+R，界面就会从「下载中 62%」跳回「空闲」，而主进程其实
 * 还在下载。因此 init() 必须先 `await getState()` 拿权威快照，再 onEvent。
 *
 * ## 两套排序机制，各管各的
 *
 *  - 传输层丢弃：`shouldAcceptEnvelope(prev, next)`，判据是信封上的
 *    generation/sequence。**全仓唯一实现在契约包**，这里绝不手写第二份。
 *  - 快照对账：`stateSequence`，update 域内的单调计数器。用来丢掉「订阅
 *    建立之前就已经发出、比快照还旧」的那几条事件。
 *
 * ## dismiss 状态不在这里
 *
 * 这里不碰任何浏览器端存储：那份数据会随着「清除浏览数据」、多窗口、
 * 隐私模式各自漂移，而用户的预期是「我说了稍后，它就该 24 小时别再烦我」。
 * dismissedVersion / dismissedUntil 一律由 main 持久化，这里只读。
 * 结构断言见 update.test.ts。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { SequencedFrame, UpdateChannel, UpdateState } from "@contract";
import { shouldAcceptEnvelope } from "@contract";

/** 主进程没起来之前的占位快照。版本号留空 —— 渲染侧禁止硬编码版本。 */
export function emptyUpdateState(): UpdateState {
  return {
    status: "idle",
    stateSequence: -1,
    currentVersion: "",
    candidateVersion: null,
    channel: "stable",
    checkSource: null,
    lastCheckedAt: null,
    releaseDate: null,
    releaseNotes: null,
    bytesTransferred: 0,
    totalBytes: 0,
    percent: 0,
    bytesPerSecond: 0,
    errorCode: null,
    retryable: false,
    dismissedVersion: null,
    autoCheck: true,
    autoDownload: false,
    cancelSupported: false,
    blockers: [],
  };
}

type UpdateEnvelopeLike = SequencedFrame & { payload?: unknown };

export const useUpdateStore = defineStore("update", () => {
  const state = ref<UpdateState>(emptyUpdateState());
  /** 上一条被接受的信封（只留 generation/sequence 两个字段）。 */
  const lastFrame = ref<SequencedFrame | null>(null);
  /** 用户在本次会话里手动关掉了横幅（与 main 的 24h dismiss 是两件事）。 */
  const bannerClosed = ref(false);
  /** 安装阻断对话框是否打开。只有「用户点过安装且主进程回了清单」才为 true。 */
  const blockerDialogOpen = ref(false);
  let unsubscribe: (() => void) | null = null;

  const status = computed(() => state.value.status);
  const cancelSupported = computed(() => state.value.cancelSupported);
  const blockers = computed(() => state.value.blockers);

  /** 主进程决定 24 小时抑制是否仍有效；主动检查仍应显示结果。 */
  const bannerVisible = computed(() => {
    if (bannerClosed.value) return false;
    const s = state.value;
    if (s.status === "available") {
      return (
        s.checkSource === "manual" ||
        !s.candidateVersion ||
        s.dismissedVersion !== s.candidateVersion
      );
    }
    return s.status === "error" || s.status === "downloading" || s.status === "downloaded";
  });

  function apply(next: UpdateState): void {
    // 快照对账：比已知快照还旧的状态一律丢弃。没有这一行，订阅刚建立时
    // 那几条在途事件会把界面打回更早的状态。
    if (next.stateSequence < state.value.stateSequence) return;
    state.value = next;
  }

  function onEnvelope(raw: unknown): void {
    if (raw === null || typeof raw !== "object") return;
    const env = raw as UpdateEnvelopeLike;
    if (typeof env.generation !== "number" || typeof env.sequence !== "number") return;
    // 传输层丢弃规则：契约包里的唯一实现。
    if (!shouldAcceptEnvelope(lastFrame.value, env)) return;
    lastFrame.value = { generation: env.generation, sequence: env.sequence };
    if (env.payload) apply(env.payload as UpdateState);
  }

  /** 先取快照，再订阅。顺序反了会漏掉两者之间的那几条事件。 */
  async function init(): Promise<void> {
    apply(await window.piBuddy.update.getState());
    unsubscribe?.();
    unsubscribe = window.piBuddy.update.onEvent(onEnvelope);
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  async function checkNow(): Promise<void> {
    bannerClosed.value = false;
    apply(await window.piBuddy.update.checkForUpdates("manual"));
  }

  async function download(): Promise<void> {
    apply(await window.piBuddy.update.downloadUpdate());
  }

  async function cancelDownload(): Promise<void> {
    apply(await window.piBuddy.update.cancelDownload());
  }

  async function install(mode: "now" | "wait" | "force" = "now"): Promise<void> {
    apply(await window.piBuddy.update.installAndRestart(mode));
    // 用户点了「立即重启安装」，主进程回过来一份阻断清单 —— 摊开给他三选一，
    // 而不是替他决定。'wait' / 'force' 是他已经做过选择之后的路径，关掉。
    blockerDialogOpen.value = mode === "now" && state.value.blockers.length > 0;
  }

  function closeBlockerDialog(): void {
    blockerDialogOpen.value = false;
  }

  async function setChannel(channel: UpdateChannel): Promise<void> {
    apply(await window.piBuddy.update.setUpdateChannel(channel));
  }

  async function setAutoCheck(enabled: boolean): Promise<void> {
    apply(await window.piBuddy.update.setAutoCheck(enabled));
  }

  async function setAutoDownload(enabled: boolean): Promise<void> {
    apply(await window.piBuddy.update.setAutoDownload(enabled));
  }

  /** 「稍后」：本次会话关掉横幅，并让 main 记 24 小时。 */
  async function dismiss(): Promise<void> {
    bannerClosed.value = true;
    const version = state.value.candidateVersion;
    if (version) apply(await window.piBuddy.update.dismissVersion(version));
  }

  return {
    state,
    status,
    cancelSupported,
    blockers,
    bannerVisible,
    bannerClosed,
    blockerDialogOpen,
    closeBlockerDialog,
    apply,
    onEnvelope,
    init,
    dispose,
    checkNow,
    download,
    cancelDownload,
    install,
    setChannel,
    setAutoCheck,
    setAutoDownload,
    dismiss,
  };
});

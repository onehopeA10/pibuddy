/**
 * 「现在能不能安全地重启」的唯一判据。
 *
 * ## 为什么这件事值得单独一个文件
 *
 * 自动更新最容易造成的真实损失不是装错版本，而是**在用户还有东西没保存的
 * 时候把应用关掉**。Agent 正在跑一个十分钟的任务、输入框里有半篇草稿、
 * 麦克风正在录、一个权限请求悬在那儿等确认 —— 这四种情况下重启都等于
 * 丢东西。它们分散在四个模块里，如果由 UpdateService 各查一遍，将来新增
 * 第五种阻断项时一定会漏。
 *
 * ## 订阅，不是轮询
 *
 * 「等任务结束后安装」的等待必须由事件驱动：`whenIdle` 注册一个回调，
 * agent_settled 到来时重算一次，真的空了才触发并**立刻退订**。
 * 本文件里不允许出现任何定时轮询 —— 那意味着应用永远有一个醒着的定时器，
 * 笔记本合盖后照样耗电；而且「每秒查一次」在阻断项刚好在两次查询之间出现
 * 又消失时会给出错误答案。
 */
import { EventEmitter } from "node:events";

import type { UpdateBlocker } from "@pibuddy/contract";

/**
 * 四类阻断项的探针。
 *
 * 每一项都是同步查询：这些数字本来就活在主进程的内存里（supervisor 的
 * 运行中会话表、草稿表、录音标志、pending 权限队列），不需要跨进程去问。
 */
export interface ShutdownProbe {
  /** 正在跑的 Agent 数 */
  activeAgents(): number;
  /** 有未保存草稿的会话数 */
  unsavedDrafts(): number;
  /** 是否正在录音 */
  recording(): boolean;
  /** 等待用户确认的权限 / 扩展 UI 请求数 */
  pendingPermissions(): number;
}

/**
 * agent_settled 事件源的最小面。
 *
 * 只要求 on/off/listenerCount 三个方法 —— 单测据 listenerCount 断言
 * 「回调触发后监听器真的被摘掉了」，这是防监听器泄漏唯一可机器判定的方式。
 */
export interface SettleEvents {
  on(event: "agent_settled", listener: () => void): unknown;
  off(event: "agent_settled", listener: () => void): unknown;
  listenerCount(event: "agent_settled"): number;
}

export interface ShutdownGate {
  /** 当前全部阻断项；空数组表示可以安全重启 */
  collectBlockers(): UpdateBlocker[];
  /**
   * 等到阻断项清空时调一次 callback 并自动退订。
   * 返回的函数用于提前放弃等待（用户点了「取消」）。
   * 调用时若本来就没有阻断项，callback 同步执行，不留任何监听器。
   */
  whenIdle(callback: () => void): () => void;
}

/** 探针 → 人类可读的阻断项。顺序即界面上的展示顺序，从最贵到最便宜。 */
function toBlockers(probe: ShutdownProbe): UpdateBlocker[] {
  const out: UpdateBlocker[] = [];

  const agents = Math.max(0, probe.activeAgents());
  if (agents > 0) {
    out.push({ kind: "agent", count: agents, label: `有 ${agents} 个任务正在运行` });
  }

  const permissions = Math.max(0, probe.pendingPermissions());
  if (permissions > 0) {
    out.push({
      kind: "permission",
      count: permissions,
      label: `有 ${permissions} 个请求在等你确认`,
    });
  }

  if (probe.recording()) {
    out.push({ kind: "recording", count: 1, label: "正在录音" });
  }

  const drafts = Math.max(0, probe.unsavedDrafts());
  if (drafts > 0) {
    out.push({ kind: "draft", count: drafts, label: `有 ${drafts} 段话还没发出去` });
  }

  return out;
}

/**
 * 建一个关机闸门。
 *
 * `events` 是 agent_settled 的来源（生产是 pi supervisor，测试是最小替身）。
 */
export function createShutdownGate(probe: ShutdownProbe, events: SettleEvents): ShutdownGate {
  const collectBlockers = (): UpdateBlocker[] => toBlockers(probe);

  return {
    collectBlockers,

    whenIdle(callback: () => void): () => void {
      // 本来就空 —— 同步回调，一个监听器都不挂。
      if (collectBlockers().length === 0) {
        callback();
        return () => {};
      }

      let done = false;
      const listener = (): void => {
        if (done) return;
        if (collectBlockers().length > 0) return;
        // 先退订再回调：回调里可能同步触发新一轮等待，顺序反了会重复挂。
        done = true;
        events.off("agent_settled", listener);
        callback();
      };

      events.on("agent_settled", listener);

      return () => {
        if (done) return;
        done = true;
        events.off("agent_settled", listener);
      };
    },
  };
}

// ---------------------------------------------------------------- 活动追踪

/**
 * 「有几个 Agent 正在跑」的唯一真相源。
 *
 * 判据直接取 pi 的两个协议事件：`agent_start` 进入忙碌，`agent_settled`
 * 退出忙碌。**不**用「最近有没有收到 message_update」之类的启发式 —— 那种
 * 判据在模型思考三十秒不吐字时会误判成空闲，然后应用就在用户等结果的时候
 * 自己重启了。
 *
 * runtime 退出（正常或崩溃）时必须 forget，否则一次崩溃会把 busy 永久钉在
 * 那里，用户从此再也装不上更新。
 */
class AgentActivityTracker extends EventEmitter implements SettleEvents {
  private readonly busy = new Set<string>();

  markBusy(runtimeId: string): void {
    this.busy.add(runtimeId);
  }

  markSettled(runtimeId: string): void {
    if (!this.busy.delete(runtimeId)) return;
    this.emit("agent_settled");
  }

  forget(runtimeId: string): void {
    this.markSettled(runtimeId);
  }

  busyCount(): number {
    return this.busy.size;
  }

  /** 仅供单测：清空。 */
  reset(): void {
    this.busy.clear();
    this.removeAllListeners("agent_settled");
  }
}

/** 全进程唯一的活动追踪器。pi-supervisor 在事件回调里喂它。 */
export const agentActivity = new AgentActivityTracker();

/**
 * 除 Agent 之外的三类阻断信号。
 *
 * 它们的真相分散在别的模块里（草稿在会话索引、录音在渲染进程的麦克风
 * 状态、待确认权限在扩展 UI 队列），由各自的持有者写进来。默认全 0 意味着
 * 「这三类当前不阻断」，而不是「不检查」—— 差别在于将来接上时不需要改
 * UpdateService 一行代码。
 */
const signals = { unsavedDrafts: 0, recording: false, pendingPermissions: 0 };

export function setShutdownSignals(patch: Partial<typeof signals>): void {
  Object.assign(signals, patch);
}

/** 生产环境的探针。 */
export function defaultShutdownProbe(): ShutdownProbe {
  return {
    activeAgents: () => agentActivity.busyCount(),
    unsavedDrafts: () => signals.unsavedDrafts,
    recording: () => signals.recording,
    pendingPermissions: () => signals.pendingPermissions,
  };
}

/**
 * 五个端口接口（只定型，不实现）。
 *
 * ## 依赖方向硬规则
 *
 *     renderer → preload → main → pi-sdk → pi 进程
 *
 * 反向依赖一律禁止：main 不得 import renderer 的任何东西，pi-sdk 不得
 * 感知 Electron。@pibuddy/contract 横切在这条链上，**只允许被依赖，
 * 自身不依赖任何 workspace 包**（因此 StartResult 用泛型槽位而不是直接
 * 引用 pi-sdk 的 AgentState）。
 *
 * 实现落地节奏：
 *   M1 PiRuntimeSupervisor / SessionRepository
 *   M2 PermissionEngine
 *   M3 SettingsStore
 *   M4/M5 UpdateService
 */
import type { AppSettings, AppSettingsPatch } from "./settings.js";
import type { SessionSummary } from "./session.js";

// ---------------------------------------------------------------- M1

/** 一次 pi 子进程实例的运行时句柄。 */
export interface PiRuntimeHandle {
  runtimeId: string;
  /** 代际：每次 start 都 +1，用于识别并丢弃上一代的迟到事件 */
  generation: number;
  workspaceId: string;
  sessionId: string;
}

export interface PiRuntimeStartOptions {
  workspaceId: string;
  /** 工作目录绝对路径 */
  cwd: string;
  /** 续接的会话 jsonl 路径；缺省表示新会话 */
  sessionPath?: string;
  /** 会话目录（pi 的 --session-dir）；与主进程枚举用的目录必须是同一个 */
  sessionDir?: string;
}

/**
 * pi 子进程的生命周期监管者。
 *
 * 关键约束：stop 之后到下一次 start 之前，上一代 runtime 仍可能吐出事件。
 * 消费方靠 `generation` 而不是靠时间窗口来判断新旧。
 */
export interface PiRuntimeSupervisor {
  start(options: PiRuntimeStartOptions): Promise<PiRuntimeHandle>;
  stop(runtimeId: string): Promise<void>;
  /** 释放全部 runtime，用于窗口关闭 / 应用退出 */
  dispose(): Promise<void>;
  /** 当前代际；无活跃 runtime 时返回最后一次的代际 */
  currentGeneration(): number;
  currentHandle(): PiRuntimeHandle | null;
}

/** 会话仓储：负责在磁盘上定位、枚举并解析 pi 的会话 jsonl。 */
export interface SessionRepository {
  list(workspacePath: string): Promise<SessionSummary[]>;
  /** 工作目录 → pi 会话目录（~/.pi/agent/sessions/--<path>--） */
  resolveSessionDir(workspacePath: string): string;
  read(sessionPath: string): Promise<SessionSummary | null>;
}

// ---------------------------------------------------------------- M2

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * IPC 准入判定。TASK-007 的 ipc-guard.ts 直接 `implements PermissionEngine`。
 *
 * 三道闸各管一件事，不可合并：
 *   checkFrame   —— 发送者是否可信（channel 在白名单、sender 是我们自己的窗口）
 *   checkPayload —— 载荷是否符合该 channel 的 schema
 *   checkRate    —— 调用频率是否越界（渲染进程被注入后可无限刷 IPC）
 */
export interface PermissionEngine {
  checkFrame(channel: string, senderId: number): PermissionDecision;
  checkPayload(channel: string, payload: unknown): PermissionDecision;
  checkRate(channel: string, senderId: number, now?: number): PermissionDecision;
}

// ---------------------------------------------------------------- M3

/** 设置读写与版本迁移。实现方必须用 writeJsonAtomic 落盘。 */
export interface SettingsStore {
  load(): AppSettings;
  save(patch: AppSettingsPatch): AppSettings;
  /** 把旧版本磁盘格式升到当前 schema；返回是否发生了改写 */
  migrate(): boolean;
}

// ---------------------------------------------------------------- M4 / M5

// 自更新的端口在 M0 阶段是一个六态空壳（`UpdateStatus` / `UpdateService`）。
// M4 落地时它被 ./update.ts 的十态状态机整体取代 —— 空壳里的 'ready' 与
// 真实实现的 'downloaded' / 'waiting-for-agent' / 'installing' 对不上，
// 而 UpdateService 这个名字同时被主进程的实现类占用（契约唯一性闸门会当场
// 拦下同名 export）。因此这里不留一个永远不会被实现的接口：
//
//   状态与错误码  → ./update.ts 的 UpdateStatus / UpdateState / UpdateErrorCode
//   动作面        → ./channels.ts 的 update:* 九条窄通道
//   主进程实现    → packages/app/src/main/update/update-service.ts

/**
 * `window.piBuddy.piResources` —— Pi 资源中心与 project trust（EXT-102）。
 *
 * 这个命名空间上**没有**、也不会有一个 `run(command)`。安装与卸载收的是
 * 包规格字符串（`npm:@foo/bar@1.0.0`），子命令白名单写死在主进程的
 * package-install.ts 里，execFile 且 shell:false。渲染进程在结构上就
 * 表达不出「执行这条命令」—— 而 pi 的包管理本身跑的是 npm / git，
 * 留一条通用转发口等于把本机命令行挂在界面上。
 *
 * 打开目录收的是扫描结果里的 `id` 而不是 `path`：`path` 是**单向下发**的
 * 展示字段，和 workspace 的 displayPath 同一条纪律。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  PiPackageCommandResult,
  PiResourceScanResult,
  ProjectTrustState,
  TrustDecision,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const piResources = {
  /** 枚举 user / project / package 三来源的全部资源 + 当前 trust 态 */
  scan: (workspaceId: string) =>
    invoke<PiResourceScanResult>(CHANNELS.piResourcesScan, { workspaceId }),
  /** 启停一条资源。返回改动后的**权威快照**，界面不必自己推断列表变成什么样 */
  setEnabled: (workspaceId: string, id: string, enabled: boolean) =>
    invoke<PiResourceScanResult>(CHANNELS.piResourcesSetEnabled, {
      workspaceId,
      id,
      enabled,
    }),
  install: (workspaceId: string, spec: string, scope: "user" | "project") =>
    invoke<PiPackageCommandResult>(CHANNELS.piResourcesInstall, {
      workspaceId,
      spec,
      scope,
    }),
  remove: (workspaceId: string, spec: string, scope: "user" | "project") =>
    invoke<PiPackageCommandResult>(CHANNELS.piResourcesRemove, {
      workspaceId,
      spec,
      scope,
    }),
  /** 在系统文件管理器里打开该资源所在目录。入参是 id，不是路径 */
  openDir: (workspaceId: string, id: string) =>
    invoke<void>(CHANNELS.piResourcesOpenDir, { workspaceId, id }),

  trust: {
    describe: (workspaceId: string) =>
      invoke<ProjectTrustState>(CHANNELS.trustDescribe, { workspaceId }),
    /**
     * 记录决定。
     *
     * `remember: true` 会写 `~/.pi/agent/trust.json` —— 那是**跨应用共享**的
     * 状态，用户在终端里跑 pi 时也会读到它。因此主进程写入前必须先读出
     * 并合并已有决定，绝不整文件覆盖。
     */
    decide: (workspaceId: string, decision: TrustDecision, remember: boolean) =>
      invoke<ProjectTrustState>(CHANNELS.trustDecide, { workspaceId, decision, remember }),
  },
};

/**
 * `window.piBuddy.settings`。
 *
 * 有 setSecret 没有 getSecret，这是刻意的：明文进了主进程就再也出不来
 * （safeStorage 保管），渲染进程能问到的极限是 `{configured, last4}`。
 * 补一个读取方法等于让那层加密只是给磁盘上的字节换了个编码。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  AppSettings,
  AppSettingsPatch,
  PiRuntimeApplyResult,
  SecretDescriptor,
  SecretKind,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

/**
 * 渲染进程可写的设置子集。
 *
 * workspace 只能经 dialog.chooseFolder()（一次真实的用户手势）；
 * schemaVersion 与 sttEndpointId / sttApiKeyConfigured / sttApiKeyLast4 是
 * 主进程单向下发的派生字段 —— 允许渲染进程写它们等于允许它自称「已配置」
 * 或指向一个没校验过的端点。
 *
 * piRuntimeMode / piExternalCommand 同样被剔除（SEC-005）：它们最终是 spawn
 * 的 argv[0]，改由 setPiRuntime() 承接，那条路上路径由主进程当面向用户取得。
 */
export type RendererSettingsPatch = Omit<
  AppSettingsPatch,
  | "workspace"
  | "schemaVersion"
  | "sttEndpointId"
  | "sttApiKeyConfigured"
  | "sttApiKeyLast4"
  | "piRuntimeMode"
  | "piExternalCommand"
>;

export const settings = {
  get: () => invoke<AppSettings>(CHANNELS.settingsGet),
  set: (patch: RendererSettingsPatch) => invoke<AppSettings>(CHANNELS.settingsSet, patch),
  setSecret: (kind: SecretKind, value: string) =>
    invoke<SecretDescriptor>(CHANNELS.settingsSetSecret, { kind, value }),
  describeSecret: (kind: SecretKind) =>
    invoke<SecretDescriptor>(CHANNELS.settingsDescribeSecret, { kind }),
  /**
   * 切换 Pi 运行时来源（SEC-005）。
   *
   * **签名里没有路径形参，将来也不许加**：一旦渲染进程能说出「用这个文件」，
   * 主进程的 spawn 就成了一条任意本机程序执行通道。external 的可执行文件由
   * 主进程弹原生文件选择框 + 一次展示完整路径的确认框当面取得。
   * 返回 `applied:false` 表示用户取消了，磁盘上一个字节都没改。
   */
  setPiRuntime: (mode: "bundled" | "external") =>
    invoke<PiRuntimeApplyResult>(CHANNELS.settingsSetPiRuntime, { mode }),
};

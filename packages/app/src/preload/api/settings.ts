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
 */
export type RendererSettingsPatch = Omit<
  AppSettingsPatch,
  "workspace" | "schemaVersion" | "sttEndpointId" | "sttApiKeyConfigured" | "sttApiKeyLast4"
>;

export const settings = {
  get: () => invoke<AppSettings>(CHANNELS.settingsGet),
  set: (patch: RendererSettingsPatch) => invoke<AppSettings>(CHANNELS.settingsSet, patch),
  setSecret: (kind: SecretKind, value: string) =>
    invoke<SecretDescriptor>(CHANNELS.settingsSetSecret, { kind, value }),
  describeSecret: (kind: SecretKind) =>
    invoke<SecretDescriptor>(CHANNELS.settingsDescribeSecret, { kind }),
};

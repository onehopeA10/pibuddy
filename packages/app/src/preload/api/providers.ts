/**
 * `window.piBuddy.providers` —— Provider / 模型中心与用量页的接口面。
 *
 * 与 `settings` 同一条纪律：**有 saveKey，没有 getKey**。密钥写进
 * `~/.pi/agent/auth.json` 之后，仓库里没有任何一条通道能把它送回渲染进程；
 * 渲染进程能问到的极限是 `providers.list()` 返回的 `{configured, last4}`。
 *
 * `test()` 与 `discoverModels()` 会触发真实出站请求，但地址不由渲染进程
 * 指定 —— 入参只有一个 providerId，往哪发由主进程按目录或已登记的自定义
 * 端点查出来。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  AppSettings,
  ProviderCustomRequest,
  ProviderListResult,
  ProviderTestResult,
  SetScopeDefaultRequest,
  UsageExportRequest,
  UsageExportResult,
  UsageQuery,
  UsageRecordRequest,
  UsageRow,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const providers = {
  list: () => invoke<ProviderListResult>(CHANNELS.providersList),
  /** value 为空串 = 删除这条凭据。返回全量快照，里面没有 key 字段。 */
  saveKey: (providerId: string, key: string, env?: Record<string, string>) =>
    invoke<ProviderListResult>(CHANNELS.providersSaveKey, { providerId, key, env }),
  remove: (providerId: string) =>
    invoke<ProviderListResult>(CHANNELS.providersRemove, { providerId }),
  addCustom: (input: ProviderCustomRequest) =>
    invoke<ProviderListResult>(CHANNELS.providersAddCustom, input),
  /** 永不 reject：失败信息在返回值的 errorCode / redactedMessage 里 */
  test: (providerId: string) =>
    invoke<ProviderTestResult>(CHANNELS.providersTest, { providerId }),
  discoverModels: (providerId: string) =>
    invoke<ProviderListResult>(CHANNELS.providersDiscoverModels, { providerId }),
  setScopeDefault: (input: SetScopeDefaultRequest) =>
    invoke<AppSettings>(CHANNELS.providersSetScopeDefault, input),

  usage: {
    query: (filter: UsageQuery = {}) => invoke<UsageRow[]>(CHANNELS.usageQuery, filter),
    export: (request: UsageExportRequest) =>
      invoke<UsageExportResult>(CHANNELS.usageExport, request),
    /** agent_settled 之后上报会话累计量，由主进程做差值入库 */
    record: (payload: UsageRecordRequest) => invoke<void>(CHANNELS.usageRecord, payload),
  },
};

/**
 * Remote / PWA 远程访问的契约（ADR-0002 连接器层 / REM-101）。
 *
 * ## 这个文件在回答什么
 *
 * `connector.remote` 这个能力对外声明的**主机侧管理面**八条窄通道，以及远程
 * 服务的 scope 模型、设备视图、配对信息的形状。它是四层边界里唯一会**开一个
 * 对外网络监听**的能力——因此每一条约定都围着同一件事转：
 *
 *   1. **默认对外零暴露**：监听默认只绑 loopback（127.0.0.1），LAN 由用户主动
 *      开启（`bindScope: "lan"`），开启时界面显示实际监听范围 + 一键关闭。
 *   2. **凭证只存 hash**：设备长期 token 只在配对那一刻发给设备本身，主进程只
 *      存它的 sha256 hash（`token` 一个字段都不进任何返回值 / 任何日志）。渲染
 *      进程能看到的极限是设备的 id / 名字 / 时间戳 / scopes。
 *   3. **危险 scope 默认关**：`terminal` / `workspace.write` / `permission.approve`
 *      / `admin` 不在配对可自动获得的集合里，必须 owner 在主机上按设备显式授予。
 *
 * ## 与远程 HTTP/WS 服务的关系
 *
 * 本文件声明的八条通道是 **renderer ↔ main** 的 IPC，走 ipc-guard 的四道闸，
 * 只有本机主窗口能发。**远程设备**访问的是另一套完全独立的入口：main/remote 下
 * 的 HTTP/WS 服务，每一个入口（HTTP 路由 / WS 升级 / SSE / raw file / upload）
 * 都过同一套统一鉴权中间件（token + origin/CSRF + 限速 + 尺寸 + 审计）。两套
 * 入口没有任何共享的放行路径——这是审计明确点名的坑（「不能只保护 WS 而漏了
 * HTTP」），因此远程服务的鉴权判据独立成 spec，不复用 IPC 的四道闸。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

/** 远程访问能力 id（四层边界表第四行，tier=connector）。 */
export const REMOTE_CAPABILITY_ID = "connector.remote";

// ---------------------------------------------------------------- scope 模型

/**
 * v1 能力范围（配对可默认获得的**安全** scope）。
 *
 * ADR-0002 与审计文档把 v1 的对外能力钉死在这七项：看会话、实时消息、发 prompt、
 * 停止、后台状态、通知、看 permission inbox。它们都是**读或低破坏**动作，配对
 * 一台设备时可以一并授予。
 */
export const REMOTE_SAFE_SCOPES = [
  "sessions.read",
  "messages.read",
  "prompt.send",
  "session.stop",
  "pool.read",
  "notify",
  "permission.read",
] as const;
export type RemoteSafeScope = (typeof REMOTE_SAFE_SCOPES)[number];

/**
 * 危险 scope（**默认不授予**）。
 *
 * 这四项每一个都能扩大远程攻击面到「在本机上跑东西 / 写用户文件 / 替 owner 批
 * 权限 / 管其它设备」，因此配对时一律拿不到，必须 owner 在主机上按设备显式打开
 * （`remote:set-device-scope`）。这与 SEC-003 的 allow-once / 显式授权同一姿态：
 * 危险能力永远是「主机上现开」，不存在「配对即获得」。
 */
export const REMOTE_DANGEROUS_SCOPES = [
  "terminal",
  "workspace.write",
  "permission.approve",
  "admin",
] as const;
export type RemoteDangerousScope = (typeof REMOTE_DANGEROUS_SCOPES)[number];

export const REMOTE_ALL_SCOPES = [...REMOTE_SAFE_SCOPES, ...REMOTE_DANGEROUS_SCOPES] as const;
export type RemoteScope = RemoteSafeScope | RemoteDangerousScope;

export const remoteScopeSchema = z.enum(REMOTE_ALL_SCOPES);
export const remoteDangerousScopeSchema = z.enum(REMOTE_DANGEROUS_SCOPES);

/** 一个 scope 是否属危险集合（默认关的那批）。 */
export function isDangerousRemoteScope(scope: string): scope is RemoteDangerousScope {
  return (REMOTE_DANGEROUS_SCOPES as readonly string[]).includes(scope);
}

// ---------------------------------------------------------------- 监听范围

/**
 * 监听范围。
 *
 * `loopback` = 只绑 127.0.0.1，本机以外一律不可达（默认，对外零暴露）；
 * `lan` = 绑 0.0.0.0，同一网段可达（用户主动开启，界面须显示实际地址 + 一键关）。
 *
 * 没有「绑我指定的某个地址字符串」这个选项：一个自由的地址字段等于把「监听在
 * 哪」交给渲染进程决定，而那正是最不该被下放的一个决策。
 */
export const REMOTE_BIND_SCOPES = ["loopback", "lan"] as const;
export type RemoteBindScope = (typeof REMOTE_BIND_SCOPES)[number];
export const remoteBindScopeSchema = z.enum(REMOTE_BIND_SCOPES);

// ---------------------------------------------------------------- 渲染侧视图

/**
 * 渲染进程可见的一台已配对设备。
 *
 * **没有 token、没有 tokenHash**：长期凭证只在配对那一刻发给设备本身，之后
 * 主进程只留 hash（不出主进程）。这里给的是让 owner 认出并管理设备所需的最小
 * 信息：不透明 id、名字、创建 / 最近使用时间、当前 scopes、是否在线。
 */
export const remoteDeviceViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    createdAt: z.number(),
    /** 最近一次成功鉴权的时刻；从未用过为 null */
    lastUsedAt: z.number().nullable(),
    /** 该设备当前持有的 scopes（含 owner 显式授予的危险 scope） */
    scopes: z.array(remoteScopeSchema),
    /** 是否有活跃连接（WS / SSE） */
    online: z.boolean(),
  })
  .strict();
export type RemoteDeviceView = z.infer<typeof remoteDeviceViewSchema>;

/**
 * 一次活跃配对的可展示信息。
 *
 * `url` 是给设备扫 / 开的配对地址，**里面带的是一次性 challenge，不是长期
 * token**：challenge 短时、单次，用一次即失效，即便被旁人看到也只能配一台设备
 * 且很快过期。`code` 是同一 challenge 的短码形态，供无法扫码时手动输入。
 */
export const remotePairingInfoSchema = z
  .object({
    /** 配对地址（承载一次性 challenge，供 QR / 打开） */
    url: z.string().min(1),
    /** 手动输入用的短码（同一 challenge 的可读形态） */
    code: z.string().min(1),
    /** 过期时刻（Unix ms）；到点未消费即作废 */
    expiresAt: z.number(),
  })
  .strict();
export type RemotePairingInfo = z.infer<typeof remotePairingInfoSchema>;

/**
 * 远程服务的权威快照（`remote:describe` 与每个变更动作的返回）。
 *
 * 与 connector / providers 同一口径：任何一个管理动作做完立刻拿到全量状态，
 * 界面不必自己推断，「点了没反应」这类问题在结构上不成立。
 */
export const remoteStateSchema = z
  .object({
    /** 服务是否开启（关 = 不监听、对外零暴露） */
    enabled: z.boolean(),
    /** 当前监听范围 */
    bindScope: remoteBindScopeSchema,
    /** 是否正在监听（enabled 且绑定成功） */
    listening: z.boolean(),
    /** 实际监听地址（供界面显示「谁能连」）；未监听为 null */
    address: z.string().nullable(),
    /** 实际监听端口；未监听为 null */
    port: z.number().nullable(),
    /** 已配对设备 */
    devices: z.array(remoteDeviceViewSchema),
    /** 当前未消费的配对；无则 null */
    pairing: remotePairingInfoSchema.nullable(),
    /** 安全事件审计（最近若干条，脱敏，绝不含 token） */
    audit: z.array(
      z
        .object({
          at: z.number(),
          event: z.string(),
          detail: z.string(),
        })
        .strict()
    ),
  })
  .strict();
export type RemoteState = z.infer<typeof remoteStateSchema>;

// ---------------------------------------------------------------- 请求

export const remoteSetEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type RemoteSetEnabledRequest = z.infer<typeof remoteSetEnabledRequestSchema>;

export const remoteSetBindScopeRequestSchema = z
  .object({ scope: remoteBindScopeSchema })
  .strict();
export type RemoteSetBindScopeRequest = z.infer<typeof remoteSetBindScopeRequestSchema>;

export const remoteDeviceIdRequestSchema = z.object({ deviceId: z.string().min(1) }).strict();
export type RemoteDeviceIdRequest = z.infer<typeof remoteDeviceIdRequestSchema>;

/**
 * 按设备授予 / 收回一个**危险** scope。
 *
 * `scope` 限死在危险集合：安全 scope 在配对时已一并授予，不走这条；owner 这条
 * 通道存在的唯一意义就是「现开 / 现关」那四个默认关的危险能力。
 */
export const remoteSetDeviceScopeRequestSchema = z
  .object({
    deviceId: z.string().min(1),
    scope: remoteDangerousScopeSchema,
    granted: z.boolean(),
  })
  .strict();
export type RemoteSetDeviceScopeRequest = z.infer<typeof remoteSetDeviceScopeRequestSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `connector.remote` 的八条管理通道。
 *
 * 分片 id 是 capabilityId 的第二段（`connector.remote` → `remote`），drift test
 * 据此把「manifest 声明的通道」与「本分片的键集合」逐条对账。
 */
export const remoteContractShard = defineContractShard("remote", {
  [CHANNELS.remoteDescribe]: {
    request: z.void(),
    response: remoteStateSchema,
  },
  [CHANNELS.remoteSetEnabled]: {
    request: remoteSetEnabledRequestSchema,
    response: remoteStateSchema,
  },
  [CHANNELS.remoteSetBindScope]: {
    request: remoteSetBindScopeRequestSchema,
    response: remoteStateSchema,
  },
  [CHANNELS.remoteCreatePairing]: {
    request: z.void(),
    response: remoteStateSchema,
  },
  [CHANNELS.remoteCancelPairing]: {
    request: z.void(),
    response: remoteStateSchema,
  },
  [CHANNELS.remoteRevokeDevice]: {
    request: remoteDeviceIdRequestSchema,
    response: remoteStateSchema,
  },
  [CHANNELS.remoteRotateDevice]: {
    request: remoteDeviceIdRequestSchema,
    response: remoteStateSchema,
  },
  [CHANNELS.remoteSetDeviceScope]: {
    request: remoteSetDeviceScopeRequestSchema,
    response: remoteStateSchema,
  },
});

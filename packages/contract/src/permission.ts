/**
 * 能力权限的决策契约（ADR-0002 D3 / SEC-003）。
 *
 * ## 这个文件在回答什么
 *
 * `capability.ts` 回答「一个能力**申请**了哪些权限」——那是一份不含任何
 * 「已授予」的纯声明。本文件回答的是另一半：**谁批准了什么**。授权决策由
 * 核心 PermissionEngine 在**主进程**侧做（`main/permission/**`），本文件只
 * 定义决策的数据形态与四条 IPC 通道的契约。
 *
 * ## 为什么与 `PermissionRule` 分开
 *
 * `PermissionRule`（ipc-contract.ts）是**单条 IPC 通道的准入配额**
 * （channel / maxBytes / windowMs / maxPerWindow），按 channel 索引，是
 * `ipc-guard` 四道闸的运行时投影。本文件的 `CapabilityGrant` 按
 * **capabilityId** 索引，回答「这个能力被允许做哪一类事」。两者连键都对不上，
 * 因此授权表是 `WorkspaceProfile` 上一张**与 `permissionRules` 并列**的新表，
 * 不复用它（FIX-capability-core §5 记过这个结论）。
 *
 * ## 决策为什么必须在主进程
 *
 * ADR-0002 D3：即使能力被启用，renderer 被攻陷后也不能**直接**触达
 * Git / Shell / 任意文件。因此拦截点是 `ipc-guard` 的第五道闸（主进程侧），
 * 而不是渲染层弹个框就算数。渲染进程只负责**收集用户选择**并把它交给主进程
 * 记录；grant 的合法性由主进程按 manifest 声明的上界二次校验（渲染进程即便
 * 被攻陷，也只能申请到某个已启用能力**声明过**的权限，越不过 manifest）。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";
import { CAPABILITY_PERMISSION_ATOMS, CAPABILITY_PERMISSION_PREFIXES } from "./capability.js";

// ---------------------------------------------------------------- 决策档位

/**
 * 决策档位（SEC-003 原文：deny / allow once / allow session / allow workspace）。
 *
 *   - `deny`            —— 拒绝（并留痕，供审计）；
 *   - `allow-once`      —— 只放行紧接着的这一次，用后即焚（主进程内存）；
 *   - `allow-session`   —— 本次应用运行内有效（主进程内存，重启即失效）；
 *   - `allow-workspace` —— 落盘到该 workspace 的授权表，跨重启有效。
 *
 * 只有 `allow-workspace` 会被持久化；其余两档活在主进程内存里，因此一次
 * 重启就是一次「把临时授权全部收回」。
 */
export const PERMISSION_DISPOSITIONS = [
  "deny",
  "allow-once",
  "allow-session",
  "allow-workspace",
] as const;
export type PermissionDisposition = (typeof PERMISSION_DISPOSITIONS)[number];
export const permissionDispositionSchema = z.enum(PERMISSION_DISPOSITIONS);

/** 需要跨重启保留的档位（当前只有一档）。 */
export function isPersistentDisposition(d: PermissionDisposition): boolean {
  return d === "allow-workspace";
}

// ---------------------------------------------------------------- 危险权限

/**
 * 危险权限：能触达子进程 / 出站 / 密钥的那几类。
 *
 * 它们的持久化授权（allow-workspace）必须经一次**主进程原生确认框**，渲染
 * 进程既伪造不了也绕不开——与 `settings:set-pi-runtime` 的原生确认同一口径。
 * 安全权限（workspace.read/write、external.open）不做原生确认：它们的副作用
 * 已经被 workspace 收容原语（CT-18）与 shell 白名单夹住，再加一道原生框只会
 * 把日常操作拖成弹窗地狱。
 */
export const DANGEROUS_PERMISSION_ATOMS = [
  "process.git",
  "process.shell",
  // network.local 能触达私网出站（SEC-004 扩展的 local 车道），与 network:*
  // 同级危险：持久化授权（allow-workspace）必过主进程原生确认框。
  "network.local",
] as const;
export const DANGEROUS_PERMISSION_PREFIXES = ["network", "secret"] as const;

/** 这条权限申请是否属危险类。 */
export function isDangerousPermission(permission: string): boolean {
  if ((DANGEROUS_PERMISSION_ATOMS as readonly string[]).includes(permission)) return true;
  const sep = permission.indexOf(":");
  if (sep <= 0) return false;
  return (DANGEROUS_PERMISSION_PREFIXES as readonly string[]).includes(permission.slice(0, sep));
}

// ---------------------------------------------------- network.local 的资源形态

/**
 * `network.local` 授权必须绑定的资源形态：`host:port`。
 *
 * SEC-004 原文：「允许本地网络时也应绑定用户确认的 host/port，而不是放开
 * 整个内网」。这条正则就是那句话的机器化——host 只能是 IPv4 点分或主机名
 * （写不出 CIDR、通配、IPv6、URL），port 必须显式给出。null-resource（通配）
 * 由 `decidePermission` 在落库前拒绝，于是「授权整个内网」在结构上无处落笔。
 *
 * 端口的数值区间（1-65535）正则表达不划算，归 `parseLocalEndpointResource`。
 */
export const LOCAL_ENDPOINT_RESOURCE_RE =
  /^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):(\d{1,5})$/i;

export interface LocalEndpointResource {
  /** 小写化后的 host（IPv4 点分或主机名） */
  host: string;
  /** 1-65535 */
  port: number;
}

/** 解析一条 `host:port` 资源；非法形态返回 null（与 capability.ts 的解析器同风格）。 */
export function parseLocalEndpointResource(raw: string): LocalEndpointResource | null {
  const m = LOCAL_ENDPOINT_RESOURCE_RE.exec(raw.trim());
  if (!m) return null;
  const port = Number.parseInt(m[1]!, 10);
  if (port < 1 || port > 65535) return null;
  const host = raw.trim().slice(0, raw.trim().lastIndexOf(":")).toLowerCase();
  return { host, port };
}

// ---------------------------------------------------------------- 授权记录

/**
 * 一条授权记录。
 *
 * `resource` 是可选的更细粒度目标（例如某个具体文件路径 / 某个域名）；
 * `null` 表示「该能力的该权限，不限具体资源」。判定时 `null` 记录覆盖任何
 * 具体 `resource` 请求，具体记录只覆盖同名资源。
 */
export const capabilityGrantSchema = z
  .object({
    capabilityId: z.string().min(1),
    permission: z.string().min(1),
    resource: z.string().min(1).nullable(),
    grantedAt: z.number().int().nonnegative(),
  })
  .strict();
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;

/** 一次决策结果。 */
export const capabilityPermissionDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
});
export type CapabilityPermissionDecision = z.infer<typeof capabilityPermissionDecisionSchema>;

// ---------------------------------------------------------------- 审计

/**
 * 审计条目（SEC-003：加审计与撤销）。
 *
 * 每一次授予 / 拒绝 / 撤销 / 拦截都在这里留一条，同时经 `logger`（脱敏）
 * 落盘。没有审计的话，「功能突然不好使」与「被权限挡了」在现场是同一种
 * 表现——这正是 `ipc_rejected` 那条日志存在的同一个理由。
 */
export const PERMISSION_AUDIT_KINDS = ["granted", "denied", "revoked", "blocked"] as const;
export type PermissionAuditKind = (typeof PERMISSION_AUDIT_KINDS)[number];

export const permissionAuditEntrySchema = z
  .object({
    at: z.number().int().nonnegative(),
    kind: z.enum(PERMISSION_AUDIT_KINDS),
    capabilityId: z.string(),
    permission: z.string(),
    resource: z.string().nullable(),
    /** 授予时的档位；非授予事件为 null */
    disposition: permissionDispositionSchema.nullable(),
    /** 供人读的补充（拒绝原因 / 撤销范围等） */
    detail: z.string().nullable(),
  })
  .strict();
export type PermissionAuditEntry = z.infer<typeof permissionAuditEntrySchema>;

// ---------------------------------------------------------------- 对外快照

/**
 * 下发给渲染进程的权限视图。
 *
 * workspace 授权与 session 授权分开列：前者跨重启、需要用户明确管理，
 * 后者本次运行就会蒸发。撤销界面据此对两组各给一个「撤销」。
 */
export const permissionStateSchema = z
  .object({
    /** 当前上下文 workspace；无工作区时为 null */
    workspaceId: z.string().nullable(),
    workspaceGrants: z.array(capabilityGrantSchema),
    sessionGrants: z.array(capabilityGrantSchema),
    audit: z.array(permissionAuditEntrySchema),
  })
  .strict();
export type PermissionState = z.infer<typeof permissionStateSchema>;

// ---------------------------------------------------------------- 通道入参

export const permissionDescribeRequestSchema = z
  .object({ workspaceId: z.string().min(1).nullable().default(null) })
  .strict();
export type PermissionDescribeRequest = z.infer<typeof permissionDescribeRequestSchema>;

export const permissionDecideRequestSchema = z
  .object({
    capabilityId: z.string().min(1),
    permission: z.string().min(1),
    resource: z.string().min(1).nullable().default(null),
    disposition: permissionDispositionSchema,
    workspaceId: z.string().min(1).nullable().default(null),
  })
  .strict();
export type PermissionDecideRequest = z.infer<typeof permissionDecideRequestSchema>;

export const permissionRevokeRequestSchema = z
  .object({
    capabilityId: z.string().min(1),
    permission: z.string().min(1),
    resource: z.string().min(1).nullable().default(null),
    scope: z.enum(["session", "workspace"]),
    workspaceId: z.string().min(1).nullable().default(null),
  })
  .strict();
export type PermissionRevokeRequest = z.infer<typeof permissionRevokeRequestSchema>;

/**
 * 权限探针的入参 / 返回（本轮的**可证伪拦截点**，也是将来 `process.git`
 * 之类真实消费者的**预留入口**）。
 *
 * 本轮还没有 Git 包 / 连接器，`process.git` 没有真实消费者。这条通道
 * 声明自己需要 `process.git`（见 main/permission 的需求表），因此：
 *
 *   - 未授权时，第五道闸把它挡在 handler 之外（真机可复核的「拒绝」证据）；
 *   - 授权后，handler 才被调到并返回 `{ok:true}`（「放行」证据）。
 *
 * 一对互斥的真机取证就落在这一条通道上，而不必先把整个 Git 包做出来。
 */
export const permissionProbeRequestSchema = z
  .object({ workspaceId: z.string().min(1).nullable().default(null) })
  .strict();
export type PermissionProbeRequest = z.infer<typeof permissionProbeRequestSchema>;

export const permissionProbeResponseSchema = z.object({ ok: z.boolean() }).strict();
export type PermissionProbeResponse = z.infer<typeof permissionProbeResponseSchema>;

/**
 * 探针通道所代表的保留能力与权限。
 *
 * 用一个**不在能力注册表里**的保留 id，避免它出现在能力开关界面上被用户
 * 误关；它声明的权限上界就是 `process.git`（未来的 Git 包会用真实
 * capabilityId 声明同一条权限，届时把需求表指过去即可）。
 */
export const PERMISSION_PROBE_CAPABILITY_ID = "kernel.git-probe";
export const PERMISSION_PROBE_PERMISSION = "process.git";

// ---------------------------------------------------------------- 契约分片

/**
 * 权限决策的四条内核通道。
 *
 * 权限是**平台内核**设施（ADR-0002 四层边界表第一行，不可关闭），因此这四条
 * 恒注册、不受任何能力开关影响——否则「把能力全关掉」会连带关掉那个用来
 * 管理与撤销授权的入口。
 */
export const permissionContractShard = defineContractShard("kernel-permission", {
  [CHANNELS.permissionDescribe]: {
    request: permissionDescribeRequestSchema,
    response: permissionStateSchema,
  },
  [CHANNELS.permissionDecide]: {
    request: permissionDecideRequestSchema,
    response: permissionStateSchema,
  },
  [CHANNELS.permissionRevoke]: {
    request: permissionRevokeRequestSchema,
    response: permissionStateSchema,
  },
  [CHANNELS.permissionProbe]: {
    request: permissionProbeRequestSchema,
    response: permissionProbeResponseSchema,
  },
});

/** 已知的无参权限原子（供决策层做上界校验时引用，避免重复常量）。 */
export const KNOWN_PERMISSION_ATOMS = CAPABILITY_PERMISSION_ATOMS;
export const KNOWN_PERMISSION_PREFIXES = CAPABILITY_PERMISSION_PREFIXES;

/**
 * 连接器 v1 的契约（ADR-0002 连接器层 / CON-101）。
 *
 * ## 这个文件在回答什么
 *
 * `connector.webhook` 这个**连接器能力**对外声明的七条窄通道：列举、创建、
 * 更新（改名 / 轮换凭证）、删除、启停、连接自检、主动推送。连接器是四层
 * 边界里风险最高的一层——它是唯一会把消息**送出本机**的能力。因此本文件的
 * 每一条约定都围着同一件事转：渲染进程既表达不出「往任意地址发」，也拿不回
 * 任何凭证。
 *
 * ## 为什么选 Webhook 而不是飞书
 *
 * 飞书要 tenant_access_token 换取、事件订阅回调 URL 校验、AES 解密、im API
 * 一整套，没有真实租户凭据无法端到端；而**框架层**要验证的那条链路——
 * 「连接器声明 `network:<domain>` → 经权限引擎授权 → 可装卸」——用一个通用
 * Webhook 连接器就能完整跑通，且飞书 / Slack / 钉钉 / 企微 / Discord 的自定义
 * 机器人 incoming webhook 全都是「POST 一段 JSON 到一个带密令的 URL」，一套
 * 框架天然覆盖多平台。
 *
 * ## 凭证为什么不进任何返回值
 *
 * 一条 incoming webhook URL 的密令就写在它的路径里（`.../hook/<token>`）。
 * 把完整 URL 回传给渲染进程等于把密令交出去。因此渲染进程能看到的极限是
 * `{domain, configured, last4}`——与 secret-store / providers 的
 * `{configured, last4}` 同一口径。完整 URL 只活在主进程，经 secret-store
 * （safeStorage 加密、只进不出）保管。
 *
 * ## 为什么域名是一张固定白名单而不是通配
 *
 * ADR-0002 D3 与 capability.ts 都拒绝 `network:*`：一条通配等于「任意出站」，
 * 而 main 侧唯一的出站原语 `net/outbound-guard.ts` 的全部意义就是不存在这种
 * 东西。因此连接器能达到的域名是一张**声明在 manifest 里的白名单**
 * （`CONNECTOR_SUPPORTED_DOMAINS` 派生），配置一个白名单之外的域名会在
 * manifest 上界当场被拒——那正是「未授权域名被拒」这条可证伪判据的来源。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

/** 连接器能力 id（四层边界表第四行，tier=connector）。 */
export const CONNECTOR_CAPABILITY_ID = "connector.webhook";

/**
 * 连接器实例的**类型**：通用 webhook（基座）或三个真实渠道适配器。
 *
 * 类型决定的是「出站消息体怎么拼、入站事件怎么解、目标域名限定在哪几个 host」
 * ——这套差异全部收在 `main/connector/adapters/` 的适配器描述符里，contract 这里
 * 只固定名字与派生常量。新增一个渠道 = 在这里加一个 kind + 在 adapters 加一个
 * 描述符 + 一份 manifest，出站三关与权限引擎判定随之自动生效。
 */
export const CONNECTOR_KINDS = ["webhook", "feishu", "slack", "telegram"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export const connectorKindSchema = z.enum(CONNECTOR_KINDS);

/**
 * 三个真实渠道适配器的能力 id 与目标域名（各自 manifest 的 `network:` 权限由
 * 对应 domain 派生）。每个适配器只声明**自己**那一个 host——飞书连接器越不过
 * `open.feishu.cn`、Slack 越不过 `hooks.slack.com`、Telegram 越不过
 * `api.telegram.org`，跨平台发送在出站第一关（域名上界）当场被拒。
 *
 * 出站 API 形状取自各平台官方文档（不臆测）：
 *   - 飞书自定义机器人：`POST open.feishu.cn/open-apis/bot/v2/hook/<token>`，
 *     体 `{msg_type:"text",content:{text}}`，成功回 `{code:0}`（code≠0 即失败）。
 *   - Slack incoming webhook：`POST hooks.slack.com/services/...`，体 `{text}`。
 *   - Telegram：`POST api.telegram.org/bot<token>/sendMessage`，体 `{chat_id,text}`
 *     （chat_id 随凭证 URL 的 query 一起落，出站体因此只带 `{text}`）。
 */
export const FEISHU_CAPABILITY_ID = "connector.feishu";
export const FEISHU_DOMAIN = "open.feishu.cn";
export const SLACK_CAPABILITY_ID = "connector.slack";
export const SLACK_DOMAIN = "hooks.slack.com";
export const TELEGRAM_CAPABILITY_ID = "connector.telegram";
export const TELEGRAM_DOMAIN = "api.telegram.org";

/**
 * 本连接器**声明能够访问**的目标域名（manifest 的 `network:` 权限由它派生）。
 *
 * 前五条是真实协作平台的自定义机器人 webhook host；`postman-echo.com` 是一个
 * 可达的公开 JSON 回声端点，用于框架自检与真机验证（它回 `application/json`，
 * 正好满足 safeFetch 对响应类型的要求）。**新增一个平台 = 在这里加一行**，
 * manifest 的上界与权限引擎的判定随之自动生效，无需改动出站或权限逻辑。
 */
export const CONNECTOR_SUPPORTED_DOMAINS = [
  "open.feishu.cn",
  "oapi.dingtalk.com",
  "qyapi.weixin.qq.com",
  "hooks.slack.com",
  "discord.com",
  "postman-echo.com",
] as const;
export type ConnectorSupportedDomain = (typeof CONNECTOR_SUPPORTED_DOMAINS)[number];

/** 一条域名对应的能力权限申请字符串（`network:hooks.slack.com`）。 */
export function connectorNetworkPermission(domain: string): string {
  return `network:${domain}`;
}

/** manifest 应声明的全部 `network:` 权限（供 connector-webhook.manifest 引用）。 */
export const CONNECTOR_NETWORK_PERMISSIONS: readonly string[] =
  CONNECTOR_SUPPORTED_DOMAINS.map(connectorNetworkPermission);

// ---------------------------------------------------------------- 渲染侧视图

/**
 * 渲染进程可见的连接器实例。
 *
 * **没有 url、没有 token**：完整 webhook URL 是密令，只活在主进程。渲染进程
 * 拿到的只有目标域名（不敏感）与凭证状态。
 */
export const connectorViewSchema = z
  .object({
    id: z.string().min(1),
    kind: connectorKindSchema,
    displayName: z.string().min(1),
    /** 目标域名（webhook URL 的 host），非敏感 */
    domain: z.string().min(1),
    enabled: z.boolean(),
    /** 是否已配置 webhook URL（凭证） */
    configured: z.boolean(),
    /** URL 尾四位，仅用于让用户认出配的是哪一条，不可逆推 */
    last4: z.string(),
    createdAt: z.number(),
  })
  .strict();
export type ConnectorView = z.infer<typeof connectorViewSchema>;

// ---------------------------------------------------------------- 请求

/**
 * 创建一个连接器实例。
 *
 * `url` 是密令承载体：它经 IPC 进来后立刻被主进程拆成「域名（落 sqlite）+
 * 完整 URL（落 secret-store 加密）」，**绝不原样返回**。这与 providers:save-key
 * 携带明文 key 的口径一致——密钥只进不出。
 */
export const connectorCreateRequestSchema = z
  .object({
    kind: connectorKindSchema,
    displayName: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();
export type ConnectorCreateRequest = z.infer<typeof connectorCreateRequestSchema>;

/**
 * 更新一个连接器实例：改名与 / 或轮换凭证。
 *
 * `url` 省略 = 只改名，保留原凭证；`url` 给出 = 轮换凭证（重新落 secret-store）。
 * 这是「凭证管理」里的轮换动作，同样不回传任何 URL。
 */
export const connectorUpdateRequestSchema = z
  .object({
    connectorId: z.string().min(1),
    displayName: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  })
  .strict();
export type ConnectorUpdateRequest = z.infer<typeof connectorUpdateRequestSchema>;

export const connectorIdRequestSchema = z
  .object({ connectorId: z.string().min(1) })
  .strict();
export type ConnectorIdRequest = z.infer<typeof connectorIdRequestSchema>;

export const connectorSetEnabledRequestSchema = z
  .object({ connectorId: z.string().min(1), enabled: z.boolean() })
  .strict();
export type ConnectorSetEnabledRequest = z.infer<typeof connectorSetEnabledRequestSchema>;

/**
 * 连接自检 / 推送都需要 workspaceId：出站授权按 workspace 判定
 * （`network:<domain>` 的授权表挂在 WorkspaceProfile 上）。
 */
export const connectorTestRequestSchema = z
  .object({ connectorId: z.string().min(1), workspaceId: z.string().min(1) })
  .strict();
export type ConnectorTestRequest = z.infer<typeof connectorTestRequestSchema>;

export const connectorSendRequestSchema = z
  .object({
    connectorId: z.string().min(1),
    workspaceId: z.string().min(1),
    /** 要推送的文本（图片 / 附件推送属后续，见 manifest 说明） */
    text: z.string().min(1),
  })
  .strict();
export type ConnectorSendRequest = z.infer<typeof connectorSendRequestSchema>;

// ---------------------------------------------------------------- 结果

/**
 * 一次出站（自检 / 推送）的结果。
 *
 * **永不抛**：这是「测试 / 发送」类动作，任何失败都是它的正常结果，抛出去
 * 只会让界面上的按钮转完圈没下文。所有信息都在返回值里，且 `redactedMessage`
 * 已在主进程侧脱敏（webhook URL 与凭证绝不出现在里面）。
 *
 * `errorCode` 把三类根因分开，用户的下一步动作完全不同：
 *   - `permission`：该 workspace 还没授权访问这个域名 → 去授权
 *   - `domain`：目标域名不在 manifest 白名单 → 换一个受支持的平台
 *   - `ssrf`：URL 指向内网 / 环回 / 元数据地址，被出站守卫挡下 → 配置有误或被攻击
 *   - `network`：连不上 / 超时 / 上游报错 → 看网络或对方服务
 */
export const connectorResultSchema = z
  .object({
    ok: z.boolean(),
    /** 上游 HTTP 状态；未发出请求（被授权 / 守卫拦下）时为 null */
    status: z.number().nullable(),
    errorCode: z.enum(["ok", "permission", "domain", "ssrf", "network", "config", "unknown"]),
    redactedMessage: z.string(),
    latencyMs: z.number().nonnegative(),
  })
  .strict();
export type ConnectorResult = z.infer<typeof connectorResultSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `connector.webhook` 的七条通道。
 *
 * 分片 id 是 capabilityId 的第二段（`connector.webhook` → `webhook`），drift
 * test 据此把「manifest 声明的通道」与「本分片的键集合」逐条对账。
 *
 * 列举 / 增删改 / 启停的返回都是**权威快照**（ConnectorView[]）：渲染进程做完
 * 任何一个动作立刻拿到全量状态，不必自己推断列表变成了什么样——「点了没反应」
 * 这类问题在结构上就不成立。
 */
export const connectorContractShard = defineContractShard("webhook", {
  [CHANNELS.connectorList]: {
    request: z.void(),
    response: z.array(connectorViewSchema),
  },
  [CHANNELS.connectorCreate]: {
    request: connectorCreateRequestSchema,
    response: z.array(connectorViewSchema),
  },
  [CHANNELS.connectorUpdate]: {
    request: connectorUpdateRequestSchema,
    response: z.array(connectorViewSchema),
  },
  [CHANNELS.connectorRemove]: {
    request: connectorIdRequestSchema,
    response: z.array(connectorViewSchema),
  },
  [CHANNELS.connectorSetEnabled]: {
    request: connectorSetEnabledRequestSchema,
    response: z.array(connectorViewSchema),
  },
  [CHANNELS.connectorTest]: {
    request: connectorTestRequestSchema,
    response: connectorResultSchema,
  },
  [CHANNELS.connectorSend]: {
    request: connectorSendRequestSchema,
    response: connectorResultSchema,
  },
});

# FEAT-channels：三个真实渠道适配器（connector.feishu / slack / telegram）

在 FEAT-connector（通用 webhook 基座）之上加三个**真实渠道能力包**。基座那套
「凭证只进不出、出站穿三关、入站四道守卫」一个字节没重造——三个渠道各自只加一层
平台适配（消息体、响应判读、入站解析），并各自是一份可单独启停的能力包。

依据：`FEAT-connector.md`（v1 框架）、`docs/product/ADR-0002-capability-architecture.md`
（D3 network scope / D4 命名空间与数据分区 / D5 UI 插槽）。

---

## 0. 一句话架构：适配器是唯一的平台差异面

出站路径统一成「`resolveAdapter(connector.kind)` 然后照它拼」，没有一条
`if (kind === "feishu")` 特例。一个适配器（`main/connector/adapters/*.ts`）声明三件事：

| 差异 | 字段 | 飞书 | Slack | Telegram | webhook 基座 |
|---|---|---|---|---|---|
| 域名上界 | `domains` | open.feishu.cn | hooks.slack.com | api.telegram.org | 多平台白名单 6 条 |
| 出站体 | `formatBody` | `{msg_type:"text",content:{text}}` | `{text}` | `{text}`(chat_id 随凭证 URL) | `{text}` |
| 响应判读 | `checkResponse` | `code===0` | HTTP 状态 | `ok===true` | HTTP 状态 |
| 入站解析/防回环 | `parseInbound` | sender_type≠user | bot_id 存在 | from.is_bot | 通用 `{message_id,text}` |

新增一个渠道 = 加一个 kind（contract）+ 一个适配器 + 一份 manifest，出站三关与权限
引擎判定随之自动生效。

## 1. 交付物（按路径）

**契约（扩展）**
```
packages/contract/src/connector.ts            + ConnectorKind 枚举 + 三平台 domain/capabilityId 常量；kind 由 literal("webhook") 放宽为 enum
packages/contract/src/connector-channels.ts   新增：入站请求/结果 schema + feishu/slack/telegram 三个契约分片（各 send+receive 两条通道）
packages/contract/src/channels.ts             + feishu/slack/telegram:send/receive 六条
packages/contract/src/ipc-contract.ts         + 三个分片进装配清单
packages/contract/src/index.ts                + export connector-channels
```

**主进程（新增适配层 + 扩展基座）**
```
packages/app/src/main/connector/adapters/adapter.ts    适配器抽象 + kind→adapter 注册表（重复 kind 抛错）+ 解析小工具
packages/app/src/main/connector/adapters/webhook.ts    基座适配器（body={text}、多平台白名单）
packages/app/src/main/connector/adapters/feishu.ts     飞书适配器（msg_type/content、code 判读、sender_type 防回环、事件 v2/握手）
packages/app/src/main/connector/adapters/slack.ts      Slack 适配器（incoming webhook、bot_id 防回环、Events API/握手）
packages/app/src/main/connector/adapters/telegram.ts   Telegram 适配器（sendMessage、ok 判读、from.is_bot 防回环、Update）
packages/app/src/main/connector/adapters/index.ts      装配点
packages/app/src/main/connector/channel-delivery.ts    共享收发执行体（出站授权按 kind 的 capabilityId 判 + 入站准入）
packages/app/src/main/connector/feishu-ipc.ts          feishu:send / feishu:receive（exposure.module）
packages/app/src/main/connector/slack-ipc.ts           slack:send / slack:receive
packages/app/src/main/connector/telegram-ipc.ts        telegram:send / telegram:receive
packages/app/src/main/connector/connector-outbound.ts  出站改为 adapter-aware（域名上界/体/响应判读三处从适配器来）
packages/app/src/main/connector/connector-store.ts     kind 由 "webhook" 放宽为 ConnectorKind
packages/app/src/main/connector/connector-manager.ts   createConnector 收 kind，域名上界按 kind 的适配器判
packages/app/src/main/connector/connector-ipc.ts       基座 test/send 改走 channel-delivery（按连接器 kind 判授权）
packages/app/src/main/capability/manifests/connector-feishu.manifest.ts     能力清单（network:open.feishu.cn，depends connector.webhook）
packages/app/src/main/capability/manifests/connector-slack.manifest.ts      同上（hooks.slack.com）
packages/app/src/main/capability/manifests/connector-telegram.manifest.ts   同上（api.telegram.org）
packages/app/src/main/capability/capability-manifests.ts   + 三份清单进 BUILT_IN + general/coding 两 Profile
packages/app/src/main/capability/capability-catalog.ts     + 三份 register（无 deactivate，复用基座拆卸）
```

**预载 / 渲染（扩展，命名空间数不变仍 24）**
```
packages/app/src/preload/api/connector.ts                       + create 收 kind、sendVia、receive 三个方法（不新增命名空间）
packages/app/src/renderer/src/stores/connector.ts               + createChannel / sendVia；权限唤起 capabilityId 按 kind 判
packages/app/src/renderer/src/components/ConnectorChannelsPanel.vue  新增：三渠道共享面板（选平台建连接器 / 推送 / 自检 / 删）
packages/app/src/renderer/src/components/AppShell.vue           + 「渠道」按钮 + 面板挂载 + 三渠道各自 isEnabled 门控
```

**测试**
```
packages/app/test/connector-channels.spec.ts   19 条（体拼装 / 响应判读 / 域名隔离 / 引擎授权 / SSRF / 防回环去重握手，全部含对拍）
```

## 2. 设计要点（为什么这么切）

- **三个渠道各自一份能力包（独立 manifest 接入 registry），但只加两条平台通道**：
  增删改启停复用基座 `connector:*` 七条（create 收 kind），三个渠道**只额外**声明
  `<平台>:send/receive`。drift test 要求「每能力有自己非空且不跨能力重复的通道 + 匹配
  的契约分片」，两条平台通道恰好满足，又不把一套 CRUD 抄三遍。
- **`dependencies: ["connector.webhook"]`**：三个渠道复用基座的库、入站守卫、出站原语。
  依赖关系让「适配器建在基座之上」这件事被引擎显式建模——基座未启用时渠道被判依赖
  未满足而不启用；基座的 `disposeConnectorResources` 一并收三渠道共享的运行期资源，
  故三渠道 manifest 的 `teardown` 为空、无需各自 dispose。
- **出站授权按连接器自身 kind 的适配器 capabilityId 判**（channel-delivery 的
  `outboundDepsFor`）：飞书连接器无论走 `feishu:send` 还是基座 `connector:send`，都在
  `connector.feishu` 名下授权，grant 不分裂。
- **Telegram 的 chat_id 随凭证 URL 落 secret-store**（`…/sendMessage?chat_id=<id>`）：
  Bot API 允许参数走 query，故出站体只带 `{text}`，与「整条 URL 即凭证、只进不出」的
  基座模型保持一致（token 与 chat_id 都不进渲染进程、不进日志）。
- **未做 permission 域一行改动**：连接器的 `network:<domain>` 上界由各渠道 manifest 声明，
  核心 PermissionEngine 的 isDeclared/授权判定据此对 `connector.<平台>` 自动生效。

## 3. 可证伪判据 + 对拍（临时拆掉、确认变红、两次输出）

单测 `connector-channels.spec.ts` 全部真实制造，不是「断言函数被调用」：

### 3.1 未授权域名被拒（域名上界按适配器隔离）—— 实做对拍
临时把 `connector-outbound.ts` 关 1 改成 `if (false && …)`（拆掉域名上界）：

| | 输出 |
|---|---|
| 拆掉后（红） | `飞书连接器配了 Slack 的 host → domain 拒` ✗ `expected [ false, 'network' ] to deeply equal [ false, 'domain' ]`——host 落到网络关而非被上界拦下 |
| 恢复后（绿） | 该用例通过：飞书连接器配 `hooks.slack.com` → `domain` 拒，即便授权恒真 |

### 3.2 入站防回环（适配器的 fromSelf 判定）—— 实做对拍
临时把 `feishu.ts` 的 `fromSelf` 改成 `false && …`（拆掉飞书防回环判定）：

| | 输出 |
|---|---|
| 拆掉后（红） | `飞书：sender_type 非 user（机器人）→ loop` ✗ `expected null to be 'loop'`——机器人自己的消息不再被认成回环 |
| 恢复后（绿） | 机器人事件判 `loop`、真人事件 `accepted` |

### 3.3 经引擎授权（对拍，真实 CapabilityPermissionEngine）
飞书连接器：空授权表 → `permission`（底层 fetch 一次没调）；补上
`network:open.feishu.cn` 的 workspace 授权 → 同一次推送放行且真的发了。上界对拍：
伪造一条 `network:api.telegram.org` 授权也越不过飞书 manifest（isDeclared 挡在上界外）。

### 3.4 SSRF 挡内网（对拍，真实 safeFetch + 注入 DNS）
Telegram 出站：域名解析到 `127.0.0.1` → 被出站守卫挡下（`ssrf`）；对拍解析到公网
`203.0.113.10` → 放行（放行/拦截只由地址决定）。底层错误带完整 URL 经 safeFetch 脱敏后，
`SECRET:TOKEN` 不出现在返回值。

### 3.5 响应判读对拍
飞书 `code≠0` / Telegram `ok:false` 即便 HTTP 200 也判失败；对拍 `code:0` / `ok:true`
才算送达。飞书出站上游回 `code:9499` → 整次推送判 `network` 失败。

单测实跑：
```
$ npx vitest run connector-channels
 Test Files  1 passed (1)     Tests  19 passed (19)
```

## 4. 真机取证（release/win-unpacked/PiBuddy.exe + CDP，非模拟）

`pnpm dist` 出包（PiBuddy-Setup-0.1.0.exe，含本轮代码），`Start-Process` 脱离启动
`--remote-debugging-port=9222`，`scripts/cdp-eval.mjs` 连渲染进程 target：

```
A. window.piBuddy.connector 方法 = create,list,receive,remove,send,sendVia,setEnabled,test,update
   （命名空间仍 24 个，未新增；sendVia/receive 是本轮加的）

B. 能力快照：connector.webhook:true | connector.feishu:true | connector.slack:true | connector.telegram:true

C. 未授权域名被拒（配置期上界）：
   connector.create('bad','https://hooks.slack.com/x','feishu')
     → 抛 CONNECTOR_DOMAIN_UNSUPPORTED   ← 飞书渠道越不过 open.feishu.cn

D. 建飞书连接器（open.feishu.cn）→ 视图 {kind:"feishu", domain:"open.feishu.cn",
   configured:true, last4:"OKEN", hasUrl:false}   ← 视图里没有 url 字段（凭证只见状态）

E. 入站（经真实 IPC → channel-delivery → adapter.parseInbound → IngestGuard）：
   飞书机器人事件(sender_type app)  → rejected/loop        ← 防回环
   飞书真人事件(sender_type user)   → accepted             ← 放行
   同一 message_id 再投一次         → rejected/duplicate   ← 去重
   url_verification 事件            → challenge/ch-99       ← 握手回声

F. 清理：remove 掉验证连接器 → 非 webhook 剩余 = 0；
   Stop-Process -Name PiBuddy -Force 之后 Get-Process PiBuddy,electron = 0
```

E 就是「防回环 / 去重 / 握手」在**打包产物**上穿过真实 IPC 与出站/入站编排跑出来的
证据，不是靠架构图推断。

> **未验证部分（如实标注，不伪装）**：
> 1. **真实飞书/Slack/Telegram 端到端**——无真实租户凭据（tenant token / signing secret /
>    bot token+chat_id），无法确认对方平台真的收到并正确渲染消息。框架层（域名上界 +
>    经引擎授权 + safeFetch 出站 + 响应判读 + 凭证隔离 + 入站准入）已用单测（真实引擎 +
>    真实 safeFetch + 注入 DNS）与真机 CDP 验证。出站 API 形状取自各平台官方文档
>    （飞书 open.feishu.cn/document、Slack api.slack.com、Telegram core.telegram.org/bots/api），
>    并在 §3 的 body 抓取用例里比对，非臆测。
> 2. **入站接 Agent 触发未接**：`receiveThrough` 走完解析 + 四道守卫、返回 accepted，但
>    v1 **不在此处触发 Agent**（pi:prompt / 后台池）。理由与 FEAT-connector 一致：真实入站是
>    「平台把事件 POST 到一个常驻回调端口」，v1 刻意不开这个常驻监听端口（避免常驻入站攻击面）；
>    把 accepted 消息交给 Agent 那一步，与真实入站端口（含平台签名校验、回调 URL 的 SSRF 防护）
>    一起在后续落地——`channel-delivery.ts` 里已标出触发点会挂上来的位置。这也受本轮硬边界所限
>    （不碰 main/tasks、后台池内核既有逻辑）。
> 3. **飞书签名推送 / 富文本 / 附件推送未做**：v1 走飞书自定义机器人不签名文本路径；
>    启用签名校验的机器人需体内带 timestamp+sign，属后续。

## 5. 硬约束核对（命令与真实输出）

```
守卫外 fetch( 命中                    → 0（连接器出站只经 safeFetch）
ipcMain.handle/on 外 ipc-guard        → 0（六条平台通道全经 registerHandler）
node scripts/check-contract-uniqueness → OK（contract exports 671，契约名唯一）
node scripts/check-test-discovery      → OK（onDisk 126 == discovered 126）
node packages/app/scripts/check-pure-js-deps → OK（无原生扩展）
node packages/app/scripts/verify-packaged-app → OK
```

- **channels.ts 不依赖 zod**：六条平台通道名是纯字符串常量；preload `api/connector.ts`
  只从 `@pibuddy/contract/channels` 引通道名。
- **secret-store 唯一 / logger 唯一**：凭证仍走基座 `connector-secret`（槽位 `connector.<id>`，
  safeStorage 加密、只进不出）；审计走 `createLogger("connector")`（脱敏，记 kind/域名/结果码）。
- **未新增运行时依赖**：适配器是纯逻辑，出站用现成 safeFetch。

## 6. 全量门禁（收尾一次全跑）

```
pnpm typecheck            → 三个包全 Done
pnpm -w test              → Test Files 126 passed (126)   Tests 1151 passed (1151)
                            （基线 125 / 1132 → +1 文件 / +19 用例，无一条既有用例被改判）
pnpm build                → ✓ built（含三渠道全链路）
pnpm --filter @pibuddy/app dist → PiBuddy-Setup-0.1.0.exe 出包
```

## 7. 本轮发现、未修（留给后续）

1. **入站无真实端口 / 未接 Agent 触发**（见 §4 未验证 2）：`receiveThrough` 是准入 + 解析
   的纯逻辑闭环，接真实回调服务器（含平台签名校验、回调 URL 的 SSRF 防护）与 Agent 触发
   是后续，也受本轮边界（不碰 tasks / 后台池内核）所限。
2. **Slack 出站体与基座 webhook 同为 `{text}`**：Slack 与 webhook 的出站差异只在域名隔离 +
   入站解析；富文本 blocks / Web API chat.postMessage（需 header Bearer token，凭证模型不同）
   属后续。
3. **渠道与基座 webhook 的域名有交集**：基座 webhook 白名单本就含飞书/Slack 的自定义机器人
   host（通用 webhook 合法用途）；平台渠道在其上加平台适配。二者按 capabilityId 分别授权，
   互不串。

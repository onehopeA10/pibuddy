# FEAT-connector：连接器 v1（Webhook，connector.webhook / CON-101）

四层边界第四行（连接器）的第一个实体。验证 ADR-0002 的连接器链路：
**连接器声明 `network:<domain>` → 经核心 PermissionEngine 授权 → 可随 Profile 装卸**，
出站只走 `net/outbound-guard.ts` 的 safeFetch（SSRF 防护），凭证只进不出。

依据：`docs/product/ADR-0002-capability-architecture.md`（D3 权限 network scope / D4 / D5）；
`FEAT-permission-engine.md`（连接器出网靠它授权 `network:<domain>`，§6 预留入口）；
`FIX-capability-core.md`（manifest / registry / Profile / feature gate / drift test）。

---

## 0. 选型理由：为什么是通用 Webhook 而不是飞书

二选一，选**通用 Webhook**，理由是「这一批要验证的是框架层，不是某个平台的完整对接」：

- **飞书端到端要一整套且离不开真实租户凭据**：tenant_access_token 换取、事件订阅
  回调 URL 校验、AES-256-CBC 解密、im.message API。没有真实 App ID/Secret 无法端到端，
  框架层的验证会被平台细节淹没。
- **Webhook 能在单 agent 预算内完整跑通框架链路**，且能对**可达的公开 HTTPS 端点**
  做真机端到端验证（见 §4），不伪装。
- **Webhook 天然覆盖多平台**：飞书 / 钉钉 / 企业微信 / Slack / Discord 的自定义机器人
  incoming webhook 全是「POST 一段 JSON 到一个带密令的 URL」，一套框架覆盖它们。
  manifest 用一张固定域名白名单声明这几个平台的 host（`CONNECTOR_SUPPORTED_DOMAINS`），
  白名单之外的域名在上界当场被拒——这正是「未授权域名被拒」可证伪判据的来源。

`postman-echo.com` 作为白名单里的第 6 条，是一个可达的公开 JSON 回声端点，用于框架自检与
真机验证（它回 `application/json`，恰好满足 safeFetch 对响应类型的要求）。

## 0.1 本批范围与明确未做

- **做**：主动推送（Agent → 外部平台）的完整出站链路（域名上界 → workspace 授权 →
  safeFetch）；连接器框架（manifest / 注册 / 启停 / 连接自检 / 凭证管理）；入站准入守卫
  （去重 / 防回环 / 限速 / 附件上限，纯逻辑 + 单测）；按 workspace/connector 隔离；审计。
- **明确未做（如实标注，不伪装）**：真实的入站 HTTP 回调**服务器**（v1 不在本机开常驻
  入站端口，避免引入一个常驻监听的攻击面——入站守卫是纯函数 + 测试，适配层接真实端口
  是后续）；多平台消息体格式化（当前统一发 `{text}`）；图片 / 附件推送；飞书 / Slack 的
  真实凭据端到端（无真实租户，改用可达公开 HTTPS 端点验证框架层，见 §4）。

---

## 1. 决策模型

### 1.1 出站要连过三道关（`connector-outbound.ts`）

1. **域名上界**：目标 host 必须在 manifest 声明的 `network:<domain>` 白名单里。不在 → 拒
   （`domain`），连授权都不问。这是「未授权域名被拒」的第一处落地。
2. **workspace 授权（经引擎授权）**：交给注入的 `authorizeNetwork`，生产路径 = 核心
   `PermissionEngine.evaluate({capabilityId:"connector.webhook", permission:"network:<host>", workspaceId})`。
   未授权 → 拒（`permission`）。**这一关就是链路里「经引擎授权」的那一段。**
3. **出站守卫**：真正的 HTTP 只走 `safeFetch`——手动跟随重定向、每跳重解析、拦内网 /
   环回 / 云元数据地址（SSRF）、跨源摘凭证头。守卫外裸出站命中数恒为 0。

### 1.2 为什么不改 `main/permission/**`

按硬边界「permission 既有逻辑只调用」：连接器的网络授权**不接 IPC 第五道闸的需求表**
（那要改 `permission-store.ts`），而是在出站时**直接调用** `permissionEngine().evaluate(...)`。
连接器 manifest 声明 `network:<domain>`，引擎的上界校验（`isDeclared`，读注册表里连接器
manifest 的 permissions）与授权判定据此对 `connector.webhook` 这个 capabilityId **自动生效**，
`main/permission` 域一行未改。

### 1.3 凭证只进不出

一条 incoming webhook URL 的密令写在路径里（`.../hook/<token>`），因此**整条 URL 就是凭证**：
经 secret-store（safeStorage 加密、只进不出）保管，槽位 `connector.<id>`。渲染进程能看到的
极限是 `{domain, configured, last4}`——`ConnectorView` 里**没有 url 字段**。完整 URL 只在
`connector-outbound` 里从 secret-store 取出直接喂给 safeFetch，不进任何 logger、不进返回值。

### 1.4 入站准入四道关（`connector-ingest.ts`，纯逻辑）

防回环（带自我标记 `x-pibuddy-connector` / 本机器人自己的消息一律丢）→ 去重（按 messageId）→
尺寸 / 附件上限 → 限速（每 connector 滑动窗口）。按 connectorId 分桶、按 workspace 隔离。

---

## 2. 改了什么（按路径）

**新增**

```
packages/contract/src/connector.ts                                 契约 + 7 条通道分片 + 域名白名单
packages/app/src/main/connector/connector-store.ts                 sqlite 持久（非敏感配置，node:sqlite）
packages/app/src/main/connector/connector-secret.ts                凭证存取（走 secret-store）
packages/app/src/main/connector/connector-outbound.ts              出站三道关（可注入依赖，对拍友好）
packages/app/src/main/connector/connector-ingest.ts                入站准入守卫（纯逻辑）
packages/app/src/main/connector/connector-manager.ts               编排（增删改启停 + 视图）
packages/app/src/main/connector/connector-ipc.ts                   7 条通道 + 接线引擎授权 + 审计 + dispose
packages/app/src/main/capability/manifests/connector-webhook.manifest.ts   能力清单（纯数据）
packages/app/src/preload/api/connector.ts                          window.piBuddy.connector（第 22 个命名空间）
packages/app/src/renderer/src/stores/connector.ts                  渲染侧状态
packages/app/src/renderer/src/components/ConnectorPanel.vue         drawer.tab UI 贡献
packages/app/test/connector-outbound.spec.ts                       7 条（网络授权对拍 + SSRF + 凭证不泄漏）
packages/app/test/connector-ingest.spec.ts                         8 条（去重 / 防回环 / 限速 / 附件）
packages/app/test/connector-manager.spec.ts                        7 条（域名上界 + 凭证只进不出 + 增删改启停）
```

**修改（共享中央文件，各自追加末尾 / 唯一插入点）**

```
packages/contract/src/channels.ts             + connector:* 7 条
packages/contract/src/ipc-contract.ts         + connectorContractShard（第 22 个分片）
packages/contract/src/index.ts                + export connector.js
packages/app/src/main/capability/capability-manifests.ts  + connectorWebhookCapability；进 general/coding 两个 Profile
packages/app/src/main/capability/capability-catalog.ts    + register（seal 之前）
packages/app/src/main/logger.ts               + LogScope "connector"
packages/app/src/preload/api/index.ts         + connector 命名空间
packages/app/src/renderer/src/components/AppShell.vue     + 门控 + 工具栏按钮 + 面板挂载
packages/app/test/preload-api.spec.ts         命名空间集合 21 → 22
```

**未新增任何运行时依赖**（sqlite 用 node:sqlite 内建，出站用现成 safeFetch）。
**未触碰** `main/git|tasks|scheduler|agent-pool|child-agent|memory/**`、`main/permission/**` 既有逻辑。

---

## 3. 对拍验证（临时拆掉机制，确认结果翻转）

三件事各做对拍，因为「断言函数被调用」挡不住恒真——「出网被 SSRF 挡」「未授权域名被拒」
都是真的制造出来，不是断言调用。

### 3.1 经引擎授权（`connector-outbound.spec.ts`，用**真实** CapabilityPermissionEngine）

| 场景 | 结果 |
|---|---|
| 无 workspace 授权 → 推送 | **拒（permission）**，底层 fetch 一次都没被调用 |
| **对拍：补上 `network:hooks.slack.com` 的 workspace 授权 → 同一次推送** | **放行 + 真的发出去** |
| 上界对拍：伪造一条 `network:evil.example.com` 授权 | 仍拒（isDeclared 越不过 manifest） |

拆掉授权那一关（authorizeNetwork 恒真）后，无授权也能发——证明这道关是真门槛。

### 3.2 域名上界（未授权域名被拒）

配置白名单外的域名（`evil.example.com`），即便授权恒真也拒（`domain`）。

### 3.3 SSRF 守卫 + 凭证不泄漏（真实 safeFetch，注入 DNS）

| 场景 | 结果 |
|---|---|
| 域名解析到 `127.0.0.1` | **被出站守卫挡下（ssrf）** |
| **对拍：同一调用，解析到公网 `203.0.113.10`** | **放行**（放行 / 拦截只由地址决定） |
| 底层 fetch 抛出带完整 URL 的错误 | 经 safeFetch 脱敏，`SECRETTOKEN` / `hooks.slack.com/services` **不出现在返回值** |

### 3.4 单测实跑

```
$ npx vitest run connector-outbound connector-ingest connector-manager
 Test Files  3 passed (3)
      Tests  22 passed (22)
```

drift test（`capability-drift.spec.ts`，数据驱动，自动纳入 connector.webhook）17 条全绿：
声明的 7 条通道 == registerHandler 实际注册 == 契约分片键集合；权限双向对账
（network → 一次 safeFetch 调用，反向无未申报调用）；teardown（listener）↔ dispose 导出；
UI 贡献存在且被门控（`isEnabled("connector.webhook")`）；catalog 逐条 register + seal，
ipc-registry 无写死注册。

---

## 4. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP，拒绝→授权→放行互斥）

打包产物含本轮代码。`Start-Process` 脱离启动 + `scripts/cdp-eval.mjs` 连渲染进程 target：

```
A. 命名空间：Object.keys(window.piBuddy).includes('connector') = true（共 22 个）

B. connector.list() = []（初始空）

C. 配置期域名上界（未授权域名被拒）：
   connector.create('bad','https://evil.example.com/x')
     → 抛 CONNECTOR_DOMAIN_UNSUPPORTED

D. 创建 echo 连接器（postman-echo.com）：
   connector.create('echo','https://postman-echo.com/post')
     → {domain:"postman-echo.com", configured:true, last4:"post", hasUrl:false}
        ↑ 视图里**没有 url 字段**（凭证只见状态）

E. 出站互斥闭环（真实公网 HTTPS，非模拟）：
   connector.test(id, 'e2e-verify')                      → {ok:false, code:"permission"}   ← 未授权被拒
   permission.decide(allow-session, network:postman-echo.com, 'e2e-verify')
   connector.test(id, 'e2e-verify')                      → {ok:true, code:"ok", status:200, "已送达"}  ← 授权后放行
```

E 就是那对**「未授权 → 拒 → 授权 → 放行」的真机互斥证据**，且不是靠架构图推断——连接器
穿过真实 secret-store 取凭证 → 出站三道关 → safeFetch → 打到**真实的公开 HTTPS 端点**
（postman-echo.com）拿回 200。

**清理**：`connector.remove` 把 E2E 造的连接器与凭证删掉（remaining=0）；
`Stop-Process -Name PiBuddy -Force` 之后 `Get-Process PiBuddy,electron` 均为 0。

> 未验证部分（如实标注）：**真实飞书 / Slack 端到端**——无真实租户凭据，无法确认
> 具体平台的消息体被对方正确接收。框架层（域名授权 + safeFetch 出站 + 200 往返 + 凭证隔离）
> 已用可达公开 HTTPS 端点端到端验证。**SSRF 挡内网**在真机上未单独制造（无法在运行期改
> DNS），但已用真实 safeFetch + 注入 DNS 在单测里跑出（§3.3）。

---

## 5. 硬约束核对（命令与真实输出）

```
$ rg -n '\bfetch\(' packages/app/src/main -g '*.ts'
packages/app/src/main/net/outbound-guard.ts:6 / :89 / :98
→ 守卫外命中数 0（3 条全在守卫内）；连接器出站只经 safeFetch

$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0        # 唯一 ipcMain.handle 出口仍是 ipc-guard；connector 的 7 条全经 registerHandler

$ rg -c 'invoke\(\s*channel\s*:\s*string' packages/app/src/preload | awk -F: '{s+=$2} END{print s+0}'
0        # 未向 preload 增加无约束入口（D4 规则 1）
```

- **channels.ts 不依赖 zod**：connector 通道名是纯字符串常量；preload 的 `api/connector.ts`
  只从 `@pibuddy/contract/channels` 引通道名。
- **logger 唯一 / secret-store 唯一**：审计走 `createLogger("connector")`（脱敏）；凭证走
  `secret-store` 的 saveSecret/loadSecret（safeStorage 加密，只进不出）。
- **数据分区（D4 规则 3）**：connectors.db（非敏感配置）+ secret-store（凭证）+ 入站守卫
  按 connectorId 分桶、按 workspace 隔离。
- **数据保留（D4 规则 4/5）**：`disposeConnectorResources` 只收 sqlite 句柄 + 入站内存状态，
  connectors.db 与凭证一个字节不动。

---

## 6. 全量门禁（收尾一次全跑）

> 说明：由于本 agent 初期误把文件写进了共享 checkout（而非隔离 worktree），
> typecheck / test / build / dist 是在共享 checkout 上对**字节完全一致**的这批文件跑的
> （文件随后按 `cp` 原样迁入 worktree 并提交，共享 checkout 已恢复干净）。目录位置不影响
> 编译（包内相对路径）。

```
$ pnpm typecheck            → 三个包全 Done
$ pnpm -w test              → Test Files 120 passed (120)   Tests 1099 passed (1099)
                              （基线 117 / 1077 → +3 文件 / +22 用例，无一条既有用例被改判）
$ pnpm build                → ✓ built（含 connector 全链路）
$ pnpm --filter @pibuddy/app dist  → PiBuddy-Setup-0.1.0.exe 出包
$ node scripts/check-contract-uniqueness.mjs   → OK（契约名字唯一）
$ node scripts/check-test-discovery.mjs        → OK（onDisk 120 == discovered 120）
$ node packages/app/scripts/check-pure-js-deps.mjs   → OK（无原生扩展）
$ node packages/app/scripts/verify-packaged-app.mjs  → OK
```

---

## 7. 本轮发现、未修（留给后续）

1. **入站没有真实 HTTP 端口**：`connector-ingest` 是纯准入守卫（去重 / 防回环 / 限速 /
   附件上限）+ 单测，接真实入站回调服务器（含回调 URL 的 SSRF 防护、平台签名校验）是后续。
   v1 不在本机开常驻入站端口是刻意的——那是一个常驻监听的攻击面。
2. **消息体统一 `{text}`**：飞书 `{msg_type,content}` / Slack `{text}` / 钉钉 `{msgtype}`
   的差异化格式化未做；当前对 postman-echo 与「接受 `{text}` 的平台」可用。
3. **`network:<domain>` 的授权是域名级**：同一平台不同租户共享一条 `network:<host>` 授权。
   若要按连接器实例细分，可用 grant 的 `resource` 位（引擎已支持 resource 级 grantCovers），
   本批未细分。
4. **AppShell 既有畸形标记**：`AppShell.vue` 里 git / 定时两个按钮的模板存在既有的标记
   畸形（他人合并遗留，Vue 当文本渲染、不影响编译）。本轮在其**之后**干净追加连接器按钮，
   未触碰该区域。

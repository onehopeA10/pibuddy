# PiBuddy 发布配置手册

> **本文件不含任何 secret 的值。** 只写「叫什么名字、去哪里申请、多久轮换、
> 过期了怎么办」。任何人如果在这份文档里看到一串像密钥的东西，那就是事故，
> 请立刻吊销它并提 issue。

## 0. 当前验收状态（2026-08-03）

| 项 | 状态 | 说明 |
|---|---|---|
| 三平台 target 配置（win NSIS / mac dmg+zip / linux AppImage+deb） | **已交付** | `packages/app/electron-builder.yml` |
| `publish` 块（generic feed） | **已交付** | URL 来自 `PIBUDDY_UPDATE_FEED_URL`，客户端里没有任何 token |
| release workflow + 失败关闭 | **已交付** | `.github/workflows/release.yml` |
| 产物完整性校验 | **已交付** | `packages/app/scripts/verify-release-artifacts.mjs` |
| Windows 代码签名 | `blocked-by-credential` | 无证书，未验证 |
| macOS 签名与公证 | `blocked-by-credential` | 无 Developer ID / Apple ID，未验证 |
| Linux 包签名 | `blocked-by-credential` | 无私钥，未验证 |
| 真实 N→N+1 自动更新闭环 | `not-tested (no clean VM)` | 无干净虚拟机，未执行 |

上面四项 `blocked-by-credential` / `not-tested` **不是"差不多完成"**。在真实凭据
与干净虚拟机齐备之前，任何"自动更新已打通"的说法都是错误的。

---

## 1. 必须由产品所有者提供的真实值

Coding Agent **不得编造**下列任何一项。它们要么来自你花钱买的证书，要么来自
你实际控制的域名与账号。

| # | 用途 | 需要的东西 |
|---|---|---|
| 1 | GitHub 仓库 | owner / repo（release 上传目标） |
| 2 | Windows 签名 | 代码签名证书（OV 或 EV）+ 证书密码 + Publisher 名称 |
| 3 | macOS 签名 | Apple Developer Program 账号、Team ID、Developer ID Application 证书 |
| 4 | macOS 公证 | Apple ID + App-Specific Password（或 App Store Connect API Key） |
| 5 | Linux 包签名 | GPG 私钥（deb/rpm 仓库签名用） |
| 6 | 正式下载域名 | 更新 feed 与安装包的对外地址 |

---

## 2. Secret 名称清单

在 GitHub 仓库 → Settings → Environments → `release` 下配置。**放在
environment 而不是 repository secret**：environment 可以要求人工审批，
fork 的 PR 也拿不到它。

| Secret 名称 | 用途 | 缺失时的行为 |
|---|---|---|
| `WIN_CSC_LINK` | Windows 代码签名证书（base64 的 .pfx，或 https URL） | release job `exit 1` |
| `WIN_CSC_KEY_PASSWORD` | 上述证书的密码 | release job `exit 1` |
| `MAC_CSC_LINK` | macOS Developer ID 证书（base64 的 .p12） | mac 产物未签名 |
| `MAC_CSC_KEY_PASSWORD` | 上述证书的密码 | mac 产物未签名 |
| `APPLE_TEAM_ID` | Apple Developer Team ID | release job `exit 1` |
| `APPLE_ID` | 用于公证的 Apple ID 邮箱 | release job `exit 1` |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该 Apple ID 的 App-Specific Password | release job `exit 1` |
| `PIBUDDY_UPDATE_FEED_URL` | 更新 feed 的根地址（客户端会去这里取 `latest*.yml`） | release job `exit 1` |

### 2.1 哪些 job 声明了 `environment: release`

environment secret **只有声明了该 environment 的 job 才读得到**。没声明的
job 里 `${{ secrets.X }}` 是空串，而不是一个明确的报错 —— 表现是「照文档
配好了，preflight 却说每一项都 missing」。因此下面三个 job 全部显式声明：

| job | 为什么需要 |
|---|---|
| `preflight` | 逐项检查凭据是否存在，读不到就等于全都缺失 |
| `upload-artifacts` | 构建时直接消费 Windows / macOS 签名与公证凭据 |
| `publish-manifest` | 发布前二次核验凭据，并执行不可撤回的发布动作 |

`regression` job **不**声明 `environment: release`：它只跑 `pnpm test:regression`，
不读任何 secret。给它挂 environment 只会多一次人工审批，测试本身拿不到凭据。

若在 environment 上配置了 **required reviewers**，审批会在这三个阶段各请求
一次（`upload-artifacts` 的三个平台同属一个阶段，一次批完）。这不是缺陷：
第一次批的是「允许开始构建」，最后一次批的是「允许把清单推给全网客户端」。

`.github/workflows/release.yml` 的 `preflight` job 会在**任何构建开始之前**
逐项检查上表中标注 `exit 1` 的 secret，缺一个就整条流水线红。这是刻意的：

> 未签名的正式包在 Windows 上会被 SmartScreen 拦、在 macOS 上直接打不开，
> 而用户看到的只是「这个软件有问题」。宁可发不出去，也不要发出去一个
> 装不上的包。

`beta` / `nightly` 渠道允许产出未签名 artifact，但它们会被打上
`-UNSIGNED-DO-NOT-PUBLISH` 后缀，且 `publish-manifest` job 不会运行 ——
未签名产物在结构上进不了 stable feed。

---

## 3. 申请步骤

### 3.1 Windows 代码签名证书

1. 向 CA（DigiCert / Sectigo / SSL.com 等）申请 **OV** 或 **EV** 代码签名证书。
   - OV：便宜，但新证书需要积累 SmartScreen 信誉，头几周仍会有警告。
   - EV：贵，硬件令牌或云 HSM，SmartScreen 即时信任。
2. 拿到 `.pfx` 之后：`base64 -w0 cert.pfx` ，把输出存入 `WIN_CSC_LINK`。
3. 证书密码存入 `WIN_CSC_KEY_PASSWORD`。
4. **EV 证书通常不能导出为 .pfx**。用 EV 时改走 Azure Trusted Signing 或
   CA 的云签名 API，此时 `WIN_CSC_LINK` 换成对应的配置，
   `electron-builder.yml` 需要加 `win.signtoolOptions` —— 属于配置变更，
   要走一次 PR 评审。

### 3.2 macOS 签名与公证

1. 加入 Apple Developer Program（99 USD/年）。
2. 在 Certificates 页面创建 **Developer ID Application** 证书。
3. 从钥匙串导出为 `.p12`，`base64 -w0` 后存入 `MAC_CSC_LINK`，密码存
   `MAC_CSC_KEY_PASSWORD`。
4. 在 appleid.apple.com → 登录与安全 → App 专用密码，生成一个，存入
   `APPLE_APP_SPECIFIC_PASSWORD`。
5. Team ID 在 Membership 页面，存入 `APPLE_TEAM_ID`；Apple ID 邮箱存入 `APPLE_ID`。

`packages/app/build/entitlements.mac.plist` 里每一条例外都有具体理由，
不要"为了先跑通"往里加条目 —— hardened runtime 的意义就在于没写进去的能力
一律没有。

### 3.3 更新 feed

1. 准备一个 HTTPS 静态站点（对象存储 + CDN 即可），例如
   `https://dl.<你的域名>/pibuddy/`。
2. 该地址存入 `PIBUDDY_UPDATE_FEED_URL`。
3. feed 目录下需要有 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`
   与对应安装包。发布顺序**必须**是「先传安装包，最后传清单」——
   `publish-manifest` job 已经把这个顺序写死。

---

## 4. 轮换周期

| 项 | 轮换周期 | 触发条件之外的强制轮换 |
|---|---|---|
| Windows 签名证书 | 随证书有效期（1~3 年） | 私钥疑似泄露、离职交接 |
| macOS Developer ID | 5 年 | 同上 |
| Apple App-Specific Password | **每 12 个月** | 账号密码变更时会全部失效 |
| `PIBUDDY_UPDATE_FEED_URL` | 不轮换 | 换域名时需要一个双写过渡期，见 §7 |
| GPG 私钥（Linux） | 2 年 | 同上 |

**轮换记录**写在本文件的 §8，只记「谁在什么时候换了哪一项」，不记值。

---

## 5. 过期演练

每季度做一次，在 `beta` 渠道上进行，不影响正式用户：

1. 把 `release` environment 里的 `APPLE_APP_SPECIFIC_PASSWORD` 临时改成一个
   无效值。
2. 触发一次 `workflow_dispatch`，channel 选 `beta`。
3. **期望结果**：`preflight` 通过（值非空），构建阶段公证失败，job 红。
4. 再把该 secret 整个删掉，重跑，channel 选 `stable`。
5. **期望结果**：`preflight` 直接 `exit 1`，一次构建都没开始。
6. 恢复正确的值，重跑一次确认绿。

演练的目的是验证**失败方式**，不是验证成功路径。如果第 3 步或第 5 步
"居然成功了"，说明失败关闭已经失效，必须当作 P0 处理。

---

## 6. 发布暂停

发现新版本有严重问题时，按下面的顺序做。**先止血，再归因。**

1. **撤回清单**（30 秒内可完成）：把 feed 上的 `latest.yml` /
   `latest-mac.yml` / `latest-linux.yml` 换回上一个好版本的内容。
   安装包文件**不要删** —— 已经开始下载的客户端会在中途 404，
   而 electron-updater 对 404 的表现是一句无解释的下载失败。
2. **停掉流水线**：在 GitHub Actions 里 disable `Release` workflow，
   防止有人重跑一次又把清单发回去。
3. **验证撤回生效**：用一台装着新版本的机器点「检查更新」，应看到
   「已是最新」（因为 feed 里的版本号已经回退且 `allowDowngrade: false`）。
4. 到这一步才开始查问题。

已经装上问题版本的用户走安全模式那条路：连续两次启动健康检查失败会自动进入
安全模式，横幅里有诊断导出与上一稳定版本的下载入口。**PiBuddy v1 不做真实的
二进制自动回滚**，理由见 `ADR-0001-update-feed.md`。

---

## 7. Hotfix 流程

1. 从出问题的 tag 切分支：`git switch -c hotfix/v<x.y.z+1> v<x.y.z>`。
2. 只改导致问题的那一处。hotfix 分支上**不合并**任何其它 PR ——
   "顺便带上"是 hotfix 变成第二次事故的最常见原因。
3. 本地跑：`pnpm test:regression`（要连打包冒烟再加 `pnpm test:regression:full`）。
4. bump patch 版本，打 tag，push。`Release` workflow 会自动跑。
5. **分阶段放量**：先把清单发到 `beta` 渠道，找 5~10 台机器验证
   N→N+1 真的走通了，再切 `stable`。
6. 回填到 `main`。

### 换域名的双写过渡

老 feed 上的客户端只认它出厂时烧进 `app-update.yml` 的那个 URL。因此换域名
必须双写：新旧两个地址同时提供同一份清单与安装包，直到旧地址的日活降到
可接受为止（经验值 6~12 个月）。**不要**指望"发一版新的就都迁过去了"—— 恰恰
那批没更新过来的用户才是需要旧地址的人。

---

## 8. 轮换记录

| 日期 | 项 | 操作人 | 备注 |
|---|---|---|---|
| （待填） | | | |

---

## 9. 发布前人工清单

`pnpm test:regression` / Release 的 `regression` job 覆盖机器能判的部分
（类型、闸门、单测、解包启动）。下面四项**不能**假装自动化了，每次正式
发布前由人在真机上勾：

| # | 项 | 怎样算过 | 为什么机器做不了 |
|---|---|---|---|
| 1 | 签名安装包 | 干净 Windows 上双击 NSIS，SmartScreen 不永久拦截；干净 macOS 上 dmg 能打开且 Gatekeeper 放行 | 凭据与信誉在证书侧，CI runner 不是用户桌面 |
| 2 | 真模型一轮对话 | 配好真实 key 后：发一句、权限弹窗能批、中断后「继续」、记忆页能看到本轮注入 | CI 没有真实供应商账号，也不该把 key 写进日志 |
| 3 | N→N+1 自动更新 | 干净机装着 N，feed 切到 N+1 后检查更新能下完并重启到新版本 | 需要两份已签名安装包 + 对外 feed，不是 `--dir` 能代替的 |
| 4 | 渠道与通知 | 至少一条真实渠道（飞书 / Slack / Telegram）能把回复送出去 | 依赖外部 webhook 与租户配置 |

本地发布前最小命令：

```
pnpm test:regression
```

打安装包并启动解包产物（十几分钟，对得上 CI `package` job）：

```
pnpm test:regression:full
```

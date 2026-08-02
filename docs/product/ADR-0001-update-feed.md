# ADR-0001：更新源选型与 v1 的回滚策略

- 状态：已接受
- 日期：2026-08-03
- 相关：UPD-005 / UPD-006 / UPD-007 / OBS-101

## 背景

PiBuddy 需要一条自动更新路径。electron-updater 支持多种 provider，其中现实
可选的是两条：直接用 **GitHub Releases** 作为 feed，或者自建一个
**generic feed**（HTTPS 静态目录 + `latest*.yml`）。

## 决策一：客户端用 generic feed，GitHub Releases 只作为构建产物的存放处

`packages/app/electron-builder.yml`：

```yaml
publish:
  provider: generic
  url: ${env.PIBUDDY_UPDATE_FEED_URL}
  channel: latest
```

### 为什么不是 GitHub Releases

1. **私有仓库要 token，而 token 会被打进客户端。** electron-updater 的
   `github` provider 对私有仓库需要 `GH_TOKEN`，那个值会出现在产物里的
   `app-update.yml`。等于给每一个装了 PiBuddy 的人发了一把仓库钥匙。
   公开仓库不需要 token，但那要求发布仓库必须永远公开 —— 这不是一个应该
   由更新机制来决定的事。
2. **api.github.com 在部分网络下不可达**，而 CDN 上的静态目录可以按地区
   分发。更新失败的用户不会来提 issue，他们只是永远停在旧版本上。
3. **撤回速度。** generic feed 撤回一次发布只需要覆盖一个
   `latest.yml`（秒级）；GitHub Releases 要改 release 状态，且客户端的
   缓存行为不由我们控制。发布出事时，撤回速度就是止血速度。

代价：需要自己准备一个 HTTPS 静态站点与域名（见 `RELEASE_SETUP.md` §3.3）。
这条代价是可接受的，因为它同时也是安装包的下载域名，本来就要有。

## 决策二：差分更新的收益在本项目里非常有限，不为它牺牲 asar

`asar: true`（TASK-003 恢复）之后，产物里有三块内容：

| 内容 | 位置 | 是否参与 blockmap 差分 |
|---|---|---|
| 应用主代码 | `app.asar` 内 | 是 |
| pi 运行时 | `extraResources` 外置到 `resources/pi-runtime` | **否** |
| convert-worker | `asarUnpack` 外置到 `app.asar.unpacked` | **否** |

electron-builder 的 blockmap 差分是**按整个安装包文件**计算的。
`extraResources` 与 `asarUnpack` 出来的内容确实在包里，但它们是大量独立的
小文件，任何一次 pi 版本变化都会让这一整段的字节布局大幅改变，差分块的复用
率极低。实测的结论是：**pi 运行时体积一变，就等于整包重下**。

那么能不能把 `asar` 改回 `false` 来换取差分收益？**不能。**

- TASK-003 已经用 `runtime-manifest.json` + `extraResources` 消除了 pi 对
  `asar: false` 的依赖。回退会同时破坏那个任务的收敛条件与产物完整性。
- `asar: false` 意味着应用主代码以散文件形式躺在安装目录里，任何一个能写
  该目录的进程都能改我们的 JS。为了省几十 MB 下载量换掉这个，是明显的
  错误交易。

**结论**：保留 `asar: true`，接受"pi 版本变化 = 整包重下"这个事实，并在
发布节奏上补偿它（pi 运行时不随每个 patch 版本变化）。

## 决策三：v1 **不做**真实的二进制自动回滚

### 为什么不做

自动回滚要求三件事同时成立：

1. 用户机器上留着上一版的完整安装包（几十上百 MB，长期占盘）；
2. 有一条经过验证的**降级**安装路径；
3. 降级不会破坏数据 —— 新版本可能已经把 SQLite 索引升到了新 schema。

第 2 条在三个平台上的语义各不相同：Windows per-user NSIS 的降级会触发
`allowDowngrade` 相关的一整套分支；macOS 的 ZIP 替换是原地覆盖，降级等于把
新版本删掉；Linux AppImage 干脆没有"安装"这个概念。**做半套比不做更危险**：
一个失败到一半的回滚，产出的是既不是新版也不是旧版的残骸。

第 3 条更麻烦：`SessionIndex.migrate()` 对"用旧版应用打开新版索引"的处理是
"不动它，本次运行退化为每次重扫"，这是安全的；但如果将来某次 migration 是
破坏性的，回滚就会连带丢数据。在没有 down-migration 契约之前，声称支持回滚
是在给用户一个不存在的保证。

### 替代方案（已实现）

| 机制 | 落点 |
|---|---|
| **health marker** | `<userData>/update-state/pending-update.json` 在 `quitAndInstall` 前写；健康启动后写 `last-known-good.json` 并清除 pending |
| 更新后首次启动的轻量健康检查 | `main/health/health-check.ts`，三项各 5 秒超时 |
| **safe mode** | 连续两次健康检查失败即进入；关掉第三方扩展、自动更新、自动会话恢复，并给出诊断导出与上一稳定版本的下载入口 |
| 分阶段放量 | 先发 `beta` 渠道，验证 N→N+1 后再切 `stable`（`RELEASE_SETUP.md` §7） |
| 快速撤回 feed | 覆盖 `latest*.yml` 即可秒级止血（`RELEASE_SETUP.md` §6） |

界面上因此**没有**任何看起来像"一键回滚"的按钮 —— safe mode 横幅里那个是
「下载上一稳定版本」，它打开发布页，由用户自己决定装不装。摆一个假的回滚
按钮，比不摆更糟。

## 决策四：更新清单最后发布

`publish-manifest` job 的最后一个 step 才上传 `latest*.yml`。顺序反过来的
表现是：客户端在那几十秒里读到一个指向尚未上传完的文件的清单，报「下载更新
失败」，而服务端看起来一切正常。

## 决策五：正式发布不使用第三方 Electron 镜像

改前 `electron-builder.yml` 硬编码了一个国内镜像。那意味着正式产物的 Electron
二进制来自未经供应链审批的来源，且没有开关能关掉它。现在镜像由
`packages/app/scripts/build-config.mjs` 按 `PIBUDDY_USE_CN_MIRROR` 注入，
CI 的 release job 不设该变量（`release.yml` 里有一条回归守卫断言它不出现）。

## 决策六：内置 pi 的版本跟随应用发布（UPD-007）

**绝不在用户机器上跑 `npm update` / `npm i -g`。** 运行期装进来的代码没有
经过发布签名，等于绕开整条供应链验证；而且用户机器上的 pi 版本会各不相同，
任何一份报障日志都对不上一个可复现的组合。内置 pi 的升级路径只有一条：
随应用发新版，走同一次签名与回归。

external pi（用户显式指定的外部命令）只做兼容范围检测与提示，一行都不改
用户的环境 —— 不升级、不降级，启动失败时也不静默切回内置（那等于替用户改了
他没做过的设置）。

## 未验证项

本 ADR 描述的发布链路中，以下部分在编写时**未经真机验证**：

- Windows / macOS / Linux 的真实签名与公证：`blocked-by-credential`
- 干净虚拟机上的真实 N→N+1 更新闭环：`not-tested (no clean VM)`

见 `RELEASE_SETUP.md` §0。

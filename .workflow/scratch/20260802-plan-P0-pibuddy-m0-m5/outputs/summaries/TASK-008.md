# TASK-008: SEC-004 凭据安全存储、出站请求 SSRF 防护与设置原子写

状态：**completed_with_deviations**（4 项偏差，逐条列在下方，其中 1 项是「未验证」而非「已通过」）

## 一、Changes

### 新建

- `packages/app/src/main/secret-store.ts` — safeStorage 密钥保管。`saveSecret` /
  `loadSecret`（**仅主进程内部**）/ `describeSecret` → `{configured, last4}`。
  `isEncryptionAvailable()` 为 false 时**先抛 `SECRET_STORE_UNAVAILABLE` 再碰磁盘**，
  绝不降级明文。落盘 `userData/secrets.json`，值是 base64(safeStorage 密文)。
- `packages/app/src/main/net/outbound-guard.ts` — 全仓唯一出站原语。
  `normalizeEndpointUrl` / `parseNumericIpForms` / `isBlockedAddress` /
  `assertPublicAddress` / `safeFetch`。
- `packages/app/src/main/endpoints.ts` — 端点注册表。`registerEndpoint` **先校验后落盘**，
  签发 `sha256(kind|baseUrl)` 派生的不透明 `endpointId`；`requireEndpoint` 对未知 id 抛错。
- `packages/app/test/ssrf.spec.ts`（31 用例）、`packages/app/test/settings-atomic.spec.ts`（5）、
  `packages/app/test/secret-store.spec.ts`（3）
- `packages/contract/test/ipc-contract.spec.ts`（4）— **files[] 里没有这个文件**，
  见偏差 3。承载 c[4] 的 `.shape` 键集合断言与 CT-09 白名单断言。
- `doc/regression/TASK-008-secrets.md` — 人工回归取证

### 修改

- `packages/contract/src/settings.ts` — 删除明文密钥字段；新增 `schemaVersion`、
  `sttEndpointId`、`sttApiKeyConfigured`、`sttApiKeyLast4`；导出 `APP_SETTINGS_PUBLIC_KEYS`。
- `packages/contract/src/ipc-contract.ts` — `sttTranscribeRequestSchema` 收窄为
  `{endpointId, audio, mimeType}`；新增 `secretKindSchema` / `secretWriteRequestSchema` /
  `secretQueryRequestSchema` / `secretDescriptorSchema`；`rendererSettingsPatchSchema`
  额外剔除 4 个主进程单向下发的派生字段。
- `packages/contract/src/channels.ts` — 新增 `settings:set-secret`、`settings:describe-secret`。
- `packages/app/src/main/settings.ts` — `SETTINGS_SCHEMA_VERSION = 1` + `migrate()` +
  `writeJsonAtomic` + `.bak` 备份 + 「主文件坏了从 .bak 恢复」；`loadSettings` 刻意不看 `.tmp`。
- `packages/app/src/main/ipc.ts` — `settings:get` 按白名单挑字段；`settings:set` 在落盘前
  跑端点校验；新增两条密钥通道（经 `registerHandler`）；`stt:transcribe` 收窄入参 +
  `MAX_AUDIO_BYTES` + `requireEndpoint` + `loadSecret` + `safeFetch`。
- `packages/app/src/preload/index.ts` / `index.d.ts` — 新增 `settings.setSecret` /
  `describeSecret`（**没有** getSecret）。
- `packages/app/src/renderer/src/stores/app.ts` — 新增 `saveSttSecret`；`saveSettings`
  不吞异常；首帧占位值补齐新字段。
- `packages/app/src/renderer/src/components/SettingsModal.vue` — 密钥框永不回填，
  显示「已配置 ····尾四位（留空则不改动）」；保存失败展示主进程原文。
- `packages/app/src/renderer/src/components/InputBar.vue` — 闸门改判 `sttApiKeyConfigured`；
  转写只传 `{endpointId, audio, mimeType}`。
- `packages/app/test/ipc-guard.spec.ts` — 25MB 音频用例改用新形状（原用例引用已删的字段）。
- `doc/threat-model.md` — G-5 / G-6 标为已闭合；新增第 5 节「出站请求的残余风险」，
  明确记录 DNS rebinding 第二跳与 localhost 端点两条**未闭合**项。

## 二、Verification —— 逐条实跑

### c[1] secret-store 的 safeStorage 用法

```
$ rg -c --no-filename 'safeStorage' packages/app/src/main/secret-store.ts | awk '{s+=$1} END{print s+0}'
6                                    # >= 2 ✓
isEncryptionAvailable()  -> 2 ✓   encryptString -> 1 ✓   decryptString -> 1 ✓
```

### c[2] CT-09 字段名唯一口径 — **PASS**

```
sttApiKey\b in preload/index.d.ts (want 0): 0 ✓
contract contains sttApiKeyConfigured: 3 ✓      sttApiKeyLast4: 3 ✓
export const APP_SETTINGS_PUBLIC_KEYS: 1 ✓
contract contains 'sttApiKey'(带引号, want 0): 0 ✓
sttApiKeySet 全仓 (want 0): 0 ✓
```

### c[3] preload 不再能同时提交 base URL 与密钥 — **PASS**

```
$ rg -c 'baseUrl|apiKey' packages/app/src/preload/index.ts | wc -l
0 ✓
```

### c[4] CT-07 STT 请求形状唯一 — **PASS**

`packages/contract/test/ipc-contract.spec.ts` 断言
`Object.keys(sttTranscribeRequestSchema.shape).sort()` === `['audio','endpointId','mimeType']`，
在 `pnpm -w test` 中通过。handler 体内 apiKey 命中数由 node 脚本按回调体行号区间判定：

```
PASS  c4 找到 stt:transcribe 注册
PASS  c4 handler 体内 apiKey 命中数 == 0  实测 0
PASS  c4 handler 体内 endpointId 来自 request
INFO  handler 体内 baseUrl 命中 1（`endpoint.baseUrl`，由 main 侧按 endpointId 查得，非入参）
```

### c[5][6] outbound-guard 内容断言 — **全部 PASS**

```
169.254.169.254 -> 4    100.64 -> 2    172.16 -> 2    192.168 -> 2
fc00:: -> 2             fe80:: -> 3    ::ffff: -> 4   ::1 -> 3
redirect: "manual" -> 1
MAX_RESPONSE_BYTES = 2 * 1024 * 1024 -> 1
CONNECT_TIMEOUT_MS = 5000 -> 1
OVERALL_TIMEOUT_MS = 60000 -> 1
application/json -> 1
```

### c[7] dns/lookup + 每跳重校验 — **PASS**

```
dns -> 4    lookup -> 8
PASS  c7 找到 redirect 循环（for (let hop = 0; hop <= MAX_REDIRECTS; hop++)）
PASS  c7 循环体内有 normalizeEndpointUrl
PASS  c7 循环体内有 assertPublicAddress
```

### c[8] CT-08 17 项 SSRF 阻断 + 唯一出站路径 — **PASS**（rg glob 需修正，见偏差 1）

`ssrf.spec.ts` 有一条 `expect(BLOCKED.length).toBe(17)` 钉死数量，17 项逐条独立 `it`，
全部在 `pnpm -w test` 中通过：非 https / localhost / 127.0.0.1 / 127.1 / 0.0.0.0 /
2130706433 / 0177.0.0.1 / 0x7f000001 / [::1] / [::ffff:127.0.0.1] / 10.0.0.5 /
172.16.0.1 / 192.168.1.1 / 100.64.0.1 / 169.254.169.254 / metadata.google.internal /
DNS rebinding（stub lookup 让公网域名解析到 10.0.0.1）。

```
$ rg --no-filename -c '\bfetch\(' packages/app/src/main -g '*.ts' -g '!**/outbound-guard.ts' -g '!*.spec.ts' -g '!*.test.ts' | awk '{s+=$1} END{print s+0}'
0 ✓
$ rg --no-filename -c 'assertHttpsOrLocalhost' packages/app/src | awk '{s+=$1} END{print s+0}'
0 ✓
```

### c[9] safeFetch 的 4 条断言 — **PASS**（均在 ssrf.spec.ts，`pnpm -w test` 通过）

- 302 → `http://169.254.169.254/latest/meta-data/` 抛 `OUTBOUND_BLOCKED`，
  且断言 `visited` 只有第一跳（元数据端点一次都没被请求）
- 响应体 > `MAX_RESPONSE_BYTES` 抛「响应体超过上限」（流式累计截断，不是先 `text()` 再判长度）
- content-type `text/html` 抛「响应类型不受支持」
- 错误消息 `not.toContain(完整 URL)` / `not.toContain("Authorization")` / `not.toContain("sk-live-XYZ")`

额外补了一条：跨源重定向时 `Authorization` 头被丢弃（`sentAuth[1]` 为 undefined）。

### c[10] settings.ts 原子写单点 — **1 项残留，见偏差 2**

```
SETTINGS_SCHEMA_VERSION = 1 -> 1 ✓    function migrate -> 1 ✓
from "./fs-atomic -> 1 ✓              writeJsonAtomic( -> 1 ✓
$ rg --no-filename -c 'fsyncSync|renameSync' packages/app/src/main -g '*.ts' -g '!fs-atomic.ts' | awk '{s+=$1} END{print s+0}'
3        # ✗ 期望 0 —— 全部来自 logger.ts 的日志轮转，非原子写实现（偏差 2）
```

### c[11] 第 30 行的直接覆写已消失 — **PASS**

```
$ rg -c 'writeFileSync\(settingsPath\(' packages/app/src/main/settings.ts | wc -l
0 ✓
```

### c[12] settings-atomic.spec.ts — **PASS**

- (a) 写 tmp 后崩溃：`assert.deepStrictEqual(loadSettings(), previous)` —— 用的是
  `node:assert/strict` 的 deepStrictEqual，不是人工判断
- (b) 无 `schemaVersion` 的旧文件迁移后 `schemaVersion === SETTINGS_SCHEMA_VERSION`，
  且 workspace / provider / modelId / thinkingLevel / sttBaseUrl / sttModel /
  piRuntimeMode / piExternalCommand **逐项**断言保留
- 另补两条：`renameSync` 抛错时原文件逐字节未变；主文件被改坏时从 `.bak` 恢复

### c[13] secret-store.spec.ts — **PASS**

- (a) `isEncryptionAvailable()` 返回 false → `saveSecret` 抛 `SECRET_STORE_UNAVAILABLE`，
  且落盘文件 `not.toContain('sk-live-XYZ')`
- (b) 可用时 `loadSecret` === `'sk-live-XYZ'`，落盘文件仍 `not.toContain` 明文

### c[14] 三条命令 — **全部 EXIT 0**

```
$ pnpm -w test          → Test Files 19 passed (19) / Tests 179 passed (179)   EXIT=0
$ pnpm typecheck        → EXIT=0
$ pnpm --filter @pibuddy/app build → EXIT=0
```
（改前基线 136 个测试；本任务新增 43 个：ssrf 31 + settings-atomic 5 + secret-store 3 + contract 4）

### c[15][16] [UI-observable] 真机取证 — 详见 `doc/regression/TASK-008-secrets.md`

真机形态：`npx electron packages/app --remote-debugging-port=9222`（build 产物），
取证经 `scripts/cdp-eval.mjs` 直连渲染进程调试端口 + 直接 `cat`/`grep` userData 下真实文件。

- [x] c[15] 填入密钥并重启后界面显示 `已配置 ····7788（留空则不改动）`，密码框 value 为空，
      弹窗全文不含明文；`await window.piBuddy.settings.get()` 返回对象无任何完整密钥字段
- [x] c[15] 真实 safeStorage（Windows DPAPI）：`secrets.json` 里是密文，
      `grep -c 'sk-live-PROBE-7788' secrets.json` → **0**
- [ ] c[16](a) **未验证** —— 见偏差 4
- [x] c[16](b) `https://169.254.169.254/v1` 保存被拒，界面文案含「内网」与 `OUTBOUND_BLOCKED`
- [x] c[16](c) `http://api.example.com/v1` 保存被拒，界面文案含「HTTPS」
- [x] c[16](d) 两次拒绝后 `grep -E '169\.254\.169\.254|api\.example\.com' settings.json` → 0 命中，
      `endpoints.json` 不存在（拒绝不半落盘）

### c[17] 裁定1 IPC 守卫结构断言 — **PASS**

```
$ rg --no-filename -c 'ipcMain\.(handle|on)\(' packages/app/src/main -g '*.ts' -g '!ipc-guard.ts' | awk '{s+=$1} END{print s+0}'
0 ✓
$ rg --no-filename -c 'registerHandler\(' packages/app/src/main/ipc.ts | awk '{s+=$1} END{print s+0}'
32 ✓ （>= 2；本任务新增 2 条 channel 全部经 registerHandler）
```

### c[18] 裁定6 契约唯一性 — **脚本 PASS，附加子句见偏差 3**

```
$ node scripts/check-contract-uniqueness.mjs
contract exports 74
OK: 契约名字唯一、无第二套契约包、无跨层 preload/index.d 引用
EXIT=0 ✓
```

## 三、Tests

| 命令 | 结果 |
|---|---|
| `pnpm -w test` | **EXIT 0** — 19 files / 179 tests 全绿 |
| `pnpm typecheck` | **EXIT 0** |
| `pnpm --filter @pibuddy/app build` | **EXIT 0** |
| `node scripts/check-contract-uniqueness.mjs` | **EXIT 0** |

## 四、Deviations

### 偏差 1（判据表述，非实现问题）：c[8] / c[10] 的 rg glob 在 Windows 上不生效

`rg -g '!net/outbound-guard.ts'` 用的是带 `/` 的相对 glob，但 ripgrep 在本机输出的
路径是 `packages/app/src/main\net\outbound-guard.ts`（反斜杠），该排除规则不命中，
于是自身的 3 处 `fetch(` 被计入。改用 `-g '!**/outbound-guard.ts'` 后：

```
0 ✓
```

判据的**意图**（main 下只有一条出站路径）成立，写法在 Windows 上需要 `**/` 前缀。

### 偏差 2（**未达成，如实记录**）：c[10] 的 `fsyncSync|renameSync` 命中数为 3 而非 0

三处全部在 `packages/app/src/main/logger.ts`（TASK-002 引入，本任务未触碰）：

```
logger.ts:56  * 用 renameSync 逐级顺移，从后往前，避免覆盖。       ← 注释
logger.ts:67      fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
logger.ts:73      fs.renameSync(filePath, `${filePath}.1`);
```

这是**日志轮转**（把 `app.log` 顺移成 `app.log.1`），不是原子写实现——它没有 tmp、
没有 fsync，语义是「重命名一批历史文件」。判据原文的意图是「原子写只有 fs-atomic.ts
一份实现」，这一点成立：settings.json / workspaces.json / secrets.json / endpoints.json
四处全部 `import { writeJsonAtomic } from "./fs-atomic.js"`，本任务没有新增第二份。

**我没有为了让数字变 0 去改 logger.ts 或改判据的 glob。** 按字面判定这条是 FAIL，
按意图判定是 PASS，两种口径都记在这里由复核者裁定。

### 偏差 3（判据表述 + 一处主动收敛）：c[18] 的附加子句

判据末尾要求新增的每个 .ts 文件 `rg -c "from '@pibuddy/contract'" <file>` >= 1。
两个问题：

1. 判据里是**单引号** `from '@pibuddy/contract'`，而本仓统一用双引号，
   该 grep 对**全仓所有文件**（含 TASK-007 的既有文件）都是 0。
2. 实测三个新文件的双引号命中数：

```
secret-store.ts              1  ✓
endpoints.ts                 0
net/outbound-guard.ts        0
```

`secret-store.ts` 的那 1 次是**真实收敛**：我把它原本自己声明的
`interface SecretDescription {configured, last4}` 删掉，改 import 契约包的
`SecretDescriptor` —— 那个形状要跨 IPC 送到渲染进程，本来就该归契约包。

`endpoints.ts` 与 `outbound-guard.ts` 没有任何跨进程形状要共享：前者的
`EndpointRecord` 只存在于主进程磁盘上，后者是纯网络原语。**为了让 grep 命中而
加一个用不到的 import，正是「用抑制机制掩盖」而不是解决问题**，所以我没有加。
`node scripts/check-contract-uniqueness.mjs` 本体 EXIT 0。

### 偏差 4（**未验证，不是通过**）：c[16](a) 语音转写成功一段没有取到证据

本机没有可用的 STT 凭据：`api.openai.com` 从这台机器不可达（裸 `fetch` 3.1 秒后
`TypeError: fetch failed`），且改造前 `sttApiKeyConfigured` 本就是 false（说明语音
输入在本机从未被配置过）。

真机上**已经跑通**的部分（点真实麦克风按钮，非模拟）：

```
点击 → {"before":"🎤 语音","during":"🔴 说完了，点我"}      ← 闸门放行 + getUserMedia 成功
点「说完了」 → "语音转写失败（HTTP 404）"                    ← 真实音频送出并拿回真实 HTTP 状态
伪造 endpointId → "ENDPOINT_NOT_FOUND: 端点不存在…"
```

即：真实 `MediaRecorder` 音频 → `stt.transcribe({endpointId, audio, mimeType})` →
主进程按 id 查地址、解出 safeStorage 里的密钥 → `safeFetch` 发出真实 TLS 请求 →
content-type 校验通过 → 拿回真实状态码 → 可读错误回显到界面。用的替身端点是
`https://registry.npmmirror.com`（一个可达的公网 JSON 服务），返回 404 是因为它
本来就不是转写服务。

**没有证明的是「一段真实语音变成文字填进输入框」**（`editorLen` 为 0，因为 404）。
拿到可用 STT 凭据后必须补验这一条。

### 偏差 5（字段命名）：`schemaVersion` 而非 `settingsSchemaVersion`

`files[]` 里 contract 那条写的是新增 `settingsSchemaVersion`，但 c[12] 的机器判据写的是
「`loadSettings()` 返回对象的 **schemaVersion** === SETTINGS_SCHEMA_VERSION」。
两者冲突，我按**收敛判据**取 `schemaVersion`。

### 偏差 6（常量归属）：`SETTINGS_SCHEMA_VERSION` 定义在 main/settings.ts 而非契约包

c[10] 要求 `packages/app/src/main/settings.ts` 字面含 `SETTINGS_SCHEMA_VERSION = 1`。
如果常量定义在契约包、settings.ts 只 import，这行字面量就不存在；如果两边都
`export`，`check-contract-uniqueness.mjs` 的 A 项（名字碰撞）会直接失败。
因此常量由 `main/settings.ts` 持有（迁移逻辑也在那里，归属合理），契约包的
`appSettingsSchema` 用 `.default(1)` 字面量并在注释里指明两处需同改。
**我没有用「在注释里写一行让 grep 命中」的方式糊弄。**

## 五、Notes for next tasks

- **TASK-014 必须复用 `safeFetch`**：`testProvider` / `discoverModels` 两条新出站路径
  不得另立第二套判定，尤其不得为了支持本地模型而放行 localhost。
  `packages/app/src/main` 下 `fetch(` 命中数为 0 这条断言现在是真的，别把它弄假。
- **TASK-014 的 auth.json 是 CT-24 明确的例外**：pi 运行时自己要读它，不纳入
  「不明文落盘」范围，走 0o600 + 原子写 + 写前备份。`secret-store.ts` 的头注释里
  已写明这条边界。
- **`~/.pi` 的 provider 凭据不归 secret-store 管**，不要顺手把它塞进来。
- 新增 channel 一律经 `registerHandler`；`ipcMain.handle` 仍然只允许出现在 `ipc-guard.ts`。
- 端点注册表目前只被 STT 用到，`EndpointKind` 已经预留了 `"provider"`，
  TASK-014 加 provider 端点时直接复用 `registerEndpoint`，别新建第二张表。
- **DNS rebinding 第二跳未闭合**（记在 `doc/threat-model.md` 第 5 节）：
  彻底封死要用自定义 lookup 把已校验 IP 钉给连接层，是后续改进方向。

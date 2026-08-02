# TASK-008 密钥与出站人工回归记录

- 日期：2026-08-02
- 形态：`npx electron packages/app --remote-debugging-port=9222`（electron-vite build 产物，非 dev server）
- 工作目录：`D:\pi\test`；模型 `gpt-5.6-sol`（openai），thinkingLevel `max`，运行时 bundled
- userData：`C:\Users\yehh\AppData\Roaming\@pibuddy\app`
- 取证方式：`node scripts/cdp-eval.mjs "<表达式>"` 直连渲染进程调试端口读真实 DOM 与真实 IPC 返回；
  磁盘证据用 `cat` / `grep` 直接读 userData 下的真实文件。下面每条附的都是脚本原样输出。

---

## 一、接口面：密钥不再回传渲染进程

- [x] `window.piBuddy.settings` 上有 `setSecret` / `describeSecret`，**没有**任何 getSecret

```
{"hasApi":"object","settingsKeys":["describeSecret","get","set","setSecret"],"sttKeys":["transcribe"]}
```

- [x] `await window.piBuddy.settings.get()` 的返回对象不含任何完整密钥字段

```
{"schemaVersion":1,"workspace":"D:\\pi\\test","provider":"openai","modelId":"gpt-5.6-sol",
 "thinkingLevel":"max","sttApiKeyConfigured":false,"sttApiKeyLast4":"",
 "piRuntimeMode":"bundled","piExternalCommand":"D:/definitely-missing/pi-not-here.exe"}
```

- [x] 写入一把真实密钥后，IPC 返回的只有 `{configured, last4}`，`settings.get()` 里查不到明文

```
{"setSecret":{"configured":true,"last4":"7788"},
 "describe":{"configured":true,"last4":"7788"},
 "settingsHasPlaintext":false,
 "settingsKeys":["modelId","piExternalCommand","piRuntimeMode","provider","schemaVersion",
                 "sttApiKeyConfigured","sttApiKeyLast4","thinkingLevel","workspace"]}
```

## 二、磁盘：明文不落盘（真实 safeStorage / Windows DPAPI）

写入的明文是 `sk-live-PROBE-7788`。

- [x] `secrets.json` 里是密文，`grep` 明文命中 0

```
$ cat secrets.json
{
  "version": 1,
  "secrets": {
    "stt.apiKey": "djEwTLSiljqtm3pqSSDDCwpsqltjhShQRsqdJ2kZsTzsii5j7eOpTv1SoJr6n8LxkQ=="
  }
}

$ grep -c 'sk-live-PROBE-7788' secrets.json
0
```

- [x] `settings.json` 里只有配置态与尾四位

```
"sttApiKeyConfigured": true,
"sttApiKeyLast4": "7788",
```

## 三、[UI-observable] 重启后界面显示「已配置 ····尾四位」而非明文

刷新渲染进程（store 重新 boot）后打开设置：

- [x] 提示行恰好出现一次，密码框 value 为空，弹窗全文不含明文

```
{"settingsFromIpc":{"configured":true,"last4":"7788","baseUrl":"https://registry.npmmirror.com/"},
 "hintLine":"已配置 ····7788（留空则不改动）",
 "passwordFieldValue":"",
 "plaintextAnywhereInModal":false}
```

## 四、[UI-observable] 端点保存的拒绝路径

以下三条是**点真实「保存」按钮**、读真实 `.n-alert` 文案得到的。

- [x] (b) 填 `https://169.254.169.254/v1` 保存被拒，文案 contains「内网」与 `OUTBOUND_BLOCKED`

```
保存被拒绝
Error invoking remote method 'settings:set': OutboundBlockedError:
OUTBOUND_BLOCKED: 不允许访问内网 / 环回 / 元数据地址（169.254.169.254）
```

- [x] (c) 填 `http://api.example.com/v1` 保存被拒，文案 contains「HTTPS」

```
保存被拒绝
Error invoking remote method 'settings:set': OutboundBlockedError:
OUTBOUND_BLOCKED: 只允许 HTTPS 端点，请把地址改成 https:// 开头
```

- [x] (d) 两次拒绝后重新读 `settings.json`，其中不含这两个 URL（拒绝不半落盘）

```
$ grep -E '169\.254\.169\.254|api\.example\.com' settings.json
（无输出）→ 0 命中
$ ls endpoints.json
不存在（被拒的端点一条都没登记）
```

另外经 IPC 直接压测的四类输入，全部在 `settings:set` 落盘前被拒：

```
{"metadata": "OUTBOUND_BLOCKED: 不允许访问内网 / 环回 / 元数据地址（169.254.169.254）",
 "plainHttp":"OUTBOUND_BLOCKED: 只允许 HTTPS 端点，请把地址改成 https:// 开头",
 "localhost": "OUTBOUND_BLOCKED: 不允许访问内网 / 环回 / 元数据地址（localhost）",
 "decimalIp": "OUTBOUND_BLOCKED: 不允许访问内网 / 环回 / 元数据地址（127.0.0.1）",
 "afterSettings": {}}
```

`https://2130706433/v1` 被折成 `127.0.0.1` 后拒绝 —— 数字形态 IP 归一化在真机上生效。

## 五、[UI-observable] (a) 语音链路 —— **部分验证，转写成功一段未取到证据**

真机上走完的部分（点真实麦克风按钮，非模拟）：

- [x] 配置态闸门放行（`sttApiKeyConfigured && sttEndpointId`），按钮进入录音态

```
{"before":"🎤 语音","during":"🔴 说完了，点我","disabled":false}
```

- [x] 点「说完了」→ 真实 `MediaRecorder` 音频经 `stt.transcribe({endpointId, audio, mimeType})`
      送进主进程 → 主进程按 endpointId 查地址、按槽位解出 safeStorage 里的密钥 →
      `safeFetch` 发出真实 TLS 请求 → 拿回真实 HTTP 状态并把可读错误显示到界面

```
{"messages":["…","Error invoking remote method 'stt:transcribe': Error: 语音转写失败（HTTP 404）"],
 "editorLen":0,"btn":"🎤 语音"}
```

- [x] 伪造 endpointId 被拒

```
"forged": "ENDPOINT_NOT_FOUND: 端点不存在，请到「设置」里重新保存"
```

### ⚠️ 未验证项（如实记录，不得当成通过）

**「录音后 ChatView 输入框 value 长度 > 0」这一条没有取到证据。**

原因：本机没有可用的 STT 端点凭据 —— `api.openai.com` 从这台机器**不可达**
（裸 `fetch` 3.1 秒后 `TypeError: fetch failed`），且 secret-store 里本来就没有
任何 STT 密钥（改造前 `sttApiKeyConfigured` 为 false，即语音输入在本机从未被
配置过）。因此上面用 `https://registry.npmmirror.com`（一个可达的公网 JSON 服务）
顶替端点，把整条链路跑到了「真实 TLS 请求发出并拿回响应」为止，返回 404 是
因为它本来就不是转写服务。

这证明了 endpointId → 地址解析 → 密钥解密 → safeFetch → content-type 校验 →
错误回显整条链路在真机上通畅，但**没有**证明「一段真实语音能变成文字填进输入框」。
拿到可用的 STT 凭据后需要补验这一条。

## 六、未回归的既有功能（抽验，确认无回归）

- [x] 内置 pi 运行时正常启动（语音按钮的 `:disabled="!store.started"` 为 false 即已启动）
- [x] 流式文本对话正常

```
{"promptOk":true}
$ pi.getMessages()
{"count":2,"tail":[{"role":"user","text":"[{\"type\":\"text\",\"text\":\"只回复两个字：收到\"}]"},
                   {"role":"assistant","text":"[{\"type\":\"text\",\"text\":\"收到\",…"}]}
```

## 七、收尾

探针数据已清理，磁盘回到干净状态，无残留 `.tmp`：

```
$ cat settings.json | grep stt
  "sttBaseUrl": "",
  "sttApiKeyConfigured": false,
  "sttApiKeyLast4": "",
  "sttModel": "",
$ cat secrets.json
{ "version": 1, "secrets": {} }
$ ls *.tmp
无残留 tmp
```

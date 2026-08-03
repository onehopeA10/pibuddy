# FIX：trust 竞态 / 预览输出上限 / artifact latestOnly / 诊断包内存

基线 HEAD `299301d`。四条缺陷全部先核实、后修复，每条都配了**可证伪**的回归测试并做了对拍（临时拆掉修复跑一遍确认变红），最后在打包产物上做了真机验证。

## 1（P2）workspace trust 的过期响应会把信任决定写给另一个项目

### 核实

- `AppShell.vue:130-136` 在 `store.workspaceId` 上 watch，每次切换发一次 `piRes.describeTrust(id)`；
- 修复前的 `stores/piResources.ts` 里 `describeTrust` **无任何校验**地写全局态：`trustState.value = state`；
- `ProjectTrustDialog.vue` 提交时用的是 `store.workspaceId`（**当前**工作目录），而弹窗里列的资源来自 `piRes.trust`（**最后一个回来的响应**）。

两者会真的分开：A 的目录在网络盘上，它的 `describe` 响应晚于切到 B —— 弹窗里是 A 的资源清单，提交却写给 B。勾了「记住」时这条决定会进 `~/.pi/agent/trust.json`，那是与终端 pi 共享的文件。

### 修法

`packages/app/src/renderer/src/stores/piResources.ts`：

- 加 `trustSeq` / `scanSeq` 两个代际计数器，口径照 `main/pi-supervisor.ts` 的 runtime generation：发起时取一个代际，回来时比一次，不是当前代际就整个丢弃（`describeTrust` / `decideTrust` / `refresh` / `setEnabled` 四处）；
- 除代际外再比一次 `state.workspaceId === workspaceId`（主进程的 `trust-store.describeTrust` 会把入参原样回填）；
- `decideTrust` **提交前再校验一次**：`trustState.value.workspaceId` 与入参不一致直接拒，`decideSpy` 一次都不发，并写一句可读的 `lastError`；
- 新增 `applyTrust()`：只有 `scan.value.trust.workspaceId` 与本次一致时才就地更新 scan，避免 B 的扫描结果配上 A 的 trust。

`packages/app/src/renderer/src/components/ProjectTrustDialog.vue`：提交目标改为 `trust.workspaceId`（**用户实际看到的那份数据**）而不是 `store.workspaceId`；`store.start()` 只在决定确实落地且该项目仍是当前工作目录时才调。

未改 `trust-store.ts`：它已经通过 `toPiWireFormat()` 只写 `true|false`，符合 pi `readTrustFile` 的严格校验（写别的形状会让用户在终端里所有项目的信任决定一起失效）。真机上复核了 `trust.json` 仍是合法形状，见下。

### 回归测试

`packages/app/src/renderer/src/stores/pi-resources-store.test.ts`（+4）——时序**真的做出来**，用 deferred promise 让 A 的响应在 B 之后才兑现，不是靠 `await` 把并发串行化：

```
✓ A 的响应晚于切到 B 时被丢弃，trust 态仍然是 B 的
✓ 弹窗里显示的是 B 时，拿 A 的 id 提交会被拒，绝不落到 trust.json
✓ 给当前显示的那个项目提交则照常放行
✓ 晚到的 scan 结果不会把当前项目的资源列表与 trust 一起冲掉
```

`packages/app/src/renderer/src/components/project-trust-dialog.test.ts`（新建，+2）：挂载真组件、点页脚按钮，断言 `decideSpy` 收到的是**弹窗显示的** `ws-A` 而不是当前的 `ws-B`。

### 对拍

把 `piResources.ts` 还原成 HEAD 版本：

```
$ git show HEAD:...stores/piResources.ts > ...  && npx vitest run .../pi-resources-store.test.ts
× A 的响应晚于切到 B 时被丢弃，trust 态仍然是 B 的
  → expected { workspaceId: 'ws-A', …(7) } to be null
× 弹窗里显示的是 B 时，拿 A 的 id 提交会被拒，绝不落到 trust.json
  → expected { workspaceId: 'ws-1', …(7) } to be null        ← 旧代码真的把决定发给了 ws-A
× 晚到的 scan 结果不会把当前项目的资源列表与 trust 一起冲掉
  → expected 'ws-A' to be 'ws-B'
Tests  3 failed | 5 passed (8)
```

恢复后：`Tests 8 passed (8)`。

把 `ProjectTrustDialog.vue` 单独还原成 HEAD 版本（store 修复保留）：

```
× ProjectTrustDialog > 提交给弹窗里显示的那个项目，而不是当前工作目录
  → expected "spy" to be called 1 times, but got 0 times
Tests  1 failed | 1 passed (2)
```

## 2（P3）预览输出上限只统计 text

### 核实

`main/preview/convert-host.ts` 修复前只有一行：`Buffer.byteLength(result.text, "utf8") > maxOutputBytes`。而 `PreviewResult` 还有 `tables` / `dataUrl` / `notices` 三处 —— 一个宽表或多工作表的 xlsx 可以做到 `text` 为空、`tables` 里躺着几百兆字符串，这个闸门一个字节都数不到。结果要跨两次 structured-clone（worker → main、main → 渲染进程），主进程在克隆期间完全卡住。

### 修法

`convert-host.ts` 新增 `checkOutputLimits(result)`（纯函数，可单测），量的是**整份结果**：

| 上限 | 取值 | 拦的是 |
|---|---|---|
| `maxTables` | 256 | 工作表 / 分片数 |
| `maxTableColumns` | 4096 | 单表列数 |
| `maxTableCellChars` | 8,000,000 | 全部单元格字符总数 |
| `maxOutputBytes` | 100MB（不变） | text + suggestion + notices + **tables** + **dataUrl** 的 UTF-8 总量 |

- 判据仍在**宿主侧**（worker 正在解析攻击者的字节，它自己的上限不可信）；
- 超限**不静默截断**，返回 `too-large` + 一句能据以行动的话（工作表太多 / 列太多 / 内容太多分别给不同的下一步）；
- `ConvertOutcome` 加可选 `suggestion`（`preview-types.ts`，进程内私有协议，不动契约包），`preview-ipc.ts` 的 `flatten()` 优先用它、否则回落到 `SUGGESTION[code]`；
- `maxOutputBytes` 数值不动：50MB 图片的 base64 dataUrl 约 67MB，收紧会把大图预览打死。

### 回归测试

`packages/app/src/main/preview/convert-host.test.ts`（+6）：正常结果放行 / 工作表数超限 / 列数超限 / 单元格字符总数超限（`text` 为空也拦得住）/ dataUrl 计入总量 / `convert()` 端到端返回 `too-large` 且带具体提示。

### 对拍

把 `checkOutputLimits` 换成旧口径（只数 `text`），签名不变：

```
× 工作表数超限 → too-large，提示里说清是工作表太多       → expected undefined to be 'too-large'
× 列数超限 → too-large，提示里说清是列太多               → expected undefined to be 'too-large'
× 单元格字符总数超限 → too-large（text 为空也照样拦得住） → expected undefined to be 'too-large'
× dataUrl 也计入总量（图片走的就是这一条）               → expected undefined to be 'too-large'
× 超限时 convert() 返回 too-large，并带上那句更具体的提示 → expected true to be false
Tests  5 failed | 11 passed (16)
```

恢复后 `packages/app/src/main/preview/` 全目录 `Tests 57 passed (57)`。

## 3（P3）Artifact 的 latestOnly 可能返回旧版本

### 核实

`main/artifacts/artifact-store.ts` 的 `query()` 先 `ORDER BY updated_at DESC, version DESC`，再按 `logicalKey` **取第一条**去重。而 `rename()` 只改 name + updated_at、`setStatus()` 只改 status + updated_at —— 两者都不动 version。对 v1 做任意一个动作，v1 的 updated_at 就越过 v2，列表里显示的是 v1，磁盘上躺着的是 v2 的内容。

### 修法

去重改成**按每个 `logicalKey` 的 MAX(version) 选取**。在 JS 里做而不是塞进 SQL 子查询：MAX(version) 必须与上面那串 where（trashed / kind / status / sessionId / query）用同一套过滤条件才正确 —— v2 进了回收站时，非回收站视图里的「最新一版」是 v1。子查询要重复这些条件，重复就会漂移。用 `filter` 而不是直接取 map 的值，外层的 updated_at 排序原样保留。

### 回归测试

`packages/app/src/main/artifacts/artifact-store.test.ts`（+3）——数据是**真的把 updated_at 与 version 的顺序做反**（用 `now` 参数把 v1 的 updated_at 顶到 9000、v2 是 2000）：

```
✓ 给旧版本改名（updated_at 越过新版本）之后，列表里仍然是新版本
✓ 把旧版本从回收站恢复之后，列表里仍然是新版本
✓ 最新一版进了回收站时，非回收站视图里的「最新」是仍然可见的那一版
```

第三条在新旧实现下都绿——它挡的是「改成 SQL 子查询」这条错路，不是本次缺陷的判据，如实记在这里。

### 对拍

还原去重逻辑为 `seen` 集合：

```
× 给旧版本改名（updated_at 越过新版本）之后，列表里仍然是新版本 → expected 1 to be 2
× 把旧版本从回收站恢复之后，列表里仍然是新版本                 → expected [ 1 ] to deeply equal [ 2 ]
Tests  2 failed | 14 passed (16)
```

恢复后 `Tests 16 passed (16)`。

## 4（P3）诊断包可因 crash dump 过大而耗尽主进程内存

### 核实

`main/diagnostics/support-bundle.ts` 的 `plan()` 对 crash dump **不限数量、不限大小、不限总量**；`exportBundle()` 对每个二进制条目 `fs.readFileSync(entry.source)` 整份读进内存，最后 `buildZip()` 再 `Buffer.concat` 一次 —— 峰值内存 = 所有条目之和 ×2。用户点「导出诊断包」时程序多半已经出过问题，这个按钮能把它再打崩一次。

### 修法

**总量上限**（写进 `plan()`，因此 preview 与 export 天然一致）：

| 常量 | 取值 |
|---|---|
| `MAX_BUNDLE_TOTAL_BYTES` | 512MB |
| `MAX_CRASH_DUMPS_IN_BUNDLE` | 3（按 mtime 取最近的） |
| `MAX_CRASH_DUMP_BYTES` | 256MB |

被挡下的每一条都记进新增的 `omitted.txt` 条目并说明原因 —— 悄悄少收几个文件，排查的人会以为「崩的时候本来就没留转储」。

**流式写 ZIP**：`buildZip()` 换成 `ZipStreamWriter`，边算边往 fd 里写。常驻内存只剩中央目录（每条约 46 字节 + 文件名）与一个 1MB 复制缓冲。STORE（不压缩）保持不变——单测能直接在字节流里搜预置的假密钥，这条断言才有意义。

细节：STORE 的本地头要求 crc 与长度写在数据**前面**，所以二进制条目分两遍——第一遍分块过一遍算 crc32 与真实长度（`zlib.crc32(chunk, seed)` 累加，回落表也加了 seed 参数），第二遍照这个长度流式复制，写出字节数被钉死（短了补零、长了截断），文件在两遍之间被改动时产出的仍是合法 zip。

文本条目仍整份 `redactText`：脱敏不能分块喂，密钥正好横跨两个分块时会漏。这些条目本身已有上限（日志取尾部 1MB）。

**未引入新依赖**：`check-pure-js-deps.mjs` 的闸门下自己写流式写入器，jszip 只在**测试**里用来反过来校验产物。`node packages/app/scripts/check-pure-js-deps.mjs` → `OK（扫描 83 个包，无原生扩展；npmRebuild: false 成立）`。

### 回归测试

`packages/app/src/main/diagnostics/support-bundle.test.ts`（+4）：

```
✓ 最多只收 MAX_CRASH_DUMPS_IN_BUNDLE 个转储，其余在 omitted.txt 里如实列出
✓ 单个转储超过 MAX_CRASH_DUMP_BYTES 时被挡下，并说明原因
✓ 导出**不整份读**二进制转储（读进内存正是这个缺陷本身）   ← spy 住 fs.readFileSync，断言从没拿转储路径调用过
✓ 流式写出的 zip 是合法归档：jszip 能逐条解出来且 CRC 校验通过（loadAsync(..., {checkCRC32:true})）
```

### 对拍

去掉三条上限 + 把二进制分支换回 `readFileSync`：

```
× 最多只收 MAX_CRASH_DUMPS_IN_BUNDLE 个转储…  → expected [ …(5) ] to have a length of 3 but got 5
× 单个转储超过 MAX_CRASH_DUMP_BYTES 时被挡下… → expected [...] to not include 'crash-dumps/huge.dmp'
× 导出**不整份读**二进制转储                   → expected [ …(4) ] to not include '…\pibuddy-…\big.dmp'
Tests  3 failed | 5 passed (8)
```

恢复后 `Tests 8 passed (8)`。

## 全量闸门

```
$ pnpm typecheck
packages/pi-sdk typecheck: Done
packages/contract typecheck: Done
packages/app typecheck: Done

$ pnpm -w test
Test Files  95 passed (95)
     Tests  856 passed (856)          ← 新增 19 条（trust 4 + 弹窗 2 + 预览 6 + artifact 3 + 诊断 4）

$ pnpm build            ✓ built（main 28.63s / preload 304ms / renderer 15.37s）
$ node packages/app/scripts/check-pure-js-deps.mjs
check-pure-js-deps: OK（扫描 83 个包，无原生扩展；npmRebuild: false 成立）

$ pnpm --filter @pibuddy/app dist
• building  target=nsis file=release\PiBuddy-Setup-0.1.0.exe archs=x64
• building block map  blockMapFile=release\PiBuddy-Setup-0.1.0.exe.blockmap
```

`pnpm dist` 第一次因 `prepare-pi-runtime` 报「复制后入口缺失」而失败，原因是 `resources/pi-runtime` 里有上一次运行留下的**残缺目录树**，脚本自己的 `rmSync(force:true)` 在 Windows 上没能真正删掉（`rm -rf` 也报 "Directory not empty"，`Remove-Item -Recurse -Force` 才成功）。清干净后一次通过。与本次改动无关，但记在这里：这个脚本在 Windows 上对残留目录不设防。

## 真机验证

`release/win-unpacked/PiBuddy.exe --remote-debugging-port=…`，证据经 `scripts/cdp-eval.mjs` 从真实 DOM / 真实 IPC 取得。

**启动与 preload 完整**（preload 静默失败会表现为全白界面）：

```json
{"title":"PiBuddy · AI 办公小助手","mounted":true,
 "hasPiBuddyApi":["artifacts","diagnostics","dialog","file","pi","piResources",
                  "preview","providers","sessions","settings","shell","stt","update","workspace"],
 "errors":0}
```

**缺陷 2 —— 真的用一个 5000 列的 CSV 撞上限**（临时文件建在 `D:\pi\test\.pibuddy-verify-tmp\`，验证后已删）：

```json
{"wide":{"code":"too-large",
         "suggestion":"这张表有 5000 列，超过预览上限 4096 列。请用 Excel 这类程序直接打开，或者先删掉用不到的列再预览。",
         "tables":0},
 "narrow":{"code":"ok","cols":3,"firstRow":["姓名","部门","金额"]}}
```

图片预览（dataUrl 这条新计入总量的路径）未受影响：

```json
{"image":{"kind":"image","code":"ok","dataUrlPrefix":"data:image/png;base64,","dataUrlLen":118}}
```

**缺陷 3 —— 拿真实产物库交叉验证**（10 条记录、6 条版本链，其中 `agent-产物.md` 有 4 版）：

```json
{"allCount":10,"latestCount":6,"everyLatestIsMaxVersion":true,
 "sample":[{"key":"agent-产物.md","v":4,"max":4},{"key":"周报.md","v":2,"max":2}, …]}
```

**缺陷 1 —— 主进程回的 trust 态自带 workspaceId**（渲染侧那道校验的前提）：

```json
{"trust":{"echoedWorkspaceId":"9b7497499cae1f644a743fece40f0021","matches":true,
          "needsPrompt":false,"effective":"allow","resources":2}}
```

`~/.pi/agent/trust.json` 复核（只读，未写入）——3 条记录，**pi 的 `readTrustFile` 会拒绝的条目 0 条**，仍是 `{"<dir>": true}` 的合法形状：

```
{
  "C:\\Users\\yehh\\Documents\\土狗": true,
  "D:\\pi\\test": true,
  "D:\\selftool\\pi-maestro-flow": true
}
```

**缺陷 4 —— 诊断包清单**（当前机器 crashDumpConsent 未同意，因此清单里没有 crash-dumps，符合预期）：

```json
{"bundle":{"entries":4,"paths":["system-info.json","logs/pibuddy-20260803.log",
                                "settings.json","update-state/last-known-good.json"]}}
```

收尾：验证用的临时目录 `.pibuddy-verify-tmp/`（narrow.csv / tiny.png / wide.csv，全部由本次验证创建）已删除，未碰用户的任何既有文件；`Stop-Process -Force` 后 `PiBuddy.exe` 进程数归 **0**。

## 并行边界

只改了 `stores/piResources.ts`、`ProjectTrustDialog.vue`、`main/preview/**`、`main/artifacts/**`、`main/diagnostics/**`。`main/update/**`、`main/lifecycle/**`、`.github/workflows/**`、`docs/product/RELEASE_SETUP.md`、`stores/update.ts` 一行未动。`contract/**`、`ipc-registry.ts`、`preload/api/*` 一行未动（本次没有新增通道，`ConvertOutcome` 的 `suggestion` 是主进程内部类型）。`git add` 按路径逐个指定，提交前用 `git status` 核对过暂存清单。

## 偏离与遗留

1. `AppShell.vue` 最终**没有改**。缺陷描述里把它列为修改点，但代际校验放在 store 里更靠近状态本身：AppShell 只是发起方，把校验写在它那儿的话，任何别的调用点（PiResourcesPanel 等）都会绕过。判据不变，位置不同，如实记录。
2. `maxOutputBytes` 维持 100MB 未收紧。50MB 图片的 base64 约 67MB，收紧会打死大图预览——这条属于「必须保护的现有功能」。真正堵住宽表膨胀的是新增的三条形状上限。
3. 真机验证期间与另一个 agent 的 `pnpm dist` / 真机启动**发生过三次冲突**：对方的 electron-builder 重新解压 electron，把我正在验证的 `win-unpacked/PiBuddy.exe` 清掉；对方的 `Stop-Process` 也两次杀掉了我带调试端口的实例。等对方进程退出后重跑取得全部证据。共享工作树 + 共享 `release/` 目录下，两个 agent 同时做真机验证是会互相踩的。

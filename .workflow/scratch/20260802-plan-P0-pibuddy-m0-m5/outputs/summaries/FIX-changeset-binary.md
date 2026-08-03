# FIX-changeset-binary：二进制 changeset 被 UTF-8 转码损坏（P1）

## 1. 缺陷核实

审计结论属实，且**比描述的更早发生**。转码点有四处，串成一条链：

| # | 位置 | 原代码 | 后果 |
|---|------|--------|------|
| 1 | `tool-watch.ts` `readOrNull()` | `fs.readFileSync(abs, "utf8")` | before 快照在解码那一刻就丢字节 |
| 2 | `changeset-store.ts` `record()` | `readFileSync(p,"utf8")` + `writeFileAtomic(p, beforeContent)` | **把坏掉的 before 写回磁盘** |
| 3 | `apply.ts` `acceptChange()` | `writeFileAtomic(abs, nextText)` / 备份同样是字符串 | 接受与备份都写失真字节 |
| 4 | `changeset-store.ts` `sha256Text()` | 对解码后的字符串取 hash | 二进制条目恒被误判 conflict |

**关键发现（决定了修复方向）**：最致命的不是「接受」，是 #2 的**还原**。
`record()` 为了让「拒绝」有意义，会在登记时就把磁盘改回 before。这一步无条件
执行，因此用户**还没打开审阅面板，文件就已经坏了** —— 这正是审计所说「登记、
接受、甚至拒绝都会留下失真字节」的机制。拒绝本身确实不写盘（`rejectChange`
只翻转状态），它「留下失真字节」是因为损坏在登记阶段就完成了。

DB 侧同源：`before_content TEXT / after_content TEXT`，正文以文本存储。

## 2. 方向选择：Buffer 全链路（而非「识别二进制并禁止入流程」）

选 Buffer。理由是后一种方案对 #2 无解：

- 若识别到二进制就**跳过还原** → 工具的写入留在磁盘上且再也回不去，
  等于拿「损坏」换「原文件永久丢失」，更糟；
- 若识别到二进制就**拒绝登记** → 这次写入完全绕过审阅面板，而
  `tool-watch` 的特征匹配设计（不用白名单）存在的唯一目的就是防止
  「没人看见的写入」。

因此保真必须由 Buffer 承担。二进制识别保留，但只负责**降级视图**：
不逐行 diff、不许逐 hunk 接受，整体保留 / 整体还原照常可用 —— 即审计
建议的界面语义，只是由已有的 `binary` 标记 + `diffOf` 的 `degraded`
字段承载，**未改 contract**（避免与并行 agent 冲突）。

## 3. 改动

仅 5 个文件，全在 `main/changeset/**`：

- `tool-watch.ts` — 快照读字节；判等用 `Buffer.equals()`（字符串比较下两份
  不同的坏字节会塌成同一串 U+FFFD，真实改动被误判为「没变」）
- `changeset-store.ts` — 新增 `sha256Bytes()` / `looksBinary()`；
  `record()` 全字节；`ChangesetRecord.beforeBytes/afterBytes: Buffer`
  （**改名**而非沿用 `*Content`，让任何遗漏的字符串路径变成编译错误）；
  DDL 正文列改 `BLOB`，`CHANGESET_SCHEMA_VERSION` 1 → 2
- `apply.ts` — `readDisk` / `composeAccepted` / 落盘 / **备份**全字节；
  新增「二进制或超大条目禁止逐 hunk 接受」守卫
- `apply.test.ts` / `tool-watch.test.ts`（新建）— 回归测试

两处顺带修掉的真实缺陷：

1. `binary` 原先只看 after。若 before 是二进制、after 是文本，条目会被判为
   可逐行审阅，然后拿一份 decode 坏了的 before 去算 diff —— 而逐 hunk 接受
   正是从 before 的行拼出落盘内容。现改为两侧任一为真即降级。
2. 二进制/超大条目的 `diffOf` 返回空 hunks，原 `composeAccepted` 会据此拼出
   一份「只剩 before」的内容当作用户的选择写下去（静默整文件回退）。已挡掉。

`looksBinary` 判据为「NUL 字节 ∪ 非合法 UTF-8」—— 只判 NUL 会漏掉无 NUL 的
非法序列（latin-1 正文、JPEG 的 0xFF 段）。合法性整份判（截断验会把尾部半个
多字节序列误判），但超过 `CHANGESET_DIFF_MAX_BYTES` 时跳过（那些内容本就走
降级视图，`tooLarge` 同样封掉逐 hunk），避免为不会渲染的 diff 解码整个文件。

### 迁移：老库不重写数据

先实测了 node:sqlite 的行为再决定：

```
$ node blobprobe.mjs        # 列声明为 TEXT 的旧表
a storage= blob js= Uint8Array bytes= 89504e47001afffec328eda08000
b storage= text js= String    bytes= 6f6e650a74776f0a
BLOB roundtrip lossless: true
```

SQLite 动态类型下 BLOB 存进 TEXT 亲和列仍按 BLOB 存储类保留原字节，**老库
无需 ALTER 就能接住新写入**；老行仍是 TEXT，由 `toBytes()` 按 utf8 读回。
那些行当年就是转码后写进去的，重写既补不回丢掉的字节又要搬整张表 —— 不做。

## 4. 对拍验证（把修复拆掉，确认测试真的变红）

测试内容为**真实二进制**：PNG magic + NUL + 4 类非法 UTF-8 序列
（`0xff 0xfe` 非法起始 / `0xc3 0x28` 截断双字节 / `0xed 0xa0 0x80` 代理区 /
`0xf0 0x9f 0x92` 截断四字节）。

两个测试文件各含一条**夹具自检**，断言
`Buffer.from(fixture.toString("utf8"),"utf8").equals(fixture) === false`。
夹具一旦退化成 ASCII，自检立刻变红 —— 防止整组测试悄悄变成恒真。

修复齐全时：`17 passed (17)`。逐层拆除后：

**A. 拆 `tool-watch` 快照**（`readFileSync(abs)` → utf8 往返）

```
× 快照与还原全程走字节：磁盘回到原样，入库的 before/after 也是原字节
  → expected false to be true
  tool-watch.test.ts:131  expect(fs.readFileSync(file).equals(original)).toBe(true)
Tests  1 failed | 2 passed (3)
```

**B. 拆 `record()` 还原**（`writeFileAtomic(p, beforeBytes.toString("utf8"))`）

```
× 二进制变更的字节保真 > 登记时还原磁盘 —— 写回去的是逐字节的原文件
× 二进制变更的字节保真 > 拒绝之后磁盘仍是逐字节的原文件
× 二进制变更的字节保真 > 接受把 after 的原字节写下去，备份是 before 的原字节
× 二进制变更的字节保真 > 二进制条目拒绝逐 hunk 接受，且一个字节都不写
Tests  4 failed | 10 passed (14)
```

其中「拒绝之后磁盘仍是原字节」变红，正面证实了审计「拒绝也会留下失真字节」
的判断，以及该断言确实咬住了这条路径。
**7 条既有文本用例在本轮全绿** —— 文本行为未受影响。

**C. 拆 `apply.ts` 落盘 + 备份**（两处 `.toString("utf8")`）

```
× 二进制变更的字节保真 > 接受把 after 的原字节写下去，备份是 before 的原字节
  → expected false to be true
Tests  1 failed | 13 passed (14)
```

**D. 拆逐 hunk 守卫**（`if (hunkIndexes && ... binary)` → `if (false)`）

```
× 二进制变更的字节保真 > 二进制条目拒绝逐 hunk 接受，且一个字节都不写
  → expected true to be false
Tests  1 failed | 13 passed (14)
```

四轮全部变红且定位精准（每轮只打中对应层），无恒真断言。
拆除标记全部清除后复跑：`Test Files 2 passed / Tests 17 passed (17)`。

## 5. 收尾门禁实跑

| 命令 | 结果 |
|------|------|
| `tsc --noEmit -p tsconfig.node.json`（含 `main/changeset/**`） | **0 error** |
| `pnpm typecheck` | 失败，但**全部错误在 `src/renderer/src/stores/`**（`app.ts` / `sessions.ts` / `chat-window.ts`）—— 并行 sessions agent 的在途改动，非本次范围 |
| `pnpm -w test` | `Test Files 3 failed \| 88 passed (91)` |
| `pnpm build` | 通过 |
| `pnpm --filter @pibuddy/app dist` | 通过（exit 0，产出 `PiBuddy-Setup-0.1.0.exe`） |
| 真机启动 `release/win-unpacked/PiBuddy.exe` | 见 §6 |

### 3 个失败测试文件不属于本次改动

`sessions-ipc.spec.ts` / `session-index.test.ts` / `input-bar.test.ts`。判据：

- 三者对 `changeset` / `tool-watch` 的引用数均为 **0**；
- `git status` 显示这三个 spec 文件**自身未被改动**，而它们所测的实现
  （`session-index.ts`、`sessions-ipc.ts`、`preload/api/sessions.ts`、
  `contract/session.ts`、`stores/app.ts`）全在并行 agent 的未提交改动里。

即：测试没动，被测实现被另一个 agent 改到一半。本次改动前后
`main/changeset/**` 的 17 条测试均全绿。

## 6. 真机启动验证

```
启动前 PiBuddy 进程数: 0
启动后 PiBuddy 进程数: 5
主窗口标题: PiBuddy · AI 办公小助手
40 秒后仍存活进程数: 5
杀进程后 PiBuddy 进程数: 0     # powershell Stop-Process -Name PiBuddy -Force
```

打包应用正常起窗并稳定存活 40 秒，无崩溃。按要求用
`powershell Stop-Process -Force` 收尾并核对进程数归 0（未用 `pkill -f electron`）。
全部验证在临时目录与打包产物上进行，**未触碰用户真实文件**；单测的工作区一律
`fs.mkdtempSync(os.tmpdir())`，`afterEach` 中先按正常入口关闭 sqlite 句柄
（`__setChangesetDataDir(null)` / `__setArtifactDataDir(null)`）再删除，
没有用 try/catch 盖住 Windows 的 EPERM。

## 7. 边界与纪律

- 改动仅 `main/changeset/**`（5 个文件）。未碰 `stores/app.ts`、`InputBar.vue`、
  `ChatView.vue`、`main/sessions/**`、`main/update/**`、`.github/workflows/**`、
  `AppShell.vue`、`stores/piResources.ts`、`main/preview|artifacts|diagnostics/**`。
- **未改 `packages/contract/`** —— 二进制降级复用已有的 `binary` /
  `degraded` 字段，无需扩契约，避免与并行任务抢同一文件。
- `main/fs-atomic.ts` 未改：`writeFileAtomic` 本就接受 `string | Uint8Array`。
- `ipcMain.handle` 调用点仍为 **0**（`changeset-ipc.ts` 未改，
  仍全部经 `ipc-guard.registerHandler`）。
- 提交按路径逐个 `git add`，**未使用 `-A` / `.`**；提交前核对暂存清单只含
  上述 5 个文件。
- 未修改 `source/`。

## 8. 遗留

- 代际 1 写入的老条目其正文已在当时被转码，字节不可恢复；新代际只保证**此后**
  的变更保真。
- 本仓当前有并行 agent 的在途改动导致 `pnpm typecheck`(web) 与 3 个 spec 变红，
  需由对应 owner 收敛；本次提交不含这些文件。

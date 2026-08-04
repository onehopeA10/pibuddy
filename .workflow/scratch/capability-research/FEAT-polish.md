# FEAT-polish：memory-v2 / mcp / tasks 三能力端到端与测试打磨

对三个「逻辑就绪但端到端待真实凭据/待接线」的已交付能力，逐条对照各自 summary 的
「未验证 / deferred / risks」清单：**真缺口补上、可注入替身钉死逻辑、接真实凭据的
形状测对**；无凭据仍无法真连的，如实保留「未验证」标注、不假装验证。

分支：`worktree-agent-af7221b02b326337f`（独立 worktree，只提交本分支，不 push origin/main）。
边界：只动 `main/memory/**`、`main/mcp/**`、`main/tasks/**` 及对应测试；未碰
connector / git / workflow / permission 既有逻辑 / agent-pool（只读判定、未改）。

---

## 1. 交付物（按路径）

**修改（本域独占，surgical）**

```
packages/app/src/main/mcp/mcp-client.ts       + planSpawn / resolveWindowsExecutable / escapeCmdArg
                                                （Windows .cmd shim 修复，见 §2）
packages/app/src/main/memory/memory-extract.ts + export defaultExtractor（仅加 export 关键字，供边界测试）
```

**新增（全部本域测试）**

```
packages/app/test/mcp-client-win.spec.ts       5 条：planSpawn 形态 + 真机 .cmd 握手 + 注入不逃逸
packages/app/test/memory-embed.spec.ts        12 条：Provider 嵌入契约（请求/响应形状 + 错误码 + 三态切换）
packages/app/test/memory-extract.spec.ts       9 条：默认启发式边界 + 落库不变量（ADR 红线）
packages/app/test/tasks-trigger.spec.ts        4 条：AgentRunTrigger 契约（产出如实落 run 记录）
packages/app/test/tasks-schedule-extra.spec.ts 11 条：sleep/wake 前跳 + weekly/cron gap + catch-up 封顶
```

**未新增任何运行时依赖**；未改契约 / manifest / channels / ipc（无 drift 影响）。

---

## 2. mcp：Windows `.cmd`（npx）在 `shell:false` 下不可 spawn —— 修

FEAT-mcp.md §5 risks 3 记的坑：`spawn(shell:false)` 底层是 CreateProcess，只能跑 PE
可执行，**不能**直接执行 `.cmd`/`.bat` 批处理；而 MCP 生态最常见的 `npx`（`pnpm dlx`
同理）在 Windows 上正是 `npx.cmd` 这类 shim —— 于是 `spawn("npx",…,{shell:false})`
直接 ENOENT。

**修复而不放宽安全边界**（`planSpawn`）：
- 命令按 PATH + PATHEXT 解析成一个具体存在的文件（`resolveWindowsExecutable`）；
- 解析到 PE（`.exe`/`.com`）→ spawn 该绝对路径，shell 仍 false；
- 解析到 `.cmd`/`.bat` → 经 `cmd.exe /d /s /c` 执行，但用 `escapeCmdArg` 把每个用户
  参数按 CreateProcess 引号规则 + cmd 元字符双重 `^` 转义，配合
  `windowsVerbatimArguments`（Node 不再二次加引号）—— 参数里的 `;` `|` `&` `()`
  全部保持字面量，**不重新获得 shell 注入能力**（cross-spawn 多年验证的做法）；
- 非 Windows / 解析不到 → 原样返回（行为不变，保留「不存在的命令→失败」）。

`connectStdio` 处只多解析一次 spawn 形态并传 `windowsVerbatimArguments`；`shell:false`
一字未动。

**http / OAuth 传输仍 deferred（如实）**：FEAT-mcp.md §5 risks 1/2 的根因是两条现实
约束叠加——safeFetch（SEC-004）阻断全部私网/环回而本地 MCP 常在 `http://localhost`；
且任意远程主机无法用 `network:<domain>` 表达（`network:*` 被契约拒）。硬做 http 连接
测试要么改 SEC-004 安全策略、要么加对不上的 network 权限（撞 drift 反向对账）——两者都
超出本域干净边界、属 PermissionEngine 落地后的事。当前 http 服务器可枚举/可编辑、连接
测试回明确的「未实现」诊断，OAuth 仅从配置读「是否需要」并展示。**不为「打磨完」而
放宽安全边界或伪造实现。**

---

## 3. memory-v2：Provider 嵌入契约 + 抽取边界

**Provider 嵌入的 fake/real 切换 + 契约测**（FEAT-memory-v2.md §5「未真机验证的两环」
之一）：本环境无 embedding 凭据、无法真连 OpenAI。用 vi.mock 把 `safeFetch` 与
`readAuthFile` 换成替身，把「接上真实凭据后请求/响应的形状」现在就测对：
- 请求：URL=`https://api.openai.com/v1/embeddings`、`Authorization: Bearer <key>`、
  body `{model, input:[...]}`；
- 响应：`data[].embedding` 解析 → L2 归一（`[3,4]→[0.6,0.8]`）；
- 错误码：非 200→`MEMORY_EMBED_HTTP_<status>`（不回显上游正文/key）、条数不匹配→
  `COUNT_MISMATCH`、无字面量 key（含 `$ENV`/`!cmd` 间接引用）→`NO_KEY` 且不发请求、
  目录外 Provider→`UNSUPPORTED`；
- 三态切换：`resolveEmbedder` local→本地哈希、provider→`provider:model` id、
  `__setEmbedder` 注入覆盖一切、传 null 恢复。

**抽取边界**（FEAT-memory-v2.md §2「有限抽取」红线）：
- 默认启发式（`defaultExtractor` 纯函数）：只看用户消息、去重、最短长度、线索词
  分类（instruction/preference/fact）、按标点切句、不命中不抽；
- 落库不变量（ADR 红线：总结不是不可更正真相）：可注入抽取器 + 真实 MemoryStore
  钉死每条恒为 `origin=inferred` / `confidence=0.5` / `excluded=true`（直接后果：注入
  候选零命中）、secret 候选被 save 拒不落库、limit 截断。

**注入钩子 live 触发（如实标注）**：注入逻辑由既有 memory-inject.spec 的 5 条（完整
时序 + 零成本门 + 注入总开关 + 敏感不注入）钉死，`injectMemory` 的 async await 契约已
被 exercise。pi:prompt→注入的 live 触发需一个已配置模型的真实 prompt（与 v1 同样受限），
且该钩子是 MEM-101 established 的唯一内核接触点（pi-ipc.ts），不宜为验证而改动内核触点。
**逻辑已钉死，live 模型触发保持凭据受限的「未验证」标注。**

---

## 4. tasks：触发契约 + DST/回拨/错过 边界补测

**触发 Agent run（诚实标注，不假接线）**：FEAT-tasks.md §4/§8-1 说这是待接线 stub。
核实后台池现状——`agent-pool/pool.ts` 的真实后台派生**本身也尚未落地**（launch 走记账
占位）。因此把 tasks 接上池只是 stub 接 stub、徒增耦合且触边界。诚实做法：把
`AgentRunTrigger` 这个可注入窄接口的**形状用替身钉死**，一旦后台池/任何真实触发就位、
按此接口返回 sessionId/artifactIds/costUsd/error，scheduler 就正确落库、替换实现时
scheduler 一行不动（task-trigger.ts 的设计承诺）：
- 成功 outcome 的 sessionId/artifactIds/costUsd 原样落 run 记录；
- 失败 outcome 的 error 落库、状态 failed；
- 触发时拿到的是**冻结输入快照** `{provider,model,prompt}` + budget/timeout；
- 触发实现抛异常 → run 判 failed，不外泄未捕获错误。

**DST/回拨/错过 补测**（FEAT-tasks.md §2/§8，补既有 tasks-schedule.spec 未覆盖的时序，
断言具体 epoch/条数）：
- sleep/wake 大幅前跳后 catch-up（逐个补）/ run-once（只补最近）/ skip（只跑 grace
  内准点、超出全略）三档各自行为，及 `nextAfter` 严格晚于 now 不变量；
- weekly 落在春季 gap（周日 02:30 不存在）→ 滚到 03:30 EDT（与 daily 一致）；
- 秋季回拨 daily/overlap 取较早只算一次；
- catch-up 封顶 `MAX_CATCHUP_SLOTS`（1000）+ `dropped` 如实报告、升序无重复；
- 回拨（now<sinceMs）dueSlots 空但 nextAfter 仍是 now 之后的下一次。

**本批发现（诚实记录，未擅自改）**：cron 落在春季 gap 的语义**与 daily/weekly 不同**——
daily/weekly 用 `wallToEpoch` 把 gap 时间 roll-forward；cron 逐「真实墙钟分钟」扫描，
gap 那一分钟（02:30）不存在于任何真实 epoch，于是 cron **跳过这一次**、落到下一个真实
存在的匹配（下周日 02:30 EDT）。这是「cron 匹配真实发生过的墙钟分钟」定义的自然结果，
不是 bug，但与 daily 的 roll-forward 不一致——已用一条测试钉住现状（防日后无意改动其中
一侧），是否统一两侧语义留待产品决策，本批不擅自改调度语义。

---

## 5. 可证伪测试 + 对拍（临时拆机制确认变红，两次输出）

对每处打磨都做了对拍（拆掉承重逻辑→跑 spec→确认恰变红→还原→复跑全绿）：

| # | 拆掉的机制 | 结果 |
|---|---|---|
| P-A | `planSpawn` 的 `.cmd` 分支（直接 spawn .cmd） | RED：mcp-client-win 3 条失败（握手 ENOENT/EINVAL、注入测试无法跑）。还原后 5 passed |
| P-B | `providerEmbedder` 请求体 `input`→`prompt` | RED：memory-embed「请求体 {model,input} 形状」恰 1 条失败。还原后 12 passed |
| P-C | `extractFromSession` 落库 `excluded:true`→`false` | RED：memory-extract「落库不变量」失败（字段错 + 注入候选泄漏）。还原后 9 passed |
| P-D | `schedule.ts` gap 方向 `Math.max`→`Math.min` | RED：tasks-schedule-extra「weekly 落春季 gap」失败。还原后 11 passed |
| P-E | `scheduler.ts` 成功收尾 `sessionId: outcome.sessionId`→`null` | RED：tasks-trigger「sessionId 原样落库」失败。还原后 4 passed |

注入不逃逸的判据非恒真：`args.cmd` 里塞 `a&echo PWNED`，断言子进程 stdout **精确等于**
print-args 的那一行 JSON（一个字节不多）—— 元字符逃逸会让 `echo PWNED` 单独执行或参数
被拆，两者都让断言不等。Provider 契约测断言的是**具体请求体字段与解析结果**、不是
「safeFetch 被调用过」。

---

## 6. 门禁（收尾一次全跑，全绿）

```
pnpm typecheck                     contract / pi-sdk / app(node tsc + web vue-tsc) 全 Done
pnpm -w test（unit）               127 文件 / 1161 测试 passed（+5 文件 / +41 测试，无既有用例改判）
pnpm build                         3155 modules ✓
pnpm --filter @pibuddy/app dist    win-unpacked + NSIS 安装包，签名完成
ipcMain 守卫外命中                 0（唯一注册点仍在 ipc-guard）
raw fetch（main，outbound-guard 外）0；mcp 目录 fetch( 0（.cmd 修复不引出站）
check-contract-uniqueness          OK（未改契约）
check-test-discovery               OK（5 个新 spec 全在发现范围）
check-pure-js-deps                 OK（扫 83 包无原生扩展；未新增依赖）
```

三域全部 spec 合跑：**17 文件 / 139 测试 passed**。

---

## 7. 真机启动验证（packaged，CDP 取证）

`release/win-unpacked/PiBuddy.exe --remote-debugging-port=9222`（proc count=5），CDP
`Runtime.evaluate`：

```
{"hasMcp":true,"mcpMethods":["list","remove","save","start","stop","test"],
 "hasMemory":true,"hasTasks":true,
 "listErr":"Error invoking remote method 'mcp:list': Error: WORKSPACE_UNKNOWN: __nope_ws__"}
```

三域命名空间在打包产物里都在；`mcp:list` 打到的是**真实 handler**
（`WORKSPACE_UNKNOWN`，不是 `No handler registered`）—— 证明含本批 mcp-client 改动的
main 包在打包后 preload→ipc-guard→handler 整条链完好。**Windows `.cmd` spawn 修复本身
由 mcp-client-win.spec 在本机用真实 `.cmd` shim 端到端验证**（最强验证：真的经 cmd.exe
起了 node MCP stub 并完成握手，且注入不逃逸）。

进程清理：`Stop-Process -Name PiBuddy -Force` → count=0（按铁律用 powershell）。

---

## 8. 诚实清单（无凭据/待接线仍无法真连的，逻辑已钉死）

- **memory Provider 嵌入真连**：无 embedding 凭据，未走真实外部 `/embeddings`；请求/响应
  形状 + 错误码由 memory-embed.spec 替身钉死，接真实凭据时形状对。
- **memory 注入 live 触发**：需真实模型 prompt；注入逻辑由 memory-inject.spec 钉死。
- **tasks 触发真跑**：后台池真实后台派生本身未落地；`AgentRunTrigger` 形状由
  tasks-trigger.spec 钉死，接线时一处替换。
- **mcp http/OAuth**：受 SEC-004 + `network:*` 禁用约束，属 PermissionEngine 落地后的事；
  当前回明确「未实现」诊断，不伪装已连。
- **cron gap 语义与 daily 不一致**：现状已钉住，统一与否留待产品决策。

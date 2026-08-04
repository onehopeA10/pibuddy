# 无人值守推进计划(2026-08-04 起)

用户睡觉,主流程自动推进到剩余能力全部完成或遇到硬阻断。能并行(worktree 隔离)就并行,不行就串行。

## 铁律(每一步都遵守)
- 每个 agent 用 `isolation: worktree`,只提交自己分支,**不 push origin/main**;主流程逐个 merge
- 集成:一个分支一个分支合,每合一个过全量 `typecheck` + `pnpm -w test` + 结构断言(守卫外 ipcMain=0 / fetch=0)+ `dist` + 真机;全绿才推
- 中断的 agent(API 错误)用 SendMessage 从 transcript 续跑,不重头来、不丢工作
- 提交按路径 `git add`,严禁 `-A`
- 每条完成的能力写 summary 到 `.workflow/scratch/capability-research/FEAT-*.md`
- 遇到 node 原生模块 / 缺凭据 / 缺认证基建等硬阻断:如实标 blocked,不伪装完成,继续下一条

## 批次与依赖

### 当前批(进行中,3 worktree agent)
- [ ] Git 编码包(`coding.git`)—— 第一个 process.git 消费者
- [ ] 后台多会话池(`kernel`)—— child Agent 的硬前置
- [ ] Durable tasks(`common.tasks`)—— 曾中断一次,已续跑

→ 三个完成后主流程集成进 main。

### 第二批已完成并集成推送(`5234a24`,2026-08-04)
- ✅ Git 编码包 `coding.git`(`696d0c8`)—— 第一个垂直包,真机证明 general profile 下默认 off、coding profile 下启用,权限引擎 process.git 拒绝/放行互斥对已验
- ✅ 后台多会话池(`7b48f30`)—— 内核状态机就绪;真实后台进程 spawn 是占位(child-agent 起点)
- ✅ Durable tasks `common.tasks`(`092db25`)—— headless 调度 + 可注入时钟 + 预授权安全点
- 集成:三分支逐个 merge,纯追加冲突用 both-sides 解;**踩坑**:sed 盲删冲突标记把 git register 块的 `});` 连带吞了(跨结构边界的冲突),6 测试红,补回括号后 117 文件/1077 测试全绿。教训:sed 解冲突只适合行级追加,跨括号/函数边界的冲突要手工核对配对。
- 真机:21 preload 命名空间,7 能力包 + 内核池全存活,0 error,coding.git(off) 证明按 profile 装卸生效。

### 下一批(第二批已合并,现在开始)
可并行(worktree):
- [ ] 连接器 v1 —— 飞书 或 通用 webhook,权限引擎已就位(network scope)
- [ ] 记忆 v2 / 知识库 —— embeddings/语义检索 + 引用,记忆 v1 已合

串行(必须等后台池合并):
- [ ] child Agent 编排 —— 父子拓扑/取消传播/worktree 隔离/结果收敛;审计明写"不得早于 worktree 和权限中心"

### 第三批进行中(2026-08-04)
- ✅ 记忆 v2 `common.memory` 扩展(`6b663ee`)—— 语义检索 + 知识库 + 有限抽取,120 文件/1089 测试,真机「删除后语义零命中」兑现。默认本地哈希嵌入(离线无凭据)。
- ✅ child-agent 编排(`968bb30`)—— AGT-102 端到端接线 + AppShell 挂载,worktree 仍 locked(收尾中)。
- 🔄 连接器 v1 —— 还在跑,**又污染了共享树**(connector 全套散在 5234a24 工作区,重演后台池的绝对路径写盘)。记忆 v2/child-agent 没污染。等它跑完(应会 commit 到自己分支),再清污染统一集成。
- 集成待办:连接器完成后 → 共享树清 connector 污染(`git checkout -- .` + `git clean` connector 新文件)→ 逐个 merge 记忆v2/child-agent/连接器 三分支 → **冲突处理注意跨结构边界(上批 sed 吞了 `});`)**→ 全量门禁 + 真机 → 推送。

### 第三批已完成并集成推送(`d39a522` + `4ef9b87`,2026-08-04)
- ✅ 记忆 v2 `common.memory`(`6b663ee`)—— 语义检索+知识库+有限抽取,真机删除后语义零命中
- ✅ child-agent `common.child-agent`(`8587a6f`)—— AGT-102 编排 + **落地后台池三占位**(真实后台 spawn:create 子进程 5→6、cancel 6→5;inbox→deny 闭环;AppShell 挂载)
- ✅ 连接器 `connector.webhook`(`897d44d`)—— 网络授权+SSRF+域名上界三关,真机互斥闭环(未授权拒/授权送达 200);选 webhook 覆盖飞书/钉钉/企微/Slack/Discord incoming
- 集成:三分支 merge,连接器冲突含 catalog 跨括号边界——**这次人工修 catalog 括号,没重蹈 sed 吞括号**;125 文件/1132 测试全绿
- **修了个第二批遗留 bug**:AppShell 的 Git/定时按钮畸形模板(第二批 sed 吞了 </n-button>+<n-button,Vue 编译宽松没报错,只真机可见),已补(`4ef9b87`)
- 真机:23 preload 命名空间,**11 能力包全存活**(9 common + coding.git(off) + connector.webhook),四层架构完整,0 error

### 已交付能力总览(11 包)
common:workspace-files / workspace-review / preview / artifacts / session-tree / memory(v2语义) / mcp / tasks / child-agent
coding:git(按 profile 装卸,默认 off)
connector:webhook
内核:权限引擎(第五道闸+授权表+审计)、后台会话池、能力 registry/manifest/Profile/feature-gate

### 剩余两块的诚实评估(2026-08-04)

**终端 / LSP —— 结构性 BLOCKED,不做。**
- 根因实测:所有 PTY 方案(node-pty / node-pty-prebuilt-multiarch / @homebridge/...)都依赖原生绑定(binding.gyp / prebuild-install / nan / node-addon-api),全被 `check-pure-js-deps` 的 `NATIVE_SCRIPT_RE` 拦。PTY 本质是 OS syscall,**纯 JS 不存在**(xterm-pty 只是前端渲染器,不提供真 PTY)。
- 更硬的约束:即使放行闸门,`electron-builder` 的 `npmRebuild:false`(为保护 pi runtime 刻意设的)会让打包机编的 .node ABI 与用户 Electron 不匹配 → 运行时崩溃;还要给三平台各架构预编译分发。
- **不破坏地基**:`npmRebuild:false` + `check-pure-js-deps` 保护 pi runtime 与"能力包纯 JS"承诺,不为一个终端牺牲。
- 解锁前置:①改发布工程支持按平台预编译原生模块 + 对 node-pty 单独开 npmRebuild ②或等 Node 稳定的 WASM PTY。届时终端作为 coding tier 能力包接入(argv/权限已就位)。**在此之前标 blocked-by-native-module。**

**Remote / PWA —— 不做,前置未建 + 高攻击面。**
- 卡在:统一认证 + 设备 scope + 审计(审计文档明写"不得早于")。这不是原生模块问题,是要先建一层认证基建。
- 可以做但工作量大且是**全新的对外攻击面**(loopback→LAN、QR pairing、token hash、设备撤销、HTTP/WS/SSE 统一鉴权、SSRF)。无人值守下自主开一个对外网络服务的安全面,风险超出"能并行就并行"的授权范围。
- **决定:留给用户醒来确认后再做**,不在无人值守批次里自主开对外服务。标 deferred-needs-owner。

### 至此无人值守批次自然收敛
能做的都做了(11 能力包 + 权限引擎 + 后台池)。剩两块一个结构 blocked(终端)、一个需 owner 确认(Remote)。无更多可自主推进项 → 停在这里,等用户。
- [ ] 终端 / LSP —— node-pty 是原生模块,被 npmRebuild:false + check-pure-js-deps 挡。先评估能否用纯 JS PTY 或把原生模块按平台预编译分发;不行标 blocked
- [ ] Remote / PWA —— 卡在统一认证 + 设备 scope + 审计。先建认证基建,再做;或标 blocked
- [ ] M4 签名闭环 —— blocked-by-credential(用户已确认接受),不动

## 进度记录(主流程随时更新)
- 2026-08-04 00:xx 起,当前批 3 agent 运行中
- **后台池完成**:分支 `worktree-agent-aac7928986237fd20` @ `7b48f30`,112 文件/1026 测试绿,真机验证过。
  - ⚠️ 该 agent 误用绝对路径污染了共享树 main 的工作区(pi-supervisor/channels/ipc-registry 等未提交改动 + agent-pool/ 新文件)。经核实是**过期中间态**,权威在分支 `7b48f30`(与共享树污染有 244 行 diff)。**集成时丢弃共享树污染,以分支为准。**
  - 预留未做(child-agent 起点,非缺陷,合并时标 summary):① `PoolRuntimeHost.launch/stop` 是记账占位,真实后台进程 spawn 未做,supervisor 仍单活动 runtime ② inbox→引擎闭环只审计未接副作用 ③ `AgentPool.vue` 未挂 AppShell slot。
- Git(`abf7599`)、Durable(`a4baef`,续跑中)两个 worktree 仍在跑,分支停在 43d20c1。
- 集成策略确认:等三个都完成 → 共享树 `git checkout -- .`(丢污染,perf.json 除外)→ 逐个 merge 三分支进 main → 每合过全量门禁 → 真机 → 一次推 origin。教训补记:worktree agent 必须只在自己 worktree 内用相对路径改文件,禁止绝对路径写共享 checkout。

## 追赶批(2026-08-04,对标 hermes/CodePilot 差距)
用户选 1/2/3/5 并行,4(终端)待讨论。按文件域切成 4 个 worktree agent:
- A 渠道扩展(飞书/Slack/Telegram)—— main/connector/**  [运行中]
- B Git 补完整(worktree/stash/history/push/hunk-stage/危险审批)—— main/git/**  [运行中]
- C 可视化工作流(Vue Flow 画布)—— 新建 main/workflow/**  [运行中]
- ✅ D 深度打磨(memory-v2/mcp/tasks 端到端+测试)—— `f351826`,127 文件 1161 测试
  - mcp 修真 bug:npx.cmd 在 shell:false 不可 spawn,用 cmd.exe + 双层转义 windowsVerbatimArguments 括死参数,安全边界未放宽
  - 诚实保留:http/OAuth deferred(会破 SEC-004 内网阻断);后台池真实派生也是 stub 故 tasks 触发用替身钉死
  - 诚实记录未擅改的现状 bug:cron 落 DST 春季 gap 语义与 daily 不一致
- 合并策略:等 A/B/C 齐 → 一次集成(D 域独立不冲突,一起合)→ catalog/AppShell 冲突**一律人工修括号/标签,不 sed 盲删**(前两批吞括号教训)→ 全量门禁+真机 → 推送

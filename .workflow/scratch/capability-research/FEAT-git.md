# FEAT-git：Git 编码能力包（coding.git / GIT-101 第一批）

**第一个 coding tier 垂直能力包**。验证 ADR-0002 的整条链路：垂直能力声明
`process.git` → 经核心 PermissionEngine 授权 → 随 Profile 装卸。它是
`FEAT-permission-engine.md` §6 预留入口的**第一个真实 `process.git` 消费者**。

依据：`docs/product/ADR-0002-capability-architecture.md`（D2 重依赖 / D3 权限 /
D5 UI 插槽）、`FEAT-permission-engine.md`（授权入口）、`FIX-capability-core.md`
（manifest / registry / Profile 落地形态）。

---

## 1. 交付

`coding.git` 九条窄通道，全部经 ipc-guard + 第五道闸（process.git）：

| 通道 | 动作 |
|---|---|
| `git:status` | 仓库探测 + 当前分支 + 逐文件状态（porcelain -z 解析） |
| `git:diff` | 文件/hunk diff（staged / unstaged 两端），**复用 changeset 的 review 原语** |
| `git:stage` / `git:unstage` | 逐文件暂存 / 取消暂存 |
| `git:revert` | 安全回退（丢弃前先 `writeFileAtomic` 备份） |
| `git:commit` | 提交已暂存改动，message 经 argv 传 |
| `git:branch-list` / `git:branch-create` / `git:branch-switch` | 分支列举 / 创建 / 切换 |

**危险类本批不做（deferred）**：`push --force` / `reset --hard` / `branch -D` 会丢
用户提交或历史，要单独走高风险审批（主进程原生确认 + 更细的 resource 授权）；
fetch/push 属网络操作（要 credential helper），同样不在本批。本批全是**本地**
操作，压根不碰网络与凭据，从根上回避了 token 落日志的风险。

### Git 子进程纪律（`main/git/git-cli.ts` 唯一原语）

- **只传 argv，`shell:false`**：`execFile`（导入时别名成 `execGit`）把参数数组
  原样交给 git，不经 shell 分词。路径、分支名、提交信息都是数组里的一个元素。
- **受控环境**：`GIT_TERMINAL_PROMPT=0` / 空 askpass 让要凭据/passphrase 的操作
  **立刻失败**而非挂起；`GIT_OPTIONAL_LOCKS=0` / `GIT_PAGER=cat` / `LC_ALL=C`。
  **token/凭据既不入 argv 也不入日志**（日志只记 `{subcommand, code, ms}` 与失败
  时一段经 logger-redact 脱敏、截断的 stderr）。
- **选项注入防御**：即便 shell:false，`--force` / `-D` 这样的「分支名」会被 git
  当选项——分支名过 `assertSafeBranchName` 严格白名单（拒绝以 `-`/`/` 开头、`..`、
  `.lock` 结尾），路径过 `assertRepoRelPath`（拒绝绝对路径与 `..`）+ `assertContained`
  realpath 复核。
- **纯 JS，无原生依赖**：用系统 `git` CLI，不引 nodegit/simple-git（ADR-0002 D2）。
  `check-pure-js-deps` OK（扫描 83 个包，无原生扩展）。
- **可装卸**：`git-cli` 登记在途子进程，`disposeGitResources` 一次 kill；仓库不动
  （D4 规则 4/5）。

### diff 复用 changeset 的 review 原语（不另造一套）

`git-diff.buildGitDiff(relativePath, beforeBytes, afterBytes)` 直接 import
`main/changeset/changeset-store` 的 `diffLines` / `looksBinary` /
`CHANGESET_DIFF_MAX_BYTES`，产出与变更审阅面板**完全一致**的 `ChangesetHunk` /
`ChangesetDiff`。避免「两套冲突状态」——同一份 diff 在两个面板里长得一样、
接受语义一致。manifest 因此声明 `dependencies: ["common.workspace-review"]`，让
「只开 Git、不开变更审阅」被 resolve 当场拒绝。

---

## 2. 权限接线（本包核心验证点）

- manifest 声明 `permissions: ["process.git", "workspace.read", "workspace.write"]`
  （**不申请 process.shell**——跑 git 归 process.git；也不申请 network）。
- 按 `FEAT-permission-engine.md` §6 的预留入口接入：给九条 git 通道在
  `main/permission/permission-store.ts` 的 `CHANNEL_PERMISSION_REQUIREMENTS` 里
  **各加一行** `{capabilityId: coding.git, permission: process.git}`（只往需求表
  追加行，**不改** engine/gate 的任何既有决策逻辑）。引擎的上界校验与第五道闸的
  拦截自动生效，ipc-guard 一行未动。
- 探针保留 id `kernel.git-probe` **未退休**（避免触碰 permission 既有逻辑，留作
  回归探针）。

## 3. 严格文件边界

**新增**（我的地盘）：
```
packages/contract/src/git.ts                               契约 + gitContractShard("git")
packages/app/src/main/git/git-cli.ts                       子进程唯一原语（execGit + inflight + dispose）
packages/app/src/main/git/git-repo.ts                      仓库探测 / 状态解析 / 输入校验
packages/app/src/main/git/git-diff.ts                      diff（复用 diffLines/looksBinary）
packages/app/src/main/git/git-actions.ts                   stage/unstage/revert/commit/branch
packages/app/src/main/git/git-ipc.ts                       registerGitIpc + disposeGitResources（exposure.module）
packages/app/src/main/capability/manifests/git.manifest.ts 清单
packages/app/src/preload/api/git.ts                        window.piBuddy.git（第 19 个命名空间）
packages/app/src/renderer/src/stores/git.ts                渲染侧状态（denied → 唤起权限弹窗）
packages/app/src/renderer/src/components/GitPanel.vue      面板
packages/app/test/git.spec.ts                              8 条（互斥 + diff 复用 + 校验 + 解析）
```

**追加自己的行**（共享中央文件）：
```
packages/contract/src/channels.ts        + git:* 9 条
packages/contract/src/ipc-contract.ts    + gitContractShard 进 CHANNEL_CONTRACT_SHARDS
packages/contract/src/index.ts           + export git.js
packages/app/src/main/capability/capability-manifests.ts  + gitCapability + coding Profile 加 coding.git
packages/app/src/main/capability/capability-catalog.ts    + git 注册（activate/deactivate）
packages/app/src/main/permission/permission-store.ts      + 需求表九行（§6 预留入口）
packages/app/src/preload/api/index.ts    + git 命名空间
packages/app/src/renderer/src/components/AppShell.vue     + 🌿 Git 开关 + 面板 + isEnabled("coding.git") 门控
```

**未改** `main/permission/**` 的既有决策逻辑（engine/gate/ipc 一行未动，只往需求表
加数据行）、**未改** runtime core（pi-supervisor / event-forwarder）、**未新增运行时依赖**。

### Profile：coding-only（第一次让 coding ≠ general）

`coding.git` 只进「编码」Profile，「通用办公」不装。这是 Profile 机制第一次有了
**可验证的差别**（此前 coding 与 general 能力集相同，因为一个垂直包都不存在）。
切到 coding = 装上 Git；切走 = 卸下。

**连带的两处测试演进**（不是绕过，是 invariant 随第一个 off-by-default 垂直包
正当地改变，且保留可证伪性）：`sessions-ipc.spec` / `pi-resources-ipc.spec` 的
「无死通道」判据——默认 general 下未启用能力的通道**合法地不注册**，因此排除
「被禁用能力拥有的通道」后再断言 missing==[]。对拍是 `capability-gate.spec`（lite
下反过来断言这些通道一条都不在）。`capability-drift` 的 `process.git` 标记从
`simpleGit(|nodegit`（预置的库形态）更新为 `+runGit(`（系统 git 形态，ADR D2 要求
用 CLI）；`execGit` 别名使 process.shell 标记不误命中——「跑 git」归 process.git、
「跑任意子进程」才归 process.shell，两者源码上可分。

---

## 4. 可证伪对拍（临时拆掉，确认变红）

| 拆掉的机制 | 命令 | 结果 |
|---|---|---|
| 需求表里 git 的九行（`GIT_GATED_CHANNELS.filter(()=>false)`） | `vitest run git.spec.ts` | **RED**：3 条权限互斥用例失败（未授权不再被挡）；restore 后全绿 |
| diff 复用（`buildGitDiff` 里 `diffLines(...)` 改成 `[]`） | `vitest run git.spec.ts` | **RED**：「hunks 逐字节等于 diffLines」失败；restore 后全绿 |

权限用例本身也不恒真：断言 `git:commit`/`git:status` **被挡**的同时断言需求表外的
`settings:get` **放行**——若是全盘拒绝（恒真）后者也会挡。上界那条做了双向（给
coding.git 发它没声明的 `process.shell` 授权 → 不产生任何授权、git 仍拒）。

---

## 5. 门禁（全绿）

```
pnpm typecheck            contract / pi-sdk / app 全 Done
pnpm -w test              Test Files 111 passed (111) / Tests 1014 passed (1014)
                          （基线 110/1006 → +1 文件 git.spec.ts / +8 测试，无既有用例被改判）
pnpm build                renderer 3139 modules（基线 3134 → +GitPanel/git store）✓
pnpm --filter @pibuddy/app dist   win-unpacked + nsis 出包，含 git 全链路 ✓

rg ipcMain.(handle|on) 守卫外命中数求和            = 0
node check-pure-js-deps.mjs                        OK（无原生扩展）
node check-contract-uniqueness.mjs                 OK（486 契约名唯一）
node check-test-discovery.mjs                      OK（111 spec 全在发现范围）
node check-workflow-pins.mjs                       OK
main/git 内无 shell:true（仅注释提及）             ✓
```

---

## 6. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP，隔离 --user-data-dir）

对一个临时 test repo（`git init` + 1 commit + 1 未暂存改动 + 1 未跟踪文件）跑全链路。
隔离：`--user-data-dir` 指向临时 userData，启动后先核对 `currentWorkspace` 确实是
seed 的 test repo（`B_workspaceMatches:true`）才做写动作，绝不碰用户真实 profile。

**Launch A（general Profile）—— 可装卸 OFF：**
```
命名空间（19）：…,git,…                              ← preload 命名空间在册
git.status → "No handler registered for 'git:status'"  ← 通道未注册（feature gate 生效）
describe → {profile:general, git:{enabled:false, tier:vertical}}
```

**Launch B（coding Profile）—— 装卸 ON + 权限互斥 + 真跑 git：**
```
describe → {profile:coding, git:{enabled:true, tier:vertical, perms:[process.git,workspace.read,workspace.write]}}

未授权 git:status → DENIED: IPC_PERMISSION_DENIED …coding.git / process.git   ← 第五道闸挡在 handler 外
未授权 git:commit → DENIED: IPC_PERMISSION_DENIED …coding.git / process.git   ← 任务点名的那条
allow-session(coding.git/process.git) → OK sessionGrants=1
授权后 git:status → {isRepo:true, branch:"main", entries:[["tracked.txt"," ","M",false,false],["untracked.txt","?","?",false,true]]}
授权后 git:diff(tracked.txt) → {degraded:null, hunks:[{del:["line2"], add:["LINE2-modified"]}]}   ← 复用 changeset hunk
git:stage(tracked.txt) → {ok:true}
git:commit("test commit from pibuddy") → {ok:true, commit:"673280f"}
commit 后 git:status → [["untracked.txt","?","?"]]                            ← tracked.txt 已提交
git:branch-create("feature/git-101") + branch-list → {branches:["feature/git-101","main"], current:"main"}
git:branch-create("--force") → REJECTED: GIT_BRANCH_NAME_REJECTED               ← 选项注入被拒
revoke session → git:status → DENIED_AGAIN                                      ← 互斥闭环
向后兼容：settings.get() → "settings:get OK"

磁盘核对（跳出渲染进程直接问 repo）：
  git log --oneline → ["673280f test commit from pibuddy","32b1988 init commit"]  ← 提交真的落盘了
  git branch → ["feature/git-101","main"]                                          ← 分支真的建了
```

未授权 status+commit **必挡** → 授权 **必放行** → 撤销 **又挡**，这对互斥不是靠断言
「引擎被调用」，而是探针穿过真实 `ipcMain.handle` → 五道闸 → handler 的全链路（handler
被调到本身就是放行证据），且 `git log` 证明 commit 真的发生在磁盘上的 repo 里。

**进程清理**：`powershell Stop-Process -Name PiBuddy -Force` 后
`{PiBuddy:0, electron:0}`（`pkill` 本机无效，按铁律用 powershell）。

---

## 7. 本轮发现、未修（留给后续）

1. **危险类操作 deferred**：force push / reset --hard / branch -D / fetch/push
   （网络 + credential helper）。要一套「更细 resource 授权 + 主进程原生确认」的高风险
   审批路径，本批不做。
2. **hunk 级 stage 未做**：本批 stage/unstage 是**文件级**；diff 可看到 hunk（复用
   changeset hunk），但逐 hunk 暂存（`git apply --cached` 造补丁）留到后续。这与 ADR
   「已知未决」把行级 hunk 归属留到第二阶段一致。
3. **仓库根 = git 信任边界**：工作区是某仓库的子目录时，面板显示的是**整个仓库**的
   状态（git 的固有 UX），收容判定对齐仓库根而非工作区根。第一批如此，够用。
4. **git 日志用 `main` scope + `domain:"git"` 字段**：未给 logger.ts 新增 `LogScope`
   字面量（logger.ts 是全仓唯一 logger，不属本包地盘），事件名 `git_*` 已足以区分。

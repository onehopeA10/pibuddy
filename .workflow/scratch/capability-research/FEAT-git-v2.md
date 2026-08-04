# FEAT-git-v2：Git 编码能力包补完整（coding.git / GIT-101·102 剩余）

在 `FEAT-git.md`（Git v1，九条本地通道）基础上**扩展**。v1 刻意把网络类与危险类
deferred（v1 §7）；本批补上，纪律一字不改：一切仍走 `main/git` 的 `runGit`
（execFile + shell:false + 只传 argv），渲染进程拿到的仍只有不透明 workspaceId +
已校验的 ref / 相对路径 / 不透明 worktree id，**没有任何 argv 或命令行字段**。

依据：`FEAT-git.md`（v1，本文件在其上扩展）、`ADR-0002`（D2 用系统 git CLI / D3 权限 /
D4 拆卸）、`FEAT-permission-engine.md` §6（process.git 预留入口）、SEC-003（allow-once 语义）。

---

## 1. 交付：v1 九条 → v2 三十条（+21）

| 组 | 通道 |
|---|---|
| 网络 | `git:fetch` / `git:pull` / `git:push` |
| 危险（额外二次确认） | `git:force-push`(--force-with-lease) / `git:reset-hard` / `git:branch-delete`(-D) |
| stash | `git:stash-save` / `git:stash-list` / `git:stash-pop` / `git:stash-drop` |
| history | `git:log`（提交列表 / 单文件历史）/ `git:show`（提交详情 + 改动文件） |
| worktree | `git:worktree-create` / `list` / `open` / `rename` / `compare` / `remove` |
| hunk 级 stage | `git:diff-hunks` / `git:stage-hunk` / `git:unstage-hunk` |

### 权限接线：扩 `GIT_GATED_CHANNELS` 即自动接上第五道闸

permission-store 的 `CHANNEL_PERMISSION_REQUIREMENTS` 由 `GIT_GATED_CHANNELS.map(...)`
派生（v1 已如此）。因此**只在契约层把 21 条新通道加进 `GIT_GATED_CHANNELS`**，
引擎上界校验与第五道闸拦截对新通道自动生效——`main/permission/**` 一行未动
（严格边界：只往需求表追加数据、不碰既有决策逻辑，这里连追加都发生在契约层派生源上）。

### 危险操作的**两道**闸（任务点名 / SEC-003 allow-once）

force push / reset --hard / branch -D 会不可逆地丢提交或历史。process.git 那道闸
（第五道闸）粒度太粗——授权后 force push 与 status 无从区分。因此这三条在 process.git
之外，handler 内再走一次**主进程原生二次确认**（`dialog.showMessageBox`，渲染进程伪造
不了、绕不开），确认框逐字列出**精确范围**（哪个 remote/branch、当前 HEAD → 目标 ref、
要删分支的 tip 短 hash）。语义按 allow-once：**每次现确认、用后即焚**，不落任何持久
授权（不碰 capabilityGrants）——「上次点过允许」不该让这次的 reset --hard 直接执行。
确认器可注入（`setDangerConfirmer`），是可证伪的接缝。force push 用 `--force-with-lease`
而非裸 `--force`（别人在你 fetch 后又推了会被拒），即便如此仍走二次确认。

### 网络类不申请 network 权限

凭据由 git 子进程自己经 credential helper / SSH 处理，PiBuddy 从不经手 token：
`GIT_TERMINAL_PROMPT=0` + 空 askpass（v1 controlledEnv）让缺凭据的操作**立刻失败**而非
挂起，token 既不进 argv 也不进日志。PiBuddy 侧没有第二条出站路径、没有 safeFetch，
因此 manifest **不申请 network**——出站是 git 自己的事，仍归 process.git。

### worktree：不透明 id，路径不外发；落盘位置主进程决定

worktree-list 给渲染进程的是 `id = sha256(worktreePath)`（复用 `workspaceIdFor`），
open/rename/compare/remove 都用它回指，主进程每次重新 `git worktree list` 按 id 匹配路径
（**不存映射**，无陈旧状态可被 TOCTOU 攻击）。create 的 worktree 放在
`<userData>/git-worktrees/<workspaceId>/<name>`——不落在仓库工作树里，也不接受渲染进程
给的路径（只给一个受白名单校验的 name）。**remove 前脏检查**（任务点名）：默认
`force=false` 时先 `git -C <worktree> status --porcelain`，非空（未提交改动 / 未跟踪 /
未合并冲突）就拒绝并给中文原因；clean 才删。open 把 worktree 目录注册成工作区、回
workspaceId 供切过去（与 dialog:choose-folder 同形态）。

### hunk 级 stage：git 原生补丁，不反推 changeset

渲染仍用 changeset 的 LCS 逐行 hunk（`git:diff`，与变更审阅面板一致）。**暂存**另用
`git:diff-hunks` 取 git 原生 unified diff 片段，选中段经 stdin 喂给 `git apply --cached`
（`--reverse` 反向 = unstage）。补丁走 stdin 不进 argv/日志（git-cli 的 runGit 新增
`input?: Buffer`）。为什么不反推 changeset 成补丁：反推一定在换行 / `\ No newline` /
上下文细节上与 git 自己的补丁偏差，apply 就会失败——渲染与暂存各用各的表示，各司其职。

---

## 2. 严格文件边界

**新增**（我的地盘 `main/git/**`）：
```
packages/app/src/main/git/git-network.ts    fetch/pull/push（凭据归 git 子进程）
packages/app/src/main/git/git-danger.ts     force-push/reset-hard/branch-delete + 可注入二次确认器
packages/app/src/main/git/git-stash.ts      save/list/pop/drop
packages/app/src/main/git/git-history.ts    log/show（US/RS 分隔解析）
packages/app/src/main/git/git-worktree.ts   create/list/open/rename/compare/remove + 脏检查
packages/app/src/main/git/git-hunk.ts       diff-hunks/stage-hunk/unstage-hunk（git apply --cached）
packages/app/test/git-v2.spec.ts            13 条（真 git 子进程 + 真仓库 + 对拍）
```

**扩展**（我的地盘既有文件）：
```
packages/contract/src/git.ts             + 21 通道的 schema / 分片 / GIT_GATED_CHANNELS / GIT_DANGEROUS_CHANNELS
packages/app/src/main/git/git-cli.ts     + runGit 的 input?:Buffer（stdin 喂补丁）
packages/app/src/main/git/git-repo.ts    + assertSafeRef / assertSafeRemoteName（挡选项注入）
packages/app/src/main/git/git-ipc.ts     + 21 条 registerHandler（恰 30 条）
packages/app/src/preload/api/git.ts      + 21 个方法（第 19 命名空间扩到 30 方法）
packages/app/src/renderer/src/stores/git.ts        + 网络/危险/stash/history/worktree/hunk 状态与动作
packages/app/src/renderer/src/components/GitPanel.vue  + 远端/stash/worktree/历史/危险区 + 逐 hunk 暂存
```

**追加自己的行**（共享中央文件）：
```
packages/contract/src/channels.ts        + git:* v2 21 条
packages/app/src/main/capability/manifests/git.manifest.ts  + channels 21 条（drift 自动对账）
```

**未改**：`main/permission/**`（需求表由 GIT_GATED_CHANNELS 派生，一行未动）、`ipc-guard.ts`、
`ipc-contract.ts` 的合并/封口逻辑（gitContractShard 自动进 CHANNEL_CONTRACT_SHARDS）、
`connector/**` / `workflow/**` / `memory|mcp|tasks/**`。**未新增运行时依赖**（系统 git CLI，
无 nodegit/isomorphic-git）。

---

## 3. 可证伪对拍（临时拆掉机制，确认变红，restore 后全绿）

| 拆掉的机制 | 命令 | 结果 |
|---|---|---|
| reset --hard 的二次确认（`if(!confirmed)return` 换成 `void confirmed`） | `vitest run git-v2 -t 确认器拒绝` | **RED**：`expected true to be false`——确认器返回 false 时 HEAD 仍被移动；restore 后绿 |
| worktree remove 的脏检查（删掉 `!force` 的 status 早返回块） | `vitest run git-v2 -t "dirty worktree"` | **RED**：脏 worktree 的 force=false 也被删，`toContain("拒绝移除")` 失败；restore 后绿 |

两条对拍都用**真 git 子进程 + 真临时仓库**，不是打桩：`resetHard` 后跳出去 `git rev-parse
HEAD` 核对 HEAD 真没动 / 真动了；worktree 弄脏后核对它还在册 / 被删。权限那组也不恒真——
断言 v2 各通道被挡的同时断言需求表外的 `settings:get` 放行（若全盘拒绝则后者也会挡）。

hunk 级 stage 的判据同样落在磁盘：改两处 → diff-hunks 得两段 → stage 第 0 段后
`git diff --cached` 含 LINE2 但**不含** LINE38，且 `git diff` 仍含 LINE38，逐文件状态
x/y 两侧都非空（部分暂存真的发生）。

---

## 4. 门禁（全绿）

```
pnpm typecheck            contract / pi-sdk / app 全 Done
pnpm -w test              Test Files 126 passed (126) / Tests 1145 passed (1145)
                          （基线 125/1132 → +1 文件 git-v2.spec.ts / +13 测试，无既有用例被改判）
pnpm build                renderer 3155 modules（基线 3134 → +GitPanel v2 段/git store 扩展）✓
pnpm --filter @pibuddy/app dist   win-unpacked + NSIS 出包，含 git v2 全链路 ✓

守卫外 ipcMain.(handle|on) 命中数求和              = 0
main/git 内 shell:true                            仅 git-cli.ts 注释提及（与 v1 同）
check-pure-js-deps.mjs                            OK（扫描 83 个包，无原生扩展）
check-contract-uniqueness.mjs                     OK（712 契约名唯一）
check-test-discovery.mjs                          OK（126 spec 全在发现范围）
check-workflow-pins.mjs                           OK
capability-drift.spec.ts                          绿（manifest 30 通道 == registerHandler == 契约分片键，自动对账）
```

---

## 5. 真机取证（`release/win-unpacked/PiBuddy.exe` + CDP，隔离 --user-data-dir）

seed 一个临时 test repo（1 commit + tracked.txt 已改 + untracked.txt + 本地 bare remote），
写 `settings.json{workspace}` + `capability-prefs.json{profileId:coding}`，`--user-data-dir`
指向临时 userData（绝不碰用户真实 profile），`--remote-debugging-port=9223` 逐条 CDP 穿过
打包产物的真实五道闸。清单（单次干净运行）：

```
gitMethodCount:30  hasV2Methods:true                     ← 9 v1 + 21 v2 全部在 window.piBuddy.git
workspace: repo（B_workspaceMatches）  describeGit:true  ← coding Profile 下 coding.git 已启用
未授权 git:log        → DENIED                            ← 只读通道也被第五道闸挡（连 log/worktree-list）
未授权 git:worktree-list → DENIED
grant allow-session   → sessionGrants=1
git:log               → ["init commit"]
git:status            → [["tracked.txt"," ","M"],["untracked.txt","?","?"]]
git:worktree-create(wtA/feat-a) → {ok:true}
git:worktree-list     → [["repo","main",主],["wtA","feat-a",非主]]
git:worktree-remove(clean) → {ok:true}
git:diff-hunks(tracked.txt) → 1 hunk
git:stash-save → {ok:true}；stash-list → [[0,"main"]]；stash-pop → {ok:true}
git:push(origin main -u) → {ok:true, output:"* [new branch] main -> main; upstream set"}
git:fetch(origin)     → {ok:true}
revoke session → git:log → DENIED_AGAIN                   ← 互斥闭环
向后兼容：settings.get() → "settings:get OK"

磁盘核对（跳出渲染进程直接问 bare repo）：
  bareHasMain:true    ← push 真的把 main 送进了 bare（bare rev-parse main == repo rev-parse main）
```

危险类（force push / reset --hard / branch -D）**未在真机触发**：它们会弹**阻塞式**原生
确认框（那正是设计——渲染进程绕不开），CDP 自动化点不了原生按钮。其二次确认由单测的
注入确认器证明（§3 对拍：拒绝→不执行、允许→执行，且核对磁盘 HEAD）。

**进程清理**：`powershell Stop-Process -Name PiBuddy,electron -Force` 后
`{PiBuddy:0, electron:0}`（`pkill` 本机无效，按铁律用 powershell）。取证脚本写在 gitignored
的 `release/` 下、用后即删，不进提交。

---

## 6. 本轮发现、未修（留给后续）

1. **危险类的真机自动取证受限于原生框**：二次确认是阻塞式原生 dialog（compromise-proof
   的代价），CDP 无法点它，故真机只验非危险类，危险类靠单测注入确认器。若要真机自动化，
   需给确认器留一个「仅测试环境经环境变量旁路」的口子——但那本身会削弱 compromise-proof，
   本轮不做。
2. **hunk 级 stage 对二进制 / 无换行结尾的边角**：二进制直接降级拒绝；`\ No newline at end
   of file` 已随 hunk 正文原样保留（apply 依赖它）。极端交织的相邻 hunk（-U0）未专门处理，
   走 git apply 自身的容错。
3. **worktree compare 只给摘要**：ahead/behind + name-status 文件列表，不给逐文件 full diff
   （要看细节仍走 open 后的 git:diff）。够用，避免把两棵树的全量 diff 灌进渲染进程。
4. **stash drop 未加二次确认**：任务把危险类界定为 force push / reset --hard / branch -D 三条；
   stash drop 虽丢一条 stash，但 git reflog 短期可捞，归 stash 组常规操作，不额外确认。

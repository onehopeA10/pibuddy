# TASK-001: M0 工程基线：git 快照 + vitest + fake Pi RPC fixture + 最小 CI

## Changes

| 文件 | 动作 | 内容 |
|------|------|------|
| `.gitignore` | modify | 排除 `source/`（只读参考树，体积原因）、`node_modules/`、`out/`、`release/`、`dist/`、`*.tsbuildinfo`、`resources/pi-runtime/`、`*.log`、`.workflow/embedding*`、`.workflow/*.zvec`、`.workflow/search-cache.json`、`.workflow/scratch/*/outputs/tmp*` |
| `package.json` | modify | 新增 `devDependencies.vitest ^3.2.0`（实装 3.2.7）、`scripts.test` = `vitest run`、`scripts.test:watch` = `vitest` |
| `vitest.config.ts` | create | 仓库根唯一 vitest 配置。`include` = `packages/*/src/**/*.{test,spec}.ts` + `packages/*/test/**/*.{test,spec}.ts`；`exclude` 含 `**/node_modules/**` 与 `source/**` |
| `vitest.workspace.ts` | create | `export default ["."]` —— 见「Deviations」第 1 条 |
| `tools/fake-pi/fake-pi.mjs` | create | fake Pi RPC 子进程，9 个场景，手写 LF 分帧 |
| `tools/fake-pi/scenarios.mjs` | create | 场景常量与 normal 事件序列，fixture 与测试共用 |
| `packages/pi-sdk/test/client.spec.ts` | create | 4 条关键路径共 10 个用例 |
| `packages/pi-sdk/tsconfig.json` | modify | `include` 由 `["src"]` 改为 `["src", "test"]`，让 spec 也进 typecheck |
| `scripts/check-test-discovery.mjs` | create | 磁盘 spec 集合 D vs vitest 实际发现集合 F 的闸门 |
| `scripts/probe-node-sqlite.mjs` | create | Electron 运行时 `node:sqlite` 探针，结果回写基线文档 |
| `.github/workflows/ci.yml` | create | ubuntu + windows 矩阵，install/typecheck/discovery/test/build，三个 action 全部 40 位 SHA 固定，零 secrets |
| `doc/baseline-2026-08-02.md` | create | 15 项闭环功能 smoke 清单 + 断言写法约定 + 运行时能力（探针输出已回填） |

git：`git init -b main` → 两个提交 → `git remote add origin` → `git push -u origin main`。

## Verification

逐条实跑，命令与真实输出如下。

### C1 `git rev-parse --is-inside-work-tree` == true — PASS
```
$ git -C D:/selftool/pi-ui rev-parse --is-inside-work-tree
true
```

### C2 `git remote` 为空 — **FAILED（用户指令覆盖，见 Deviations 第 2 条）**
```
$ git -C D:/selftool/pi-ui remote
origin
```
task 原文要求 0 行；用户指令明确覆盖为「远端已建 https://github.com/onehopeA10/pibuddy，git init → 首次提交 → remote add → push -u origin main」。按用户指令执行，故此条按 task 原文判定为 failed。

推送前的安全闸门（用户指定）已实跑：
```
$ git ls-files | grep -c "^source/"
0
```

### C3 `rev-list --count HEAD >= 1` 且 `status --porcelain` 为空 — PASS
```
$ git rev-list --count HEAD
2
$ git status --porcelain
(空)
```

### C4 `.gitignore` 含 node_modules / release / out — PASS
```
$ for p in node_modules release out source; do rg -c --no-filename "$p" .gitignore; done
1
1
2
2
```

### C5 package.json + 唯一 vitest.config.ts — PASS
```
$ rg -n '"test": "vitest run"|"vitest"' package.json
13:    "test": "vitest run",
14:    "test:watch": "vitest"
17:    "vitest": "^3.2.0"

$ rg -n 'include|exclude' vitest.config.ts
16:    include: [
17:      "packages/*/src/**/*.{test,spec}.ts",
18:      "packages/*/test/**/*.{test,spec}.ts",
20:    exclude: ["**/node_modules/**", "source/**", "**/dist/**", "**/out/**"],
```

### C6 fake-pi.mjs 含全部 9 个场景字面量 — PASS
```
$ for s in normal malformed-json timeout stderr-noise exit-immediately \
           crash-mid-stream extension-ui stale-generation oversized-line; do
    rg -c --no-filename "\"$s\"" tools/fake-pi/fake-pi.mjs tools/fake-pi/scenarios.mjs | awk '{s+=$1} END{print s+0}'
  done
normal => 3
malformed-json => 2
timeout => 2
stderr-noise => 2
exit-immediately => 2
crash-mid-stream => 2
extension-ui => 2
stale-generation => 3
oversized-line => 2
```
（9 个字面量在 `scenarios.mjs` 的 `SCENARIOS` 数组与 `fake-pi.mjs` 的 switch 分支中均出现；两文件通过 import 强耦合，字面量不会漂移。）

### C7 手写 LF 分帧、无 readline — PASS
```
$ rg -c -F 'indexOf("\n")' tools/fake-pi/fake-pi.mjs
2
$ test -e tools/fake-pi/fake-pi.mjs && [ "$(rg -c 'readline' tools/fake-pi/fake-pi.mjs | wc -l)" -eq 0 ] && echo PASS
PASS
```
注：原 criteria 写的 `rg -c 'indexOf("\n")'` 会被 ripgrep 拒绝（`the literal "\n" is not allowed in a regex`，退出码 2），必须加 `-F` 走定长字符串。这是又一条「命令本身不成立」的写法，已按 SYS-1 精神记录。

### C8 `pnpm -w test` 退出码 0 且通过用例数 >= 8 — PASS（10 > 8）
```
$ pnpm -w test
 ✓ packages/pi-sdk/test/client.spec.ts (10 tests) 1514ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
test exit=0
```

### C9 client.spec.ts 含 `--scenario` / `malformed-json` / `exit-immediately` — PASS
```
$ rg -c --no-filename -- '--scenario' packages/pi-sdk/test/client.spec.ts   -> 1
$ rg -c --no-filename 'malformed-json' packages/pi-sdk/test/client.spec.ts  -> 4
$ rg -c --no-filename 'exit-immediately' packages/pi-sdk/test/client.spec.ts -> 4
```

### C10 CI 内容 + action SHA 固定 + 本任务一次性 create — PASS
(a)
```
$ for p in 'pnpm typecheck' 'pnpm test' 'pnpm build' 'node scripts/check-test-discovery.mjs'; do rg -c --no-filename "$p" .github/workflows/ci.yml; done
1
1
1
1
```
(b)
```
$ rg -n '^\s*-?\s*uses:' .github/workflows/ci.yml
30:        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
34:        uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
40:        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
$ rg -n '^\s*-?\s*uses:' .github/workflows/ci.yml | rg -v '@[0-9a-f]{40}\s*$' | wc -l
0
```
SHA 来源（`gh api` 实查，v4 tag 解引用）：checkout v4 → `11d5960…`；setup-node v4 → `49933ea…`；pnpm/action-setup v4 是 annotated tag，已二次解引用到 commit `b906aff…`。版本号写在 `name:` 与注释里，**不写在 `uses:` 行尾**，否则 `@sha$` 锚定会被 `# v4` 破坏。

(c) 本文件由本任务一次性 create，TASK-002 / TASK-013 只能 modify。`node scripts/check-contract-uniqueness.mjs` 按 criteria 要求**未**写入（该脚本由 TASK-002 创建）。

### C11 CI 不引用任何凭证 — PASS
```
$ test -e .github/workflows/ci.yml && [ "$(rg -c 'secrets\.' .github/workflows/ci.yml | wc -l)" -eq 0 ] && echo PASS
PASS
```

### C12 基线文档关键词 — PASS
```
$ for p in 流式文本增量 'Extension UI' packaged-smoke; do rg -c --no-filename "$p" doc/baseline-2026-08-02.md; done
1
1
2
```

### C13 [UI-observable] 人工走通 dev 模式并逐项打勾 — **NOT RUN**
本轮执行环境无法驱动 Electron GUI 窗口做人工点击，15 项在 `doc/baseline-2026-08-02.md` 中**全部记为「未验证」**，并在文档里写明了原因与补做方式。
不伪造打勾。协议层替身已就位：`normal` 场景吐出的 `thinking_delta` / `text_delta` / `toolcall_end` / `tool_execution_start|end` 使第 1、2、3 项的协议层回归自动化，`extension-ui` 场景覆盖第 10 项。渲染层确认待有 GUI 的环境补做后回填该表。

### C14 [CT-21] 测试发现范围不得被注销 — PASS
(a)
```
$ find . \( -name 'vitest.config.*' -o -name 'vitest.workspace.*' \) -not -path './node_modules/*' -not -path './source/*' | sort
./vitest.config.ts
./vitest.workspace.ts
-- count: 2
```
(b)
```
$ node scripts/check-test-discovery.mjs
discovered 1
onDisk 1
OK: 磁盘上的全部 spec 都在 vitest 的发现范围内
exit=0
```

### C15 [CT-12] node:sqlite 探针 — PASS
```
$ node scripts/probe-node-sqlite.mjs
- electron 版本: 43.2.0
- Electron 内 process.versions.node: 24.18.0
- `require('node:sqlite')`: OK (DatabaseSync,StatementSync,Session,constants,backup)
probe-node-sqlite: 已写入 doc\baseline-2026-08-02.md
exit=0
```
探针走的是 `ELECTRON_RUN_AS_NODE=1 <electron.exe> -e "…"`，不是宿主 node。三行已回写到 `doc/baseline-2026-08-02.md` 的「运行时能力」小节（`<!-- probe:node-sqlite:start -->` 标记块内，可重复执行幂等覆盖）。
结论确认 plan.json design_decisions 第 7 条：TASK-009 采用 `node:sqlite`，`electron-builder.yml` 的 `npmRebuild` 保持 `false`。

### C16 [SYS-1] 断言写法约定 — PASS
`doc/baseline-2026-08-02.md` 的「断言写法约定（SYS-1）」小节逐字记录了三条（否定型 / 计数型 / 禁令）。
```
$ rg -c 'grep -rc' doc/baseline-2026-08-02.md
1
```

## Tests

| 命令 | 结果 |
|------|------|
| `pnpm -w test` | **exit 0**，10 passed (10) |
| `pnpm typecheck` | **exit 0**，pi-sdk Done + app Done |
| `pnpm build` | **exit 0**，main 16.07 kB / preload 1.49 kB / renderer 2929 modules |
| `node tools/fake-pi/fake-pi.mjs --scenario normal` | 正常吐出 response + 事件流 |
| `node tools/fake-pi/fake-pi.mjs --scenario exit-immediately < /dev/null` | exit=0 |
| `node tools/fake-pi/fake-pi.mjs --scenario oversized-line` | 单行输出 16777452 字节（> 16 MB） |

10 个用例分布（4 条关键路径）：

| 路径 | 用例 |
|------|------|
| 1 正常流式响应 | id 与 response.id 一一对应；显式 id 不被内部序号覆盖；按顺序转发文本增量；转发 thinking 增量与 tool 执行事件 |
| 2 畸形 JSON | 畸形行不抛异常且随后 response 仍能关联；畸形行之后的合法事件依旧被转发 |
| 3 进程 crash / ENOENT | exit-immediately 触发一次 exit 事件；crash-mid-stream 以码 1 退出并 reject 在途请求；ENOENT 时在途请求被 reject 而非静默挂起 |
| 4 旧 generation 延迟事件 | abort 响应之后迟到 300ms 的上一代事件仍会送达 |

一次真实缺陷修复：初版 `crash-mid-stream` 在崩溃前 20ms 内仍会应答后续命令，导致「在途请求被 reject」用例拿到的是 response 而非 Error。已在 fixture 里加 `crashing` 标志位 —— 濒死进程不再应答任何命令，这也更贴近真实进程崩溃的行为。

## Deviations

1. **`vitest.workspace.ts` 内容为 `export default ["."]`，而非 task files[] 写的 `["packages/*"]`。**
   理由有二：(a) 写成 `["packages/*"]` 后每个包各自成为一个 project 并回落到 vitest 默认 include，**根 `vitest.config.ts` 的 include 反而完全失效**，与 C5/CT-21「根配置是唯一测试发现真相源」直接冲突；(b) `packages/` 下存在非目录条目（`pi-sdk.zip`、`tsconfig.base.json`），该 glob 会踩空。
   改成 `["."]` 后仅一个 project（仓库根），根配置的 include/exclude 生效，`check-test-discovery.mjs` 实测 discovered == onDisk == 1。C5 与 C14 两条 criteria 均通过。

2. **配置了 remote 并推送到 GitHub，违反 task 原文的 C2 与 implementation 步骤 1「禁止 git remote add / git push」。**
   依据是用户在本次执行指令中的明确覆盖（优先级高于 task 原文）。推送前已实跑安全闸门 `git ls-files | grep -c "^source/"` == 0。C2 按 task 原文如实记为 **failed**。

3. **C13 [UI-observable] 未执行**，见上。基线文档 15 项全部标「未验证」，不伪造。

4. **`packages/pi-sdk/tsconfig.json` 的 `include` 增加了 `"test"`**（task files[] 未列出该文件）。
   不这么改的话 spec 完全不进 `pnpm typecheck`，「CI 跑通类型检查」对测试代码就是空转。改完首轮 typecheck 立刻抓到 3 处真实类型错误（见 Notes 第 2 条），证明这一步有实际收益。

5. **`.gitignore` 的新内容进入了第 1 个「基线快照」commit**，而不是第 2 个。
   因为 `git init` 发生在实现之后，不先有新 `.gitignore` 就无法把 `source/`（GB 级参考树）挡在基线 commit 之外。`package.json` 与 `packages/pi-sdk/tsconfig.json` 已还原成改造前内容参与基线 commit，改动归入第 2 个 commit，历史是干净的。

6. **CI 未写入 `node scripts/check-contract-uniqueness.mjs` 步骤** —— 这是 criteria C10(c) 自身的明确要求（该脚本由 TASK-002 在 wave 2 创建，wave 1 引用必然退出码 1），不算偏离。

## 精简掉的内容（按用户指令 A）

**保留**：fake Pi RPC fixture（全部 9 个场景，后续 task 唯一的回归判定手段）、根级唯一 vitest 配置、CI 骨架、发现范围闸门、运行时探针。

**砍掉**：
- 测试**场景**精简到 4 条关键路径（正常流式 / 畸形 JSON / crash 与 ENOENT / 旧 generation 延迟）。`timeout`、`stderr-noise`、`extension-ui`、`oversized-line` 四个场景**在 fixture 里完整实现**，但本轮不写对应用例 —— 它们分别服务于 A04 的 JSONL buffer 上限、超时处理、Extension UI 五方法等后续 task，由那些 task 按需取用。
- 不写穷举测试矩阵：没有为每个命令类型、每个事件类型各写一个用例；`normal` 场景把 thinking / text / toolcall / tool 执行压进**一条**事件序列，用一个用例覆盖三类 UI 回归判定点。
- 不为每个边界单独写用例：`\r\n` 容忍、空行跳过、超长行等分帧边界只在 fixture 与 `jsonl.ts` 中实现，不单独立用例。
- CI 不跑 coverage、不跑 e2e、不跑打包 —— 只保留 install / typecheck / discovery / test / build 五步。

## Notes

1. **vitest 3.2.7 会对 workspace 文件报 DEPRECATED**（`The workspace file is deprecated and will be removed in the next major. Please, use the test.projects field`）。当前仅是警告、不影响退出码。若将来升到 vitest 4，`vitest.workspace.ts` 会被移除支持，届时需把 projects 声明并入 `vitest.config.ts` 的 `test.projects` —— 但那会让 CT-21(a) 的「恰好 2 行」断言失败，需要同步改 criteria。**这是一个已知的、写进计划里的定时炸弹，后续任务碰到 vitest 升级时必须一并处理。**

2. **`AgentEvent` 联合类型末尾有兜底成员 `{ type: string; [key: string]: unknown }`**（`packages/pi-sdk/src/types.ts:229`）。后果是按 `e.type === "message_update"` 判别**无法收窄**到具体成员 —— 收窄结果是「具体成员 | 兜底成员」，`e.assistantMessageEvent` 仍是 `unknown`。spec 里用 `deltaOf()` 手工取值绕开。
   这是 SDK 类型设计的真实缺陷，会让**所有**消费 `AgentEvent` 的上层代码失去类型保护。本任务不改产品代码，留给后续 task 决定是否去掉兜底成员或改用 `Extract<>`。

3. **fixture 与真实协议的漂移风险**：`scenarios.mjs` 的事件形状照 `@earendil-works/pi-coding-agent@0.83.0` 的 `docs/rpc.md`「Events」章节写。升级 pi 版本时必须重读该章节校对，否则 fixture 会在协议已变的情况下继续「通过」。

4. **CI 从未真实运行过**：workflow 文件已推送但本轮未触发/观察 GitHub Actions 的实际结果。ubuntu runner 上 `pnpm build`（electron-vite build）能否顺利下载 Electron 二进制、`.npmrc` 里的 `electron_mirror=https://npmmirror.com/mirrors/electron/` 在 GitHub 网络下是否可达，都是未验证项。**下一个碰 CI 的 task 应先看一次 Actions 运行记录。**

5. `packages/pi-sdk.zip` 与 `packages/app/tsconfig.web.zip` 是仓库里遗留的两个 zip 产物（共 134 KB），已随基线 commit 进入历史。不属于本任务 scope，未删除。

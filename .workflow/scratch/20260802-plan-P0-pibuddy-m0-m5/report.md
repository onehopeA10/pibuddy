---
verdict: PLAN_READY_LOW_CONFIDENCE
summary: PiBuddy M0-M5 执行计划已产出并经 6 轮验证；本轮未写任何产品代码，M0-M5 出口门禁均未达成。
constraints:
  - DO_NOT_MIGRATE_FRAMEWORK=true，保持 Electron + Vue 3 + Pinia + Naive UI + electron-vite + electron-builder
  - PRIMARY_PLATFORM=Windows 11 x64
  - 非 git 仓库，无法产生 git diff 证据（TASK-001 负责建仓，禁 remote/push）
  - 无 clean VM，packaged 验收只能记 packaged-smoke
  - M4 缺签名与发布凭据，doc:455 规定不得编造
decisions:
  - 六组架构归属由 AI 代裁（IPC 守卫结构性断言、附件注册表唯一 TTL 1800000 滑动、workspaceId=sha256(realpath) 持久化、logger 唯一、会话枚举唯一、契约类型唯一）
  - IPC 目录采用「域内 *-ipc.ts」，依据 doc:344 推荐目录
  - 插话传输保留 prompt + streamingBehavior:"steer"，不改原生 steer（依据 rpc.md:82 原生 steer 禁扩展命令）
  - 长对话反向分页走本地 SQLite offset 而非 pi RPC（依据 rpc.md:696 since 仅向前）
  - 用户确认：M4 接受 blocked-by-credential；SES-101 会话树 UI 接受裁剪
concerns:
  - 置信度 0.75，标记 LOW_CONFIDENCE：修订轮次超限（W002）
  - user_validation 因子 0.05：全程 -y，六组架构归属未经用户逐条确认
  - estimation_accuracy 0.55：16 个 task 中 15 个统一标 large
  - 遗留 NF-1/2/3：TASK-001 c[4] 可能被 vitest.workspace.ts 架空（有行为闸门兜底）、TASK-006 c[1] 反斜杠层数存疑、TASK-006 c[4]/c[5] 用散文 contains
  - 每一轮自检报 PASS 后，下一轮仍能发现真实缺陷；执行阶段应保持同等怀疑度
next:
  - { command: execute, reason: plan ready with low confidence, needs: [current-plan] }
---

# PiBuddy M0-M5 执行计划

## Summary

为 PiBuddy 产品级改造产出 16 个 task / 13 波次的执行计划，覆盖 doc 规格中 M0-M5 的 35 个需求 ID（双向全等，零遗漏）。

本轮**仅做规划，未写任何产品代码**。M0-M5 的出口门禁全部未达成。

## Conclusion / Verdict

计划骨架经独立重算验证健康：依赖图 16 节点 34 边、0 悬空边、0 环、13 波次各含 `[UI-observable]` 条件、3 组并行波次写集两两不相交、悬空路径引用 0。

验收条件层经 6 轮验证（synthesis → check → revise×3 → final check → errata×2），373 条 criteria。每一轮的自检都报 PASS，而下一轮都能发现真实缺陷——这个模式本身是执行阶段最重要的警示。

判定为 **LOW_CONFIDENCE**（W002，修订轮次超限），置信度 0.75，最弱维度 estimation_accuracy 0.55，user_validation 因子 0.05。

## Discussion / Retrospective

三处修正了审计文档的实测发现：

1. **SES-001 会话目录编码在 Windows 上完全正确**，缺陷只在 macOS/Linux 显现（pi 会剥离前导分隔符，PiBuddy 没有）。验收因此必须写成不经 `path.resolve` 的纯函数单测，否则在开发机上永远无法验证失败。
2. **RUN-003 的 ENOENT** 真正问题是 `proc.on("exit")` 永不触发导致死 client 滞留 map，而非 `running` 恒为 true。
3. **`get_entries` 的 `since` 游标只能向前**（rpc.md:696），协议无反向分页 API——原计划的「向上加载更早历史」取数模型不成立，改走本地 SQLite offset。

两处架构级冲突在计划阶段被拦下：

- **33ms 事件折叠的正确性依赖「事件携带累积快照」**。M3 若改为 delta 拼帧，折叠会从无损优化退化为静默丢字符——不抛错、不失败类型检查、只在长回复偶发。
- **守卫断言钉死在 `main/ipc.ts`**，TASK-009 迁走 handler 后约 50 个新 channel 全裸奔而 CI 依然绿。已改为结构性断言（全仓 `ipcMain.handle(` 直接调用点除守卫外命中数 0）。

一个反复出现的失效模式值得记：**写下的验收条件本身跑不通或恒真**。实例包括供应链 pin 闸门的正则不认 `- uses:` 紧凑写法（装上去永不报警）、`rg -vc` 计数为 0 时不输出 `0` 而是 exit 1、`rg` 不支持 look-around 直接退出码 2。凡是没被实际执行过的验收条件，都不能假定它有效。

## Artifacts

- `outputs/plan.json` — 计划总览，含 35 条 requirement_traceability、6 条 unreachable_exit_gates、13 条 deferred_requirements、11 条 residual_risks、28 条 design_decisions
- `outputs/tasks/TASK-001.json` … `TASK-016.json` — 16 个 task
- `outputs/waves.json`、`outputs/dependency-graph.json`
- `outputs/exploration-{architecture,implementation,risk}.json` — 三份源码实测证据
- `outputs/plan-check.json`、`plan-check-final.json` — 首轮与终轮审查
- `outputs/revision-round-{1,2,3}.json`、`errata-{1,2}.json` — 修订与勘误记录

## Handoff / Next

执行入口：`/maestro-execute`，从 wave 1（TASK-001）开始。

TASK-001 是全部后续工作的前提——它建 git 仓库（禁 remote/push）、根级唯一 vitest 配置、fake Pi RPC fixture（9 场景）与最小 CI。在它完成前，「现有功能无回归」没有任何可执行的判定手段：15 项已闭环功能的回归全部表现为运行时静默行为变化，无一会导致类型错误或构建失败。

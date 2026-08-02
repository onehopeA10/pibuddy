# TASK-005 运行时生命周期 · 人工回归记录

执行时间：2026-08-02
形态：`npx electron .`（`packages/app/out`，本次 `pnpm build` 产物），
经 `--remote-debugging-port=9222` 用 CDP 驱动真实渲染进程，非模拟。
运行时：bundled（`node_modules` 里的 pi 0.83.0），真实 provider（GPT-5.6 Sol）。

## 结论

全部通过。过程中发现并修掉一个由本任务引入的真实回归（见文末）。

## 勾选项

- [x] **启动即可用**：应用启动后 `pi_runtime_launched` 记录到
      `runtimeId=…/generation=1/protocolVersion=1`，输入框可用，无任何错误浮层。
- [x] **流式对话未被破坏**：发送「逐条列出 1 到 15 的平方数」，聊天区文本逐步增长
      （`π` → 思考块 → 1..15 逐条出现），顶栏花费由 `$0` 变为 `$0.12`，
      会话列表实时新增该会话。
- [x] **thinking 折叠未被破坏**：渲染出「💭 思考过程 ▼」可折叠块。
- [x] **流式状态正确**：流式期间 store `streaming === true`、输入框下方出现
      「正在努力工作中… 你可以随时输入新指令插话，或点『停止』」与「⏹ 停止」按钮；
      settle 后回落 `false`。
- [x] **steer 插话未被破坏**：流式进行中发送「等一下，改成只数到 10 就好」，
      界面提示「已插话，助手会尽快处理你的新指令」与「（已排队 1 条插话）」，
      且模型实际改为只数到 10 —— 说明走的仍是
      `prompt + streamingBehavior:"steer"`，未被改成 pi 原生 `steer` 命令。
- [x] **c[18] 连点两次「开始新任务」**：在流式回复进行中连续点击两次，
      界面**未**弹出「智能体进程意外退出，请重新开始」；输入框保持可用，
      随后立即发送下一条消息成功并正常收到回复。
- [x] **c[19] external 指向不存在的命令**：把 `piRuntimeMode` 设为 `external`、
      `piExternalCommand` 设为 `D:/definitely-missing/pi-not-here.exe` 后重启运行时，
      界面显示：

      😥 启动失败
      [PI_RUNTIME_RESOLVE_FAILED] 无法定位 pi 运行时：
      [PI_RUNTIME_RESOLVE_FAILED] ENOENT: 外部 pi 命令不存在
      "D:/definitely-missing/pi-not-here.exe"（已按显式路径查找）

      文案同时 contains `ENOENT` 与缺失命令名，且 **not contains**「智能体尚未启动」。
- [x] **失败后可恢复**：改回 `bundled` 并重启运行时，`startError` 清空、
      `currentGeneration` 由 1 递增到 2、`droppedEnvelopes === 0`、无崩溃提示 ——
      即一次真实的代际切换没有污染新会话。

## 过程中发现并修复的回归（本任务自身引入）

**症状**：加信封之后，流式文本照常渲染，但 `streaming` 恒为 `false`、
「停止」按钮不出现，插话被 pi 拒绝并回
`Agent is already processing. Specify streamingBehavior (...)`。
store 的 `droppedEnvelopes` 持续增长（实测 20 → 27）。

**根因**：三条 push 通道共用同一个单调 `sequence` 计数器，但 `pi:event` 走 33ms
合批、`pi:ui-request` / `pi:exit` 立即发出。扩展（AUTO/ACT/YOLO 状态）频繁发
`setStatus` ui-request，它带着更大的 sequence 先于队列里的事件到达；
渲染进程的序号闸门若按**全局**判定，紧随其后的一整批事件就会被误判为
「序号倒退」而全部丢弃，`agent_start` 首当其冲。

**修复**：序号单调性改为**按通道**判定（generation 仍全局判定）。同一通道内部的
子序列仍严格递增，因此按通道判既安全又够用。
回归测试：`packages/app/test/generation.spec.ts` 的
「ui-request 抢先到达不会吃掉随后合批送达的事件」。

**教训**：这条 bug 能让单测全绿而界面静默降级 —— 只有真机跑一次流式对话
才暴露得出来。c[18] 这类 UI-observable 判据不可省略。

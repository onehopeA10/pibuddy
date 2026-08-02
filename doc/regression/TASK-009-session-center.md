# TASK-009 会话中心 · 既有闭环功能人工回归记录

真机验证方式：`electron-vite preview` 启动打包产物，经 `scripts/cdp-eval.mjs`
从**真实 DOM 与真实 store 状态**取证（不是读代码推断）。工作目录 `D:\pi\test`，
11 个真实会话文件，模型 `gpt-5.6-sol`。

- [x] 2026-08-03T00:19:41+08:00 会话列表与切换：列表 11 条（store.rows=11 与
      `.session-item` DOM 节点数一致）；切到最大的历史会话后 `currentSessionId`
      随之更新、`sessionLoadError` 为空、`.msg-row` 13 条 / `.tool-chip` 5 个 /
      `.thinking-block` 4 个全部渲染，`.session-item.active` 高亮命中
- [x] 2026-08-03T00:21:05+08:00 流式文本增量：发出「从1数到300」后 `streaming`
      转 true，`activityTick` 由 6 递增到 88（ChatView 滚动驱动未断），
      `droppedEnvelopes` 为 0，无 `status==='running'` 的僵死工具卡片；
      流式中插话（prompt + streamingBehavior:"steer"）被接受，提示「已插话，
      助手会尽快处理你的新指令」，助手最终回「已停止」
- [x] 2026-08-03T00:21:05+08:00 模型切换：`gpt-5.6-sol` → `claude-fable-5` →
      切回 `gpt-5.6-sol`，`currentModel.id` 两次都如实跟随
- [x] 2026-08-03T00:21:05+08:00 费用显示：`stats.cost` 由 0.3536 增至 0.4031，
      侧边栏 footer 实际渲染为「本次花费 $0.40」

## 会话中心新功能的真机取证（非既有闭环，附记）

- 搜索：关键字命中 7/11，无匹配时列表为 0 且显示「没有匹配的任务」，清空后回到 11
- 重命名：活动会话经 `set_session_name` 落盘 —— 会话文件里实际出现
  `{"type":"session_info","name":"活动会话改名测试"}`；非活动会话只写索引，
  其 .jsonl 未被写入
- 新建会话立即改名：pi 惰性写文件，此时磁盘上没有会话文件，改名仍经 RPC 生效，
  发出第一条消息后索引读回该名字并显示在列表中
- 置顶 / 归档 / 回收站 / 恢复：11 → 10（归档）→ 回收站页 1 条 → 恢复回 11
- **回收站不动真相源**：整轮整理操作前后对 11 个 .jsonl 做 sha256 全量比对，
  `changed: NONE` / `missing: NONE`
- 反向分页：对 25298 字节的真实会话连续翻页至 `nextBeforeOffset === null`，
  得到 28 条 entry、28 个唯一 id，首尾 id 与整文件逐行解析的结果逐字相同

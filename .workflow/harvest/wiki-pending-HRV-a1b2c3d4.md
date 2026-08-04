---
type: knowhow
slug: harvest-scratchpad-capability-research
title: 能力包集成协议(多 agent 并行 → 主干)
tags: [integration, worktree, capability, harvest]
confidence: low  # pending offline — wiki create 不可用,待手工入库
---

# 能力包集成协议(11+ 包实战沉淀)

worktree agent 完成 → 逐个 merge 进 main → catalog/AppShell 结构冲突一律人工修
(禁 sed 跨括号)→ typecheck + 全量测试 + 结构断言 → 有新依赖先 pnpm install →
pnpm dist → 核对 app.asar mtime 是新产物 → 真机 CDP 验证(能力数/入口/无 error)
→ 一次推送 origin。

要点:
- 集成以 agent 分支为权威,共享树污染 `git checkout -- .` 丢弃
- 每合一个包过一遍全量门禁,不攒批
- 安全相关能力(remote 等)的验证不信 agent 自述,主流程独立复验
  (netstat 监听面 / curl 拒绝路径 / 打包产物)

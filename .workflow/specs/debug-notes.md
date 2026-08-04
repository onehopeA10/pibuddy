---
title: "Debug Notes"
readMode: optional
priority: medium
category: debug
keywords:
  - debug
  - issue
  - workaround
  - root-cause
  - gotcha
---

# Debug Notes

## Entries



<spec-entry category="debug" keywords="sed,merge冲突,capability-catalog,appshell" date="2026-08-04" sid="S-20260804-al3m" title="结构性冲突禁 sed 跨括号,一律人工修" description="harvest: OVERNIGHT-PLAN 教训" source="main@5161c4a">

### 结构性冲突禁 sed 跨括号,一律人工修

catalog/AppShell 等中央装配文件的 merge 冲突涉及括号/标签边界时,禁止用 sed 跨行删改(两次吞掉 }); 与 </n-button>,Vue 编译器容忍、仅真机可见)。人工修结构边界,改后跑结构断言+真机验证。

</spec-entry>

<spec-entry category="debug" keywords="worktree,并行agent,git-race" date="2026-08-04" sid="S-20260804-wkug" title="并行 worktree agent 铁律:只在自己 worktree 相对路径写" description="harvest: OVERNIGHT-PLAN 教训" source="main@5161c4a">

### 并行 worktree agent 铁律:只在自己 worktree 相对路径写

agent 用绝对路径写共享 checkout 会污染 main 工作区(实发:后台池 agent 留下 244 行过期中间态)。铁律:agent 只在自身 worktree 内用相对路径改文件、只提交自己分支;主流程集成时以分支为权威,共享树污染 git checkout -- . 丢弃。

</spec-entry>

<spec-entry category="debug" keywords="npx,spawn,windows,mcp" date="2026-08-04" sid="S-20260804-u0jy" title="Windows npx.cmd 在 shell:false 不可 spawn" description="harvest: FEAT 深度打磨批" source="main@5161c4a">

### Windows npx.cmd 在 shell:false 不可 spawn

npx.cmd 等 cmd 包装脚本在 spawn shell:false 下起不来;修法:cmd.exe /c + windowsVerbatimArguments 双层转义把参数括死,不放宽 shell:true(安全边界不动)。

</spec-entry>
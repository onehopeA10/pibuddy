---
title: "Architecture Constraints"
readMode: required
priority: high
category: arch
keywords:
  - architecture
  - module
  - layer
  - boundary
  - dependency
  - structure
---

# Architecture Constraints

## Module Structure

## Layer Boundaries

## Dependency Rules

## Technology Constraints

## Entries



<spec-entry category="arch" keywords="pi-import,kernel-boundary,session-tree" date="2026-08-04" sid="S-20260804-9y4q" title="PI_IMPORT_ALLOWLIST 只减不增:common 能力不得 import pi 域" description="harvest: FEAT-session-tree" source="main@5161c4a">

### PI_IMPORT_ALLOWLIST 只减不增:common 能力不得 import pi 域

内核对 pi 域的 import 允许表只减不增(pi runtime 必须可替换)。common 能力需要会话数据时从持久化 JSONL 重建(entry.parentId 即树边,append-only),不走 pi get_tree。先例:session-tree 从 JSONL 重建树,只用 workspace.read 权限,按 workspaceId+sessionId 分区。

</spec-entry>

<spec-entry category="arch" keywords="permission,ipc-guard,第五道闸" date="2026-08-04" sid="S-20260804-foi7" title="权限第五道闸:拦截点在主进程,默认拒绝" description="harvest: FEAT-permission-engine" source="main@5161c4a">

### 权限第五道闸:拦截点在主进程,默认拒绝

PermissionEngine 挂 ipc-guard 第五道闸:renderer 被攻陷也只能发 IPC,到需求表通道即被挡。决策次序:上界(manifest 声明集合)→once→session→workspace→拒绝。四档中仅 allow-workspace 落盘;危险权限(process.git/shell、network:、secret:)持久授权必须过主进程原生确认框。

</spec-entry>

<spec-entry category="arch" keywords="capabilitygrants,permissionrules,workspace-store" date="2026-08-04" sid="S-20260804-j0rj" title="capabilityGrants 与 permissionRules 并列,不复用" description="harvest: FEAT-permission-engine" source="main@5161c4a">

### capabilityGrants 与 permissionRules 并列,不复用

permissionRules 按 channel 索引(IPC 准入配额),能力权限按 capabilityId 索引,键域不同不得复用。WorkspaceProfile 新增 capability_grants 列(schema v1→v2 用 ALTER 补列,不动既有数据)。

</spec-entry>

<spec-entry category="arch" keywords="remote,agent-pool,rfc6455" date="2026-08-04" sid="S-20260804-g9zb" title="Remote 架构:零新依赖 + agent-pool sanctioned 入口" description="harvest: FEAT-remote" source="main@5161c4a">

### Remote 架构:零新依赖 + agent-pool sanctioned 入口

远程服务全用 node 内置(http/crypto/sqlite),WS 手写 RFC6455 免引原生 bufferutil。发 prompt/停止经 agent-pool 的 poolRuntimeHost().deliver / agentPool().stopSession 投递,与 child-agent/workflow 同一 sanctioned 入口,不新增 pi 域 import。网络 listener 风险面由 runtime.teardown+exposure.dispose 强制可拆卸表达。

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-13" sid="S-20260813-09345bdc1c83e0a0" title="Goal mode = scheduler 多 wake，pool-run-trigger 保持单次 settle" description="Promoted from run:20260813-001-analyze, artifact:ART-001-001, artifact:ART-001-002, artifact:ART-001-003, artifact:ART-001-004, artifact:ART-001-005, report.md#decision:D-001" source="session:20260813-analyze-genericagent:KDC-09345bdc1c83e0a0">

### Goal mode = scheduler 多 wake，pool-run-trigger 保持单次 settle

Goal mode = scheduler 多 wake，pool-run-trigger 保持单次 settle

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-13" sid="S-20260813-1e88455c52e79dac" title="L1 指针 SOP 与现有 FTS 并存；No Execution No Memory；禁止自动结晶" description="Promoted from run:20260813-001-analyze, artifact:ART-001-001, artifact:ART-001-002, artifact:ART-001-003, artifact:ART-001-004, artifact:ART-001-005, report.md#decision:D-003" source="session:20260813-analyze-genericagent:KDC-1e88455c52e79dac">

### L1 指针 SOP 与现有 FTS 并存；No Execution No Memory；禁止自动结晶

L1 指针 SOP 与现有 FTS 并存；No Execution No Memory；禁止自动结晶

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-13" sid="S-20260813-2c837dbaf08fccb0" title="SOP/L1 指针记忆只是建议文本，永不参与授权判定；写入须用户确认" description="Promoted from run:20260813-001-analyze, artifact:ART-001-001, artifact:ART-001-002, artifact:ART-001-003, artifact:ART-001-004, artifact:ART-001-005, report.md#constraint:C-003" source="session:20260813-analyze-genericagent:KDC-2c837dbaf08fccb0">

### SOP/L1 指针记忆只是建议文本，永不参与授权判定；写入须用户确认

SOP/L1 指针记忆只是建议文本，永不参与授权判定；写入须用户确认

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-13" sid="S-20260813-75792bab1b2fbae8" title="不引入 code_run 无界原语，不把真实浏览器登录态纳入本阶段实施" description="Promoted from run:20260813-001-analyze, artifact:ART-001-001, artifact:ART-001-002, artifact:ART-001-003, artifact:ART-001-004, artifact:ART-001-005, report.md#constraint:C-001" source="session:20260813-analyze-genericagent:KDC-75792bab1b2fbae8">

### 不引入 code_run 无界原语，不把真实浏览器登录态纳入本阶段实施

不引入 code_run 无界原语，不把真实浏览器登录态纳入本阶段实施

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-13" sid="S-20260813-884c3bf1da97715c" title="无人值守只认 workspace 预授权，Goal 不得跨 wake 保活会话，不得使用 once/session" description="Promoted from run:20260813-001-analyze, artifact:ART-001-001, artifact:ART-001-002, artifact:ART-001-003, artifact:ART-001-004, artifact:ART-001-005, report.md#constraint:C-002" source="session:20260813-analyze-genericagent:KDC-884c3bf1da97715c">

### 无人值守只认 workspace 预授权，Goal 不得跨 wake 保活会话，不得使用 once/session

无人值守只认 workspace 预授权，Goal 不得跨 wake 保活会话，不得使用 once/session

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-13" sid="S-20260813-8d8d97473e7c0c3f" title="工作 notepad 走 pi:prompt 注入缝，与 memory-inject 并列，不声称省 token" description="Promoted from run:20260813-001-analyze, artifact:ART-001-001, artifact:ART-001-002, artifact:ART-001-003, artifact:ART-001-004, artifact:ART-001-005, report.md#decision:D-002" source="session:20260813-analyze-genericagent:KDC-8d8d97473e7c0c3f">

### 工作 notepad 走 pi:prompt 注入缝，与 memory-inject 并列，不声称省 token

工作 notepad 走 pi:prompt 注入缝，与 memory-inject 并列，不声称省 token

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-13" sid="S-20260813-abf68a2646b5c151" title="空转自愈看门狗放 pool-run-trigger（runtime 中立）" description="Promoted from run:20260813-001-analyze, artifact:ART-001-001, artifact:ART-001-002, artifact:ART-001-003, artifact:ART-001-004, artifact:ART-001-005, report.md#decision:D-004" source="session:20260813-analyze-genericagent:KDC-abf68a2646b5c151">

### 空转自愈看门狗放 pool-run-trigger（runtime 中立）

空转自愈看门狗放 pool-run-trigger（runtime 中立）

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-18" sid="S-20260818-96d4683d000250b3" title="secret 写入 memories / candidates / Hindsight 都必须先过 classifyContent" description="Promoted from run:20260818-001-companion, report.md#constraint:C-001" source="session:20260818-companion-mem-warn-20260818-123612:KDC-96d4683d000250b3">

### secret 写入 memories / candidates / Hindsight 都必须先过 classifyContent

secret 写入 memories / candidates / Hindsight 都必须先过 classifyContent

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-18" sid="S-20260818-80a91e005219acaf" title="live 证据必须带 workspaceId，缺省为空" description="Promoted from run:20260818-001-companion, report.md#constraint:C-002" source="session:20260818-companion-mem-warn-20260818-123612:KDC-80a91e005219acaf">

### live 证据必须带 workspaceId，缺省为空

live 证据必须带 workspaceId，缺省为空

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-18" sid="S-20260818-fab9fc4af8b06645" title="inject 删除 resolveAuthority(fresh)，只信 resolveEnvelopes" description="Promoted from run:20260818-001-companion, report.md#decision:D-001" source="session:20260818-companion-mem-warn-20260818-123612:KDC-fab9fc4af8b06645">

### inject 删除 resolveAuthority(fresh)，只信 resolveEnvelopes

inject 删除 resolveAuthority(fresh)，只信 resolveEnvelopes

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-18" sid="S-20260818-0dfd8fd701367ccd" title="admitted 的 reflect/observation 仍进 DERIVED，不进 VERIFIED" description="Promoted from run:20260818-001-companion, report.md#decision:D-002" source="session:20260818-companion-mem-warn-20260818-123612:KDC-0dfd8fd701367ccd">

### admitted 的 reflect/observation 仍进 DERIVED，不进 VERIFIED

admitted 的 reflect/observation 仍进 DERIVED，不进 VERIFIED

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-18" sid="S-20260818-1fad7a7d95296a62" title="无 critical 且 high≤5 时审查只读，修复另开 companion，封链前须给 residual 开票或 depends_on" description="Promoted from run:20260818-001-retrospective, artifact:ART-001-001, artifact:ART-001-002, report.md#decision:D-001" source="session:20260818-phase-0-6:KDC-1fad7a7d95296a62">

### 无 critical 且 high≤5 时审查只读，修复另开 companion，封链前须给 residual 开票或 depends_on

无 critical 且 high≤5 时审查只读，修复另开 companion，封链前须给 residual 开票或 depends_on

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-18" sid="S-20260818-46b1405f863e9eb4" title="inject 只信 resolveEnvelopes，禁止再跑 resolveAuthority(fresh)" description="Promoted from run:20260818-001-retrospective, artifact:ART-001-001, artifact:ART-001-002, report.md#constraint:C-001" source="session:20260818-phase-0-6:KDC-46b1405f863e9eb4">

### inject 只信 resolveEnvelopes，禁止再跑 resolveAuthority(fresh)

inject 只信 resolveEnvelopes，禁止再跑 resolveAuthority(fresh)

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-18" sid="S-20260818-50917ded7fab6efb" title="memories / candidates / Hindsight / seed 每个写入口必须自带 classifyContent 与 workspace 隔离" description="Promoted from run:20260818-001-retrospective, artifact:ART-001-001, artifact:ART-001-002, report.md#constraint:C-002" source="session:20260818-phase-0-6:KDC-50917ded7fab6efb">

### memories / candidates / Hindsight / seed 每个写入口必须自带 classifyContent 与 workspace 隔离

memories / candidates / Hindsight / seed 每个写入口必须自带 classifyContent 与 workspace 隔离

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-18" sid="S-20260818-b55f63515597eefe" title="skip 或 in-process slot 测试不能当作 live-IO 验收关闭" description="Promoted from run:20260818-001-retrospective, artifact:ART-001-001, artifact:ART-001-002, report.md#decision:D-002" source="session:20260818-phase-0-6:KDC-b55f63515597eefe">

### skip 或 in-process slot 测试不能当作 live-IO 验收关闭

skip 或 in-process slot 测试不能当作 live-IO 验收关闭

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-18" sid="S-20260818-1d0e9aaa28abfae9" title="用户「记住」进 Hindsight 时 workspaceId=null，跨项目 User Recall 才能看见" description="Promoted from run:20260818-001-companion, report.md#constraint:C-002" source="session:20260818-companion-mem-medium-20260818-150121:KDC-1d0e9aaa28abfae9">

### 用户「记住」进 Hindsight 时 workspaceId=null，跨项目 User Recall 才能看见

用户「记住」进 Hindsight 时 workspaceId=null，跨项目 User Recall 才能看见

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,constraint" date="2026-08-18" sid="S-20260818-3c0434c770135f58" title="Hindsight search/list 缺 workspaceId 必须返回空，不能 fail-open 全库" description="Promoted from run:20260818-001-companion, report.md#constraint:C-001" source="session:20260818-companion-mem-medium-20260818-150121:KDC-3c0434c770135f58">

### Hindsight search/list 缺 workspaceId 必须返回空，不能 fail-open 全库

Hindsight search/list 缺 workspaceId 必须返回空，不能 fail-open 全库

</spec-entry>

<spec-entry category="arch" keywords="session-knowledge,decision" date="2026-08-18" sid="S-20260818-951668f6bc7dee33" title="candidate 仍记当前工作区作 origin；跨项目可见性只靠 user-scoped Hindsight" description="Promoted from run:20260818-001-companion, report.md#decision:D-001" source="session:20260818-companion-mem-medium-20260818-150121:KDC-951668f6bc7dee33">

### candidate 仍记当前工作区作 origin；跨项目可见性只靠 user-scoped Hindsight

candidate 仍记当前工作区作 origin；跨项目可见性只靠 user-scoped Hindsight

</spec-entry>
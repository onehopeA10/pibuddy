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
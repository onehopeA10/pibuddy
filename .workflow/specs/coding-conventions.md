---
title: "Coding Conventions"
readMode: required
priority: high
category: coding
keywords:
  - style
  - naming
  - import
  - pattern
  - convention
  - formatting
---

# Coding Conventions

## Formatting

## Naming

## Imports

## Patterns

## Entries



<spec-entry category="coding" keywords="node-pty,native_allowlist,asarunpack,n-api" date="2026-08-04" sid="S-20260804-gz6e" title="原生模块破例三前提(NATIVE_ALLOWLIST)" description="harvest: FEAT-terminal" source="main@5161c4a">

### 原生模块破例三前提(NATIVE_ALLOWLIST)

能力包默认纯 JS;原生模块进 NATIVE_ALLOWLIST 须同时满足:①N-API(node-addon-api,ABI 跨版本稳定,npmRebuild:false 不动)②自带多平台 prebuilds(用户机不编译)③electron-builder asarUnpack 外置 .node/.dll/.exe(prebuilt 不能从 asar 虚拟路径执行)。白名单只豁免该包自身检测,仍遍历其依赖闭包。先例:node-pty@1.1.0。

</spec-entry>

<spec-entry category="coding" keywords="manifest,exposure,drift,capability" date="2026-08-04" sid="S-20260804-9k1o" title="能力包 manifest 必须暴露真通道,禁纯 UI 空壳" description="harvest: FEAT-session-tree" source="main@5161c4a">

### 能力包 manifest 必须暴露真通道,禁纯 UI 空壳

manifest schema 强制 exposure{module,register},drift test 对账 register 通道==manifest.channels==契约分片键。channels 为空的纯 UI 包会退化成零通道空壳+空分片(死代码),至少给一条真实通道,让 feature gate(未启用不注册)有可测行为。

</spec-entry>

<spec-entry category="coding" keywords="terminal,ring-buffer,backpressure,envelope" date="2026-08-04" sid="S-20260804-a8aw" title="PTY 输出背压:合并+有界 ring buffer+序号 envelope" description="harvest: FEAT-terminal" source="main@5161c4a">

### PTY 输出背压:合并+有界 ring buffer+序号 envelope

PTY 高频输出先合并再发(不无限缓冲),写入按字符封顶的 ring buffer(超容量从头驱逐),复用 PiEnvelope(generation=tab 代际,sequence=chunk 序号)单向广播。渲染层 reload 用 snapshot 取回内容+末序号重建,推送流只接受更大序号(shouldAcceptEnvelope,与 agent-pool/workflow 同一丢弃规则)。

</spec-entry>
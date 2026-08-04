---
title: "Review Standards"
readMode: required
priority: medium
category: review
keywords:
  - review
  - checklist
  - gate
  - approval
  - standard
---

# Review Standards

## Entries



<spec-entry category="review" keywords="asar,dist,打包验证" date="2026-08-04" sid="S-20260804-cdub" title="打包验证必须核对 app.asar 时间戳" description="harvest: 集成协议教训" source="main@5161c4a">

### 打包验证必须核对 app.asar 时间戳

pnpm build 失败时 dist 可能静默复用旧 asar(实发:依赖未装→build 失败→真机跑的是旧包,现象为能力数对不上)。真机验证前必须:pnpm install(有新依赖时)→build 成功→比对 app.asar mtime 是新产物。

</spec-entry>
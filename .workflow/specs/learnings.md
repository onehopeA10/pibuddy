---
title: "Learnings"
readMode: optional
priority: medium
category: learning
keywords:
  - bug
  - lesson
  - gotcha
  - learning
---

# Learnings

Add entries with: `/maestro-spec learning <description>`

## Entries



<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-0da0c86a446bd59e" title="Normalize every backend to MemoryEnvelope, then run one Authority pass" description="Promoted from run:20260818-001-retrospective, doc/Governed_Hybrid_Memory_Implementation_Spec.md#11; review-findings.json#findings/1" source="session:20260818-phase-0-6:KDC-0da0c86a446bd59e">

### Normalize every backend to MemoryEnvelope, then run one Authority pass

&lt;spec-entry category="pattern" keywords="memory-envelope,authority-resolver,single-adjudication" date="2026-08-18" id="INS-07ae5721" source="retrospective">

### Normalize every backend to MemoryEnvelope, then run one Authority pass

Do not resolve sqlite Records and Envelopes in parallel. RetrievalScore is admission-only and must never change Authority tier; Live A0 must be able to shadow Canonical in the same pass. Treat Envelope-then-single-resolver as the merge contract for any multi-source memory pipeline.

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: technical
- **Confidence**: high
- **Evidence**: doc/Governed_Hybrid_Memory_Implementation_Spec.md#11; review-findings.json#findings/1
- **Routed to**: spec (—)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-12caec70ee66bdf9" title="Fail-closed in-process banks when workspaceId is missing" description="Promoted from run:20260818-001-retrospective, hindsight-adapter.ts:107-110; review-findings.json#findings/7" source="session:20260818-phase-0-6:KDC-12caec70ee66bdf9">

### Fail-closed in-process banks when workspaceId is missing

&lt;spec-entry category="antipattern" keywords="tenant-isolation,fail-closed,in-process-adapter" date="2026-08-18" id="INS-61b7042b" source="retrospective">

### Fail-closed in-process banks when workspaceId is missing

Keyword Adapter search still admits episodes when either side lacks workspaceId. Treat any in-process stand-in for an external store as production-shaped: partition by workspace, refuse missing tenant keys, restore process globals in finally.

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: technical
- **Confidence**: high
- **Evidence**: hindsight-adapter.ts:107-110; review-findings.json#findings/7
- **Routed to**: issue (ISS-20260818-001)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-16039d5803da28ef" title="Inject 只允许一套 Envelope 裁决" description="Promoted from run:20260818-001-retrospective, plan.json#data_flow/stages/2; companion report.md#decisions" source="session:20260818-phase-0-6:KDC-16039d5803da28ef">

### Inject 只允许一套 Envelope 裁决

&lt;spec-entry category="decision" keywords="authority,inject,resolveEnvelopes" date="2026-08-18" id="INS-0838d4a9" source="retrospective">

### Inject 只允许一套 Envelope 裁决

计划写 Resolver 吃 Envelope、忽略 retrieval.final 不够。必须点名 resolveEnvelopes 是 admitted/conflicts/shadowed 的唯一来源，并禁止 inject 再跑 resolveAuthority(fresh)。

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: decision
- **Confidence**: high
- **Evidence**: plan.json#data_flow/stages/2; companion report.md#decisions
- **Routed to**: spec (—)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-33a3dd7895930bf4" title="Put secret and tenant gates inside every write entry, not the happy-path caller" description="Promoted from run:20260818-001-retrospective, spec §23.1; review-findings.json#findings/0; memory-store.ts:1045" source="session:20260818-phase-0-6:KDC-33a3dd7895930bf4">

### Put secret and tenant gates inside every write entry, not the happy-path caller

&lt;spec-entry category="gotcha" keywords="classifyContent,write-entry,retain-vs-commit" date="2026-08-18" id="INS-48a924f2" source="retrospective">

### Put secret and tenant gates inside every write entry, not the happy-path caller

save/update having classifyContent is not enough. Candidates, Adapter seed/retain, and live-evidence slots are also write backends. Any new store method or IPC that inserts memory-shaped data must scan payload and isolate by workspaceId inside the entry.

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: technical
- **Confidence**: high
- **Evidence**: spec §23.1; review-findings.json#findings/0; memory-store.ts:1045
- **Routed to**: spec (—)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-61e0603b97007afa" title="Plan every new write sink against existing secret-scan DoD" description="Promoted from run:20260818-001-retrospective, plan.json#shared_context/patterns; review-findings.json#findings/0" source="session:20260818-phase-0-6:KDC-61e0603b97007afa">

### Plan every new write sink against existing secret-scan DoD

&lt;spec-entry category="gotcha" keywords="memory,write-path,planning-dod" date="2026-08-18" id="INS-1f5afb52" source="retrospective">

### Plan every new write sink against existing secret-scan DoD

Phase 0-1 already required secret scanning, but Phase 2-6 plan only carried zero-cost gate and working_items cleanup. candidate and Hindsight retain were new write sinks not listed in task DoD. Future memories/candidates/external-bank writes must name classifyContent in the TASK definition_of_done.

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: process
- **Confidence**: high
- **Evidence**: plan.json#shared_context/patterns; review-findings.json#findings/0
- **Routed to**: spec (—)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-bec93749589065b9" title="Fail-closed when workspaceId is missing" description="Promoted from run:20260818-001-retrospective, review-findings.json#findings/7; companion report.md#constraints" source="session:20260818-phase-0-6:KDC-bec93749589065b9">

### Fail-closed when workspaceId is missing

&lt;spec-entry category="antipattern" keywords="workspace-isolation,fail-open,R8" date="2026-08-18" id="INS-892f92f3" source="retrospective">

### Fail-closed when workspaceId is missing

Live evidence was a process-global array (R3, later fixed) and Hindsight search still isolates only when both sides have workspaceId (R8, still open). Isolation that treats a missing id as share-all leaks Project A into B.

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: quality
- **Confidence**: high
- **Evidence**: review-findings.json#findings/7; companion report.md#constraints
- **Routed to**: issue (ISS-20260818-001)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-c9b6e65c6d8b9822" title="先列写入槽口再套 classifyContent" description="Promoted from run:20260818-001-retrospective, review-findings.json#findings/0; companion report.md#constraints" source="session:20260818-phase-0-6:KDC-c9b6e65c6d8b9822">

### 先列写入槽口再套 classifyContent

&lt;spec-entry category="gotcha" keywords="classifyContent,secret,retain,candidates" date="2026-08-18" id="INS-81595e28" source="retrospective">

### 先列写入槽口再套 classifyContent

retain≠commit 和 save 拒密钥，挡不住 retainHindsight / insertCandidate / seed。规划时列出 memories、candidates、Hindsight bank、seed 全部落盘口，任一写入前必须先过 classifyContent；rejected 则禁止旁路 retain。

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: decision
- **Confidence**: high
- **Evidence**: review-findings.json#findings/0; companion report.md#constraints
- **Routed to**: spec (—)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-e5832407b4888016" title="Do not seal WARN-highs without a fix loop or residual issues" description="Promoted from run:20260818-001-retrospective, review-findings.json#repair_routing; issues.jsonl" source="session:20260818-phase-0-6:KDC-e5832407b4888016">

### Do not seal WARN-highs without a fix loop or residual issues

&lt;spec-entry category="decision" keywords="review-loop,residual-issues,calendar" date="2026-08-18" id="INS-a4c9c04a" source="retrospective">

### Do not seal WARN-highs without a fix loop or residual issues

post-review sealed with repair_routing=none. Highs later needed a separate companion; R6-R15, Calendar, and real file reads still had no issue. If the chain will not insert a fix loop, file residuals and set depends_on before seal.

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: process
- **Confidence**: high
- **Evidence**: review-findings.json#repair_routing; issues.jsonl
- **Routed to**: issue (ISS-20260818-002)

&lt;/spec-entry>

</spec-entry>

<spec-entry category="learning" keywords="session-knowledge,manual" date="2026-08-18" sid="S-20260818-fc1e0231594a33b5" title="Classify secrets inside every write sink" description="Promoted from run:20260818-001-retrospective, review-findings.json#findings/0; companion report.md#constraints" source="session:20260818-phase-0-6:KDC-fc1e0231594a33b5">

### Classify secrets inside every write sink

&lt;spec-entry category="antipattern" keywords="classifyContent,write-path,secrets" date="2026-08-18" id="INS-7c4f19ea" source="retrospective">

### Classify secrets inside every write sink

R1 discarded retainAsCandidate rejected flag, R4 left insertCandidate to the caller, and Hindsight retain/seed had no classifyContent. memories, candidates, and Hindsight banks must scan inside the sink.

- **Phase**: 1 (01-memory-hybrid-0-6)
- **Lens**: quality
- **Confidence**: high
- **Evidence**: review-findings.json#findings/0; companion report.md#constraints
- **Routed to**: spec (—)

&lt;/spec-entry>

</spec-entry>
# Governed Hybrid Memory 实施规格书

**用途**：交给 Coding AI / 软件工程 Agent 直接实施  
**版本**：v1.0  
**冻结日期**：2026-08-18  
**目标系统**：同时支持 Coding Agent 与长期个人助手的通用 Agent Harness  
**架构基线**：GenericAgent 的 Canonical / Working / L1-L3 治理思想 + Hindsight 的 Experience / Observation / Recall / Reflect  

> 本文是实施规格，不是选型讨论。除“可配置项”外，MVP 阶段应按本文默认值实现，不要擅自引入 Mem0、Letta Runtime、Graphiti/Zep 或新的向量数据库。

---

## 0. 给实施 AI 的执行指令

实现本规格时遵守以下顺序：

1. 先建立类型、接口、SQLite migration 和纯内存单元测试，不接 Hindsight。
2. 实现 CanonicalStore、WorkingMemory、FastAnalyzer、MemoryRouter。
3. 实现 AuthorityResolver、FreshnessGate、ContextMerger。
4. 再接 HindsightAdapter，所有 Hindsight 输出必须先 Normalize 为 `MemoryEnvelope`，禁止直接注入主模型上下文。
5. 最后实现 PostTaskRouter、Retain、Canonical Candidate Promotion、Telemetry。
6. 每完成一个阶段必须跑对应测试；不允许以“模型自己会判断”为理由省略硬规则。
7. 不要重写 Hindsight 内部的向量召回、RRF、图检索、时序检索或 reranker；Harness 只负责跨存储治理。
8. 不要让 Hindsight Experience / Observation / Reflect 直接覆盖 Canonical Truth。
9. `retain != commit`。Hindsight 可自动 retain；Canonical 写入必须过 Promotion Gate。
10. 当前实时数据必须优先于任何历史记忆。

### MVP 明确不做

- 不引入 Mem0。
- 不引入 Letta Runtime；只借鉴 Memory Blocks 思想实现轻量 Working State。
- 不引入 Graphiti/Zep；强时序关系成为实际瓶颈后再评估。
- 不自己实现第二套 embedding / reranker。
- 不做多 Agent 跨组织复杂 ACL；MVP 只保留 scope/owner/visibility 字段和基础隔离。
- 不自动把 Reflect 结论提升为用户事实或项目事实。

---

# 1. 目标与核心原则

## 1.1 系统目标

构建一套通用 Memory Core，让同一个 Agent Harness 同时具备：

- Coding：记住项目事实、架构决策、SOP、历史 debug 经验，同时始终尊重当前 repo 状态。
- Personal Assistant：记住用户稳定偏好、长期目标、历史选择、对话经历与演化模式。
- Long-running Agent：保存当前任务状态，跨长任务压缩上下文，不重复 Recall 已经进入 Working 的信息。
- Learning：从历史 Experience 形成 Observation / Belief，但不把推断当事实。
- Governance：解决冲突、陈旧、覆盖、证据、权限、污染与 token 预算问题。

## 1.2 核心不变量（必须写成回归测试）

1. **Current Live State > All Historical Memory**。
2. **Current User Directive > Stored User Preference**。
3. **Project Hard Constraint > Global User Preference**。
4. **Canonical Fact > Hindsight Observation**。
5. **Hindsight Reflect / Belief 永远不能直接覆盖 Canonical**。
6. **Retrieval relevance score 永远不能改变 Authority Tier**。
7. **Possibly-stale Canonical 在高风险 action 前必须重新验证**。
8. **Retain 永远不等于 Canonical Commit**。
9. **Generic knowledge 默认不 Recall 长期记忆**。
10. **同一任务已进入 Working 的稳定信息默认不重复 Recall**。
11. **用户主观偏好/目标：Current User > Canonical User > Derived Observation**。
12. **Repo/runtime/config：Current Repo/Tool > Canonical Project > Historical Experience**。

## 1.3 一句话架构

> **GenericAgent-style Canonical Governance 管“什么是被验证的真相”；Hindsight 管“过去发生过什么、形成了什么模式”；Memory Router 管“何时、去哪里、查多少”；Authority Resolver 管“谁可信”；Context Merger 管“最终给模型看什么”。**

---

# 2. 源码对齐基线

本文方案不是照搬 GenericAgent 或 Hindsight，而是利用二者当前源码已经验证的边界。

## 2.1 GenericAgent 对齐点

基于 `lsdefine/GenericAgent` 当前 main 分支：

- `memory/global_mem_insight.txt` 被注入全局 prompt，承担小型索引/导航作用，而不是开局加载所有长期记忆。
- Memory SOP 明确：L1 严格控制在约 30 行、期望低于 1k token，只保留“场景关键词 -> L2/L3 指针”和极少 RULES。
- L2 存环境特异性事实，禁止易变状态、猜测和通用常识。
- L3 只存跨会话仍重要、难以低成本重建的专项经验/SOP。
- 核心公理是 Action-Verified Only / “No Execution, No Memory”。
- `do_file_read()` 读取 memory/SOP 后提示模型将真正重要的信息提取进 Working Memory。
- `working['key_info']` 与 `_get_anchor_prompt()` 体现“长期记忆 -> 当前任务工作记忆”的二次压缩思想。
- `start_long_term_update` 只在任务结束、存在长期价值且验证成功时触发，并要求先读现有 memory、最小 patch。
- `log_memory_access()` 已有简单访问统计，可扩展为 Router Telemetry。

本方案保留这些思想，但做三项扩展：

1. 将 L2/L3 拆成结构化 `fact / constraint / decision / procedure`。
2. 将历史经历、Observation、Reflect 交给 Hindsight。
3. 增加显式 Memory Router + Authority Resolver + Freshness Gate。

## 2.2 Hindsight 对齐点

基于 `vectorize-io/hindsight` 当前 main 分支 Python client：

- 使用 `aretain / arecall / areflect` 作为 async Harness 的首选接口。
- `recall(types=...)` 的真实类型是 `world / experience / observation`，不能直接传 Harness 的 `preference / decision / procedure`。
- Recall 原生支持：`query_timestamp`、`tags`、`tags_match`、`tag_groups`、`prefer_observations`、`min_scores`、`include_source_facts`、token budget。
- Reflect 原生支持：`response_schema`、`include_facts`、`fact_types`、tag filtering。
- Bank 配置支持：`retain_mission`、`retain_extraction_mode`、`enable_observations`、`observations_mission`、`enable_temporal_retrieval`、`enable_graph_retrieval`、`enable_reranking`、`reflect_mission`、`background`。
- `aretain(... retain_async=False)` 是 async Python 调用，但后端默认不是后台排队；`retain_async=True` 才表示后台处理。

因此 Harness 不重写 Hindsight Bank 内部检索排序；只做 scope、authority、freshness 和跨来源 merge。

---

# 3. 总体架构

```text
                         User Request
                              |
                              v
                     +----------------+
                     |  Task Analyzer |
                     +-------+--------+
                             |
                             v
                     +----------------+
                     | Memory Router  |
                     | -> MemoryPlan  |
                     +-------+--------+
                             |
           +-----------------+------------------+
           |                 |                  |
           v                 v                  v
      Working State     Canonical Store     Hindsight
                        L1 -> L2/L3       Recall / Reflect
           |                 |                  |
           +-----------------+------------------+
                             v
                     +----------------+
                     |   Normalizer   |
                     | MemoryEnvelope |
                     +-------+--------+
                             v
                     +----------------+
                     |   Authority    |
                     |    Resolver    |
                     +-------+--------+
                             v
                     +----------------+
                     | Conflict Engine|
                     +-------+--------+
                             v
                     +----------------+
                     | Freshness Gate |
                     +-------+--------+
                             |
                    live validation?
                       /           \
                     yes           no
                      |             |
                Tool/Repo/API       |
                      +------+------+
                             v
                     +----------------+
                     | Context Merger |
                     +-------+--------+
                             v
                           Agent
                             |
                       Tool Execution
                             |
                             v
                     +----------------+
                     | PostTaskRouter |
                     +-------+--------+
                         /         \
                        v           v
                Hindsight Retain   Candidate
                                   Validator
                                      |
                                Canonical Commit
```

---

# 4. Memory 逻辑模型

## 4.1 Scope

MVP 固定五个 scope：

| Scope | 用途 | MVP |
|---|---|---|
| `working` | 当前任务/会话工作状态 | 必须 |
| `user` | 用户事实、偏好、目标、历史经历 | 必须 |
| `project` | 当前 repo/项目事实、决策、SOP、经验 | 必须 |
| `agent` | Agent 自己的工具/策略经验 | 必须，低频启用 |
| `organization` | 团队/公司共享规范 | 预留，MVP 可最小实现 |

## 4.2 Harness Logical Kind

```text
fact
preference
constraint
decision
procedure
experience
belief
```

严格区分：

- `fact`：被验证的事实。
- `preference`：用户偏好，不等于硬约束。
- `constraint`：当前 scope 下必须遵守的规则。
- `decision`：曾明确作出的设计/选择及原因。
- `procedure`：经验证可复用 SOP。
- `experience`：历史事件/执行经历。
- `belief`：由多个经历归纳出的模式、假设、Mental Model。

## 4.3 Hindsight Fact Type 映射

Hindsight 的 `types` 与 Harness Logical Kind 是两个维度：

| Harness Kind | Canonical | Hindsight types | 推荐 tag |
|---|---:|---|---|
| fact | 是 | `world` | `kind:fact` |
| preference | 是 | `world`,`observation` | `kind:preference` |
| constraint | 是 | `world` | `kind:constraint` |
| decision | 是 | `world`,`experience` | `kind:decision` |
| procedure | 是 | `experience`,`observation` | `kind:procedure` |
| experience | 否 | `experience` | `kind:experience` |
| belief | 否 | `observation` / Reflect | `kind:belief` |

**规则**：不要把 `preference` 等直接传给 Hindsight `types`。

---

# 5. 存储布局

## 5.1 用户级目录

```text
~/.agent-memory/
├── INDEX.yaml
├── user/
│   ├── profile.yaml
│   ├── preferences.yaml
│   ├── goals.yaml
│   ├── people.yaml
│   ├── devices.yaml
│   └── decisions/
├── procedures/
├── archive/
└── memory.sqlite
```

## 5.2 项目级目录

```text
<repo>/.agent-memory/
├── INDEX.yaml
├── facts/
│   ├── architecture.yaml
│   ├── environment.yaml
│   ├── dependencies.yaml
│   └── conventions.yaml
├── decisions/
│   ├── ADR-001-*.md
│   └── ADR-002-*.md
├── procedures/
│   ├── build.md
│   ├── test.md
│   ├── deploy.md
│   └── debug-*.md
├── candidates/
│   └── pending.jsonl
├── archive/
└── memory.sqlite   # 可选；推荐全局 SQLite + workspace_id
```

推荐实现：**内容文件人类可读 + 一个全局 SQLite 保存元数据/索引/telemetry**。项目目录中的 Canonical 文件可 Git 版本管理。

## 5.3 INDEX.yaml 原则

L1 只做导航，不存完整知识：

```yaml
project:
  database:
    facts: facts/environment.yaml
    decisions: decisions/ADR-001-database.md
    keywords: [postgres, database, storage]

  build:
    procedure: procedures/build.md
    keywords: [build, install, package]

  auth:
    facts: facts/architecture.yaml#auth
    procedure: procedures/debug-auth.md
    keywords: [auth, login, oauth, token]
```

约束：

- 推荐 <= 30 行核心路由；大型项目可采用分区 INDEX，但每个常驻索引保持小型。
- 禁止将 How-to 细节塞入 L1。
- L1 修改只做最小 patch。
- L1 不保存 secret。

---

# 6. Working Memory

Working 是“当前任务缓存”，不是长期真相。

```python
class WorkingItem(BaseModel):
    id: str
    kind: str
    content: str
    source_memory_id: str | None = None
    source_hash: str | None = None
    created_turn: int
    expires: Literal["task_end", "session_end", "manual"] = "task_end"
    refresh_on_source_change: bool = True
```

推荐块：

```text
IDENTITY
USER_SUMMARY
CURRENT_GOAL
ACTIVE_PROJECT
CONSTRAINTS
DECISIONS_IN_FORCE
LOADED_PROCEDURES
COMPLETED_STEPS
UNRESOLVED
TRIED_APPROACHES
```

规则：

1. 首次 Canonical/Hindsight Recall 后，真正与本任务持续相关的信息应压缩进入 Working。
2. 后续 turn 优先命中 Working；不要重复 Recall。
3. 若关联的 `source_hash` 变化，Working item 自动失效。
4. 任务结束默认清理 task-scoped Working，但允许将必要状态 checkpoint 到 session/project progress 文件。

---

# 7. Task Analyzer

## 7.1 输出结构

```python
class TaskAnalysis(BaseModel):
    intent: Literal[
        "knowledge", "coding", "personal", "action",
        "planning", "analysis", "conversation", "mixed"
    ]
    memory_signal: Literal["none", "implicit", "explicit"]
    history_need: Literal["none", "continuation", "episodic", "pattern"]
    current_state_need: Literal["none", "preferred", "required"]
    scopes: dict[str, bool]
    logical_kinds: list[str]
    entities: list[str]
    temporal_expressions: list[str]
    ambiguity: float
```

## 7.2 Fast Analyzer 优先

MVP 目标：约 80% 请求不需要额外 Analyzer LLM。

流程：

```python
analysis = fast_analyze(request, working_state, project_state)
if analysis.ambiguity > 0.35:
    analysis = await llm_analyze(request, context, analysis)
```

`0.35` 是初始工程参数，放入配置。

## 7.3 history_need 判定

| 值 | 含义 | 例子 |
|---|---|---|
| none | 不依赖历史 | “HTTP 429 是什么？” |
| continuation | 继续当前/近期工作 | “继续昨天那个 Router” |
| episodic | 找具体历史事件 | “上次 Docker 为什么失败？” |
| pattern | 跨多个历史事件归纳 | “为什么最近三次部署总失败？” |

典型 continuation 触发词：

```text
继续 / 接着 / 还是那个 / 照之前 / 按原来的 / 上一个 / 刚才那个 / 再来
```

pattern 触发词：

```text
总是 / 经常 / 通常 / 规律 / 趋势 / 反复 / 最近几次 / 为什么老是 / 综合过去
```

## 7.4 Scope 判定硬规则

`user=true`：

- explicit memory reference；
- personal task；
- 与偏好/长期目标/历史选择相关；
- “适合我/按我的习惯/我之前选择”等 personalization signal。

`project=true`：

- 当前存在 active project；且 intent 为 coding/action/planning；
- 或请求显式涉及 repo/project；
- 或 continuation/episodic 与项目相关。

`agent=true`：

- 只有工具使用策略、Agent 自身失败、执行 workflow 优化时开启。

`organization=true`：

- 只有明确涉及团队/公司/workspace/shared policy 时开启。

---

# 8. Memory Router

## 8.1 四级 Mode

| Mode | 行为 |
|---|---|
| `none` | 不查长期 Memory |
| `canonical` | Working + L1/L2/L3 |
| `recall` | Canonical + Hindsight Recall |
| `reflect` | Canonical + Recall + Hindsight Reflect |

默认规则：

```python
if generic_knowledge and not explicit_memory_reference:
    mode = "none"
elif history_need == "pattern":
    mode = "reflect"
elif history_need in {"episodic", "continuation"}:
    mode = "recall"
else:
    mode = "canonical"
```

## 8.2 MemoryPlan

```python
class MemoryPlan(BaseModel):
    mode: Literal["none", "canonical", "recall", "reflect"]
    working: WorkingPlan
    canonical_reads: list[CanonicalReadPlan]
    recalls: list[HindsightRecallPlan]
    reflections: list[HindsightReflectPlan]
    live_validations: list[LiveValidationPlan]
    merge: MergePolicy
    post_task: PostTaskPolicy
```

### CanonicalReadPlan

```python
class CanonicalReadPlan(BaseModel):
    scope: Literal["user", "project", "organization"]
    kind: Literal["fact", "preference", "constraint", "decision", "procedure"]
    route: Literal["l1_pointer", "direct_id", "fts"]
    key: str
    max_tokens: int
    validate_live: bool = False
```

### HindsightRecallPlan

```python
class HindsightRecallPlan(BaseModel):
    bank_id: str
    query: str
    fact_types: list[Literal["world", "experience", "observation"]]
    tags: list[str] = []
    tags_match: Literal["any", "all", "any_strict", "all_strict", "exact"] = "all_strict"
    tag_groups: list[dict] | None = None
    query_timestamp: str | None = None
    prefer_observations: bool = False
    include_source_facts: bool = False
    min_scores: dict[str, float] | None = None
    max_tokens: int = 1200
    budget: Literal["low", "mid", "high"] = "mid"
    trace: bool = False
```

### HindsightReflectPlan

```python
class HindsightReflectPlan(BaseModel):
    bank_id: str
    query: str
    fact_types: list[str] | None = None
    tags: list[str] = []
    tags_match: str = "all_strict"
    tag_groups: list[dict] | None = None
    context: str | None = None
    budget: str = "low"
    max_tokens: int = 800
    include_facts: bool = True
    response_schema: dict | None = None
```

## 8.3 Memory Query Compiler

禁止直接把含糊 User Prompt 原样 Recall。

错误：

```text
用户：“怎么又不行了？”
recall("怎么又不行了")
```

正确：

```text
working.current_project = foo
working.current_goal = Docker deploy
last_tool_error = permission denied

compiled query =
"foo 项目 Docker deployment 历史失败，volume permission、rootless container、过去成功修复方法"
```

Query Compiler 输入：用户请求 + Working + scope + logical kinds + entity + temporal reference。

---

# 9. Hindsight Bank 设计

MVP 使用三个 Bank：

```text
user::<stable_user_id>
project::<git_remote_or_root_hash>
agent::<agent_id>
```

Bank 是硬隔离边界；tag 是 Bank 内软过滤。

## 9.1 Tag 标准

统一格式：

```text
kind:<logical_kind>
domain:<domain>
module:<module>
status:<status>
source:<source>
```

示例：

```text
kind:experience
domain:deployment
module:docker
status:verified
source:execution
```

不要为了项目名重复打 `project:*` tag；项目已经由 Bank 隔离。

## 9.2 tags_match

MVP 默认：`all_strict`。

原因：Hindsight 的 `any/all` 会包含 untagged memory；严格模式可避免历史未分类 memory 污染结果。

如果 logical kind 是 OR 关系，使用 `tag_groups` 或拆分 recall；不要错误使用：

```text
kind:preference AND kind:decision
```

因为单条 memory 通常不是同时两种 kind。

## 9.3 prefer_observations

具体事件查询：

```text
“上次具体报了什么错？”
=> types=[experience]
=> prefer_observations=False
```

规律查询：

```text
“部署通常有哪些坑？”
=> types=[observation, experience]
=> prefer_observations=True
=> include_source_facts=True
```

## 9.4 query_timestamp

只要用户包含相对时间表达（上个月、去年、最近几周），传当前 offset-aware ISO 时间作为 `query_timestamp`。

## 9.5 Retain 一致性策略

- 需要“写完马上可 Recall”的重要 Episode：`await aretain(... retain_async=False)`。
- 大批量归档/历史导入：允许 `retain_async=True`，使用 `operation_id` 做幂等重试并追踪 operation status。
- 不要误以为 `aretain()` 自动意味着后台异步入库。

---

# 10. Hindsight Bank Missions

## 10.1 User Bank

`retain_mission`：

```text
Extract durable user preferences, explicit decisions, long-term goals,
important relationships and future-useful experiences. Clearly distinguish
explicit user statements from inferred patterns. Avoid one-off small talk,
volatile state and secrets.
```

`observations_mission`：

```text
Synthesize stable preference patterns and long-term behavioral tendencies
from multiple experiences while preserving changes over time and exceptions.
Do not convert inferred patterns into claims that the user explicitly stated.
```

`reflect_mission`：

```text
Recover user history, compare changes in decisions/preferences and summarize
long-term patterns. Treat derived conclusions as beliefs unless explicitly
confirmed by the user.
```

## 10.2 Project Bank

`retain_mission`：

```text
Extract debugging, implementation and tool-execution experiences, especially
failure causes, attempted fixes, successful fixes and verification results.
Do not treat historical project configuration as the authority for current repo state.
```

`observations_mission`：

```text
Synthesize recurring project failure patterns, hidden preconditions and
reliable execution strategies from multiple verified episodes.
```

`reflect_mission`：

```text
Analyze historical implementation/debugging patterns. Current repository state
and Canonical project memory remain authoritative over historical conclusions.
```

## 10.3 Agent Bank

`retain_mission`：

```text
Store only the agent's own tool-use, workflow and strategy experiences.
Do not store private user information here.
```

`observations_mission`：

```text
Synthesize strategies that repeatedly improve or degrade task success.
```

---

# 11. MemoryEnvelope：统一来源模型

所有存储结果在进入 Resolver 前必须 Normalize。

```python
class MemoryEnvelope(BaseModel):
    id: str
    scope: Literal["working", "user", "project", "agent", "organization"]
    logical_kind: Literal[
        "fact", "preference", "constraint", "decision",
        "procedure", "experience", "belief"
    ]

    claim_subject: str | None = None
    claim_predicate: str | None = None
    claim_object_json: str | None = None

    source: Literal[
        "live", "current_user", "working", "canonical",
        "hindsight_world", "hindsight_experience",
        "hindsight_observation", "hindsight_reflect", "archive"
    ]
    backend: Literal["runtime", "filesystem", "sqlite", "hindsight", "tool"]
    source_ref: str | None = None
    source_hash: str | None = None

    status: Literal[
        "active", "possibly_stale", "stale", "superseded", "conflicted"
    ] = "active"

    observed_at: datetime | None = None
    verified_at: datetime | None = None
    valid_from: datetime | None = None
    valid_until: datetime | None = None

    evidence: list[EvidenceRef] = []
    retrieval: RetrievalScore | None = None

    content: str
    estimated_tokens: int
```

### EvidenceRef

```python
class EvidenceRef(BaseModel):
    type: Literal[
        "tool_execution", "current_file", "user_explicit",
        "canonical_file", "historical_episode",
        "observation_sources", "inference"
    ]
    ref: str | None = None
```

### RetrievalScore

```python
class RetrievalScore(BaseModel):
    semantic: float | None = None
    keyword: float | None = None
    reranker: float | None = None
    final: float | None = None
```

**RetrievalScore 只做 candidate admission，不参与 Truth Authority 排名。**

---

# 12. Authority Resolver

## 12.1 Authority Tier

采用字典序裁决，不做一个可被相关度反转的乘法总分。

| Tier | 来源 | 说明 |
|---|---|---|
| A0 | Live Evidence | 当前文件/API/工具/Calendar/Email/Repo |
| A1 | Current User Directive | 本轮明确要求 |
| A2 | Scoped Canonical Constraint | 项目/组织硬约束 |
| A3 | Canonical Fact / Active Decision | 已验证事实/当前决策 |
| A4 | Verified Procedure | 经执行验证的 SOP |
| A5 | Hindsight Observation | 多经历归纳，仍属 derived |
| A6 | Hindsight World / Experience | 历史事实或事件 |
| A7 | Reflect / Belief / Archive | 推断/反思/原始归档 |

## 12.2 Scope Specificity

发生同 Claim 冲突时：

```text
current task > project > organization > user global > agent global
```

注意：只在同 Claim/同作用域语义冲突时使用，不能粗暴覆盖所有 User Memory。

## 12.3 Claim Key

```python
def claim_key(m: MemoryEnvelope) -> str:
    return f"{m.scope}::{m.claim_subject}::{m.claim_predicate}"
```

同 `claim_key` 但 object 不同进入冲突检测。

## 12.4 三类冲突

### Override（保留两者）

```text
User preference: pnpm
Project constraint: yarn
```

结果：Project constraint 在该项目内 shadow user preference；不删除用户偏好。

### Supersession

```text
旧：Node >=20
新：Node >=22
```

同 scope/subject/predicate，且有明确新时间/证据。旧条目标 `superseded`。

### True Conflict

```text
Canonical: production DB = PostgreSQL
Live config: production DB = MySQL
```

无明确迁移解释：标记 conflict，触发 live validation / 用户可见提示；禁止静默选择历史记忆。

## 12.5 Resolver 伪代码

```python
def resolve_claim_group(items, context):
    items = [x for x in items if x.status not in {"stale", "superseded"}]

    live = [x for x in items if x.source == "live"]
    if live:
        return winner(most_recent(live), reason="live_state")

    current_user = [x for x in items if x.source == "current_user"]
    if current_user:
        return winner(current_user[-1], reason="current_user_override")

    candidates = select_best_authority_tier(items)
    candidates = select_most_specific_scope(candidates, context)

    r = resolve_temporal_supersession(candidates)
    if r.resolved:
        return r

    r = resolve_by_evidence(candidates)
    if r.resolved:
        return r

    return conflict(candidates, requires_validation=True)
```

**禁止在这里比较 Hindsight `final` relevance 决定谁是真相。**

---

# 13. Freshness Gate 与 Live Validation

## 13.1 Freshness 状态

```text
active
possibly_stale
stale
superseded
```

## 13.2 Source Hash

对项目事实/SOP 前置条件，保存 `source_ref + source_hash`。

```python
def freshness(memory, live_index):
    if memory.valid_until and now > memory.valid_until:
        return "stale"
    if memory.source_ref and memory.source_hash:
        if live_index.hash(memory.source_ref) != memory.source_hash:
            return "possibly_stale"
    if memory.status == "superseded":
        return "stale"
    return "active"
```

## 13.3 默认必须 Live Validation 的类别

```text
email/inbox
calendar
weather
market/finance
current web facts
running processes
server health
file contents
git status
package versions
current configuration
permissions
```

Memory 可以提供背景，不能替代实时 source。

## 13.4 LiveValidationPlan

```python
class LiveValidationPlan(BaseModel):
    claim_key: str
    reason: Literal[
        "current_state", "stale_source", "canonical_conflict", "high_risk"
    ]
    source: Literal["file", "git", "shell", "calendar", "email", "web", "api"]
    target: str
```

触发条件：

- `current_state_need == required`；
- `possibly_stale`；
- 高 Authority 冲突；
- 高风险 action；
- source file/hash 已变化。

---

# 14. Context Merger

## 14.1 五步流程

```text
normalize -> resolve -> dedupe -> compress -> pack
```

禁止 `concat(all_results)`。

## 14.2 Dedupe

MVP 三层：

1. ID dedupe。
2. Claim dedupe：相同 scope + subject + predicate + object，只留 Authority 更高/更新者。
3. Provenance dedupe：Pattern query 中若 Observation 已覆盖 source experiences，则主上下文隐藏重复 experiences；保留 provenance ID 供审计。

MVP 不实现独立 semantic embedding dedupe。

## 14.3 Context 渲染按语义，不按 Backend

最终给主模型：

```text
<MEMORY_CONTEXT>
<CURRENT_STATE>...</CURRENT_STATE>
<CURRENT_DIRECTIVES>...</CURRENT_DIRECTIVES>
<WORKING>...</WORKING>
<VERIFIED_MEMORY>...</VERIFIED_MEMORY>
<PAST_EXPERIENCE>...</PAST_EXPERIENCE>
<DERIVED_MEMORY>...</DERIVED_MEMORY>
<CONFLICTS>...</CONFLICTS>
</MEMORY_CONTEXT>
```

不要展示：

```text
[SQLite Results]
[Hindsight Results]
```

也不要给主模型 semantic/reranker/final score。

## 14.4 Derived 标签

所有 Observation / Reflect 结论必须显式标记：

```text
[DERIVED - NOT VERIFIED FACT]
```

## 14.5 动态 Token Budget

默认总 Memory Context：

```text
min(4500, context_window * 0.08)
```

初始配置，不是理论常数。

Coding 默认：

```text
working      600
live        1000
canonical   2000
experience   700
derived      200
```

Personal 默认：

```text
working       700
live          300
canonical    1200
experience   1400
derived       900
```

Pattern/Reflect task 可提升 experience/derived，但不得突破总预算。

## 14.6 Merger 返回 Working Patch

```python
class MergeResult(BaseModel):
    prompt_context: str
    working_patch: WorkingMemoryPatch | None
    conflicts: list[ConflictRecord]
    telemetry: MergeTelemetry
```

如果某信息后续多轮持续有用，应自动进入 Working，避免重复 Recall。

---

# 15. Pre-Task Pipeline

```python
async def prepare_memory_context(request, ctx, now):
    analysis = fast_analyze(request, ctx.working, ctx.project, now)

    if analysis.ambiguity > settings.analyzer_llm_threshold:
        analysis = await llm_analyze(request, ctx, analysis)

    plan = await memory_router.build_plan(analysis, ctx, now)
    if plan.mode == "none":
        return EmptyMemoryContext()

    working = await working_store.load(ctx.session_id)

    canonical_task = load_canonical_reads(plan.canonical_reads)
    recall_task = run_hindsight_recalls(plan.recalls)

    canonical, recalls = await asyncio.gather(canonical_task, recall_task)

    reflections = []
    if plan.reflections:
        reflections = await run_reflections(plan.reflections)

    envelopes = normalizer.normalize_all(
        working=working,
        canonical=canonical,
        recalls=recalls,
        reflections=reflections,
    )

    resolved = authority_resolver.resolve(envelopes, ctx)
    validations = freshness_gate.plan(resolved, plan.live_validations)
    live_results = await live_validator.execute(validations)

    all_envelopes = envelopes + normalizer.normalize_live(live_results)
    resolved = authority_resolver.resolve(all_envelopes, ctx)

    result = context_merger.merge(resolved, plan.merge)
    await working_store.apply_patch(ctx.session_id, result.working_patch)

    return result
```

---

# 16. Post-Task Memory Pipeline

## 16.1 两条路径必须分叉

```text
Task Result
   |
   +--> Hindsight Episode Retain
   |
   +--> Canonical Candidate -> Promotion Gate -> L2/L3/User Canonical
```

## 16.2 Episode Retain

Episode 应该保存“有结构的经历”，不是整段聊天原样塞入：

```json
{
  "goal": "修复 auth CI timeout",
  "environment": {
    "branch": "main",
    "commit": "82bc91",
    "runtime": "node 22.4"
  },
  "problem": "CI auth tests timeout",
  "actions": [
    "read CI config",
    "inspect environment",
    "found TEST_DATABASE_URL missing",
    "added CI secret"
  ],
  "result": "tests passed",
  "evidence": {
    "test_command": "pnpm test auth",
    "exit_code": 0
  },
  "lesson": "auth integration tests require TEST_DATABASE_URL"
}
```

Retain policy：

- 成功或高价值失败可 retain。
- ephemeral chatter 不 retain。
- secret scanner 在 Hindsight 前运行。
- 用户明确“不要记/忘掉”必须遵守。

## 16.3 Canonical Promotion Gate

Candidate 必须经过：

```text
Novel?
Stable?
Reusable?
Evidence-backed?
Non-secret?
Non-volatile?
No unresolved conflict?
```

推荐 Evidence 级别：

| Evidence | 示例 |
|---|---|
| E0 | 当前工具/live observation |
| E1 | 当前权威项目文件 |
| E2 | 当前用户明确陈述 |
| E3 | 已存在 Canonical verified evidence |
| E4 | 多个独立历史 episodes |
| E5 | 单个历史 episode |
| E6 | Derived observation/inference |

Canonical fact/procedure 默认要求 E0/E1；用户 preference 可接受 E2。

## 16.4 Procedure 状态

```text
0 successful run -> hypothesis
1 successful run -> provisional SOP
2+ independent successful runs -> stable SOP
```

这是对 GenericAgent “No Execution, No Memory” 的扩展，防止一次偶然成功变永久流程。

## 16.5 Reflect 不能直接 Commit

Reflect 输出：

```json
{
  "claim": "部署失败高频与 volume 权限有关",
  "confidence": 0.81,
  "supporting_memory_ids": ["...", "..."],
  "contradictions": []
}
```

它只能成为 `belief candidate`。需要未来 live evidence / 多次验证才可产生 Canonical Candidate。

---

# 17. Canonical 数据格式

## 17.1 Fact YAML

```yaml
id: fact-runtime-node
scope: project
subject: project.runtime
predicate: requires_node
value: ">=22"
status: active

evidence:
  - type: current_file
    ref: package.json

source_ref: package.json
source_hash: sha256:...
verified_at: 2026-08-18T15:00:00+08:00
valid_from: 2026-08-18T15:00:00+08:00
valid_until: null
supersedes: [fact-runtime-node-v1]
tags: [node, runtime, build]
```

## 17.2 Decision / ADR

```markdown
# ADR-003 不引入独立 Vector Database

Status: active

## Context
项目需要长期 Agent Memory。

## Decision
当前阶段使用 Canonical files/SQLite + Hindsight，不新增独立 vector service。

## Why
- 降低依赖和运维复杂度
- Hindsight 已负责 Experience recall/rerank
- Canonical exact read 不需要 embedding

## Rejected
- 独立 Qdrant/Milvus：当前收益不足

## Evidence
- architecture review 2026-08-18

## Revisit when
- Hindsight 无法满足 retrieval latency/quality
- 独立大规模文档语义搜索成为核心需求
```

## 17.3 Procedure

```yaml
id: procedure-frontend-build
status: stable
trigger: [frontend_changed, shared_package_changed]
preconditions:
  node: ">=22"
  package_manager: yarn
steps:
  - yarn install --frozen-lockfile
  - yarn lint
  - yarn test
  - yarn build
success:
  - exit_code == 0
  - dist_exists == true
known_failures:
  ERR_SOMETHING:
    cause: "..."
    recovery: ["..."]
evidence:
  successful_runs: [run-334, run-519]
source_refs: [package.json, yarn.lock]
```

---

# 18. SQLite Schema（MVP）

推荐使用 SQLite WAL。Canonical 内容可在 YAML/Markdown，SQLite 存元数据、索引、Working、Candidate、Telemetry。

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    owner_id TEXT,
    workspace_id TEXT,
    logical_kind TEXT NOT NULL,

    claim_subject TEXT,
    claim_predicate TEXT,
    claim_object_json TEXT,

    source TEXT NOT NULL,
    backend TEXT NOT NULL,
    source_ref TEXT,
    source_hash TEXT,

    status TEXT NOT NULL DEFAULT 'active',
    observed_at TEXT,
    verified_at TEXT,
    valid_from TEXT,
    valid_until TEXT,

    content TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_claim
ON memory_records(scope, workspace_id, claim_subject, claim_predicate, status);

CREATE INDEX IF NOT EXISTS idx_memory_kind
ON memory_records(scope, logical_kind, status);

CREATE TABLE IF NOT EXISTS memory_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS working_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    source_memory_id TEXT,
    source_hash TEXT,
    created_turn INTEGER NOT NULL,
    expires TEXT NOT NULL,
    refresh_on_source_change INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_working_session
ON working_items(session_id, expires);

CREATE TABLE IF NOT EXISTS memory_candidates (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    workspace_id TEXT,
    logical_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_conflicts (
    id TEXT PRIMARY KEY,
    claim_key TEXT NOT NULL,
    memory_ids_json TEXT NOT NULL,
    resolution TEXT,
    requires_validation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_route_events (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    session_id TEXT,
    mode TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    retrieved INTEGER NOT NULL DEFAULT 0,
    admitted INTEGER NOT NULL DEFAULT 0,
    injected INTEGER NOT NULL DEFAULT 0,
    conflicts INTEGER NOT NULL DEFAULT 0,
    live_validations INTEGER NOT NULL DEFAULT 0,
    token_cost INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    task_success INTEGER,
    memory_helpful INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canonical_access_stats (
    route_key TEXT PRIMARY KEY,
    access_count INTEGER NOT NULL DEFAULT 0,
    hit_count INTEGER NOT NULL DEFAULT 0,
    used_count INTEGER NOT NULL DEFAULT 0,
    helped_success_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT
);
```

可选：如果不想 SQLite 存 Canonical `content`，`memory_records.content` 保存摘要，完整内容由 `source_ref` 指向 Markdown/YAML。

---

# 19. Python 模块结构

```text
memory/
├── __init__.py
├── models.py
├── settings.py
├── analyzer.py
├── router.py
├── query_compiler.py
├── normalizer.py
├── authority_resolver.py
├── conflict_engine.py
├── freshness.py
├── context_merger.py
├── working_memory.py
├── post_task.py
├── promotion.py
├── security.py
├── telemetry.py
│
├── stores/
│   ├── base.py
│   ├── canonical_store.py
│   ├── sqlite_store.py
│   └── hindsight_store.py
│
├── validators/
│   ├── base.py
│   ├── file_validator.py
│   ├── git_validator.py
│   ├── shell_validator.py
│   └── external_validator.py
│
├── prompts/
│   ├── analyzer.txt
│   ├── memory_policy.txt
│   ├── candidate_extractor.txt
│   └── reflect_schema.json
│
└── migrations/
    └── 001_memory_core.sql
```

---

# 20. Store 接口

## 20.1 CanonicalStore

```python
class CanonicalStore(Protocol):
    async def load_index(self, scope, workspace_id=None) -> CanonicalIndex: ...
    async def read(self, plan: CanonicalReadPlan) -> list[CanonicalRecord]: ...
    async def search_fts(self, query, scope, kinds, workspace_id=None) -> list[CanonicalRecord]: ...
    async def upsert_candidate(self, candidate) -> str: ...
    async def commit(self, approved_candidate) -> CanonicalRecord: ...
    async def invalidate(self, memory_id, reason) -> None: ...
```

## 20.2 HindsightStore

```python
class HindsightStore(Protocol):
    async def recall(self, plan: HindsightRecallPlan) -> HindsightRecallResult: ...
    async def reflect(self, plan: HindsightReflectPlan) -> HindsightReflectResult: ...
    async def retain_episode(self, episode: Episode, policy: RetainPolicy) -> str: ...
    async def forget(self, bank_id: str, memory_id: str) -> None: ...
```

## 20.3 WorkingMemoryStore

```python
class WorkingMemoryStore(Protocol):
    async def load(self, session_id: str) -> list[WorkingItem]: ...
    async def apply_patch(self, session_id: str, patch: WorkingMemoryPatch) -> None: ...
    async def invalidate_by_source(self, source_ref: str, source_hash: str | None) -> int: ...
    async def clear_task(self, session_id: str) -> None: ...
```

---

# 21. 对 Agent 暴露的 Memory Tool

主 Agent 不应直接看到十几个 Hindsight 原生工具。MVP 对模型只暴露 4 个：

## `memory_recall`

```json
{
  "query": "string",
  "scopes": ["user", "project", "agent"],
  "types": ["fact", "decision", "experience"]
}
```

内部可调用 Canonical + Hindsight；模型不关心 backend。

## `memory_read`

```json
{
  "id": "procedure://project/docker-deploy"
}
```

用于已知 ID 的精确读取。

## `memory_commit`

语义是“提交 Candidate”，不是直接永久写：

```json
{
  "scope": "project",
  "type": "procedure",
  "content": "...",
  "evidence_refs": ["tool-run://..."]
}
```

## `memory_forget`

```json
{
  "id": "...",
  "scope": "user",
  "reason": "user_requested"
}
```

用户明确要求删除/忘记时必须优先执行。

---

# 22. Memory Policy Prompt（建议系统级）

```text
MEMORY POLICY

1. Retrieved memory is context, not automatically truth.
2. CURRENT_STATE overrides historical memory for volatile facts.
3. CURRENT_USER_DIRECTIVE overrides stored user preferences for this task.
4. PROJECT_CONSTRAINT overrides USER_PREFERENCE inside that project only.
5. VERIFIED_MEMORY is authoritative unless marked stale/conflicted or contradicted by live evidence.
6. PAST_EXPERIENCE describes historical events; do not assume the same cause applies now without verification.
7. DERIVED_MEMORY is an observation/belief, not a verified fact.
8. If CONFLICTS says validation is required, verify before high-risk action.
9. Do not write permanent Canonical memory from inference alone.
10. Retained experience and Canonical truth are different stores with different promotion rules.
```

---

# 23. Security / Memory Poisoning

## 23.1 Secret Filter 必须在 Backend 前

Candidate / Episode 在写 Canonical 或 Hindsight 前：

```text
secret scanner -> PII policy -> scope ACL -> backend
```

拒绝或 redact：

```text
API keys
private keys
tokens
passwords
session cookies
cloud credentials
数据库密码
```

即使 Hindsight 自身有防护，也不能省 Harness 前置层。

## 23.2 不可信来源

外部网页、模型猜测、第三方输出：

- 可作为 archive/reference/experience；
- 不得直接成为 project fact/SOP；
- 必须经过当前 tool/file/API 证据验证后才能 Promotion。

## 23.3 Scope 泄漏

至少实现：

```python
class Visibility(BaseModel):
    owner_id: str | None
    workspace_id: str | None
    allowed_agent_ids: list[str]
    exportable: bool = False
```

Project A 的 memory 不得进入 Project B recall。

---

# 24. Failure Modes 与降级

## Hindsight 不可用

- `canonical` mode 正常工作。
- `recall/reflect` 降级到 Working + Canonical + L4 archive optional search。
- 不应阻塞普通 Coding task。
- Telemetry 标记 `hindsight_unavailable`。

## Reflect 不可用

- 使用 Recall Observation/Experience 回答，并明确“不做跨经历深层反思”。
- 不重试到阻塞主任务。

## Canonical 解析失败

- 不静默忽略；标记 invalid record。
- 若涉及 action constraint，停止高风险操作并触发修复/验证。

## Token 超预算

删除优先级：

```text
raw archive -> duplicated experiences -> derived explanation -> SOP explanation
```

最后保留：

```text
current directives + live state + hard constraints + verified facts + procedure steps
```

---

# 25. Telemetry

```python
class MemoryRouteTelemetry(BaseModel):
    request_id: str
    mode: str
    scopes: list[str]
    retrieved: int
    admitted: int
    injected: int
    source_counts: dict[str, int]
    conflicts: int
    live_validations: int
    token_cost: int
    latency_ms: int
    task_success: bool | None
    memory_helpful: bool | None
```

长期关注指标：

- Memory hit rate。
- Injected memory actually-used rate。
- Canonical conflict rate。
- Stale detection rate。
- Recall latency P50/P95。
- Reflect 使用率与成功收益。
- 每类 memory 的 token / task-success ROI。
- L1 route 命中率。

后续可根据 telemetry 自动调整：高频 route 升到 L1 direct pointer；低频/低收益 route demote。

---

# 26. 默认配置

```yaml
memory:
  analyzer:
    llm_threshold: 0.35

  budget:
    max_memory_tokens: 4500
    context_ratio: 0.08

  recall:
    user_max_tokens: 1000
    project_max_tokens: 1400
    agent_max_tokens: 600
    final_max_items: 8
    tags_match: all_strict
    default_budget: mid

  reflect:
    default_budget: low
    max_tokens: 800
    include_facts: true

  working:
    default_expiry: task_end
    dedupe_loaded_sources: true

  promotion:
    procedure_stable_success_count: 2
    require_live_evidence_for_project_fact: true

  hindsight:
    sync_important_episode_retain: true
    temporal_retrieval: true
    graph_retrieval: true
    reranking: true
```

所有数字必须可配置。

---

# 27. 单元测试 / 回归测试

MVP 至少实现以下测试：

| # | 输入 | 期望 |
|---|---|---|
| 1 | Python GIL 是什么？ | M0；不查长期记忆 |
| 2 | 这个 repo 怎么 build？ | M1；Project Canonical procedure |
| 3 | 我之前说过默认喜欢哪个包管理器？ | M2；User Recall |
| 4 | 继续昨天那个 Router | continuation；Working -> Canonical -> 轻 Recall |
| 5 | 上次 Docker 为什么失败？ | M2；Project experience |
| 6 | 为什么最近三次 deploy 都失败？ | M3；Recall + Reflect |
| 7 | 现在项目 Node 版本是多少？ | Canonical hint + Live file validation |
| 8 | 我喜欢 pnpm，但项目规定 yarn | Project constraint 胜出；User preference 保留 |
| 9 | 以后都默认用 pnpm，记住 | User Canonical candidate + Hindsight retain |
| 10 | 我猜这次是 Redis 导致的，记住 | 可 retain hypothesis/episode；禁止 Canonical fact |
| 11 | 今天有什么会议？ | Live Calendar 必须为 source of truth |
| 12 | 根据过去半年，我在 Agent 项目里最常纠结什么？ | User/Project temporal Reflect |
| 13 | Hindsight observation 与 package.json 冲突 | Live file 胜出 |
| 14 | Canonical source_hash 与文件 hash 不一致 | possibly_stale + validation |
| 15 | Reflect 给出高 confidence 但无 live evidence | 仍是 A7 belief |
| 16 | 同任务第二次需要相同 SOP | 命中 Working，默认不重复 Recall |
| 17 | Project A memory 在 Project B query | 不允许泄漏 |
| 18 | Memory content 包含 API key | 写入前被拒绝/redact |
| 19 | Hindsight 服务下线 | Coding canonical 路径继续可用 |
| 20 | Hindsight `final=0.99` 与 Canonical 冲突 | relevance 不得提升 Authority |

建议再做 property tests：

```text
for any historical memory H:
  if live evidence L conflicts with H:
    resolver(L, H).winner == L
```

---

# 28. 集成测试场景

## 28.1 Coding：部署历史坑

用户：

```text
帮我给这个项目部署 Docker，上次那个坑别再踩了。
```

期望：

1. `intent=coding`。
2. project canonical：读取 deploy SOP / env constraint。
3. project bank recall：历史 Docker experience。
4. prefer_observations 可用于“坑”类 pattern，但具体历史错误保留 source facts。
5. 当前 compose/Dockerfile/live env 验证优先。
6. Working 写入本任务约束和已知历史风险。
7. 任务成功后 Episode retain；只有被验证的新规则成为 Canonical Candidate。

## 28.2 Personal：恢复历史决策

用户：

```text
上次我们讨论 Agent memory，我最后偏向哪个方案？
```

期望：

1. `history_need=episodic/continuation`。
2. user canonical decisions + user bank recall。
3. 不查询 repo live state，除非当前上下文涉及正在实现的项目。
4. Derived observation 只能作为辅助，明确决策记录优先。

## 28.3 Mixed：继续实施

用户：

```text
继续昨天那个 Agent Memory，先把之前定的 Router 实现掉，还是别加太多依赖。
```

期望：

- user scope：preference/decision。
- project scope：fact/constraint/decision/procedure。
- history=continuation。
- current state required：读取当前 repo / git status / files。
- 依赖简化属于 Current User Directive，优先于历史 derived belief。

---

# 29. 实施阶段

## Phase 0：冻结模型与测试

产物：

- `models.py`
- `settings.py`
- SQLite migration
- 20 条核心测试 skeleton

完成条件：类型与 schema 可实例化，migration 可重复执行。

## Phase 1：Canonical + Working

实现：

- CanonicalStore
- INDEX routing
- YAML/Markdown parser
- WorkingMemoryStore
- source hash
- basic FTS fallback

完成条件：测试 1/2/7/8/14/16 通过。

## Phase 2：Analyzer + Router

实现：

- FastAnalyzer rules
- optional LLM analyzer
- Query Compiler
- MemoryPlan

完成条件：模式/scope/kind 路由测试通过；普通知识不触发 Recall。

## Phase 3：HindsightAdapter

实现：

- Bank bootstrap/config
- async recall/reflect/retain
- tag_groups
- strict tag filter
- query_timestamp
- prefer_observations / source facts
- service unavailable fallback

完成条件：测试 3/5/6/12/19 通过。

## Phase 4：Resolver + Freshness + Merger

实现：

- Normalizer
- Authority tiers
- Claim grouping
- Override/Supersession/Conflict
- Live validation requests
- Dedupe/budget/render
- Working patch

完成条件：测试 7/8/13/14/15/20 通过。

## Phase 5：PostTask + Promotion

实现：

- Episode builder
- Retain policy
- secret scan
- Candidate extractor
- evidence validator
- procedure provisional/stable
- forget/invalidate

完成条件：测试 9/10/18 通过。

## Phase 6：Telemetry + Benchmark

实现：

- route events
- access stats
- latency/token counters
- memory_helpful annotation
- benchmark harness

完成条件：可比较 `memory off / canonical only / canonical+hindsight / reflect` 四种模式。

---

# 30. 验收标准

MVP 只有满足以下条件才算完成：

- [ ] Generic knowledge 请求不会无意义调用 Hindsight。
- [ ] Coding 请求先读取当前项目 Canonical / live source，而不是历史 Experience。
- [ ] Personal history 能跨会话 Recall。
- [ ] `pattern` 请求能触发 Reflect，普通 history 不滥用 Reflect。
- [ ] Hindsight 输出从不直接拼接进入主 prompt，必须经 Normalizer/Resolver/Merger。
- [ ] Project constraint 可以 shadow user preference，但不会删除 user preference。
- [ ] 当前用户本轮要求可以覆盖历史 preference，仅对本任务生效。
- [ ] 当前文件/API/Calendar 可以覆盖历史记忆。
- [ ] source hash 变化会产生 possibly-stale。
- [ ] unresolved conflict 可见且能触发 live validation。
- [ ] Recall relevance 无法改变 Authority Tier。
- [ ] Episode retain 和 Canonical commit 是两条独立路径。
- [ ] Reflect 结论不会自动进入 Canonical。
- [ ] Secret 不会进入 Hindsight/Canonical。
- [ ] Hindsight 关闭时，Canonical Coding 路径仍可运行。
- [ ] Working cache 可减少同一任务重复 Recall。
- [ ] 至少 20 条核心回归测试全绿。

---

# 31. 后续扩展条件（MVP 后）

只有实际出现瓶颈时再引入：

### Graphiti/Zep

触发条件：

- 人物/公司/项目关系成为核心数据；
- temporal valid_from/valid_to 冲突数量显著；
- Hindsight + Canonical 无法清晰处理大规模关系演化。

### Mem0

默认不引入。只有需要独立对外 User Memory SaaS/API 层、并且与 Hindsight 职责明确分开时评估。

### Letta Runtime

默认不引入。当前 Harness 自己实现 Working Blocks；只有决定整体 Runtime 迁移到 Letta 时再评估。

### 独立向量数据库

只有 Canonical 文档规模/语义检索成为独立瓶颈时评估；不要为少量结构化事实提前引入。

---

# 32. 关键设计决策记录

## ADR-MEM-001：Canonical 与 Learned Memory 分离

**Decision**：Canonical Source of Truth 不由 Hindsight 直接拥有。Hindsight 负责 Experience / Observation / Reflect；Canonical 由文件/SQLite 管理并可审计。

**Reason**：经验学习允许自动化，但事实晋升需要证据与冲突治理。

## ADR-MEM-002：Router 不做重型 Agent

**Decision**：FastAnalyzer + deterministic rules 优先，只有 ambiguity 高时调用 LLM Analyzer。

**Reason**：降低延迟、成本和非确定性；保持 GenericAgent 的轻路由思想。

## ADR-MEM-003：不做统一 FinalScore 真相排序

**Decision**：Authority 使用 lexicographic tier；retrieval score 只控制候选准入。

**Reason**：高语义相关的旧记忆不能击败较低相关但权威的当前文件。

## ADR-MEM-004：Retain 与 Commit 分离

**Decision**：Hindsight Episode 可自动 retain；Canonical commit 必须通过 Promotion Gate。

**Reason**：避免 Memory Poisoning 与错误长期固化。

## ADR-MEM-005：Working 作为任务级二次压缩缓存

**Decision**：Recall 后持续有用的信息进入 Working；避免每 turn 重复检索。

**Reason**：对应 GenericAgent working checkpoint 的有效设计，同时减少 token/latency。

---

# 33. 参考源码

实施时应以当前实际 API 为准，并在依赖升级时跑 contract tests。

1. GenericAgent Repository  
   `https://github.com/lsdefine/GenericAgent`

2. GenericAgent Memory SOP  
   `https://github.com/lsdefine/GenericAgent/blob/main/memory/memory_management_sop.md`

3. GenericAgent Runtime / Working / Long-term update  
   `https://github.com/lsdefine/GenericAgent/blob/main/ga.py`

4. Hindsight Repository  
   `https://github.com/vectorize-io/hindsight`

5. Hindsight Python Client  
   `https://github.com/vectorize-io/hindsight/blob/main/hindsight-clients/python/hindsight_client/hindsight_client.py`

源码核对日期：**2026-08-18**。

---

# 34. 最终交付给 Coding AI 的最短任务描述

```text
Implement the Governed Hybrid Memory specification in this repository.

Start with Phase 0 and proceed phase-by-phase. Do not add Mem0, Letta Runtime,
Graphiti/Zep, or a separate vector DB. Preserve these invariants:

- live state > historical memory
- project constraint > user preference inside a project
- canonical > Hindsight observation/experience/reflect
- retrieval score cannot change authority
- retain != canonical commit
- reflect never directly promotes to canonical

Use GenericAgent-style minimal L1 canonical routing and Working checkpoints.
Use Hindsight only through an adapter, and normalize all Hindsight results into
MemoryEnvelope before authority resolution and context injection.

After each phase run the specified tests and do not continue with failing tests.
```


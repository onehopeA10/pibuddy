# FEAT-memory-v2：长期记忆 v2 —— 语义检索 + 知识库 + 有限抽取（MEM-101 v2）

在 v1（`common.memory`：用户显式保存 + FTS5 检索 + 注入前记录命中 + secret 拦截 +
删除覆盖正文/FTS/cache）之上**扩展**，不新建能力包（ADR-0002 允许「扩 memory manifest」）。
依据：`FEAT-memory.md`（v1）、`ADR-0002-capability-architecture.md`、`FIX-capability-core.md`。

分支：`worktree-agent-af84ae152b1dde702`（独立 worktree，只提交本分支，不 push origin/main）。

---

## 1. 交付物（按路径）

**新增（全部本能力独占）**

```
packages/app/src/main/memory/memory-vector.ts    向量原语：序列化/余弦/本地哈希嵌入（纯 JS 零依赖）
packages/app/src/main/memory/memory-embed.ts      Embedder 接口：本地哈希 + Provider(safeFetch) + 可注入
packages/app/src/main/memory/memory-search.ts     混合排序（FTS+向量）+ 嵌入编排 + 重嵌 + embed-status
packages/app/src/main/memory/memory-extract.ts    有限抽取：会话→候选事实（inferred/低置信/证据链/默认排除）
packages/app/test/memory-search.spec.ts           6 用例（含删除覆盖向量完整时序）
packages/app/test/memory-knowledge.spec.ts        4 用例（引用可追溯 + 删除覆盖 FTS+向量）
packages/app/test/memory-migrate.spec.ts          2 用例（真 v1 格式库迁移不丢数据）
```

**修改（本能力独占 + 协调点 additive）**

```
packages/contract/src/channels.ts        + memory:* 9 条 v2 通道（additive 块）
packages/contract/src/memory.ts          + v2 schemas + 9 条分片；MEMORY_DATA_SCHEMA_VERSION 1→2
packages/app/src/main/memory/memory-store.ts   + embeddings/knowledge/knowledge_fts 表 + 迁移 + 方法；deleteInternal 清向量；save 支持 inferred/excluded
packages/app/src/main/memory/memory-inject.ts  注入升级为混合语义（injectMemory 改 async）
packages/app/src/main/memory/memory-ipc.ts     9→18 通道；保存/编辑/合并即时嵌入；dispose 加 embedder
packages/app/src/main/capability/manifests/memory.manifest.ts  + 9 通道 + network 权限 + dataSchemaVersion 2
packages/app/src/main/pi/pi-ipc.ts       注入钩子那一行 injectMemory→await injectMemory（唯一内核接触点，沿用 v1 established 位置）
packages/app/src/preload/api/memory.ts   + 9 方法（同一 memory 命名空间，不新增第 16 个命名空间）
packages/app/src/renderer/src/stores/memory.ts       + 语义检索/嵌入状态/重嵌/抽取/知识库状态
packages/app/src/renderer/src/components/MemoryPanel.vue  + 语义检索区 + 嵌入状态/重嵌 + 知识库区（引用展示）
packages/app/test/memory-inject.spec.ts  既有 5 用例改 await（注入转异步）
```

**未新增任何运行时依赖**（node:sqlite 存 BLOB 向量 + 纯 JS 余弦；check-pure-js-deps 过闸）。
**未触碰**硬边界外：git / tasks / scheduler / agent-pool / child-agent / connector / permission。

---

## 2. 数据模型与关键决策

**向量表 `embeddings`**（`(kind, ref_id)` 主键）：kind 区分 memory/knowledge，`model` 记
产出向量的 embedder id。**检索只比同 model 的向量**——本地哈希向量与 Provider 向量落在不同
空间，混算余弦是无意义的数（store 层 JOIN 按 model 过滤）。向量以 Float32Array 序列化成 BLOB。

**知识库 `knowledge` + `knowledge_fts`**：文档/片段 + 来源三元组（sourceKind/sourceRef/
sourceTurnId）。检索命中回带 citation，「这条知识出自哪」始终可追溯。

**嵌入来源两条、一个接口**（`Embedder`：id/dim/embed）：
- **本地哈希嵌入**（默认）：特征哈希（词 + 中文 n-gram → 定长向量带符号累加 → L2 归一）。
  纯 JS、离线、无凭据 —— **语义检索整条管线在没有任何 API key 的机器上也端到端真跑**，
  也是单测能钉死时序的前提。捕捉形近/子串/共享词。
- **Provider 嵌入**：发文本给 Provider `/embeddings`，出站走 safeFetch（main 下唯一出站原语，
  raw fetch=0）。真正的近义词（无共享字符）需要它。**只对目录内、确有 OpenAI 兼容嵌入端点
  的 Provider 开放**（openai/mistral），manifest 据此逐条申报 `network:api.openai.com` /
  `network:api.mistral.ai` —— 权限预览里写的域名就是真会连的域名。`network:*` 通配被禁；
  自定义端点（任意域名）的嵌入缓上，与 mcp 缓上 http 连接同源。

**混合排序**：`score = 0.5·ftsNorm + 0.5·vecNorm`，两分量各按本次结果最大值归一到 [0,1]
再加权（不归一则量纲大的永远压过另一个）。分数分解（ftsScore/vectorScore）回给 UI 可解释。

**有限抽取**（ADR 红线：总结不是不可更正真相）四道结构性约束：origin=`inferred`、
confidence=0.5、保留 sourceSessionId/TurnId（可看证据）、`excluded=true` 落库（**默认不注入**，
等用户逐条确认）。抽取器可注入（默认保守启发式；可换 Provider LLM，四道约束不变）。secret
命中的候选同样被 save 拒。

**删除覆盖扩到向量**：`deleteInternal` 除主表 + FTS 外，同清 `embeddings`（kind=memory）；
知识删除同清 knowledge_fts + embeddings（kind=knowledge）。「删除后语义检索也零命中」与
「删除后 FTS 零命中」是同一条安全承诺。

**v1→v2 迁移不丢数据**：dataSchemaVersion 1→2；新表全部 `CREATE IF NOT EXISTS`（非破坏性），
`migrate()` 只把 user_version 推到 2，**不动 v1 已有的 memories/FTS/meta 一个字节**。v1 记录
迁移后仍能 FTS 查到、仍能注入，语义能力靠按需重嵌（memory:reembed）补上。

---

## 3. 可证伪测试 + 对拍（临时拆机制确认变红，两次输出）

**基线**（本能力 5 个 memory spec 全绿）：memory-store 15 + memory-inject 5 + memory-search 6 +
memory-knowledge 4 + memory-migrate 2 = 32 passed。

核心不是「delete 被调用过」，而是完整时序：
- **删除覆盖向量**：保存→嵌入→语义命中（纯向量、FTS 不命中）→删除→再检索向量零命中→直接查
  embeddings 表零行。
- **迁移不丢数据**：手工造**真 v1 格式库**（只有 v1 三张表、user_version=1、一条 v1 记录），
  v2 代码打开→代际到 2、v1 记录字段原样/FTS 仍命中/仍进注入候选、新表建好、重嵌后语义可命中。

对拍（逐条拆源码→跑 spec→还原，两次输出）：

| # | 拆掉的机制 | 结果 |
|---|---|---|
| V-A | `deleteInternal` 去掉 `DELETE FROM embeddings` | RED exit=1，**恰 1 条**：memory-search「删除覆盖向量：走完一整轮」失败（删后向量仍命中）。还原后 6 passed |
| V-B | `migrate()` 加破坏性 `DELETE FROM memories` | RED exit=1，**2 条**：memory-migrate「v1 记录一条不丢」「新表+重嵌」全失败。还原后 2 passed |

两处均确认 RED 后还原，还原后复跑全绿（memory-search 6 + memory-migrate 2 passed，无对拍残留）。

近义不同词用**可注入的概念 fake embedder**（同概念不同词映射到同一维）复现「向量命中、FTS 不
命中」，检索逻辑本身因此可证伪、不依赖任何外部凭据（任务允许无凭据时用 fake 验证逻辑）。

---

## 4. 门禁（收尾一次全跑，全绿）

```
pnpm typecheck                     contract / pi-sdk / app(node tsc + web vue-tsc) 全 Done
pnpm -w test                       120 文件 / 1089 测试 passed（基线 117/1077 → +3 文件/+12 测试，无既有用例改判）
pnpm build                         3145 modules ✓（基线 3129）
pnpm --filter @pibuddy/app dist    win-unpacked + NSIS 安装包，签名完成
check-pure-js-deps                 OK（扫 83 包无原生扩展；未新增依赖）
check-contract-uniqueness          OK（契约 594 导出唯一，无第二套契约包）
ipcMain 守卫外命中                 0（全仓唯一 ipcMain 仍在 ipc-guard）
raw fetch（main，outbound-guard 外）0（memory 只用 safeFetch）
capability-drift(17)/gate(8)/preload-api(4)  全 passed（新增 9 通道 + network 权限双向对账通过）
```

drift 对账自动纳入：memory 的 v2 通道 ↔ registerHandler ↔ 契约分片三方对齐；network 权限
↔ 源码 `safeFetch(` 双向；workspace.read ↔ `createReadStream(`（evidence + extract）；teardown
↔ disposeMemoryResources。均通过。

---

## 5. 真机启动验证（packaged，CDP 取证）

`release/win-unpacked/PiBuddy.exe --remote-debugging-port=9222`，经 CDP `Runtime.evaluate`
驱动 `window.piBuddy.memory` 走一整轮（workspaceId='cdp-mem-v2'）：

```
{"hasMemory":true,"methods":18,        ← 命名空间含 memory；v1 9 + v2 9 = 18 方法
 "saveOk":true,
 "backend":"local","model":"local-hash-v1","dim":256,  ← 默认本地嵌入，无凭据也可用
 "reembedOk":true,"embedded":1,
 "searchBackend":"local-hash-v1","searchHit":true,"topVec":1,  ← 语义检索在 packaged sqlite 里命中
 "secretRejected":true,                ← sk- 前缀在真机被拒
 "kbOk":true,"kbHits":1,"kbCitation":"docs/db.md",  ← 知识库 + 引用可追溯
 "delOk":true,"afterDeleteHit":false}  ← 删除后语义检索零命中（核心安全承诺，真机兑现）
```

覆盖了 packaged 专属风险面：sqlite BLOB 向量往返、FTS5、契约 seal、能力门在 packaged 下启用
common.memory、删除覆盖向量。进程清理：`Stop-Process -Name PiBuddy -Force` → count=0。

**未能真机端到端验证的两环（如实记录）**：
1. **Provider 嵌入**（safeFetch→/embeddings 的近义词检索）需要一个已配置的 Provider 凭据，
   本环境无可用 embedding 凭据，未走真实外部调用。检索**逻辑**由 §3 的 fake embedder 单测钉死，
   本地嵌入后端由真机跑通；Provider 后端待有凭据的环境补跑。这与任务「无凭据则如实标注端到端
   未验证」一致。
2. **注入钩子的 live 触发**（pi:prompt→混合注入）需一个已配置模型的真实 prompt，与 v1 同样受限；
   注入逻辑由 memory-inject.spec 的完整时序单测覆盖。

---

## 6. deferred（如实）

- Provider 嵌入对**自定义/任意域名端点**的支持（`network:<域名>` 无法表达任意主机，须待权限引擎
  能「按工作区放行某域名」）。当前仅目录内 openai/mistral。
- 抽取器的 Provider LLM 实现（当前默认保守启发式，接口已 `__setFactExtractor` 就位）。
- 大规模向量的近似索引（当前暴力余弦，个人规模足够；HNSW/IVF 需原生实现，与 check-pure-js-deps
  冲突，不做）。

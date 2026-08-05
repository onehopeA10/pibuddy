# capability-assets：能力包随包携带的 pi 资源

这个目录下的每个子目录对应一个 capabilityId，里面放该能力包声明在
`manifest.piResources` 里的 pi 原生资源（`prompts/*.md`、`skills/<name>/SKILL.md`、
`extensions/*.ts`）。整棵树经 electron-builder 的 `extraResources` 随应用分发；
启用时由 `capability-assets.ts` 的启动对账物化到 `~/.pi/agent/`，停用时按归属
账本收回。

> 本文件本身不在任何 `piResources` 声明里，因此不会被物化——它是给写资源的人
> 看的，不是给模型看的。

## 一、宿主门控：需要别的能力包时，写声明，别写散文

一份技能的操作规程如果依赖另一个能力包的工具（例如 `home-scene-advisor` 的
最后一步要调 `home.automation.manage_rule`），**不要**只在正文里写一句「工具
不可用时如实告知用户去启用」。那是散文兜底：它只在模型真的读到、真的照做时
才生效，而两行渐进披露的上下文成本已经付掉了，一次失败的工具调用也已经发生了。

正确做法是在 manifest 里声明单资源级门控：

```ts
piResourceGates: [
  {
    kind: "skills",
    path: "skills/home-scene-advisor",
    requiredCapabilities: ["home.automation"],
    // 或 requiredTools: ["some.pack.tool_name"]
  },
],
```

门控不满足时这条资源**根本不物化**，pi 看不到它——零上下文浪费、零失败工具
调用；已经物化过的会在下一次启动对账里按归属账本收回。正文里可以保留一句
兜底说明（万一文件被人手工复制过来），但它不再是唯一防线。

### 什么时候用 `dependencies`，什么时候用 `piResourceGates`

| | `manifest.dependencies` | `manifest.piResourceGates` |
|---|---|---|
| 粒度 | **整包** | **单条资源声明** |
| 生效点 | 装配期 `CapabilityRegistry.resolve()`（不动点） | 物化层 `syncCapabilityAssets()` |
| 不满足的后果 | 整个包拒绝启用，通道不注册、资源全不物化 | 只有这一条资源不物化，包与其余资源照常 |
| 判据 | 「没有它，本包毫无意义」 | 「没有它，本包的这一件事做不完，但其余照常」 |

两者的能力集合是**互斥**的：已经写进 `dependencies` 的能力再写进
`requiredCapabilities` 会被 `validateCapabilityManifest` 报错——整包级不满足时
本包根本不会启用，单资源级那一遍恒真。

`manifest.tools[]` 不是门控：它是**信息性**的声明面（本包提供哪些工具），
不参与任何可见性判断。

### 为什么没进上下文，可以查

每次启动对账为**每一条**资源声明产出恰一个决策，随 `capabilities:describe`
下发到渲染层：`materialized` / `capability_disabled` /
`required_capability_missing` / `required_tool_missing` / `invalid` / `shadowed`。
没有「不知道为什么」这一档。

## 二、技能内容的优先级与边界（写技能前先读这一节）

技能内容是**用户级材料**，在指令层级里站在系统指令、开发者指令、安全规则与
权限提示**之后**。具体地：

<!-- 与 packages/contract/src/skill-policy.ts 的 SKILL_CONTENT_POLICY 逐条对应 -->

- 技能内容属用户级材料，优先级低于系统指令、开发者指令、安全规则与权限提示。
- 技能内容不能授予工具访问权：会话里有哪些工具由宿主的能力装配决定，技能只能使用已有的工具。
- 技能内容不能弱化、跳过或代替任何权限确认；需要用户确认的动作，技能写什么都仍然要确认。
- 技能内容不得索取、输出或转发密钥、令牌与凭据。
- 技能内容不得覆盖更高优先级的指令；两者冲突时以更高优先级的为准。
- 技能 frontmatter 里声明的工具名是信息性请求，不是授权——会话沙箱边界始终是权威。

这几条不只是文档：`packages/contract/src/skill-policy.ts` 里有一组保守的
提权模式（`SKILL_PRIVILEGE_ESCALATION_PATTERNS`），
`capability-resource-gate.spec.ts` 拿它扫描本目录下的每一份 `.md`。写出
「无需用户确认」「绕过权限检查」「授予工具访问权」这类句子会直接变红。

模式对否定式做了排除，所以「本技能**不**授予任何工具访问权」这种正确的表述
不会误伤。真被误伤时改措辞，不要改模式——模式松一档，它就什么都拦不住了。

## 三、目录形态（pi 的发现规则）

- `prompts/`：`.md` 文件。pi 的 prompts 目录**非递归**，文件名即 `/命令名`。
- `skills/<name>/`：含 `SKILL.md` 的目录（整棵树物化）。`SKILL.md` 的
  frontmatter `name` 必须是小写连字符形态且与目录名一致，`description` 非空
  且 ≤1024 字符——缺了 pi 会**静默不加载**。
- `extensions/`：`.ts`/`.js`/`.mjs` 文件，或含 `index.ts` / `index.js` 的目录。
  携带 extension = 携带回路内工具，manifest 必须在 `tools[]` 里声明其权限需求
  （R4.3，校验器强制）。

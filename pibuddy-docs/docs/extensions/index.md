# Extension UI 与能力包

PiBuddy 的扩展性分两层：**pi 原生资源**（prompts / skills / extensions / themes / agents / MCP）与**未来的 PiBuddy UI 插件**。两者使用不同的 manifest、权限和运行宿主，不能混为一层。

## EXT-101：完整 Extension UI

- 覆盖 select / confirm / input / editor / notify / setStatus / setWidget / setTitle / set editor text，以及当前 pi 版本公开的全部 RPC UI method。
- dialog 支持 timeout、`AbortSignal`、runtime generation、多个请求排队、窗口 reload 恢复/取消；上游超时后本地 modal 立即失效。
- Widget 有稳定 key、placement、更新/删除和高度限制；Title 经过产品前缀与长度限制。
- 任何 extension request 都不能直接获得 Electron API；UI 内容按纯文本或受限 renderer 渲染。
- 显示 pi project trust：来源、将加载的 project resources、allow/deny/remember；明确说明 **trust 不等于工具权限**。

## EXT-102：pi 资源中心

- 枚举 user / project / package 来源的 packages、extensions、skills、prompts、themes、MCP；显示路径、版本、来源、启用状态、冲突和诊断。
- 支持安装、卸载、启停、刷新、打开目录、版本锁；project 资源需先通过 trust。
- 安装来源必须规范化并显示将执行/访问的权限；**禁止 renderer 直接执行任意 package manager command**。
- MCP 支持 CRUD、启停、连接测试、OAuth 状态、tool 列表和错误诊断；凭证留在 main。

## 能力包：内容资产的装卸货

`pi-resources/resource-scanner` 已识别 pi 全部资源类型。能力包把领域内容（prompts / skills / 回路内工具 / UI 贡献）打包分发，通过统一的物化通道装卸。

### R4：能力包装卸货机制（地基）

- **manifest 扩展**：能力包可声明携带的 pi 资源（prompts/skills/extensions），资源文件随包分发。
- **装卸**：启用能力包时物化资源到 pi 资源目录；停用时移除。物化必须**幂等、可重入**——重复启用不重复落盘，升级时覆盖旧版本。
- **权限**：回路内工具的执行动作走现有权限引擎（5 闸），不开旁路；工具声明的权限需求写进 `manifest.permissions`，安装时展示。
- **验收**：纯函数级测试覆盖物化/移除的幂等性；结构断言保证资源物化不绕过权限闸。

### 一个"装了货"的垂直包长什么样

以样板垂直包为例，必须同时含四类内容，证明架构闭环：

| 内容 | 说明 |
| --- | --- |
| prompts | 领域提示词（≥5 条） |
| skills | 领域技能（≥2 个） |
| 回路内工具 | ≥1 个 pi extension 工具 |
| UI 贡献 | uiContributions 挂至少一个领域面板/入口 |

核心设计原则：**确定性动作走代码保真，讲解/归因走模型**。例如出题判分由确定性工具产出题目与标准答案，讲解由模型完成。安装该包后会话内 agent 获得领域工具与技能；卸载后全部消失，通用能力零残留（drift 测试覆盖）。

## 边界要点

- pi 原生资源与 PiBuddy UI 插件运行宿主不同：第三方代码不得在主 renderer 同 realm 动态 import；使用 utility process / worker / sandboxed iframe，默认无文件/网络/shell/secret。
- 没有进程/realm 隔离时只允许 built-in / 官方签名源；公开 marketplace、支付和评分延期。
- 详见 [威胁模型与权限](/security/) 的工具审批一层，以及 [产品范围](/guide/product-scope) 里的能力包相关里程碑。

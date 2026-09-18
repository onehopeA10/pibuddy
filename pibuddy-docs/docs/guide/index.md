# 从这里开始

PiBuddy 是一个**面向办公用户的 pi 智能体桌面助手**：把工作区、主进程、Agent 运行时与 provider 配置保持可见、可检视，同时让日常办公操作足够直接。技术栈保持 **Electron + Vue 3 + Pinia + Naive UI + electron-vite + electron-builder**，pi 作为可替换的 Agent 运行时，默认使用随应用发布并经过回归测试的 bundled Pi。

## 选择一条路径

| 如果你想…… | 从这里开始 |
| --- | --- |
| 看看产品长什么样 | [截图 / Screens](/screens/) |
| 了解产品交付了什么、刻意不做什么 | [产品范围与里程碑](/guide/product-scope) |
| 理解系统如何拼在一起 | [架构总览](/architecture/) |
| 追踪一条协议或存储边界 | [事件流与信封](/architecture/event-flow) |
| 理解 pi 运行时的生命周期 | [pi 运行时生命周期](/runtime/) |
| 知道某项安全约束为何存在 | [威胁模型与权限](/security/) |
| 弄清持久状态与备份口径 | [SQLite 分区与备份](/data/) |
| 理解更新与发布闭环 | [更新与发布](/delivery/) |
| 构建一个能力包 | [Extension UI 与能力包](/extensions/) |

## 心智模型

```
Renderer 表现  →  Preload 能力桥  →  Electron Main 权威
     ↓                  ↓                    ↓
  会话归约          @pibuddy/contract      pi Node sidecar
                    (类型 + 运行时 schema)   + 12 个 SQLite 库
```

Renderer 只做呈现。Preload 在 `contextIsolation` 下暴露窄、可验证、可撤销的业务能力。Electron 主进程掌握桌面能力：窗口生命周期、IPC 路由、进程监督、权限中心、密钥保管、更新客户端与持久化。pi sidecar 掌握 Agent 循环与面向 provider 的模型工作。

## 使用这份文档

文档以主仓库 `doc/` 与 `docs/product/` 中的真实工程文档为真相源。技术标识符（协议字段、库名、RPC 方法、需求 ID）保持原样，以便搜索与交叉引用路径稳定。知道术语、协议方法或需求编号时用**全局搜索**；在探索某个领域时用**侧栏**。英文入口走同一张地图：[Start here](/en/guide/)。

## 改动一条边界之前

1. 阅读相关规格与本页对应的领域文档。
2. 核对关联的决策记录与约束。
3. 当行为对用户可见或对协议可见时，更新对应的测试场景。
4. 运行最窄且有用的验证，然后把结果记录进改动。

> 约束优先于实现细节。本站描述**边界与契约**；实现细节属于各模块源码注释。

# 事件流与信封

## 事件流（5 跳）

```
[1] pi 子进程 stdout
      │  JSONL，一行一个事件
      ▼
[2] pi-sdk/jsonl.ts 分帧
      │  StringDecoder + LF 切分，坏行跳过不中断
      ▼
[3] pi-sdk/client.ts 分派  ── toAgentEvent() 归一
      │  response(带 id) → pending promise
      │  extension_ui_request → "ui_request"
      │  其余 → "event"（未建模的类型归一为 { type:"unknown", raw }）
      ▼
[4] app/main/ipc.ts 33ms 批处理
      │  折叠连续的累积型事件（message_update / 同 toolCallId 的
      │  tool_execution_update 都携带到目前为止的全量内容，只留最后一条）
      ▼
[5] preload → renderer store reducer
      │  stores/app.ts handleEvent() switch(e.type)
      ▼
   Vue 组件
```

第 4 跳的折叠判据读事件的 `type` 与 `toolCallId`。信封化之后判据读 `envelope.payload.type`——这正是 `payload` 必须是信封**正式字段**、而不是随手挂上去的属性的原因。

## 事件信封 `PiEnvelope<T>`

八个字段，缺一不可（`contract/src/envelope.ts`，`PROTOCOL_VERSION = 1`）：

| 字段 | 作用 |
| --- | --- |
| `protocolVersion` | 版本闸门。`parseEnvelope` 第一步就比对，不等直接拒绝 |
| `workspaceId` | 工作区标识（M1 起为稳定 ID） |
| `sessionId` | pi 会话 ID |
| `runtimeId` | 一次 pi 子进程实例 |
| `generation` | 代际。每次 start / restart +1，用于丢弃上一代迟到事件 |
| `sequence` | 同一 `(sessionId, generation)` 内单调递增 |
| `occurredAt` | 主进程观测到的 Unix ms |
| `payload` | 承载的事件本体 |

## 未知协议版本 fail closed

宁可整条链路停摆，也不要一个新版本的字段被旧版本渲染进程当成 `undefined` 静默吞掉。

版本比对刻意排在结构校验**之前**——反过来的话，一个 v2 信封会先因"结构不符"被报成 malformed，运维看到的是误导性的错误分类。所有跨进程事件都用运行时 schema 校验，不能靠 TypeScript 类型假定运行时输入可信；拒绝未知字段、超长字符串、非法枚举、越界路径和非主 frame 调用。

## 为什么强调单调 sequence

- 主进程只转发**当前 generation**；renderer 再次丢弃旧 generation 或 sequence 倒退的事件。
- 快速连续切换 workspace / session 时，旧进程的 exit / update / UI request 不能污染新 generation。
- 这套代际 + 序号机制是 [pi 运行时生命周期](/runtime/) 状态机的直接依赖。

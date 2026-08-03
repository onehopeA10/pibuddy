/**
 * 会话树 / 分叉可视化的契约（common.session-tree，ADR-0002 能力包）。
 *
 * ## 这一层归一化在回答什么
 *
 * pi 的 `get_tree`（rpc.md:724）回来的是 `{tree, leafId}` 的**裸结构**：每个
 * 节点是 `{entry, children, label?}`，`entry` 又是 pi 的开放集合类型
 * （message / model_change / compaction / …，未知 type 只增不减）。渲染进程
 * 想画一棵分叉图，需要的是「这个节点是什么、它是不是分支点、是不是当前叶子、
 * 它有多深」——这些判断落在主进程做一次，渲染进程只拿一份类型化的结果。
 *
 * 分叉本身（fork / clone）**不在这层**：它们是 pi runtime 的内核动作
 * （`window.piBuddy.pi.fork/clone`，rpc.md:615/643），恒可用、可被扩展否决
 * （`data.cancelled`）。本能力只负责把「树长什么样」画出来，不重复内核已有的
 * 动作面。
 *
 * ## 为什么 `forkable` 不在图节点里
 *
 * 「哪条 user 消息可以分叉」是**跟着活动分支走的动态集合**（pi 的
 * `get_fork_messages` 只返回当前分支上的可分叉消息）。把它烙进静态的树结构里，
 * 换一次分支就会与真相脱节。因此图只承诺**结构**，可分叉集合由渲染侧另外调
 * `get_fork_messages` 取权威值再叠加上去。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

/**
 * 节点分类。
 *
 * 是枚举而不是原样透传 `entry.type`：渲染侧要的是「画成哪种节点」这个有限
 * 集合，而不是 pi 那个只增不减的开放集合。未知 type 一律归 `other`——不理解
 * 的东西照旧显示为一个节点，绝不因为看不懂就把整棵树判为损坏。
 */
export const sessionTreeNodeKindSchema = z.enum([
  "user",
  "assistant",
  "compaction",
  "model-change",
  "session",
  "other",
]);
export type SessionTreeNodeKind = z.infer<typeof sessionTreeNodeKindSchema>;

/**
 * 一个已归一化的树节点。
 *
 * `nodes` 是**拍平**的（父在子前，见 `sessionTreeGraphSchema`），父子关系用
 * `parentId` 表达而不是嵌套 `children`：拍平之后渲染侧算布局、连边、做虚拟化
 * 都只需要一次线性遍历，嵌套结构反而要递归。
 */
export const sessionTreeNodeSchema = z
  .object({
    id: z.string(),
    /** 父节点 id；根节点为 null */
    parentId: z.string().nullable(),
    kind: sessionTreeNodeKindSchema,
    /** user / assistant 的截断预览；其它类型是一句说明文本 */
    preview: z.string(),
    /** 该节点落定时的模型 id（model_change 或 message.model）；无则 null */
    modelId: z.string().nullable(),
    /** 在树里的深度，根为 0 */
    depth: z.number().int().nonnegative(),
    /** 子节点数 > 1 —— 这里就是一个分支点 */
    branchPoint: z.boolean(),
    /** 是否当前活动叶子（leafId） */
    current: z.boolean(),
    /** 原样透传的时间戳（ISO 字符串）；缺失为 null */
    timestamp: z.string().nullable(),
  })
  .strict();
export type SessionTreeNode = z.infer<typeof sessionTreeNodeSchema>;

/**
 * 一份会话树快照。
 *
 * `truncated` 是**性能保护**的出口：大树（几千节点）一次全展开会让 SVG 卡死，
 * 因此归一化时做了节点上限。被截断时活动分支（根 → 当前叶子）**保证完整**，
 * 其余分支填到预算为止；`totalNodes` 告诉界面「其实还有多少」。
 */
export const sessionTreeGraphSchema = z
  .object({
    /** 拍平的节点，父恒排在子之前 */
    nodes: z.array(sessionTreeNodeSchema),
    /** 根节点 id 集合（正常会话只有一个；孤儿链也会成根） */
    rootIds: z.array(z.string()),
    /** 当前活动叶子；空会话为 null */
    currentLeafId: z.string().nullable(),
    /** 截断前的总节点数 */
    totalNodes: z.number().int().nonnegative(),
    /** 是否因节点上限被截断 */
    truncated: z.boolean(),
  })
  .strict();
export type SessionTreeGraph = z.infer<typeof sessionTreeGraphSchema>;

/**
 * `session-tree:graph` 的入参。
 *
 * 与会话中心的通道同款：`workspaceId` + `sessionId` 成对出现，二者都是不透明
 * 标识。sessionId 在**一个工作区之内**才唯一（复制会话文件、共用 session-dir
 * 都能让同一个 id 出现两份），少了 workspaceId 就可能读到另一个工作区里同 id
 * 的那份会话——这也是「数据按 workspaceId 分区」铁律在通道入参上的落地。
 */
export const sessionTreeGraphRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();
export type SessionTreeGraphRequest = z.infer<typeof sessionTreeGraphRequestSchema>;

/**
 * 通道契约分片。
 *
 * 分片 id 恒为 capabilityId 的第二段（`common.session-tree` → `session-tree`）：
 * drift test 据它把「manifest 声明的通道」与「分片声明的契约键」对账
 * （capability-drift.spec.ts 的 drift 1）。
 */
export const sessionTreeContractShard = defineContractShard("session-tree", {
  [CHANNELS.sessionTreeGraph]: {
    request: sessionTreeGraphRequestSchema,
    response: sessionTreeGraphSchema,
  },
});

/**
 * 聊天区的**展开态**容器。
 *
 * 这两个容器原本是组件内的 `ref`：MessageItem.vue 的 openThinking 与
 * ToolActivity.vue 的 expanded。分段数据源一旦回收并重建组件实例（用户往上
 * 翻页、消息滚出窗口再滚回来），组件内 ref 随实例一起消失 —— 用户展开过的
 * 思考过程和工具输出会自己收起来，而且不报任何错。
 *
 * 提到 store 之后 key 与消息/工具绑定，不与组件实例绑定：
 *   - `openThinking` 的 key 是 `${messageKey}:${blockIndex}`；
 *   - `expandedTools` 的 key 是 toolCallId（它本身就跨渲染稳定）。
 *
 * 刻意**不放进 pinia store**：这是纯 UI 态，不参与代际治理、不需要按会话
 * 归一化，放进 defineStore 只会让组件多一层 useXxxStore() 的仪式。换会话时
 * 由 clearChatUiState() 统一清空（经 registerSessionScopedReset 注册）。
 */
import { reactive } from "vue";

export const openThinking = reactive<Record<string, boolean>>({});
export const expandedTools = reactive<Record<string, boolean>>({});

/** 思考块的稳定 key：消息 key + 块序号。 */
export function thinkingKey(messageKey: number | string, blockIndex: number): string {
  return `${messageKey}:${blockIndex}`;
}

/** 换会话时清空全部展开态（上一会话的展开态留着会错配到新会话的同序号块）。 */
export function clearChatUiState(): void {
  for (const key of Object.keys(openThinking)) delete openThinking[key];
  for (const key of Object.keys(expandedTools)) delete expandedTools[key];
}

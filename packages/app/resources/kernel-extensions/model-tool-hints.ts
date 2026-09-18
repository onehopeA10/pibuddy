/**
 * pi extension：按模型追加「工具使用提示」到系统提示词（内核级，随应用出厂）。
 *
 * ## 为什么需要它
 *
 * 实测 grok-4.6 在带「网关工具 + 用法示例」的工具面上有两个稳定的误用：
 *
 *   1. **把示例里的占位词当参数抄进去**。`mcp` 网关的描述写着
 *      `mcp({ search: "query" })`，模型于是发出 `search: "query basic web search"`
 *      —— 搜索按空格切词做 OR 匹配，"query" 这种废词直接把结果搅黄。
 *   2. **找错注册表**。它想要的 `smart_search` 是 pi-maestro-flow 注册的
 *      **本地延迟工具**，根本不是 MCP server 的工具；`mcp({search})` 只搜 MCP
 *      元数据缓存，永远命中不了。正确入口是 `search_tool_bm25`。
 *
 * 两条都不是 MCP 出错，是模型对工具面的理解偏差。给它一段针对性的引导即可，
 * 其它模型没这个问题、不该为此多付上下文 —— 所以按 `ctx.model` 判定只对 grok
 * 系追加。
 *
 * ## 为什么是 extension 而不是 `--append-system-prompt`
 *
 * PiBuddy 里模型是运行期经 RPC `set_model` 切的，启动参数拿不到「这一轮用的
 * 是哪个模型」。`before_agent_start` 每轮都触发、`ctx.model` 是当时的真值，
 * 用户中途从 grok 切到 claude，下一轮提示词就自动不带这段。
 *
 * ## 本文件不注册任何工具
 *
 * 只改系统提示词，零 IO、零工具、零权限。加载路径经 pi 的 `--extension` 参数
 * 指向随包投递的绝对路径（main/pi/kernel-extensions.ts），不物化进用户的
 * `~/.pi/agent/extensions/`，卸载应用就干净。
 *
 * 本文件不参与仓库 typecheck（resources/ 不在 tsconfig include 内），
 * `@earendil-works/pi-coding-agent` 由 pi 内置提供；单测在
 * test/model-tool-hints.spec.ts 直接 import 本文件。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 只认这几家：id 或 provider 里带 grok / xai 的都算 grok 系。 */
const GROK_RE = /grok|xai|x-ai/i;

/** 防重入标记：同一轮里别的扩展也改了 systemPrompt 时不重复追加。 */
export const HINT_MARKER = "<!-- pibuddy:model-tool-hints -->";

export const GROK_TOOL_HINT = `${HINT_MARKER}
# 工具使用提示（针对当前模型）

工具发现的正确入口：
- 需要一个当前没列出来的本地工具（比如 web 搜索、抓网页、来源核查）时，用 \`search_tool_bm25\`，它会按语义找出并激活匹配的本地工具。激活后**直接调用**那个工具，不要再经 \`mcp\` 找它。
- \`mcp({ search })\` **只搜 MCP 服务器上的工具**，搜不到 pi 本地工具；不确定一个工具属于哪边时先用 \`search_tool_bm25\`。
- 工具描述里的用法示例是**格式示范**，其中的 "query" / "name" / "tool_name" 等是占位词，**不要把它们抄进参数**。search 参数只放 2–4 个真实关键词，例如 \`search_tool_bm25({ query: "web search news" })\`。

失败处理：
- 一条 \`bash\` 命令因环境问题（命令不存在、Node 版本不对、路径解析到 WSL）失败后，不要原样重试同一条；换工具或如实报告。
- 同一个查询用同一个工具连续失败两次以上，就换关键词或换工具，不要机械重复。`;

interface ModelLike {
  id?: string;
  provider?: string;
}

export function isGrokModel(model: ModelLike | undefined): boolean {
  if (!model) return false;
  return GROK_RE.test(model.id ?? "") || GROK_RE.test(model.provider ?? "");
}

/** 纯函数：给定当前提示词与模型，返回要替换成的提示词；不需要改时返回 undefined。 */
export function hintedSystemPrompt(
  systemPrompt: string,
  model: ModelLike | undefined
): string | undefined {
  if (!isGrokModel(model)) return undefined;
  if (systemPrompt.includes(HINT_MARKER)) return undefined;
  return `${systemPrompt}\n\n${GROK_TOOL_HINT}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const next = hintedSystemPrompt(event.systemPrompt, ctx.model);
    return next === undefined ? undefined : { systemPrompt: next };
  });
}

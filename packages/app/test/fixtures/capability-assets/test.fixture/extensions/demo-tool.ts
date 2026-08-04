/**
 * R4 端到端 fixture extension：注册一个回显工具。
 *
 * 只用于测试物化通道；工具的权限需求在 fixture manifest 的 tools 里声明
 * （R4.3：物化不开权限旁路，执行动作走 pi 侧与宿主权限引擎）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "test.fixture.echo",
    label: "Echo",
    description: "Echo back the given text (PiBuddy R4 fixture).",
    parameters: Type.Object({
      text: Type.String({ description: "Text to echo" }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: params.text }],
        details: {},
      };
    },
  });
}

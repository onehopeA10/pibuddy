import { describe, expect, it } from "vitest";
import {
  isForegroundClientUsable,
  shouldRespawnAfterSwitchFailure,
} from "./switch-session-recover.js";

describe("switch-session 客户端已死后拉起", () => {
  it("认出走 switch_session 时客户端已经被拆掉的句子", () => {
    expect(
      shouldRespawnAfterSwitchFailure(
        new Error("Error invoking remote method 'pi:switch-session': Error: 客户端已停止")
      )
    ).toBe(true);
    expect(shouldRespawnAfterSwitchFailure(new Error("智能体运行时不可用：运行时不可用（phase=stopped）"))).toBe(
      true
    );
    expect(shouldRespawnAfterSwitchFailure(new Error("会话文件损坏"))).toBe(false);
    expect(
      shouldRespawnAfterSwitchFailure(
        new Error("Session file is not a valid pi session: C:\\\\x\\\\a.jsonl")
      )
    ).toBe(false);
    expect(
      shouldRespawnAfterSwitchFailure(new Error("这条会话文件已经损坏，无法打开。请再开一条新对话。"))
    ).toBe(false);
  });

  it("没有进程或已退出的 client 不能再发 RPC", () => {
    expect(isForegroundClientUsable(null)).toBe(false);
    expect(
      isForegroundClientUsable({
        running: false,
        assertUsable() {
          throw new Error("智能体运行时不可用：尚未启动，请先选择工作文件夹");
        },
      } as never)
    ).toBe(false);
  });
});

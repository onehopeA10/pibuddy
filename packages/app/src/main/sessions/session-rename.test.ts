import { describe, expect, it, vi } from "vitest";

import { renameSession, type SessionNameClient } from "./session-rename.js";

/** fake client：只需要能回一个 {success}，其余 RpcResponse 字段与本用例无关。 */
function fakeClient(resp: { success: boolean; error?: string }): {
  client: SessionNameClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => resp as never);
  return { client: { send }, send };
}

/**
 * 重命名的两条路径：
 *   - 目标是**当前打开的**会话 → 必须发 set_session_name，让名字真的落到
 *     会话文件里；RPC 返回 success:false 时必须抛错，不能只改索引（那样
 *     界面显示新名字、文件里还是旧名字，下次刷新又变回去）
 *   - 目标不是当前会话 → 一条 RPC 都不发（set_session_name 作用在当前会话
 *     上，发过去只会改错对象）
 */

function fakeIndex(): { rename: ReturnType<typeof vi.fn> } {
  return { rename: vi.fn() };
}

describe("renameSession", () => {
  it("活动会话：发出 set_session_name 并回写索引", async () => {
    const index = fakeIndex();
    const { client, send } = fakeClient({ success: true });

    await renameSession({
      index: index as never,
      sourcePath: "/s/a.jsonl",
      name: "季度报表",
      isActive: true,
      client,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "set_session_name", name: "季度报表" });
    expect(index.rename).toHaveBeenCalledWith("/s/a.jsonl", "季度报表");
  });

  it("RPC 返回 success:false 时抛错，且**不**改索引", async () => {
    const index = fakeIndex();
    const { client } = fakeClient({ success: false, error: "会话已关闭" });

    await expect(
      renameSession({
        index: index as never,
        sourcePath: "/s/a.jsonl",
        name: "新名字",
        isActive: true,
        client,
      })
    ).rejects.toThrow("会话已关闭");

    expect(index.rename).not.toHaveBeenCalled();
  });

  it("非活动会话：一条 RPC 都不发，只写索引", async () => {
    const index = fakeIndex();
    const { client, send } = fakeClient({ success: true });

    await renameSession({
      index: index as never,
      sourcePath: "/s/b.jsonl",
      name: "旧项目",
      isActive: false,
      client,
    });

    expect(send).not.toHaveBeenCalled();
    expect(index.rename).toHaveBeenCalledWith("/s/b.jsonl", "旧项目");
  });

  it("刚新建、磁盘上还没有文件的当前会话：仍经 RPC 改名，不碰索引", async () => {
    // pi 是惰性写文件的，新会话在发出第一条消息前查不到 sourcePath。
    // 这条路径实测会以 "SESSION_UNKNOWN" 报错，是「开新任务顺手起个名字」
    // 最直接的走法。
    const index = fakeIndex();
    const { client, send } = fakeClient({ success: true });

    await renameSession({
      index: index as never,
      sourcePath: null,
      name: "刚建的任务",
      isActive: true,
      client,
    });

    expect(send).toHaveBeenCalledWith({ type: "set_session_name", name: "刚建的任务" });
    expect(index.rename).not.toHaveBeenCalled();
  });

  it("既不是当前会话、磁盘上也没有它：给一句人话，而不是静默成功", async () => {
    const index = fakeIndex();
    await expect(
      renameSession({
        index: index as never,
        sourcePath: null,
        name: "无处安放",
        isActive: false,
        client: null,
      })
    ).rejects.toThrow("先说一句话再给它起名字");
    expect(index.rename).not.toHaveBeenCalled();
  });
});

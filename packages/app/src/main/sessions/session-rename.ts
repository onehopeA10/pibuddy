/**
 * 会话重命名（SES-101）。
 *
 * 两条路径，判据是「这个会话是不是 pi 当前正打开的那个」：
 *
 *   - **是**：先发 `{type:"set_session_name", name}`（rpc.md:772-790），让
 *     名字真正落到会话文件里 —— 只改索引的话，用户在 pi 命令行里看到的
 *     还是旧名字，而且我们的索引会在下一次全量重扫时被文件内容覆盖回去。
 *   - **否**：pi 没打开它，`set_session_name` 作用在当前会话上，发过去只会
 *     改错对象。此时只写索引的 name 列。
 *
 * RPC 的 `success:false` 必须抛出来：吞掉它的结果是界面显示新名字、文件里
 * 还是旧名字，下次刷新又变回去，用户完全无法理解发生了什么。
 */
import type { RpcResponse } from "@pibuddy/pi-sdk";
import type { SessionIndex } from "./session-index.js";

/** 只依赖「能发一条 set_session_name」这一件事，便于单测用 fake client。 */
export interface SessionNameClient {
  send(command: { type: "set_session_name"; name: string }): Promise<RpcResponse>;
}

export interface RenameSessionArgs {
  index: SessionIndex;
  /**
   * 会话文件的绝对路径。
   *
   * **可以为 null**：pi 是惰性写文件的，一个刚新建、还没发过消息的会话在
   * 磁盘上根本不存在，索引里自然也查不到它。那种情况下 isActive 为 true，
   * 名字经 RPC 直接落给 pi，索引等文件出现后自己会补上。
   */
  sourcePath: string | null;
  name: string;
  /** 目标是不是 pi 当前打开的那个会话 */
  isActive: boolean;
  client?: SessionNameClient | null;
}

export async function renameSession(args: RenameSessionArgs): Promise<void> {
  const { index, sourcePath, name, isActive, client } = args;

  if (isActive && client) {
    const resp = await client.send({ type: "set_session_name", name });
    // 吞掉 success:false 的后果是界面显示新名字、文件里还是旧名字，
    // 下次刷新又变回去 —— 用户完全无法理解发生了什么。
    if (resp.success === false) {
      throw new Error(resp.error ?? "重命名失败");
    }
  } else if (!sourcePath) {
    // 既不是当前会话、磁盘上又没有它：无处可写，如实报错而不是静默成功。
    throw new Error("这个会话还没有内容，先说一句话再给它起名字");
  }

  if (sourcePath) index.rename(sourcePath, name);
}

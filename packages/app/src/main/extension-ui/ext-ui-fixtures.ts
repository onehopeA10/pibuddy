/**
 * Extension UI 单测共用的替身（**不是 spec 文件**）。
 *
 * 刻意不放进任何一个 `*.test.ts`：从一个 spec 里 import 另一个 spec 会把
 * 被引文件的 describe / it 一并注册进引用方，同一批用例被重复计数 ——
 * 「78 个测试通过」里有一半是同一件事被数了三遍，而这种膨胀正好会掩盖
 * 「某个文件其实一个用例都没跑」。
 */
import { vi } from "vitest";
import type { PushChannel } from "@pibuddy/contract";
import type {
  ExtensionUiMethod,
  ExtensionUiRequest,
  ExtensionUiResponse,
} from "@pibuddy/pi-sdk";
import type { ExtUiHost } from "./ext-ui-service.js";

export interface FakeHost extends ExtUiHost {
  pushes: { targetId: number; channel: PushChannel; payload: unknown }[];
  writes: ExtensionUiResponse[];
  /** 置 false 模拟「runtime 已经没了」 */
  alive: boolean;
  /** stdin 写入的 spy：断言「超时后一条都没写」时用它 */
  respondSpy: ReturnType<typeof vi.fn>;
}

export function makeHost(alive = true): FakeHost {
  const respondSpy = vi.fn((response: ExtensionUiResponse) => {
    host.writes.push(response);
    return host.alive;
  });
  const host: FakeHost = {
    pushes: [],
    writes: [],
    alive,
    respondSpy,
    push: (targetId, channel, payload) => {
      host.pushes.push({ targetId, channel, payload });
    },
    responderFor: () => (host.alive ? { respondUi: respondSpy } : null),
  };
  return host;
}

let idSeq = 0;

export function req(
  method: ExtensionUiMethod,
  extra: Partial<ExtensionUiRequest> = {}
): ExtensionUiRequest {
  return {
    type: "extension_ui_request",
    id: `req-${++idSeq}`,
    method,
    ...extra,
  } as ExtensionUiRequest;
}

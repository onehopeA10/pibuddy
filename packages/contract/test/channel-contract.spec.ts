import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CHANNELS,
  CHANNEL_CONTRACTS,
  artifactContractShard,
  changesetContractShard,
  defineContractShard,
  isKnownChannel,
  mergeChannelContracts,
  previewContractShard,
  sealChannelContracts,
  workspaceFilesContractShard,
  type ChannelContract,
  type InvokeChannel,
} from "../src/index.js";

/**
 * 分片合并的判据（ADR-0002 实施顺序第 2 条）。
 *
 * 改前 `CHANNEL_CONTRACTS` 是 `Record<InvokeChannel, ChannelContract>`，
 * 「每条通道都有 schema」由类型的穷举性保证。分片之后那条保证只能由这里的
 * 断言接住：**缺一条、多一条、重复一条，三个方向都要红。**
 */

const STUB: ChannelContract = { request: z.void(), response: z.void() };

describe("封口：合并结果与 CHANNELS 全表严格一一对应", () => {
  it("键集恰等于 CHANNELS 的值集（既不缺也不多）", () => {
    const declared = Object.keys(CHANNEL_CONTRACTS).sort();
    const expected = (Object.values(CHANNELS) as string[]).sort();
    expect(declared).toEqual(expected);
  });

  it("每条通道都过得了 guard 的第一道闸，且请求/返回都是可 parse 的 schema", () => {
    for (const channel of Object.values(CHANNELS)) {
      expect(isKnownChannel(channel), channel).toBe(true);
      const contract = CHANNEL_CONTRACTS[channel];
      expect(typeof contract.request.parse, channel).toBe("function");
      expect(typeof contract.response.parse, channel).toBe("function");
    }
  });

  it("跨文件分片真的被合了进来（分片不是同一个文件里换个写法）", () => {
    // 这四片住在各自的域文件里（workspace.ts / preview.ts / artifacts.ts），
    // 它们的通道出现在合并结果里，才说明「各分片各自声明 + 宿主合并」这条
    // 路径是真的通的。
    for (const shard of [
      workspaceFilesContractShard,
      changesetContractShard,
      previewContractShard,
      artifactContractShard,
    ]) {
      expect(Object.keys(shard.contracts).length, shard.id).toBeGreaterThan(0);
      for (const channel of Object.keys(shard.contracts)) {
        expect(CHANNEL_CONTRACTS[channel as InvokeChannel], `${shard.id}/${channel}`).toBe(
          shard.contracts[channel as InvokeChannel]
        );
      }
    }
  });
});

describe("重复声明必须抛错，不得静默覆盖", () => {
  it("两个分片抢同一条通道时抛错，并指出是哪两个分片", () => {
    const a = defineContractShard("cap-a", { [CHANNELS.piAbort]: STUB });
    const b = defineContractShard("cap-b", { [CHANNELS.piAbort]: STUB });
    expect(() => mergeChannelContracts([a, b])).toThrowError(
      /CHANNEL_CONTRACT_DUPLICATE.*pi:abort.*cap-a.*cap-b/
    );
  });

  it("后注册者不会覆盖先注册者（裸 Map.set 的反面）", () => {
    const first: ChannelContract = { request: z.string(), response: z.void() };
    const second: ChannelContract = { request: z.number(), response: z.void() };
    const merged = mergeChannelContracts([
      defineContractShard("cap-a", { [CHANNELS.piAbort]: first }),
    ]);
    expect(merged[CHANNELS.piAbort]).toBe(first);
    expect(() =>
      mergeChannelContracts([
        defineContractShard("cap-a", { [CHANNELS.piAbort]: first }),
        defineContractShard("cap-b", { [CHANNELS.piAbort]: second }),
      ])
    ).toThrow();
  });

  it("重名分片本身就抛错（否则重复通道的报错会退化成「x 与 x 冲突」）", () => {
    expect(() =>
      mergeChannelContracts([
        defineContractShard("cap-a", { [CHANNELS.piAbort]: STUB }),
        defineContractShard("cap-a", { [CHANNELS.piStop]: STUB }),
      ])
    ).toThrowError(/CONTRACT_SHARD_DUPLICATE_ID.*cap-a/);
  });
});

describe("封口检查两个方向都查", () => {
  it("有通道没被任何分片声明时抛错，并点名缺的是谁", () => {
    const only = defineContractShard("cap-a", { [CHANNELS.piAbort]: STUB });
    expect(() => sealChannelContracts([only])).toThrowError(
      /CHANNEL_CONTRACT_MISSING.*pi:start/
    );
  });

  it("声明了 CHANNELS 里不存在的通道时抛错", () => {
    const bogus = {
      id: "cap-bogus",
      contracts: { "pi:definitely-not-a-channel": STUB } as never,
    };
    // 只喂这一片会先撞「缺一大堆」，所以把全量分片也带上，让唯一的问题是「多」。
    const full = defineContractShard(
      "cap-full",
      Object.fromEntries(
        (Object.values(CHANNELS) as InvokeChannel[]).map((c) => [c, STUB])
      ) as Record<InvokeChannel, ChannelContract>
    );
    expect(() => sealChannelContracts([full, bogus])).toThrowError(
      /CHANNEL_CONTRACT_UNKNOWN.*pi:definitely-not-a-channel/
    );
  });
});

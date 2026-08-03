/**
 * IPC 契约的**分片与合并**（ADR-0002 实施顺序第 2 条）。
 *
 * ## 从穷举 Record 到分片合并
 *
 * 改前 `CHANNEL_CONTRACTS` 是一个 `Record<InvokeChannel, ChannelContract>`
 * 对象字面量：类型的穷举性保证「每条通道都有 schema」，代价是**所有通道
 * 必须写在同一个对象里**。能力包架构要的是反过来 —— 每个包声明自己那几条
 * 通道，宿主把它们合起来。这两件事在一个对象字面量里无法同时成立。
 *
 * 于是穷举性从「编译期的类型约束」换成「装配期的封口检查」：
 *
 *   - `mergeChannelContracts` 在**重复 key 上抛错**，绝不静默覆盖；
 *   - `sealChannelContracts` 在合并之后核对 `CHANNELS` 全表，缺一条或多一条
 *     都当场抛错，然后 freeze。
 *
 * 抛错而不是覆盖，依据是 ADR-0002 D4 规则 6 与 `source/CodePilot`
 * `registry.ts:13-28` 的 seal 模式。反面教材是 pi 的裸 `Map.set`：后注册者
 * 静默覆盖先注册者，同名 Tool 冲突的表现是 RPC **直接启动失败**，而现场
 * 没有任何一句话指向「有两个同名的东西」。
 *
 * ## 为什么封口检查发生在模块加载期
 *
 * 因为它必须比 `ipc-guard` 早。guard 的四道闸里，第一道（`isKnownChannel`）
 * 直接查 `CHANNEL_CONTRACTS` 的键集；一条通道若漏掉契约，它在 guard 眼里
 * 就是「未知通道」。让这种状态活到运行期，等价于把一条通道悄悄从校验面上
 * 摘下来。合并期抛错则会让 `import "@pibuddy/contract"` 这件事本身失败 ——
 * 全部单测与应用启动一起红，不存在「只在某条冷路径上才发现」的可能。
 *
 * ## 本文件刻意不 import ipc-contract.ts
 *
 * 依赖方向必须是「分片 → 本文件」，否则各域的 schema 文件（workspace.ts /
 * artifacts.ts / preview.ts…）一旦想自带分片就会与 ipc-contract.ts 成环。
 * 本文件只依赖 zod 的类型与 channels.ts。
 */
import type { z } from "zod";

import { CHANNELS, type InvokeChannel } from "./channels.js";

/** 一条 invoke 通道的请求 / 返回 schema。 */
export interface ChannelContract {
  /** invoke 的入参 schema；无参通道为 z.void() */
  request: z.ZodType;
  /** invoke 的返回 schema */
  response: z.ZodType;
}

/**
 * 一个契约分片：一个命名的所有者 + 它声明的那几条通道。
 *
 * `id` 不是装饰：重复声明的报错要能指出**是哪两个分片**在抢同一条通道，
 * 否则报错只告诉你「冲突了」，找起来和没报一样。
 */
export interface ContractShard {
  /** 分片名（未来即 capabilityId）。全局唯一。 */
  readonly id: string;
  /**
   * 该分片声明的通道。
   *
   * 类型仍然是 `Partial<Record<InvokeChannel, …>>` 而不是 `Record<string, …>`：
   * 拼错通道名这件事因此仍然是**编译错误**。穷举性交给 seal，键的合法性
   * 留在编译期 —— 两者一个都不能少。
   */
  readonly contracts: Readonly<Partial<Record<InvokeChannel, ChannelContract>>>;
}

/** 声明一个分片。存在的意义是给分片一个统一的、可搜索的定义形态。 */
export function defineContractShard(
  id: string,
  contracts: Readonly<Partial<Record<InvokeChannel, ChannelContract>>>
): ContractShard {
  return { id, contracts };
}

/**
 * 合并若干分片。**重复的通道一律抛错，不覆盖。**
 *
 * 同时拒绝重名分片：两个分片叫同一个名字时，重复通道的报错会退化成
 * 「分片 x 与 分片 x 冲突」，等于没报。
 */
export function mergeChannelContracts(
  shards: readonly ContractShard[]
): Partial<Record<InvokeChannel, ChannelContract>> {
  const merged: Partial<Record<InvokeChannel, ChannelContract>> = {};
  /** channel → 声明它的分片 id */
  const owner = new Map<string, string>();
  const seenShardIds = new Set<string>();

  for (const shard of shards) {
    if (seenShardIds.has(shard.id)) {
      throw new Error(`CONTRACT_SHARD_DUPLICATE_ID: 分片名 "${shard.id}" 出现了两次`);
    }
    seenShardIds.add(shard.id);

    for (const [channel, contract] of Object.entries(shard.contracts)) {
      if (!contract) continue;
      const previous = owner.get(channel);
      if (previous !== undefined) {
        throw new Error(
          `CHANNEL_CONTRACT_DUPLICATE: 通道 ${channel} 同时由分片 "${previous}" 与 "${shard.id}" 声明`
        );
      }
      owner.set(channel, shard.id);
      merged[channel as InvokeChannel] = contract;
    }
  }

  return merged;
}

/**
 * 合并并封口：核对 `CHANNELS` 全表，然后冻结。
 *
 * 这是原先 `Record<InvokeChannel, ChannelContract>` 那条穷举性约束的等价物。
 * 两个方向都查：
 *
 *   - **缺**：`CHANNELS` 里有、没有任何分片声明 —— 该通道会被 guard 判成
 *     未知通道，四道闸对它形同虚设。
 *   - **多**：分片声明了一条 `CHANNELS` 里没有的通道 —— 说明通道名被删了
 *     而契约留着，或者分片抄错了名字。
 */
export function sealChannelContracts(
  shards: readonly ContractShard[]
): Record<InvokeChannel, ChannelContract> {
  const merged = mergeChannelContracts(shards);
  const declared = Object.keys(merged);
  const expected = Object.values(CHANNELS) as InvokeChannel[];
  const declaredSet = new Set<string>(declared);
  const expectedSet = new Set<string>(expected);

  const missing = expected.filter((channel) => !declaredSet.has(channel));
  if (missing.length > 0) {
    throw new Error(
      `CHANNEL_CONTRACT_MISSING: 以下通道没有任何分片声明契约：${missing.join(", ")}`
    );
  }

  const unknown = declared.filter((channel) => !expectedSet.has(channel));
  if (unknown.length > 0) {
    throw new Error(
      `CHANNEL_CONTRACT_UNKNOWN: 以下契约不对应任何已声明的通道：${unknown.join(", ")}`
    );
  }

  return Object.freeze(merged) as Record<InvokeChannel, ChannelContract>;
}

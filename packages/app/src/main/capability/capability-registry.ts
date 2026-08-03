/**
 * 能力注册表（ADR-0002 第一阶段）。
 *
 * ## 重复 id 抛错 + seal，绝不静默覆盖
 *
 * 依据 CodePilot `registry.ts:13-28`。反面教材是 pi 的裸 `Map.set`：后注册者
 * 静默覆盖先注册者，同名 Tool 冲突的表现是 **RPC 直接启动失败**，而现场没有
 * 任何一句话指向「有两个同名的东西」——宿主最后只能用三条硬编码关键词猜是
 * 哪两个在打架，猜中了就去删磁盘上的文件（`ExtensionManager.ts:586-590`）。
 * 那不是一个可以被继承的设计，是一个被迫的补丁。
 *
 * seal 的意义是**关闭注册窗口**：装配完成之后再想注册一个能力，只能抛错。
 * 没有这一步的话，「本次构建启用了哪些能力」就不是一个在某个时刻确定下来的
 * 事实，而是一个随时可能被追加的可变状态——那样任何基于它的断言都不成立。
 *
 * ## 通道所有权也在这里定
 *
 * 两个能力声明同一条通道，在合并契约那层（`mergeChannelContracts`）会抛错，
 * 但那只覆盖「契约分片」这一条路。能力包多了一条「manifest 声明」的路，
 * 两条路必须同样地拒绝重复，否则冲突会从没被守住的那条溜过去。
 *
 * ## 本文件刻意不 import electron
 *
 * 注册表是纯数据结构，activate/deactivate 只是被持有的函数引用。这样
 * drift test 与单测可以直接 import 它，不需要给 electron 打桩——需要打桩
 * 才能测的判据，最后都会变成没人跑的判据。
 */
import {
  assertValidCapabilityManifest,
  CAPABILITY_HOST_CONTRACT_VERSION,
  type AgentProfile,
  type CapabilityManifest,
} from "@pibuddy/contract";

/**
 * 一条注册项：manifest + 两个生命周期钩子。
 *
 * `activate` 在能力**启用时**被调用（注册它的 IPC）；未启用时一次都不调用，
 * 这就是 feature gate 在主进程侧的全部含义——没有第二处「其实也注册了但
 * 加了个 if」的地方。
 *
 * `deactivate` 负责 D4 规则 4 的拆卸：worker / listener / watcher / 子进程。
 * **不删用户数据**（规则 5：卸载与删数据是两个动作）。
 */
export interface CapabilityRegistration {
  readonly manifest: CapabilityManifest;
  readonly activate?: () => void;
  readonly deactivate?: () => void;
}

export interface CapabilityHostInfo {
  /** 宿主应用版本（package.json 的 version） */
  readonly appVersion: string;
  /** 宿主契约代际 */
  readonly contractVersion: number;
}

export interface CapabilityRejection {
  readonly id: string;
  readonly reason: string;
}

export interface CapabilityResolution {
  /** 最终启用的能力 id，按注册顺序 */
  readonly enabled: readonly string[];
  /** 被拒绝的能力及**可读的**原因 */
  readonly rejected: readonly CapabilityRejection[];
}

/**
 * 按数字段比较两个 `x.y.z`。
 *
 * 不引 semver：它会为了一个大小比较拖进一个带 range 语法的解析器，而这里
 * 需要的判断只有「>=」和「<」。非数字段（`1.2.0-beta.1` 的 `-beta.1`）按
 * 切分后的数字前缀比，预发布版本因此与它的正式版同级——第一阶段全部能力
 * 内置，不存在「装了个 beta 包」的场景，这个近似不会有代价。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((s) => Number.parseInt(s, 10));
  const pb = b.split(/[.\-+]/).map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityRegistration>();
  /** 注册顺序，供 `list()` 与 `resolve()` 给出稳定输出 */
  private readonly order: string[] = [];
  /** channel → 声明它的 capabilityId */
  private readonly channelOwner = new Map<string, string>();
  private sealed = false;

  register(registration: CapabilityRegistration): void {
    if (this.sealed) {
      throw new Error(
        `CAPABILITY_REGISTRY_SEALED: 注册表已封口，"${registration.manifest.id}" 来晚了`
      );
    }
    const { manifest } = registration;
    // 校验放在入表**之前**：一个不合法的 manifest 进了表，后面每一条基于
    // 表的断言都在一个不该存在的前提上运行。
    assertValidCapabilityManifest(manifest);

    if (this.entries.has(manifest.id)) {
      throw new Error(`CAPABILITY_DUPLICATE_ID: 能力 "${manifest.id}" 被注册了两次`);
    }
    for (const channel of manifest.channels) {
      const previous = this.channelOwner.get(channel);
      if (previous !== undefined) {
        throw new Error(
          `CAPABILITY_CHANNEL_CONFLICT: 通道 ${channel} 同时由 "${previous}" 与 "${manifest.id}" 声明`
        );
      }
    }
    for (const channel of manifest.channels) this.channelOwner.set(channel, manifest.id);
    this.entries.set(manifest.id, registration);
    this.order.push(manifest.id);
  }

  seal(): void {
    this.sealed = true;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): CapabilityRegistration | undefined {
    return this.entries.get(id);
  }

  /** 全部注册项，按注册顺序。 */
  list(): readonly CapabilityRegistration[] {
    return this.order.map((id) => this.entries.get(id)!);
  }

  manifests(): readonly CapabilityManifest[] {
    return this.list().map((entry) => entry.manifest);
  }

  ownerOfChannel(channel: string): string | undefined {
    return this.channelOwner.get(channel);
  }

  /**
   * 把「用户想启用哪些」折成「实际能启用哪些」。
   *
   * 四类拒绝，每类都给出可读原因（**不静默降级**）：
   *
   *   1. 请求了一个没注册的 id；
   *   2. 宿主版本 / 契约代际落在 `compatibility` 区间之外；
   *   3. 依赖的能力没被请求、或者它自己也被拒了；
   *   4. 依赖成环。
   *
   * 第 3 类要跑到不动点：A 依赖 B、B 因为版本不符被拒，那么 A 也必须被拒，
   * 而这件事在第一轮里看不出来。少了这一轮迭代的表现是 A 被启用、运行到
   * 某个用得着 B 的代码路径上才炸——那正是「静默降级」的典型形态。
   */
  resolve(requested: Iterable<string>, host: CapabilityHostInfo): CapabilityResolution {
    const wanted = new Set(requested);
    const rejected: CapabilityRejection[] = [];
    const rejectedIds = new Set<string>();

    const reject = (id: string, reason: string): void => {
      if (rejectedIds.has(id)) return;
      rejectedIds.add(id);
      rejected.push({ id, reason });
    };

    for (const id of wanted) {
      if (!this.entries.has(id)) reject(id, `未注册的能力 "${id}"`);
    }

    // ---- 兼容区间
    for (const id of wanted) {
      const entry = this.entries.get(id);
      if (!entry || rejectedIds.has(id)) continue;
      const { compatibility: compat } = entry.manifest;
      if (compareVersions(host.appVersion, compat.appMin) < 0) {
        reject(id, `需要宿主版本 >= ${compat.appMin}，当前 ${host.appVersion}`);
        continue;
      }
      if (compat.appBelow !== undefined && compareVersions(host.appVersion, compat.appBelow) >= 0) {
        reject(id, `需要宿主版本 < ${compat.appBelow}，当前 ${host.appVersion}`);
        continue;
      }
      if (host.contractVersion < compat.contractMin || host.contractVersion > compat.contractMax) {
        reject(
          id,
          `需要契约代际 ${compat.contractMin}~${compat.contractMax}，当前 ${host.contractVersion}`
        );
      }
    }

    // ---- 依赖，迭代到不动点
    for (;;) {
      let changed = false;
      for (const id of wanted) {
        if (rejectedIds.has(id)) continue;
        const entry = this.entries.get(id);
        if (!entry) continue;
        for (const dep of entry.manifest.dependencies) {
          if (!this.entries.has(dep)) {
            reject(id, `依赖 "${dep}" 未注册`);
            changed = true;
            break;
          }
          if (!wanted.has(dep)) {
            reject(id, `依赖 "${dep}" 未启用`);
            changed = true;
            break;
          }
          if (rejectedIds.has(dep)) {
            reject(id, `依赖 "${dep}" 被拒绝`);
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }

    // ---- 成环：不动点之后还活着的里面找环
    const alive = this.order.filter((id) => wanted.has(id) && !rejectedIds.has(id));
    const cycle = findCycle(alive, (id) => this.entries.get(id)!.manifest.dependencies);
    for (const id of cycle) {
      reject(id, `依赖成环：${cycle.join(" → ")} → ${cycle[0]}`);
    }

    return {
      enabled: this.order.filter((id) => wanted.has(id) && !rejectedIds.has(id)),
      rejected,
    };
  }
}

/** 在给定子图里找一条环；没有环时返回空数组。 */
function findCycle(nodes: readonly string[], depsOf: (id: string) => readonly string[]): string[] {
  const inSet = new Set(nodes);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let found: string[] = [];

  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) {
      found = stack.slice(stack.indexOf(id));
      return true;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dep of depsOf(id)) {
      if (!inSet.has(dep)) continue;
      if (visit(dep)) return true;
    }
    stack.pop();
    state.set(id, 2);
    return false;
  };

  for (const id of nodes) {
    if (visit(id)) break;
  }
  return found;
}

/**
 * 把一个 Profile 折成「请求启用的集合」。
 *
 * `overrides` 是用户在 Profile 之上的逐个开关：Profile 说开、用户关掉的关掉，
 * Profile 没说、用户打开的打开。两者分开存，因为**换 Profile 不该抹掉用户
 * 对某个能力的明确意见**——合并成一个集合存的话，换一次 Profile 就等于把
 * 那些意见全部丢了，而用户看到的是「我明明关过的东西又自己回来了」。
 */
export function requestedCapabilityIds(
  profile: AgentProfile | undefined,
  overrides: Readonly<Record<string, boolean>>
): Set<string> {
  const wanted = new Set<string>(profile?.capabilityIds ?? []);
  for (const [id, on] of Object.entries(overrides)) {
    if (on) wanted.add(id);
    else wanted.delete(id);
  }
  return wanted;
}

export { CAPABILITY_HOST_CONTRACT_VERSION };

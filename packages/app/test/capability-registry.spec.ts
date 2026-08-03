import { describe, expect, it } from "vitest";

import {
  capabilityManifestSchema,
  defineCapability,
  parseCapabilityPermission,
  validateCapabilityManifest,
  type CapabilityManifest,
} from "@pibuddy/contract";
import {
  CapabilityRegistry,
  compareVersions,
  requestedCapabilityIds,
} from "../src/main/capability/capability-registry.js";

/**
 * CapabilityRegistry 的行为判据（ADR-0002）。
 *
 * 全部用**合成 manifest**，不碰真实的四个能力：真实清单会跟着产品演进变，
 * 用它们来测「重复 id 会不会抛错」等于把一条机制判据挂在一份随时会改的
 * 数据上。合成 manifest 还让兼容区间、依赖成环这些在真实数据里不存在的
 * 情况可以被真的跑出来 —— 否则那几段代码就是没有判据的。
 */

const BASE = {
  manifestVersion: 1,
  version: "1.0.0",
  tier: "vertical",
  displayName: "合成能力",
  description: "仅用于测试。",
  compatibility: { appMin: "1.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  permissions: [],
  channels: [],
  pushChannels: [],
  tools: [],
  uiContributions: [],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: { loading: "inline", heavyDependencies: [], teardown: [] },
  exposure: { module: "main/x.ts", register: "registerX" },
} as const;

function make(overrides: Record<string, unknown>): CapabilityManifest {
  return defineCapability({ ...BASE, ...overrides });
}

const HOST = { appVersion: "1.5.0", contractVersion: 1 };

describe("重复 id 抛错 + seal（CodePilot registry.ts:13-28 的手法）", () => {
  it("同一个 id 注册两次直接抛错，不静默覆盖", () => {
    const registry = new CapabilityRegistry();
    registry.register({ manifest: make({ id: "test.a" }) });
    expect(() => registry.register({ manifest: make({ id: "test.a" }) })).toThrow(
      /CAPABILITY_DUPLICATE_ID/
    );
  });

  it("后注册者没有覆盖先注册者 —— 表里留下的是第一个", () => {
    const registry = new CapabilityRegistry();
    registry.register({ manifest: make({ id: "test.a", displayName: "第一个" }) });
    try {
      registry.register({ manifest: make({ id: "test.a", displayName: "第二个" }) });
    } catch {
      // 预期的抛错
    }
    expect(registry.get("test.a")?.manifest.displayName).toBe("第一个");
    expect(registry.list().length).toBe(1);
  });

  it("seal 之后再注册一律抛错：注册窗口在装配期关闭", () => {
    const registry = new CapabilityRegistry();
    registry.register({ manifest: make({ id: "test.a" }) });
    registry.seal();
    expect(registry.isSealed).toBe(true);
    expect(() => registry.register({ manifest: make({ id: "test.b" }) })).toThrow(
      /CAPABILITY_REGISTRY_SEALED/
    );
  });

  it("两个能力抢同一条通道也抛错，并且报出是哪两个", () => {
    const registry = new CapabilityRegistry();
    registry.register({ manifest: make({ id: "test.a", channels: ["pi:abort"] }) });
    expect(() =>
      registry.register({ manifest: make({ id: "test.b", channels: ["pi:abort"] }) })
    ).toThrow(/CAPABILITY_CHANNEL_CONFLICT.*test\.a.*test\.b/s);
  });

  it("不合法的 manifest 进不了表", () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registry.register({
        manifest: { ...BASE, id: "没有命名空间" } as unknown as CapabilityManifest,
      })
    ).toThrow(/CAPABILITY_MANIFEST_INVALID/);
    expect(registry.list().length).toBe(0);
  });
});

describe("依赖解析：不满足就拒绝启用，不静默降级", () => {
  function registryOf(...manifests: CapabilityManifest[]): CapabilityRegistry {
    const registry = new CapabilityRegistry();
    for (const manifest of manifests) registry.register({ manifest });
    registry.seal();
    return registry;
  }

  it("依赖没被请求 → 拒绝，并说明是哪一条依赖", () => {
    const registry = registryOf(
      make({ id: "test.base" }),
      make({ id: "test.dep", dependencies: ["test.base"] })
    );
    const result = registry.resolve(["test.dep"], HOST);
    expect(result.enabled).toEqual([]);
    expect(result.rejected).toEqual([{ id: "test.dep", reason: '依赖 "test.base" 未启用' }]);
  });

  it("依赖被请求了就放行", () => {
    const registry = registryOf(
      make({ id: "test.base" }),
      make({ id: "test.dep", dependencies: ["test.base"] })
    );
    const result = registry.resolve(["test.base", "test.dep"], HOST);
    expect(result.enabled).toEqual(["test.base", "test.dep"]);
    expect(result.rejected).toEqual([]);
  });

  it("依赖因兼容区间被拒时，依赖它的那个**也**被拒（迭代到不动点）", () => {
    // 少了这一轮迭代的表现是 test.dep 被启用、运行到某个用得着 test.base 的
    // 代码路径上才炸 —— 那正是「静默降级」的典型形态。
    const registry = registryOf(
      make({ id: "test.base", compatibility: { appMin: "9.0.0", contractMin: 1, contractMax: 1 } }),
      make({ id: "test.dep", dependencies: ["test.base"] })
    );
    const result = registry.resolve(["test.base", "test.dep"], HOST);
    expect(result.enabled).toEqual([]);
    expect(result.rejected.map((r) => r.id).sort()).toEqual(["test.base", "test.dep"]);
    expect(result.rejected.find((r) => r.id === "test.base")?.reason).toMatch(/宿主版本 >= 9\.0\.0/);
    expect(result.rejected.find((r) => r.id === "test.dep")?.reason).toMatch(/被拒绝/);
  });

  it("依赖成环 → 两条都拒，原因里带出那条环", () => {
    const registry = registryOf(
      make({ id: "test.a", dependencies: ["test.b"] }),
      make({ id: "test.b", dependencies: ["test.a"] })
    );
    const result = registry.resolve(["test.a", "test.b"], HOST);
    expect(result.enabled).toEqual([]);
    expect(result.rejected.every((r) => /依赖成环/.test(r.reason))).toBe(true);
  });

  it("请求一个没注册的 id → 拒绝而不是当作不存在", () => {
    const registry = registryOf(make({ id: "test.a" }));
    const result = registry.resolve(["test.a", "test.ghost"], HOST);
    expect(result.enabled).toEqual(["test.a"]);
    expect(result.rejected).toEqual([{ id: "test.ghost", reason: '未注册的能力 "test.ghost"' }]);
  });

  it("契约代际落在区间外 → 拒绝", () => {
    const registry = registryOf(
      make({ id: "test.a", compatibility: { appMin: "0.0.0", contractMin: 2, contractMax: 3 } })
    );
    const result = registry.resolve(["test.a"], HOST);
    expect(result.enabled).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/契约代际 2~3，当前 1/);
  });

  it("appBelow 上界是**不含**的", () => {
    const registry = registryOf(
      make({
        id: "test.a",
        compatibility: { appMin: "0.0.0", appBelow: "1.5.0", contractMin: 1, contractMax: 1 },
      })
    );
    expect(registry.resolve(["test.a"], HOST).enabled).toEqual([]);
    expect(registry.resolve(["test.a"], { ...HOST, appVersion: "1.4.9" }).enabled).toEqual([
      "test.a",
    ]);
  });
});

describe("命名空间强制（ADR-0002 D4 规则 6）", () => {
  it("工具名缺前缀 → 校验失败", () => {
    const errors = validateCapabilityManifest(
      capabilityManifestSchema.parse({
        ...BASE,
        id: "test.a",
        permissions: ["workspace.read"],
        tools: [{ name: "read_file", description: "读", permissions: ["workspace.read"] }],
      })
    );
    expect(errors).toContain('tools "read_file" 缺少 capabilityId 前缀 "test.a."');
  });

  it("UI 贡献 id 与配置键缺前缀 → 校验失败", () => {
    const errors = validateCapabilityManifest(
      capabilityManifestSchema.parse({
        ...BASE,
        id: "test.a",
        uiContributions: [
          { slot: "sidebar.section", id: "panel", title: "面板", module: "m.vue", host: "h.vue" },
        ],
        settingsSchema: [{ key: "showTree", type: "boolean", description: "显示" }],
      })
    );
    expect(errors).toContain('uiContributions "panel" 缺少 capabilityId 前缀 "test.a."');
    expect(errors).toContain('settingsSchema "showTree" 缺少 capabilityId 前缀 "test.a."');
  });

  it("带前缀就通过", () => {
    expect(() =>
      make({
        id: "test.a",
        permissions: ["workspace.read"],
        tools: [{ name: "test.a.read", description: "读", permissions: ["workspace.read"] }],
        uiContributions: [
          {
            slot: "sidebar.section",
            id: "test.a.panel",
            title: "面板",
            module: "m.vue",
            host: "h.vue",
          },
        ],
        settingsSchema: [{ key: "test.a.showTree", type: "boolean", description: "显示" }],
      })
    ).not.toThrow();
  });

  it("工具用到没申请过的权限 → 校验失败", () => {
    const errors = validateCapabilityManifest(
      capabilityManifestSchema.parse({
        ...BASE,
        id: "test.a",
        tools: [{ name: "test.a.run", description: "跑", permissions: ["process.shell"] }],
      })
    );
    expect(errors).toContain('tools "test.a.run" 用到未申请的权限 "process.shell"');
  });
});

describe("ADR-0002 D3：能力只能申请权限，不能自行授予", () => {
  it("manifest 里出现任何授予语义的键 → 直接抛错", () => {
    // strict schema 先挡一道
    expect(() => defineCapability({ ...BASE, id: "test.a", granted: ["workspace.write"] })).toThrow();
  });

  it("藏在嵌套对象里的授予字段也会被点名（strict 挡不住新增嵌套时的这一类）", () => {
    // 绕过 zod 直接喂进校验器：模拟「schema 演进时顺手放行了一个新嵌套对象」
    const sneaky = {
      ...BASE,
      id: "test.a",
      runtime: { ...BASE.runtime, grants: ["process.shell"] },
    } as unknown as CapabilityManifest;
    const errors = validateCapabilityManifest(sneaky);
    expect(errors.some((e) => /manifest\.runtime\.grants.*授予语义/.test(e))).toBe(true);
  });

  it("权限枚举只认 ADR D3 的那一组", () => {
    expect(parseCapabilityPermission("workspace.read")).toEqual({
      kind: "workspace.read",
      argument: null,
    });
    expect(parseCapabilityPermission("network:api.openai.com")).toEqual({
      kind: "network",
      argument: "api.openai.com",
    });
    expect(parseCapabilityPermission("secret:sttApiKey")).toEqual({
      kind: "secret",
      argument: "sttApiKey",
    });
    // 通配等于「任意出站」，而 main 侧唯一的出站原语存在的意义就是不许有这种东西
    expect(parseCapabilityPermission("network:*")).toBeNull();
    expect(parseCapabilityPermission("filesystem.any")).toBeNull();
    expect(parseCapabilityPermission("workspace.read:extra")).toBeNull();
  });
});

describe("ADR-0002 D2：带重依赖就必须懒加载 + 有预算", () => {
  it("重依赖 + inline → 抛错", () => {
    expect(() =>
      make({
        id: "test.a",
        runtime: {
          loading: "inline",
          heavyDependencies: ["monaco-editor"],
          teardown: [],
        },
      })
    ).toThrow(/必须懒加载/);
  });

  it("重依赖 + lazy 但没预算 → 抛错", () => {
    expect(() =>
      make({
        id: "test.a",
        runtime: {
          loading: "lazy",
          entry: "renderer/src/coding/index.ts",
          heavyDependencies: ["monaco-editor"],
          teardown: [],
        },
      })
    ).toThrow(/bundleBudgetKb/);
  });

  it("lazy + entry + 预算 → 通过（编码包日后就长这样）", () => {
    expect(() =>
      make({
        id: "vertical.coding",
        runtime: {
          loading: "lazy",
          entry: "renderer/src/coding/index.ts",
          bundleBudgetKb: 4096,
          heavyDependencies: ["monaco-editor"],
          teardown: ["worker"],
        },
        exposure: { module: "main/coding/coding-ipc.ts", register: "registerCodingIpc", dispose: "disposeCoding" },
      })
    ).not.toThrow();
  });

  it("声明了 teardown 却没有 dispose → 抛错（D4 规则 4）", () => {
    expect(() =>
      make({
        id: "test.a",
        runtime: { loading: "inline", heavyDependencies: [], teardown: ["watcher"] },
      })
    ).toThrow(/exposure\.dispose/);
  });
});

describe("Profile 与 overrides 的折叠", () => {
  it("overrides 在 Profile 之上生效，两个方向都生效", () => {
    const profile = {
      id: "p",
      displayName: "P",
      description: "d",
      capabilityIds: ["test.a", "test.b"],
    };
    expect([...requestedCapabilityIds(profile, {})].sort()).toEqual(["test.a", "test.b"]);
    expect([...requestedCapabilityIds(profile, { "test.b": false })].sort()).toEqual(["test.a"]);
    expect([...requestedCapabilityIds(profile, { "test.c": true })].sort()).toEqual([
      "test.a",
      "test.b",
      "test.c",
    ]);
  });

  it("未知 Profile 折出空集合，而不是悄悄回落到全开", () => {
    expect([...requestedCapabilityIds(undefined, {})]).toEqual([]);
  });
});

describe("版本比较", () => {
  it("按数字段比，不是字符串比", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("0.1.0", "1.0.0")).toBe(-1);
  });
});

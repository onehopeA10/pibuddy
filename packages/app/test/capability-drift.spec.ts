import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHANNELS, CHANNEL_CONTRACT_SHARDS, validateCapabilityManifest } from "@pibuddy/contract";
import {
  AGENT_PROFILES,
  BUILT_IN_CAPABILITIES,
  DEFAULT_PROFILE_ID,
} from "../src/main/capability/capability-manifests.js";

/**
 * 能力清单的 drift test（ADR-0002）。
 *
 * ## 它在防什么
 *
 * manifest 是一份**声明**。声明与实现之间如果没有一条机器能走的路，那它就
 * 只是注释：权限预览里写着「只读工作区」，而代码里早就多了一个 shell.openPath；
 * 界面上写着「本能力提供文件树」，而那个组件半年前就被删了。两种情况都不会
 * 有任何东西变红。
 *
 * 手法照搬 CodePilot `capability-contract.ts:178-217`：每条能力钉住它的暴露点
 * （模块路径 + 符号名），断言用 grep 写。与本仓一贯的结构性断言（「守卫外
 * `ipcMain` 命中数恒为 0」、「内核模块不得 import pi 域」）是同一手法。
 *
 * ## 这份 drift test 自己不能是恒真的
 *
 * 数据驱动的断言最容易失效的方式是**数据集为空**：清单一条都没有时，
 * 「对每条清单断言…」永远通过。因此第一组用例先把「清单集合非空、每条都
 * 有通道 / 权限 / UI 贡献」钉死；后面每一组再各自对账。
 *
 * 三条对账的**对拍验证**（把机制临时拆掉、确认变红）记在
 * `.workflow/scratch/capability-research/FIX-capability-core.md`。
 */

const APP_SRC = path.resolve(import.meta.dirname, "../src");

function readSource(relative: string): string {
  return fs.readFileSync(path.join(APP_SRC, relative), "utf8");
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(APP_SRC, relative));
}

/**
 * 去掉注释后的源码。
 *
 * 不去的话，一句「本域没有 shell.openPath(」的**注释**会被判成一次调用 ——
 * 权限对账于是变成了「注释里有没有提到过它」，比没有还糟。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** 一个能力目录下的全部实现源码（拼成一串），已去注释。 */
function capabilitySource(moduleRelative: string): string {
  const dir = path.join(APP_SRC, path.dirname(moduleRelative));
  const parts: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    // 清单自身与单测不是实现：前者里写的是对实现的描述，后者里写的是构造出来
    // 的场景，两者都会把不存在的调用喂给对账。
    if (entry.name.endsWith(".capability.ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
    parts.push(stripComments(fs.readFileSync(path.join(dir, entry.name), "utf8")));
  }
  return parts.join("\n");
}

/**
 * 权限 → 源码标记。
 *
 * 每条标记都带 `\(`：要的是**一次调用**，不是一次提及。
 */
const PERMISSION_MARKERS: Record<string, RegExp> = {
  "workspace.read":
    /\b(readFile|readFileSync|createReadStream|readdir|readdirSync|opendirSync)\s*\(/,
  "workspace.write":
    /\b(writeFile|writeFileSync|writeFileAtomic|writeJsonAtomic|mkdirSync|rmSync|renameSync|copyFile|copyFileSync|appendFileSync|cpSync)\s*\(|shell\.trashItem\s*\(/,
  "process.shell": /\b(execFile|execFileSync|spawn|spawnSync)\s*\(/,
  "process.git": /\bsimpleGit\s*\(|\bnodegit\b/,
  "external.open": /shell\.(openPath|showItemInFolder)\s*\(/,
  network: /\bsafeFetch\s*\(/,
  secret: /\b(readSecret|writeSecret)\s*\(/,
};

/** 拆卸种类 → 源码标记。 */
const TEARDOWN_MARKERS: Record<string, RegExp> = {
  "child-process": /utilityProcess\.fork\s*\(|child_process/,
  worker: /new\s+Worker\s*\(/,
  watcher: /fs\.watch\s*\(|chokidar/,
};

/** manifest 里一条权限归到哪个标记键下（`network:x` → `network`）。 */
function markerKeyOf(permission: string): string {
  const sep = permission.indexOf(":");
  return sep > 0 ? permission.slice(0, sep) : permission;
}

const shardById = new Map(CHANNEL_CONTRACT_SHARDS.map((s) => [s.id, s] as const));
/** `piStart` → `pi:start`。源码里写的是键名，清单里存的是通道字符串。 */
const CHANNEL_BY_KEY = new Map<string, string>(Object.entries(CHANNELS));

describe("能力清单本身不为空（数据驱动的断言最容易失效的方式是数据集为空）", () => {
  /**
   * 四个数据面能力是这一组「反-塌缩地基」的锚点：drift 1-5 全部数据驱动，
   * 它们只有在清单集合始终非空、且这四个始终在册时才不会空洞通过。
   *
   * 这里刻意**不锁死总数、不锁死完整 id 列表**：能力包按 ADR-0002 逐个追加
   * （session-tree / memory / … 三个并行包同时在长），锁死总数等于让每一个
   * 新能力都来改这一行，三个包会在同一行上互撞。改成「地基必须在 + 无重复 +
   * 有下界」既挡住数据集塌缩，又容得下并行追加。
   */
  const CORE_DATA_PLANE = [
    "common.workspace-files",
    "common.workspace-review",
    "common.preview",
    "common.artifacts",
  ];

  it("四个数据面能力始终在册，且没有重复 id", () => {
    const ids = BUILT_IN_CAPABILITIES.map((m) => m.id);
    for (const id of CORE_DATA_PLANE) expect([id, ids.includes(id)]).toEqual([id, true]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每份清单都通过装配期校验", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      expect([manifest.id, validateCapabilityManifest(manifest)]).toEqual([manifest.id, []]);
    }
  });

  it("每份清单都声明了通道与 UI 贡献；权限可空但整批至少一份非空（防 drift3 空洞）", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      expect([manifest.id, manifest.channels.length > 0]).toEqual([manifest.id, true]);
      expect([manifest.id, manifest.uiContributions.length > 0]).toEqual([manifest.id, true]);
    }
    // 纯读内核状态的能力（如 common.session-tree）合法地一条权限都不申请；
    // 但整批里至少要有一份非空，否则 drift3 的权限对账没有任何数据可嚼。
    expect(BUILT_IN_CAPABILITIES.some((m) => m.permissions.length > 0)).toBe(true);
  });

  it("清单合起来的通道无跨能力重复，且不少于数据面原有的 24 条", () => {
    const all = BUILT_IN_CAPABILITIES.flatMap((m) => [...m.channels]);
    // 无重复：两个能力抢同一条通道，这里就红（与 CapabilityRegistry 的
    // channelOwner、mergeChannelContracts 三处一致地拒绝）。
    expect(new Set(all).size).toBe(all.length);
    // 反-塌缩下界：四个数据面能力原本就有 24 条，掉到 24 以下说明有能力丢了通道。
    expect(all.length).toBeGreaterThanOrEqual(24);
  });
});

describe("drift 1：清单声明的通道 == 实际注册的通道", () => {
  it("exposure.register 是 exposure.module 里真实存在的导出", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      const source = readSource(manifest.exposure.module);
      expect([manifest.id, new RegExp(`export function ${manifest.exposure.register}\\b`).test(source)]).toEqual([
        manifest.id,
        true,
      ]);
    }
  });

  it("注册函数体里 registerHandler 的通道集合与清单逐条对上", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      const source = stripComments(readSource(manifest.exposure.module));
      const body = source.slice(source.indexOf(`export function ${manifest.exposure.register}`));
      // registerHandler 是全仓唯一的注册入口（ipc-guard.ts），因此「注册了哪些
      // 通道」这个问题在源码上就等于「registerHandler( 后面跟着哪些 CHANNELS.x」。
      const registered = [...body.matchAll(/registerHandler(?:<[^>]*>)?\s*\(\s*(?:\/\/[^\n]*\n\s*)?CHANNELS\.(\w+)/g)]
        .map((m) => m[1]);
      // CHANNELS.<key> → 通道字符串：清单里存的是字符串，源码里写的是键名。
      const registeredChannels = registered.map((key) => CHANNEL_BY_KEY.get(key) ?? `未知键 ${key}`);
      expect([manifest.id, [...registeredChannels].sort()]).toEqual([
        manifest.id,
        [...manifest.channels].sort(),
      ]);
    }
  });

  it("清单声明的通道 == 该能力契约分片的键集合", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      // 分片 id 是 capabilityId 的第二段：`common.workspace-files` → `workspace-files`。
      const shard = shardById.get(manifest.id.split(".")[1]);
      expect([manifest.id, shard !== undefined]).toEqual([manifest.id, true]);
      expect([manifest.id, Object.keys(shard!.contracts).sort()]).toEqual([
        manifest.id,
        [...manifest.channels].sort(),
      ]);
    }
  });
});

describe("drift 2：清单声明的 UI 贡献 == 实际存在且被挂载的组件", () => {
  it("每条贡献的实现模块与宿主模块都在磁盘上", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      for (const c of manifest.uiContributions) {
        expect([c.id, "module", exists(c.module)]).toEqual([c.id, "module", true]);
        expect([c.id, "host", exists(c.host)]).toEqual([c.id, "host", true]);
      }
    }
  });

  it("宿主模块里真的引用了那个组件", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      for (const c of manifest.uiContributions) {
        const host = stripComments(readSource(c.host));
        expect([c.id, host.includes(path.basename(c.module))]).toEqual([c.id, true]);
      }
    }
  });

  it("有 UI 贡献的能力，至少有一个宿主对它做了启用门控", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      const hosts = [...new Set(manifest.uiContributions.map((c) => c.host))];
      const gated = hosts.some((host) =>
        stripComments(readSource(host)).includes(`isEnabled("${manifest.id}")`)
      );
      expect([manifest.id, gated]).toEqual([manifest.id, true]);
    }
  });
});

describe("drift 3：清单声明的权限 == 实际发起的请求（双向）", () => {
  it("声明了的权限，源码里必须真的用到", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      const source = capabilitySource(manifest.exposure.module);
      for (const permission of manifest.permissions) {
        const marker = PERMISSION_MARKERS[markerKeyOf(permission)];
        expect([manifest.id, permission, marker !== undefined && marker.test(source)]).toEqual([
          manifest.id,
          permission,
          true,
        ]);
      }
    }
  });

  it("源码里用到的能力，必须在清单里申请过（这一半才是安全判据）", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      const source = capabilitySource(manifest.exposure.module);
      const declared = new Set(manifest.permissions.map(markerKeyOf));
      const used = Object.entries(PERMISSION_MARKERS)
        .filter(([, marker]) => marker.test(source))
        .map(([key]) => key);
      const undeclared = used.filter((key) => !declared.has(key));
      expect([manifest.id, undeclared]).toEqual([manifest.id, []]);
    }
  });
});

describe("drift 4：清单声明的拆卸项 == 实际持有的运行期资源", () => {
  it("源码里开了子进程 / worker / watcher 的，必须声明对应的 teardown", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      const source = capabilitySource(manifest.exposure.module);
      const declared = new Set<string>(manifest.runtime.teardown);
      const undeclared = Object.entries(TEARDOWN_MARKERS)
        .filter(([kind, marker]) => marker.test(source) && !declared.has(kind))
        .map(([kind]) => kind);
      expect([manifest.id, undeclared]).toEqual([manifest.id, []]);
    }
  });

  it("声明了 teardown 的，dispose 函数必须是 exposure.module 的真实导出", () => {
    for (const manifest of BUILT_IN_CAPABILITIES) {
      if (manifest.runtime.teardown.length === 0) continue;
      const dispose = manifest.exposure.dispose;
      expect([manifest.id, dispose !== undefined]).toEqual([manifest.id, true]);
      const source = readSource(manifest.exposure.module);
      expect([manifest.id, new RegExp(`export function ${dispose}\\b`).test(source)]).toEqual([
        manifest.id,
        true,
      ]);
    }
  });
});

describe("drift 5：装配点确实把每条清单接进去了", () => {
  it("capability-catalog 逐条 register 了四个能力，并且 seal 了", () => {
    const catalog = stripComments(readSource("main/capability/capability-catalog.ts"));
    for (const manifest of BUILT_IN_CAPABILITIES) {
      expect([manifest.id, catalog.includes(manifest.exposure.register)]).toEqual([
        manifest.id,
        true,
      ]);
      expect([manifest.id, catalog.includes(manifest.exposure.dispose ?? "")]).toEqual([
        manifest.id,
        true,
      ]);
    }
    expect(catalog).toContain("capabilityRegistry.seal()");
  });

  it("ipc-registry 里不再有任何一个能力域的写死注册调用", () => {
    const registry = stripComments(readSource("main/ipc-registry.ts"));
    for (const manifest of BUILT_IN_CAPABILITIES) {
      // 写死一行 registerWorkspaceIpc() 等于给 feature gate 开一个后门：
      // 能力显示为已禁用，通道却照样在那儿。
      expect([manifest.id, registry.includes(`${manifest.exposure.register}(`)]).toEqual([
        manifest.id,
        false,
      ]);
    }
  });

  it("每个 Profile 引用的 capabilityId 都是注册过的", () => {
    const known = new Set(BUILT_IN_CAPABILITIES.map((m) => m.id));
    for (const profile of AGENT_PROFILES) {
      const unknown = profile.capabilityIds.filter((id) => !known.has(id));
      expect([profile.id, unknown]).toEqual([profile.id, []]);
    }
    expect(AGENT_PROFILES.map((p) => p.id)).toContain(DEFAULT_PROFILE_ID);
  });
});

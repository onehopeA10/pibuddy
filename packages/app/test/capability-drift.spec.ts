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

/**
 * 权限扫描的显式豁免表（ISS-005）。
 *
 * ## 为什么要有这张表
 *
 * 扫描曾经只看能力目录的**顶层文件**，子目录整个是盲区——放进子目录就等于
 * 免检，而免检是**隐式**的，没人批准过。现在扫描递归全部子目录，免检必须在
 * 这里**显式**登记：每条豁免的 reason 要能回答「为什么这里的权限特征不算
 * 主进程权限使用」。
 *
 * 粒度到文件或目录（目录 = 该目录整棵子树）。路径相对 APP_SRC，用 `/` 分隔，
 * 与 manifest 里 exposure.module 的写法一致。
 *
 * 表自身的防恒真：下面 drift 3 里有一条断言钉住「每条豁免都指向磁盘上真实
 * 存在的路径」——路径没了 = 豁免过期 = 红，过期条目不许留。
 */
const PERMISSION_SCAN_EXEMPTIONS: readonly { path: string; reason: string }[] = [
  {
    path: "main/remote/pwa-assets",
    // 这些 .ts 只是**装浏览器端代码的字符串容器**：整段 HTML/JS 以模板字符串
    // 形式发给手机浏览器执行（PWA 前端）。里面的 fetch() 等特征在手机浏览器里
    // 运行，走的是 remote-server 的 HTTP 面（有自己的鉴权），从不在主进程执行，
    // 因此不算主进程权限使用。
    reason: "发给手机浏览器执行的 PWA 前端代码字符串，权限特征在浏览器端运行，不经主进程权限面",
  },
];

/** rel（相对 APP_SRC、`/` 分隔）是否落在豁免表里（命中文件本身或其祖先目录）。 */
function isExemptFromPermissionScan(rel: string): boolean {
  return PERMISSION_SCAN_EXEMPTIONS.some(
    (ex) => rel === ex.path || rel.startsWith(`${ex.path}/`)
  );
}

/**
 * 一个能力目录下的全部实现源码（拼成一串），已去注释。
 *
 * **递归**遍历全部子目录（ISS-005）：子目录不是盲区，想免检要上
 * PERMISSION_SCAN_EXEMPTIONS 显式登记。node_modules 跳过；清单自身与单测
 * 按既有惯例跳过。
 */
function capabilitySource(moduleRelative: string): string {
  const parts: string[] = [];
  const walk = (relDir: string): void => {
    for (const entry of fs.readdirSync(path.join(APP_SRC, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (isExemptFromPermissionScan(rel)) continue;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      // 清单自身与单测不是实现：前者里写的是对实现的描述，后者里写的是构造出来
      // 的场景，两者都会把不存在的调用喂给对账。
      if (entry.name.endsWith(".capability.ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
      parts.push(stripComments(fs.readFileSync(path.join(APP_SRC, rel), "utf8")));
    }
  };
  walk(path.dirname(moduleRelative));
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
  // coding.git 用**系统 git CLI**（ADR-0002 D2：不引 nodegit/simple-git 之类带原生
  // 依赖的库），所有 git 子进程都经 git-cli 的 runGit() 唯一原语。runGit 内部把
  // execFile 别名成 execGit 调用，因此不会命中上面的 process.shell 标记——「跑
  // git」归 process.git，「跑任意子进程」才归 process.shell，两者在源码上可分。
  // 保留 simpleGit/nodegit 两个备选，日后若换实现仍可对账。
  "process.git": /\bsimpleGit\s*\(|\bnodegit\b|\brunGit\s*\(/,
  "external.open": /shell\.(openPath|showItemInFolder)\s*\(/,
  network: /\bsafeFetch\s*\(/,
  // local 车道（SEC-004 扩展）：声明 network.local 的能力，其源码里必须真的
  // 经这两个受控原语之一出站；反向对账同样生效——用了它们却没声明，红。
  "network.local": /\bsafeLocalFetch\s*\(|\bopenLocalWebSocket\s*\(/,
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
  it("豁免表每条都指向真实存在的路径且带非空理由（路径没了 = 豁免过期 = 红）", () => {
    // 豁免表自己也不能恒真：指向已删除路径的豁免什么都豁免不了，却会在
    // 同名路径将来复活时静默生效。过期条目必须删。
    for (const ex of PERMISSION_SCAN_EXEMPTIONS) {
      expect([ex.path, fs.existsSync(path.join(APP_SRC, ex.path))]).toEqual([ex.path, true]);
      expect([ex.path, ex.reason.trim().length > 0]).toEqual([ex.path, true]);
    }
  });

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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Governed Hybrid Memory 规格 §27 的宿主侧回归。
 *
 * Live Calendar / package.json 走工作区真实文件（测试用 __setLiveRoot）。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mem-gov-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const {
  logicalKindFromType,
  logicalScopeFromMemoryScope,
  memoryEnvelopeSchema,
  memoryPlanSchema,
  taskAnalysisSchema,
  workingItemSchema,
} = await import("@pibuddy/contract");
const { __setMemoryDataDir, memoryStore } = await import("../src/main/memory/memory-store.js");
const { injectMemory, getLastMemoryPrep, disposeMemoryInject } = await import(
  "../src/main/memory/memory-inject.js"
);
const { applyCapabilityResolution, __resetCapabilityState } = await import(
  "../src/main/capability/capability-state.js"
);
const { MEMORY_CAPABILITY_ID } = await import("../src/main/capability/manifests/memory.manifest.js");
const { listHindsight, recallHindsight, reflectHindsight, seedHindsight, setHindsightAvailable } = await import(
  "../src/main/memory/hindsight-adapter.js"
);
const { __setLiveRoot, replaceLiveSourceProviders } = await import("../src/main/memory/live-sources.js");
const { reconstructInjected, lastPrepLog } = await import("../src/main/memory/prep-log.js");
const { evaluateInjectPolicy } = await import("../src/main/memory/inject-policy.js");
const { resolveEnvelopes } = await import("../src/main/memory/authority-resolver.js");
const { envelopeFromRecord } = await import("../src/main/memory/memory-normalizer.js");
const { planMemory } = await import("../src/main/memory/memory-router.js");
const { fastAnalyze } = await import("../src/main/memory/memory-analyzer.js");
const { benchmarkMemoryModes } = await import("../src/main/memory/memory-benchmark.js");

const WS = "ws-gov";
const WS_B = "ws-gov-b";
const SESS = "sess-gov";

function writeLiveWorkspace(workspaceId: string, files: Record<string, string>): string {
  const dir = path.join(userData, `live-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  __setLiveRoot(workspaceId, dir);
  return dir;
}

function todayKey(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

beforeEach(() => {
  const dir = path.join(userData, `d-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  __setMemoryDataDir(dir);
  disposeMemoryInject();
  applyCapabilityResolution([MEMORY_CAPABILITY_ID]);
});

afterEach(() => {
  disposeMemoryInject();
  __resetCapabilityState();
  __setMemoryDataDir(null);
});

describe("Phase 0 契约可实例化", () => {
  it("旧 type/scope 映射到 logical kind/scope", () => {
    expect(logicalKindFromType("instruction")).toBe("constraint");
    expect(logicalKindFromType("context")).toBe("fact");
    expect(logicalScopeFromMemoryScope("workspace")).toBe("project");
    expect(logicalScopeFromMemoryScope("global")).toBe("user");
  });

  it("Envelope / Working / Analysis / Plan schema 能 parse", () => {
    expect(
      memoryEnvelopeSchema.parse({
        id: "e1",
        scope: "project",
        logicalKind: "constraint",
        claimSubject: "package_manager",
        claimPredicate: "default",
        claimObjectJson: "\"yarn\"",
        source: "canonical",
        backend: "sqlite",
        sourceRef: null,
        sourceHash: "abc",
        status: "active",
        observedAt: null,
        verifiedAt: null,
        validFrom: null,
        validUntil: null,
        evidence: [],
        retrieval: null,
        content: "yarn",
        estimatedTokens: 1,
      }).id
    ).toBe("e1");
    expect(
      workingItemSchema.parse({
        id: "w1",
        kind: "procedure",
        content: "pnpm run build",
        sourceMemoryId: "m1",
        sourceHash: "h1",
        createdTurn: 0,
        expires: "task_end",
        refreshOnSourceChange: true,
      }).expires
    ).toBe("task_end");
    expect(
      taskAnalysisSchema.parse({
        intent: "knowledge",
        memorySignal: "none",
        historyNeed: "none",
        currentStateNeed: "none",
        scopes: { user: false, project: false, agent: false, organization: false },
        logicalKinds: [],
        entities: [],
        temporalExpressions: [],
        ambiguity: 0.1,
        genericKnowledge: true,
      }).genericKnowledge
    ).toBe(true);
    expect(
      memoryPlanSchema.parse({
        mode: "none",
        working: { read: false, write: false, dedupeLoadedSources: true },
        canonicalReads: [],
        recalls: [],
        reflections: [],
        liveValidations: [],
      }).mode
    ).toBe("none");
  });
});

describe("§27 本期实现", () => {
  it.each([
    "今天天气如何", "明天北京会下雨吗", "昨天北京天气如何", "今天几号",
    "帮我翻译这句话：Good morning", "2+2等于多少", "为什么太阳总是东升西落",
    "那明天呢", "再来一个", "继续",
  ])("独立问题或裸承接不因打开工作区就拉取项目记忆：%s", (prompt) => {
    const analysis = fastAnalyze(prompt, { hasActiveProject: true });
    expect(analysis.scopes.project).toBe(false);
    expect(planMemory(analysis, prompt)).toMatchObject({
      mode: "none",
      working: { read: false, write: false },
      canonicalReads: [], recalls: [], reflections: [], liveValidations: [],
    });
  });

  it("同一会话从项目问题转到天气不会复用旧 Working，返回原任务仍可复用", async () => {
    memoryStore().save({
      workspaceId: WS, content: "这个 repo 用 pnpm run build 构建", type: "instruction", scope: "workspace",
    });
    const project = "这个 repo 怎么 build？";
    expect(await injectMemory(project, WS, SESS)).toContain("pnpm run build");
    expect(memoryStore().listWorkingItems(WS, SESS).length).toBeGreaterThan(0);
    for (const prompt of ["今天天气如何", "那明天呢", "昨天北京天气如何"]) {
      expect(await injectMemory(prompt, WS, SESS)).toBe(prompt);
      expect(getLastMemoryPrep()).toMatchObject({ mode: "none", fromWorking: 0, recalled: 0, liveRefs: [] });
    }
    expect(await injectMemory(project, WS, SESS)).toContain("pnpm run build");
    expect(getLastMemoryPrep()?.fromWorking).toBeGreaterThan(0);
  });

  it("切换到明确但不同的项目问题也不整包复用旧 Working", async () => {
    memoryStore().save({ workspaceId: WS, content: "本项目季度报告放在 finance/report.xlsx", type: "fact", scope: "workspace" });
    memoryStore().save({ workspaceId: WS, content: "这个 repo 用 pnpm run build 构建", type: "instruction", scope: "workspace" });
    expect(await injectMemory("本项目季度报告在哪", WS, SESS)).toContain("finance/report.xlsx");
    const next = await injectMemory("这个 repo 怎么 build？", WS, SESS);
    expect(next).toContain("pnpm run build");
    expect(next).not.toContain("finance/report.xlsx");
  });

  it("0. 纯问候分析和路由都是 no-memory，带继续或显式记忆文本仍 recall", () => {
    const greeting = "您好！";
    const greetingAnalysis = fastAnalyze(greeting, { hasActiveProject: true });
    const greetingPlan = planMemory(greetingAnalysis, greeting);
    expect(greetingAnalysis).toMatchObject({
      intent: "conversation",
      memorySignal: "none",
      historyNeed: "none",
      currentStateNeed: "none",
      scopes: { user: false, project: false, agent: false, organization: false },
    });
    expect(greetingPlan).toMatchObject({
      mode: "none",
      working: { read: false, write: false },
      canonicalReads: [],
      recalls: [],
      reflections: [],
      liveValidations: [],
    });

    const continuation = "你好，继续上次报告";
    expect(fastAnalyze(continuation, { hasActiveProject: true }).historyNeed).toBe("continuation");
    expect(planMemory(fastAnalyze(continuation, { hasActiveProject: true }), continuation).mode).toBe("recall");

    const explicit = "你好，你还记得我之前的报告吗？";
    expect(fastAnalyze(explicit, { hasActiveProject: true }).memorySignal).toBe("explicit");
    expect(planMemory(fastAnalyze(explicit, { hasActiveProject: true }), explicit).mode).toBe("recall");
  });

  it("1. Python GIL 是什么 → mode=none，不查长期记忆", async () => {
    memoryStore().save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    const prompt = "Python GIL 是什么？";
    const out = await injectMemory(prompt, WS, SESS);
    expect(out).toBe(prompt);
    expect(getLastMemoryPrep()?.mode).toBe("none");
    expect(getLastMemoryPrep()?.recalled).toBe(0);
    expect(out).not.toContain("MEMORY_CONTEXT");
  });

  it("1b. 什么是 Python GIL → mode=none，不查长期记忆", async () => {
    memoryStore().save({ workspaceId: WS, content: "后端用 PostgreSQL", type: "fact", scope: "workspace" });
    const prompt = "什么是 Python GIL？";
    const out = await injectMemory(prompt, WS, SESS);
    expect(out).toBe(prompt);
    expect(getLastMemoryPrep()?.mode).toBe("none");
    expect(getLastMemoryPrep()?.recalled).toBe(0);
  });

  it("2. 这个 repo 怎么 build → 注入项目规程指针", async () => {
    memoryStore().save({
      workspaceId: WS,
      content: "这个 repo 用 pnpm run build 构建",
      type: "instruction",
      scope: "workspace",
    });
    const prompt = "这个 repo 怎么 build？";
    const out = await injectMemory(prompt, WS, SESS);
    expect(out).not.toBe(prompt);
    expect(out).toContain("pnpm run build");
    expect(out).toContain("MEMORY_CONTEXT");
    expect(out).toContain("VERIFIED_MEMORY");
  });

  it("7. 现在项目 Node 版本是多少 → Canonical hint + Live file", async () => {
    writeLiveWorkspace(WS, {
      "package.json": JSON.stringify({ engines: { node: "22.x" } }),
    });
    memoryStore().save({
      workspaceId: WS,
      content: "项目 Node 版本是 18",
      type: "fact",
      scope: "workspace",
    });
    const out = await injectMemory("现在项目 Node 版本是多少？", WS, SESS);
    expect(out).toContain("package.json 声明 Node 版本是 22.x");
    expect(getLastMemoryPrep()?.liveRefs).toContain("package.json");
  });

  it("R6. 无关 fact 不会因 logicalKind 被压成一条", () => {
    const finance = memoryStore().save({
      workspaceId: WS,
      content: "这个项目是给财务团队做的",
      type: "fact",
      scope: "workspace",
    });
    const timeout = memoryStore().save({
      workspaceId: WS,
      content: "后端超时设为三十秒",
      type: "fact",
      scope: "workspace",
    });
    const resolved = resolveEnvelopes([
      envelopeFromRecord(finance.record!),
      envelopeFromRecord(timeout.record!),
    ]);
    expect(resolved.admitted).toHaveLength(2);
  });

  it("R7. MemoryPlan.recalls 带编译后的 query，不再写 deferred", () => {
    const prompt = "我之前说过默认喜欢哪个包管理器？";
    const plan = planMemory(fastAnalyze(prompt, { hasActiveProject: true }), prompt);
    expect(plan.recalls.length).toBeGreaterThan(0);
    expect(plan.recalls[0]?.query).not.toBe("deferred");
    expect(plan.recalls[0]?.query).toMatch(/包管理器|喜欢|之前/);
  });

  it("8. 项目 yarn 约束 shadow 用户 pnpm 偏好，且不删用户行", async () => {
    const pref = memoryStore().save({
      workspaceId: WS,
      content: "我喜欢默认用 pnpm 做包管理器",
      type: "preference",
      scope: "global",
    });
    const constraint = memoryStore().save({
      workspaceId: WS,
      content: "本项目包管理器必须用 yarn",
      type: "instruction",
      scope: "workspace",
    });
    expect(pref.ok && constraint.ok).toBe(true);
    const out = await injectMemory("我该用哪个包管理器？", WS, SESS);
    expect(out).toContain("yarn");
    expect(memoryStore().get(pref.record!.id)?.content).toContain("pnpm");
    expect(memoryStore().get(constraint.record!.id)?.content).toContain("yarn");
  });

  it("10. 猜测+记住 不自动写成 Canonical fact", async () => {
    const prompt = "我猜这次是 Redis 导致的，记住";
    const before = memoryStore().query({ workspaceId: WS }).length;
    await injectMemory(prompt, WS, SESS);
    expect(memoryStore().query({ workspaceId: WS }).length).toBe(before);
    const candidates = memoryStore().listCandidates(WS);
    expect(candidates.some((c) => c.logicalKind === "belief" && c.status === "pending")).toBe(true);
  });

  it("14. Working source_hash 变化则失效", () => {
    memoryStore().upsertWorkingItem({
      workspaceId: WS,
      sessionId: SESS,
      kind: "fact",
      content: "Node >=20",
      sourceMemoryId: "m-node",
      sourceHash: "aaa",
    });
    expect(memoryStore().invalidateWorkingIfHashChanged(WS, SESS, "m-node", "bbb")).toBe(true);
    expect(memoryStore().listWorkingItems(WS, SESS)).toHaveLength(0);
  });

  it("16. 同任务第二次命中 Working，不再 Recall 同一来源", async () => {
    memoryStore().save({
      workspaceId: WS,
      content: "部署前先跑 pnpm test",
      type: "instruction",
      scope: "workspace",
    });
    const prompt = "这个项目怎么部署？";
    const first = await injectMemory(prompt, WS, SESS);
    expect(first).toContain("pnpm test");
    expect(getLastMemoryPrep()?.recalled).toBeGreaterThan(0);
    const second = await injectMemory(prompt, WS, SESS);
    expect(second).toContain("pnpm test");
    expect(getLastMemoryPrep()?.fromWorking).toBeGreaterThan(0);
    expect(getLastMemoryPrep()?.recalled).toBe(0);
  });

  it("17. Project A 记忆不泄漏到 Project B", async () => {
    memoryStore().save({
      workspaceId: WS,
      content: "A 项目的生产库是内部秘密库名",
      type: "fact",
      scope: "workspace",
    });
    const out = await injectMemory("生产库是什么", WS_B, "sess-b");
    expect(out).not.toContain("内部秘密库名");
  });

  it("18. API key 写入前被拒绝", () => {
    const saved = memoryStore().save({
      workspaceId: WS,
      content: "api_key: sk-abcdefghijklmnopqrstuvwxyz012345",
      type: "fact",
      scope: "workspace",
    });
    expect(saved.ok).toBe(false);
    expect(saved.record).toBeNull();
  });

  it("记住 API key 不进 candidate 也不进 Hindsight", async () => {
    setHindsightAvailable(true);
    const prompt = "记住 api_key: sk-abcdefghijklmnopqrstuvwxyz012345";
    await injectMemory(prompt, WS, SESS);
    expect(memoryStore().listCandidates(WS)).toHaveLength(0);
    expect(listHindsight(WS).every((ep) => !/sk-[a-z0-9]{16,}/i.test(ep.content))).toBe(true);
  });
});

describe("Hindsight / Resolver / PostTask / Benchmark", () => {
  it("3. 我之前说过默认喜欢哪个包管理器 → User Recall", async () => {
    setHindsightAvailable(true);
    seedHindsight({
      bankId: "user",
      workspaceId: null,
      factType: "world",
      content: "用户默认喜欢 pnpm 做包管理器",
      tags: ["包管理", "pnpm"],
      observedAt: Date.now(),
    });
    const prompt = "我之前说过默认喜欢哪个包管理器？";
    const out = await injectMemory(prompt, WS, SESS);
    expect(getLastMemoryPrep()?.mode).toBe("recall");
    expect(getLastMemoryPrep()?.hindsight).toBeGreaterThan(0);
    expect(out).toContain("pnpm");
    expect(out).toContain("PAST_EXPERIENCE");
  });

  it("5. 上次 Docker 为什么失败 → Project experience", async () => {
    setHindsightAvailable(true);
    seedHindsight({
      bankId: WS,
      workspaceId: WS,
      factType: "experience",
      content: "上次 Docker 失败是因为 volume permission",
      tags: ["docker", "失败"],
      observedAt: Date.now(),
    });
    const out = await injectMemory("上次 Docker 为什么失败？", WS, SESS);
    expect(getLastMemoryPrep()?.mode).toBe("recall");
    expect(out).toContain("volume permission");
    expect(out).toContain("PAST_EXPERIENCE");
  });

  it("6. 为什么最近三次 deploy 都失败 → Recall + Reflect", async () => {
    setHindsightAvailable(true);
    for (const n of [1, 2, 3]) {
      seedHindsight({
        bankId: WS,
        workspaceId: WS,
        factType: "experience",
        content: `第 ${n} 次 deploy 失败：CI 超时`,
        tags: ["deploy", "失败"],
        observedAt: Date.now() - n * 1000,
      });
    }
    const out = await injectMemory("为什么最近三次 deploy 都失败？", WS, SESS);
    expect(getLastMemoryPrep()?.mode).toBe("reflect");
    expect(out).toContain("PAST_EXPERIENCE");
    expect(out).toContain("DERIVED_MEMORY");
    expect(out).toContain("[DERIVED - NOT VERIFIED FACT]");
  });

  it("9. 以后都默认用 pnpm，记住 → candidate，不 commit fact", async () => {
    setHindsightAvailable(true);
    const prompt = "以后都默认用 pnpm，记住";
    const before = memoryStore().query({ workspaceId: WS }).length;
    await injectMemory(prompt, WS, SESS);
    expect(memoryStore().query({ workspaceId: WS }).length).toBe(before);
    expect(memoryStore().listCandidates(WS).some((c) => c.status === "pending")).toBe(true);
    expect(listHindsight(WS).some((ep) => ep.content.includes("pnpm") && ep.workspaceId === null)).toBe(true);
    const other = await injectMemory("我之前说过默认用 pnpm？", WS_B, "sess-other");
    expect(other).toContain("pnpm");
    expect(other).toContain("PAST_EXPERIENCE");
  });

  it("R8. 缺 workspaceId 的 Hindsight search 为空", () => {
    setHindsightAvailable(true);
    seedHindsight({
      bankId: WS_B,
      workspaceId: WS_B,
      factType: "experience",
      content: "B 仓 Docker 失败是权限问题",
      tags: ["docker", "失败"],
      observedAt: Date.now(),
    });
    expect(recallHindsight("Docker 失败")).toEqual([]);
    expect(listHindsight()).toEqual([]);
    expect(recallHindsight("Docker 失败", { workspaceId: WS })).toEqual([]);
    expect(recallHindsight("Docker 失败", { workspaceId: WS_B }).some((e) => e.content.includes("权限"))).toBe(true);
  });

  it("11. 今天有什么会议 → Live Calendar 是 source of truth", async () => {
    writeLiveWorkspace(WS, {
      "calendar.json": JSON.stringify({
        date: todayKey(),
        events: [{ title: "站会", at: "10:00" }],
      }),
    });
    memoryStore().save({
      workspaceId: WS,
      content: "记忆里写着今天下午才有会",
      type: "fact",
      scope: "workspace",
    });
    const out = await injectMemory("今天有什么会议？", WS, SESS);
    expect(out).toContain("今天的会议：10:00 站会");
    expect(getLastMemoryPrep()?.liveRefs).toContain("calendar");
    expect(out).toMatch(/<VERIFIED_MEMORY>[\s\S]*今天的会议：10:00 站会[\s\S]*<\/VERIFIED_MEMORY>/);
  });

  it("12. 根据过去半年最常纠结什么 → temporal Reflect", async () => {
    setHindsightAvailable(true);
    seedHindsight({
      bankId: WS,
      workspaceId: WS,
      factType: "observation",
      content: "过去半年在 Agent 项目里最常纠结权限模型",
      tags: ["纠结", "agent"],
      observedAt: Date.now(),
    });
    const out = await injectMemory("根据过去半年，我在 Agent 项目里最常纠结什么？", WS, SESS);
    expect(getLastMemoryPrep()?.mode).toBe("reflect");
    expect(out).toContain("DERIVED_MEMORY");
    expect(out).toMatch(/纠结|权限模型/);
  });

  it("13. Hindsight observation 与 package.json 冲突 → live 胜", async () => {
    writeLiveWorkspace(WS, {
      "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    });
    setHindsightAvailable(true);
    seedHindsight({
      bankId: WS,
      workspaceId: WS,
      factType: "observation",
      content: "观察认为 package.json 默认包管理器是 yarn",
      tags: ["包管理", "yarn"],
      observedAt: Date.now(),
    });
    const out = await injectMemory("我之前观察的包管理器和 package.json 冲突时用哪个？", WS, SESS);
    expect(out).toContain("package.json 声明包管理器是 pnpm");
    expect(out).toMatch(/<VERIFIED_MEMORY>[\s\S]*package\.json 声明包管理器是 pnpm[\s\S]*<\/VERIFIED_MEMORY>/);
    expect(out).not.toMatch(/<VERIFIED_MEMORY>[\s\S]*默认包管理器是 yarn[\s\S]*<\/VERIFIED_MEMORY>/);
  });

  it("15. Reflect 高 confidence 仍是 A7 belief", async () => {
    setHindsightAvailable(true);
    seedHindsight({
      bankId: WS,
      workspaceId: WS,
      factType: "experience",
      content: "部署失败多次，怀疑是缓存",
      tags: ["deploy", "失败"],
      observedAt: Date.now(),
    });
    const out = await injectMemory("为什么最近几次部署总失败？", WS, SESS);
    expect(out).toContain("[DERIVED - NOT VERIFIED FACT]");
    expect(out).toContain("DERIVED_MEMORY");
    expect(out).not.toMatch(/<VERIFIED_MEMORY>[\s\S]*综合/);
  });

  it("19. Hindsight 下线时 Canonical 仍可用", async () => {
    setHindsightAvailable(false);
    memoryStore().save({
      workspaceId: WS,
      content: "这个 repo 用 pnpm run build 构建",
      type: "instruction",
      scope: "workspace",
    });
    const out = await injectMemory("这个 repo 怎么 build？", WS, SESS);
    expect(getLastMemoryPrep()?.mode).toBe("canonical");
    expect(out).toContain("pnpm run build");
  });

  it("20. Hindsight final=0.99 不得提升 Authority", async () => {
    setHindsightAvailable(true);
    memoryStore().save({
      workspaceId: WS,
      content: "本项目包管理器必须用 yarn",
      type: "instruction",
      scope: "workspace",
    });
    const high = seedHindsight({
      bankId: "user",
      workspaceId: null,
      factType: "world",
      content: "历史偏好默认用 pnpm 做包管理器",
      tags: ["包管理", "pnpm"],
      observedAt: Date.now(),
    });
    const recalled = recallHindsight("包管理器", { workspaceId: WS });
    const reflect = reflectHindsight("包管理器", { workspaceId: WS });
    expect(high?.id).toBeTruthy();
    const canonical = envelopeFromRecord(memoryStore().query({ workspaceId: WS })[0]!);
    const resolved = resolveEnvelopes([...recalled, ...reflect, canonical]);
    expect(resolved.admitted.some((e) => e.content.includes("yarn"))).toBe(true);
    expect(resolved.admitted.some((e) => e.retrieval?.final === 0.99)).toBe(false);
    const out = await injectMemory("我该用哪个包管理器？", WS, SESS);
    expect(out).toContain("yarn");
    expect(out).not.toMatch(/<VERIFIED_MEMORY>[\s\S]*pnpm/);
  });

  it("Phase 6 四模式 benchmark 都有 retrieved", async () => {
    memoryStore().save({
      workspaceId: WS,
      content: "这个 repo 用 pnpm run build 构建",
      type: "instruction",
      scope: "workspace",
    });
    setHindsightAvailable(true);
    seedHindsight({
      bankId: "user",
      workspaceId: null,
      factType: "world",
      content: "用户默认喜欢 pnpm 做包管理器",
      tags: ["包管理", "pnpm"],
      observedAt: Date.now(),
    });
    const stats = await benchmarkMemoryModes("这个 repo 怎么 build？", WS, `${SESS}-bench`);
    expect(Object.keys(stats).sort()).toEqual(["canonical", "off", "recall", "reflect"].sort());
    expect(stats.off.retrieved).toBe(0);
    expect(stats.canonical.injected).toBe(true);
    expect(typeof stats.recall.retrieved).toBe("number");
    expect(typeof stats.reflect.retrieved).toBe("number");
  });
});

describe("dsh 可迁移缝", () => {
  it("政策钩是唯一 skip 入口", () => {
    expect(evaluateInjectPolicy({ capabilityEnabled: false, workspaceId: WS, injectionActive: true })).toEqual({
      action: "skip",
      reason: "capability_disabled",
    });
    expect(evaluateInjectPolicy({ capabilityEnabled: true, workspaceId: "", injectionActive: true })).toEqual({
      action: "skip",
      reason: "missing_workspace",
    });
    expect(evaluateInjectPolicy({ capabilityEnabled: true, workspaceId: WS, injectionActive: false })).toEqual({
      action: "skip",
      reason: "injection_inactive",
    });
    expect(evaluateInjectPolicy({ capabilityEnabled: true, workspaceId: WS, injectionActive: true })).toEqual({
      action: "allow",
    });
  });

  it("skip 不写 prep log，能力关闭时 message 字节不变", async () => {
    applyCapabilityResolution([]);
    const prompt = "现在项目 Node 版本是多少？";
    expect(await injectMemory(prompt, WS, SESS)).toBe(prompt);
    expect(lastPrepLog(WS, SESS)).toBeNull();
  });

  it("注入块可由 prep log 重建", async () => {
    writeLiveWorkspace(WS, { "package.json": JSON.stringify({ engines: { node: "22.11.0" } }) });
    const prompt = "现在项目 Node 版本是多少？";
    const out = await injectMemory(prompt, WS, SESS);
    expect(out).not.toBe(prompt);
    expect(reconstructInjected(WS, SESS, prompt)).toBe(out);
  });

  it("替换 Live 提供者会改变 calendar，inject 仍只消费 collect", async () => {
    writeLiveWorkspace(WS, {
      "calendar.json": JSON.stringify({ date: todayKey(), events: [{ title: "文件里的会", at: "09:00" }] }),
    });
    replaceLiveSourceProviders([
      {
        id: "fake-cal",
        collect: (_workspaceId, refs) => {
          if (!refs.includes("calendar")) return [];
          return [
            {
              id: "live-cal",
              scope: "project",
              logicalKind: "fact",
              claimSubject: "calendar",
              claimPredicate: "today",
              claimObjectJson: null,
              source: "live",
              backend: "filesystem",
              sourceRef: "seam",
              sourceHash: "fake",
              status: "active",
              observedAt: Date.now(),
              verifiedAt: Date.now(),
              validFrom: Date.now(),
              validUntil: null,
              evidence: [{ type: "current_file", ref: "seam" }],
              retrieval: null,
              content: "今天的会议：缝替换会议",
              estimatedTokens: 8,
            },
          ];
        },
      },
    ]);
    const out = await injectMemory("今天有什么会议？", WS, SESS);
    expect(out).toContain("缝替换会议");
    expect(out).not.toContain("文件里的会");
  });
});

describe("Working 按工作区隔离", () => {
  it("同一 sessionId 在 B 读不到 A 的 Working", () => {
    memoryStore().upsertWorkingItem({
      workspaceId: WS,
      sessionId: SESS,
      kind: "fact",
      content: "A 的私有事实",
    });
    expect(memoryStore().listWorkingItems(WS, SESS)).toHaveLength(1);
    expect(memoryStore().listWorkingItems(WS_B, SESS)).toHaveLength(0);
  });
});

describe("v3 表存在", () => {
  it("打开库后 working_items 可写入", () => {
    const item = memoryStore().upsertWorkingItem({
      workspaceId: WS,
      sessionId: SESS,
      kind: "fact",
      content: "x",
    });
    expect(memoryStore().listWorkingItems(WS, SESS).map((w) => w.id)).toContain(item.id);
  });
});

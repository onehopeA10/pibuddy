import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARCHIVED_TOOL_RESULT_KIND,
  DEFAULT_TOOL_ARCHIVE_MAX_ESTIMATED_TOKENS,
  buildToolArchiveRef,
  guardToolResult,
  isArchivedToolResultPlaceholder,
  parseToolArchiveRef,
  serializeToolResult,
  setToolArchiveMaxEstimatedTokens,
  toolArchiveMaxEstimatedTokens,
  type ToolResultGuardOutcome,
} from "./result-guard.js";
import { estimateTokens } from "./token-estimate.js";

/**
 * 护栏判定与占位符构造（tool-archive）。
 *
 * `archive` 是注入的，所以这一组是**纯逻辑对拍**：不碰磁盘、不碰 electron。
 * 六条不变式里的 1（只改回包不改归档）、2（归档成功前不得构造占位符）、
 * 3（fail-open 三种失败等价）、4（占位符自带可恢复引用）钉在这里；
 * 5（恢复读取有界）与 6（读回前四校验）钉在 test/tool-archive-e2e.spec.ts。
 */

const WORKSPACE = "0123456789abcdef0123456789abcdef";

/** 一个必然超阈值的中文结果（60 个带中文描述的实体）。 */
function bigChineseResult(): unknown {
  return {
    total: 60,
    entities: Array.from({ length: 60 }, (_, i) => ({
      id: `light.living_room_${i}`,
      name: `客厅主灯${i}号`,
      description: "位于客厅顶部的主照明设备，支持色温与亮度调节，归属客厅区域",
    })),
  };
}

/** 一个必然不超阈值的小结果。 */
const smallResult = { total: 1, entities: ["light.living_room | 客厅灯 | on | 客厅"] };

afterEach(() => {
  setToolArchiveMaxEstimatedTokens(null);
});

describe("阈值判定", () => {
  it("默认阈值是 2048，且可配置、非法值被忽略", () => {
    expect(toolArchiveMaxEstimatedTokens()).toBe(DEFAULT_TOOL_ARCHIVE_MAX_ESTIMATED_TOKENS);
    setToolArchiveMaxEstimatedTokens(512);
    expect(toolArchiveMaxEstimatedTokens()).toBe(512);
    // 阈值 ≤ 0 等于「全部归档」，那是配置写错而不是一种策略——忽略。
    setToolArchiveMaxEstimatedTokens(0);
    setToolArchiveMaxEstimatedTokens(-1);
    setToolArchiveMaxEstimatedTokens(Number.NaN);
    expect(toolArchiveMaxEstimatedTokens()).toBe(512);
    setToolArchiveMaxEstimatedTokens(null);
    expect(toolArchiveMaxEstimatedTokens()).toBe(DEFAULT_TOOL_ARCHIVE_MAX_ESTIMATED_TOKENS);
  });

  it("未超阈值：原样回原文，归档一次都不发生", async () => {
    const archive = vi.fn();
    const outcome = await guardToolResult({
      toolName: "home.assistant.list_entities",
      workspaceId: WORKSPACE,
      result: smallResult,
      archive,
    });
    expect(outcome).toEqual({
      result: smallResult,
      archived: false,
      archiveFailed: false,
      estimatedTokensSaved: 0,
    });
    expect(archive).not.toHaveBeenCalled();
  });

  it("已是占位符的结果不会被二次归档（否则套娃且原文早已不在这条路上）", async () => {
    const archive = vi.fn();
    const placeholder = { kind: ARCHIVED_TOOL_RESULT_KIND, artifactId: "x" };
    const outcome = await guardToolResult({
      toolName: "home.assistant.read_archived_result",
      workspaceId: WORKSPACE,
      result: placeholder,
      archive,
    });
    expect(outcome.result).toBe(placeholder);
    expect(archive).not.toHaveBeenCalled();
  });
});

describe("不变式 1 / 4：归档里是完整原文，回包里是自带可恢复引用的占位符", () => {
  it("超阈值 → 归档收到完整原文；回包换成占位符", async () => {
    const result = bigChineseResult();
    const serialized = serializeToolResult(result);
    const archive = vi.fn().mockResolvedValue({ artifactId: "abc-123.json" });

    const outcome = await guardToolResult({
      toolName: "home.assistant.list_entities",
      workspaceId: WORKSPACE,
      result,
      archive,
    });

    // 不变式 1：落进归档的就是原文，一个字都不少、也没被截断。
    expect(archive).toHaveBeenCalledTimes(1);
    const written = archive.mock.calls[0]![0] as { serializedResult: string; workspaceId: string };
    expect(written.serializedResult).toBe(serialized);
    expect(written.serializedResult).toBe(JSON.stringify(result));
    expect(written.workspaceId).toBe(WORKSPACE);

    // 不变式 4：占位符带齐全部可恢复引用 + readInstructions。
    expect(outcome.archived).toBe(true);
    expect(isArchivedToolResultPlaceholder(outcome.result)).toBe(true);
    const placeholder = outcome.result as Record<string, unknown>;
    expect(placeholder.artifactId).toBe("abc-123.json");
    expect(placeholder.bodySha256).toBe(
      createHash("sha256").update(serialized, "utf8").digest("hex")
    );
    expect(placeholder.originalBytes).toBe(Buffer.byteLength(serialized, "utf8"));
    expect(placeholder.originalEstimatedTokens).toBe(estimateTokens(serialized));
    expect(placeholder.toolName).toBe("home.assistant.list_entities");
    expect(placeholder.reason).toBe("tool_result_archived_before_reply");
    expect(placeholder.ref).toBe(
      buildToolArchiveRef({
        artifactId: "abc-123.json",
        bodySha256: placeholder.bodySha256 as string,
        originalBytes: placeholder.originalBytes as number,
      })
    );

    // 负向引导必须在场：模型看见「归档」会去文件系统里翻，那是白烧工具调用。
    expect(String(placeholder.readInstructions)).toContain("不要用 Glob");
    expect(String(placeholder.readInstructions)).toContain("home.assistant.read_archived_result");

    // 占位符确实比原文小得多，省下的量如实报出。
    expect(outcome.estimatedTokensSaved).toBeGreaterThan(0);
    expect(estimateTokens(serializeToolResult(outcome.result))).toBeLessThan(
      estimateTokens(serialized)
    );
  });

  it("中文低估对拍：旧口径 chars/4 下这条结果根本不会被归档", async () => {
    // 1560 个汉字：旧口径 390 token（<2048，不归档 → 上下文被撑爆），
    // 新口径 2340 token（>2048，归档）。重标定就是为了这一条。
    const zh = "智能家居实体的完整属性快照".repeat(120);
    expect(Math.ceil(JSON.stringify(zh).length / 4)).toBeLessThan(
      DEFAULT_TOOL_ARCHIVE_MAX_ESTIMATED_TOKENS
    );
    const archive = vi.fn().mockResolvedValue({ artifactId: "zh.json" });
    const outcome = await guardToolResult({
      toolName: "home.assistant.get_state",
      workspaceId: WORKSPACE,
      result: zh,
      archive,
    });
    expect(outcome.archived).toBe(true);
  });
});

describe("不变式 2 / 3：归档失败即保留原文，三种失败形态在计数上不可区分", () => {
  /**
   * 对拍靶点。
   *
   * 拆掉 result-guard 里「归档失败即 return」那个 early-return，本组会同时
   * 红在两条断言上：原文不在了（`result` 变成占位符）**且**占位符出现了
   * （artifactId 为 undefined 的残废占位符）。两条一起红，才说明这道结构
   * 保证真的在起作用，而不是碰巧。
   */
  async function guardWith(
    archive: () => unknown | Promise<unknown>
  ): Promise<{ outcome: ToolResultGuardOutcome; original: unknown }> {
    const original = bigChineseResult();
    const outcome = await guardToolResult({
      toolName: "home.assistant.list_entities",
      workspaceId: WORKSPACE,
      result: original,
      archive: archive as never,
    });
    return { outcome, original };
  }

  const failures: [string, () => unknown][] = [
    ["抛错", (): never => {
      throw new Error("磁盘满了");
    }],
    ["返回 undefined", (): undefined => undefined],
    ["artifactId 为空串", (): { artifactId: string } => ({ artifactId: "" })],
    ["artifactId 全空白", (): { artifactId: string } => ({ artifactId: "   " })],
  ];

  for (const [name, archive] of failures) {
    it(`${name} → 原文还在，且占位符不存在`, async () => {
      const { outcome, original } = await guardWith(archive);
      // 断言必须是两条：只断言「原文还在」的话，拆掉 early-return 之后
      // 「原文被换成占位符」会被漏掉——那正是这道闸要防的事。
      // 用 expect.soft：两条都要跑到，对拍时才看得见**两条同时红**，
      // 而不是第一条抛出后第二条根本没执行。
      expect.soft(outcome.result).toBe(original);
      expect.soft(isArchivedToolResultPlaceholder(outcome.result)).toBe(false);
      expect(outcome.archived).toBe(false);
      expect(outcome.archiveFailed).toBe(true);
      expect(outcome.estimatedTokensSaved).toBe(0);
    });
  }

  it("四种失败形态产出的结果结构完全一致（计数上不可区分）", async () => {
    const shapes = [];
    for (const [, archive] of failures) {
      const { outcome, original } = await guardWith(archive);
      shapes.push({ ...outcome, result: outcome.result === original ? "<原文>" : "<被改写了>" });
    }
    for (const shape of shapes) {
      expect(shape).toEqual(shapes[0]);
      expect(shape).toEqual({
        result: "<原文>",
        archived: false,
        archiveFailed: true,
        estimatedTokensSaved: 0,
      });
    }
  });

  it("解析不出工作区（cwd 缺失 / 不存在）同样按归档失败处置", async () => {
    const original = bigChineseResult();
    const archive = vi.fn();
    const outcome = await guardToolResult({
      toolName: "home.assistant.list_entities",
      workspaceId: null,
      result: original,
      archive,
    });
    expect(outcome.result).toBe(original);
    expect(isArchivedToolResultPlaceholder(outcome.result)).toBe(false);
    expect(outcome.archiveFailed).toBe(true);
    // 没有隔离域时**根本不该写**：写了就无处归属，读回时也校验不了。
    expect(archive).not.toHaveBeenCalled();
  });
});

describe("可恢复引用的往返与形态校验", () => {
  const identity = {
    artifactId: "m1abcd-0123456789abcdef01234567.json",
    bodySha256: "a".repeat(64),
    originalBytes: 12345,
  };

  it("build → parse 往返恒等", () => {
    expect(parseToolArchiveRef(buildToolArchiveRef(identity))).toEqual(identity);
  });

  it("形态不对一律返回 null —— 绝不猜（猜错就是拿别人的归档满足这次读取）", () => {
    const ref = buildToolArchiveRef(identity);
    expect(parseToolArchiveRef("")).toBeNull();
    expect(parseToolArchiveRef(42)).toBeNull();
    expect(parseToolArchiveRef("https://example.com/x?sha256=a&bytes=1")).toBeNull();
    expect(parseToolArchiveRef("pibuddy://tool-archive/x")).toBeNull();
    // sha256 位数不对 / bytes 非正整数 / 多带一个参数
    expect(parseToolArchiveRef(ref.replace("a".repeat(64), "a".repeat(63)))).toBeNull();
    expect(parseToolArchiveRef(ref.replace("bytes=12345", "bytes=0"))).toBeNull();
    expect(parseToolArchiveRef(`${ref}&extra=1`)).toBeNull();
  });
});

describe("serializeToolResult", () => {
  it("undefined 有稳定形态，循环引用不抛（回包路径上任何抛错都是事故）", () => {
    expect(serializeToolResult(undefined)).toBe("undefined");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeToolResult(circular)).not.toThrow();
  });
});

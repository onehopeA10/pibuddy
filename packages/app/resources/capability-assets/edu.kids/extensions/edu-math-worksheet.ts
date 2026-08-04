/**
 * pi extension：儿童教育能力包的回路内数学出题器（edu.kids / REQ-0001 R3）。
 *
 * 经 R4 物化通道装到 ~/.pi/agent/extensions/，由 pi 加载执行；工具名
 * edu.kids.math_worksheet 与能力包 manifest.tools 的声明一致（R4.3：权限
 * 需求经 manifest 进权限面；本工具纯计算、零 IO、零网络，permissions 为空）。
 *
 * 核心算法块（PIBUDDY_EDU_MATH_CORE 标记之间）与
 * packages/app/src/main/edu/math-worksheet-core.ts 逐字节一致，由仓库测试
 * test/edu-assets.spec.ts 强制对账——改算法请改仓库那份、跑测试、再把
 * 标记块原样复制过来。本文件不参与仓库 typecheck（resources/ 不在 tsconfig
 * include 内），@earendil-works/pi-coding-agent 与 typebox 由 pi 内置提供。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// === PIBUDDY_EDU_MATH_CORE_BEGIN ===
// 此标记块在 packages/app/src/main/edu/math-worksheet-core.ts 与
// resources/capability-assets/edu.kids/extensions/edu-math-worksheet.ts 两处
// 逐字节一致（由 test/edu-assets.spec.ts 强制对账）。块内零依赖、零 IO。

export type EduMathOperation = "add" | "sub" | "mul" | "div" | "mix";
export type EduMathDifficulty = "basic" | "challenge";

export interface EduMathSpec {
  /** 年级 1-6（小学） */
  grade: number;
  /** 运算类型；mix = 在该年级已学的运算里随机混合 */
  operation: EduMathOperation;
  /** 题量 1-50 */
  count: number;
  difficulty: EduMathDifficulty;
  /** 随机种子；给定同一种子输出完全一致（复现 / 对拍用），省略则随机 */
  seed?: number;
}

export interface EduMathProblem {
  /** 题号，从 1 起 */
  index: number;
  /** 题面文本，如 "23 + 45 ="（mix 挑战题可能是三数带优先级的算式） */
  text: string;
  /** 标准答案（恒为整数：减法不出负数、除法整除） */
  answer: number;
}

export interface EduMathWorksheet {
  grade: number;
  operation: EduMathOperation;
  difficulty: EduMathDifficulty;
  count: number;
  /** 实际使用的种子（未传时为随机生成的那一个），凭它可完整复现本卷 */
  seed: number;
  /** 请求的运算超出该年级教学范围而被调整时的中文说明；未调整为 null */
  adjusted: string | null;
  problems: EduMathProblem[];
}

type BasicOp = "add" | "sub" | "mul" | "div";

/** 各年级已学的运算（人教版口径：乘法二年级表内起步，除法三年级起步）。 */
function allowedOps(grade: number): BasicOp[] {
  if (grade <= 1) return ["add", "sub"];
  if (grade === 2) return ["add", "sub", "mul"];
  return ["add", "sub", "mul", "div"];
}

/** mulberry32：确定性 PRNG。同一种子 → 同一题卷，出题器因此可复现、可对拍。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [lo, hi] 闭区间整数。 */
function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** 加减法的结果上界（和 / 被减数都不超过它）。 */
function addSubLimit(grade: number, difficulty: EduMathDifficulty): number {
  const table: Record<number, [number, number]> = {
    1: [20, 100],
    2: [100, 1000],
    3: [1000, 10000],
    4: [10000, 100000],
    5: [10000, 100000],
    6: [10000, 1000000],
  };
  const [basic, challenge] = table[grade];
  return difficulty === "challenge" ? challenge : basic;
}

/** 乘法两个因数的取值范围。 */
function mulRanges(
  grade: number,
  difficulty: EduMathDifficulty
): [[number, number], [number, number]] {
  if (grade === 2) return [[2, 9], [2, 9]]; // 表内乘法
  if (grade === 3) {
    return difficulty === "challenge" ? [[100, 999], [2, 9]] : [[10, 99], [2, 9]];
  }
  // 4-6 年级：多位数乘法
  return difficulty === "challenge" ? [[100, 999], [10, 99]] : [[10, 99], [10, 99]];
}

/** 除法的商与除数范围（被除数 = 商 × 除数，恒整除）。 */
function divRanges(
  grade: number,
  difficulty: EduMathDifficulty
): { quotient: [number, number]; divisor: [number, number] } {
  if (grade === 3) {
    // 表内除法起步；挑战为商两位数
    return difficulty === "challenge"
      ? { quotient: [10, 99], divisor: [2, 9] }
      : { quotient: [2, 9], divisor: [2, 9] };
  }
  return difficulty === "challenge"
    ? { quotient: [10, 99], divisor: [10, 99] }
    : { quotient: [10, 99], divisor: [2, 9] };
}

interface BuiltProblem {
  text: string;
  answer: number;
}

/** 出一道两数（或 mix 挑战三数）题。结果恒非负、除法恒整除。 */
function buildProblem(
  op: BasicOp,
  grade: number,
  difficulty: EduMathDifficulty,
  rng: () => number,
  threeTerm: boolean
): BuiltProblem {
  if (threeTerm) {
    // 三数带优先级：a ± b × c。乘积算完再定另一头，保证不出负数。
    const f1 = randInt(rng, 2, 9);
    const f2 = randInt(rng, 2, 12);
    const product = f1 * f2;
    if (rng() < 0.5) {
      const a = randInt(rng, 1, addSubLimit(grade, "basic"));
      return { text: `${a} + ${f1} × ${f2} =`, answer: a + product };
    }
    const a = product + randInt(rng, 0, addSubLimit(grade, "basic"));
    return { text: `${a} - ${f1} × ${f2} =`, answer: a - product };
  }
  switch (op) {
    case "add": {
      const limit = addSubLimit(grade, difficulty);
      const a = randInt(rng, 1, limit - 1);
      const b = randInt(rng, 1, limit - a);
      return { text: `${a} + ${b} =`, answer: a + b };
    }
    case "sub": {
      // 先定差与减数，再凑被减数：小学不出负数是构造出来的，不是筛出来的。
      const limit = addSubLimit(grade, difficulty);
      const b = randInt(rng, 1, limit - 1);
      const diff = randInt(rng, 0, limit - b);
      return { text: `${b + diff} - ${b} =`, answer: diff };
    }
    case "mul": {
      const [ra, rb] = mulRanges(grade, difficulty);
      const a = randInt(rng, ra[0], ra[1]);
      const b = randInt(rng, rb[0], rb[1]);
      return { text: `${a} × ${b} =`, answer: a * b };
    }
    case "div": {
      // 先定商与除数，再凑被除数：整除是构造出来的。
      const { quotient, divisor } = divRanges(grade, difficulty);
      const q = randInt(rng, quotient[0], quotient[1]);
      const d = randInt(rng, divisor[0], divisor[1]);
      return { text: `${q * d} ÷ ${d} =`, answer: q };
    }
  }
}

/**
 * 独立自校验用的题面求值器：从渲染出来的文本重新解析、按优先级
 * （× ÷ 先于 + −）重算。**故意不复用构造期的任何中间量**——它与构造是
 * 两条独立路径，对不上就说明有一边错了。
 */
export function evaluateProblemText(text: string): number {
  const expr = text.replace(/=\s*$/, "").trim();
  const tokens = expr.split(/\s+/);
  if (tokens.length % 2 !== 1 || tokens.length < 3) {
    throw new Error(`EDU_MATH_PARSE_FAILED: 题面不是合法算式 "${text}"`);
  }
  const nums: number[] = [];
  const ops: string[] = [];
  tokens.forEach((tok, i) => {
    if (i % 2 === 0) {
      if (!/^\d+$/.test(tok)) throw new Error(`EDU_MATH_PARSE_FAILED: 期望数字得到 "${tok}"`);
      nums.push(Number(tok));
    } else {
      if (!["+", "-", "×", "÷"].includes(tok)) {
        throw new Error(`EDU_MATH_PARSE_FAILED: 未知运算符 "${tok}"`);
      }
      ops.push(tok);
    }
  });
  // 先乘除
  for (let i = 0; i < ops.length; ) {
    if (ops[i] === "×" || ops[i] === "÷") {
      const value = ops[i] === "×" ? nums[i] * nums[i + 1] : nums[i] / nums[i + 1];
      nums.splice(i, 2, value);
      ops.splice(i, 1);
    } else {
      i++;
    }
  }
  // 后加减，从左到右
  let result = nums[0];
  for (let i = 0; i < ops.length; i++) {
    result = ops[i] === "+" ? result + nums[i + 1] : result - nums[i + 1];
  }
  return result;
}

/**
 * 自校验：每道题把题面重新求值一遍，与标准答案不一致立即抛错。
 * 单独导出是为了让「自校验会红」自身可被测试（防恒真）。
 */
export function selfCheckProblems(problems: readonly EduMathProblem[]): void {
  for (const p of problems) {
    const evaluated = evaluateProblemText(p.text);
    if (evaluated !== p.answer || !Number.isInteger(p.answer) || p.answer < 0) {
      throw new Error(
        `EDU_MATH_SELF_CHECK_FAILED: 第 ${p.index} 题 "${p.text}" 标准答案 ${p.answer}，独立重算得 ${evaluated}`
      );
    }
  }
}

/**
 * 生成一份练习卷。确定性（同 spec + 同 seed → 同卷）、答案由构造保证正确、
 * 出门前再过一遍独立自校验。参数越界抛错（中文），不静默修正。
 */
export function generateWorksheet(spec: EduMathSpec): EduMathWorksheet {
  if (!Number.isInteger(spec.grade) || spec.grade < 1 || spec.grade > 6) {
    throw new Error(`EDU_MATH_BAD_SPEC: 年级必须是 1-6 的整数，收到 ${spec.grade}`);
  }
  if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 50) {
    throw new Error(`EDU_MATH_BAD_SPEC: 题量必须是 1-50 的整数，收到 ${spec.count}`);
  }
  if (!["add", "sub", "mul", "div", "mix"].includes(spec.operation)) {
    throw new Error(`EDU_MATH_BAD_SPEC: 未知运算类型 "${spec.operation}"`);
  }
  if (!["basic", "challenge"].includes(spec.difficulty)) {
    throw new Error(`EDU_MATH_BAD_SPEC: 未知难度 "${spec.difficulty}"`);
  }
  if (spec.seed !== undefined && (!Number.isInteger(spec.seed) || spec.seed < 0)) {
    throw new Error(`EDU_MATH_BAD_SPEC: 种子必须是非负整数，收到 ${spec.seed}`);
  }

  const seed = spec.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const learned = allowedOps(spec.grade);

  // 请求的运算超出该年级教学范围：调整到该年级的混合，并如实说明。
  // 静默照出（给一年级出除法）比报错更糟——那是一张孩子做不了的卷子。
  let pool: BasicOp[];
  let adjusted: string | null = null;
  if (spec.operation === "mix") {
    pool = learned;
  } else if (learned.includes(spec.operation)) {
    pool = [spec.operation];
  } else {
    pool = learned;
    const names: Record<BasicOp | "mix", string> = {
      add: "加法",
      sub: "减法",
      mul: "乘法",
      div: "除法",
      mix: "混合",
    };
    adjusted = `${spec.grade} 年级还没学${names[spec.operation]}，已按该年级已学运算混合出题`;
  }

  // 三数带优先级的算式只在 5-6 年级 mix 挑战卷里出现（约 1/3 的题）。
  const canThreeTerm =
    spec.grade >= 5 && spec.operation === "mix" && spec.difficulty === "challenge";

  const problems: EduMathProblem[] = [];
  for (let i = 0; i < spec.count; i++) {
    const op = pool[randInt(rng, 0, pool.length - 1)];
    const threeTerm = canThreeTerm && rng() < 1 / 3;
    const built = buildProblem(op, spec.grade, spec.difficulty, rng, threeTerm);
    problems.push({ index: i + 1, text: built.text, answer: built.answer });
  }

  selfCheckProblems(problems);

  return {
    grade: spec.grade,
    operation: spec.operation,
    difficulty: spec.difficulty,
    count: spec.count,
    seed,
    adjusted,
    problems,
  };
}
// === PIBUDDY_EDU_MATH_CORE_END ===

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edu.kids.math_worksheet",
    label: "数学出题器",
    description:
      "Deterministic elementary-school math worksheet generator (PiBuddy edu.kids). " +
      "Generates arithmetic problems with verified answers by code (self-checked; " +
      "subtraction never negative, division always exact). Use this instead of writing " +
      "problems yourself whenever a math worksheet / 口算题 / 练习卷 is requested. " +
      "Returns JSON: { grade, operation, difficulty, count, seed, adjusted, " +
      "problems: [{ index, text, answer }] }. Same seed reproduces the same sheet.",
    parameters: Type.Object({
      grade: Type.Integer({ minimum: 1, maximum: 6, description: "年级 1-6" }),
      operation: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("sub"),
          Type.Literal("mul"),
          Type.Literal("div"),
          Type.Literal("mix"),
        ],
        { description: "运算类型：加/减/乘/除/混合" }
      ),
      count: Type.Integer({ minimum: 1, maximum: 50, description: "题量 1-50" }),
      difficulty: Type.Union([Type.Literal("basic"), Type.Literal("challenge")], {
        description: "难度：basic 基础 / challenge 挑战",
      }),
      seed: Type.Optional(
        Type.Integer({ minimum: 0, description: "随机种子；相同种子复现同一份卷" })
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const worksheet = generateWorksheet({
          grade: params.grade,
          operation: params.operation,
          count: params.count,
          difficulty: params.difficulty,
          seed: params.seed,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(worksheet, null, 2) }],
          details: {},
        };
      } catch (err) {
        // 参数越界等错误以文本返回（中文），让 agent 修正参数重试，而不是
        // 让整个工具调用栈爆炸。
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: "出题失败：" + message }],
          details: {},
        };
      }
    },
  });
}

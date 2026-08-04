/**
 * 数学出题器的正确性判据（edu.kids / REQ-0001 R3.2）。
 *
 * ## 独立对拍，不是同义反复
 *
 * 核心断言「标准答案正确」用的是**测试自己写的求值器**（evalInTest），与被测
 * 代码里的 evaluateProblemText 是两份独立实现——两边都从题面文本出发重算。
 * 若复用被测代码的求值器，「答案 == 求值结果」就退化成「代码与自己一致」。
 *
 * ## 自校验必须会红
 *
 * selfCheckProblems 是出题器的最后一道闸。这里有专门的用例把一道题的答案
 * 篡改后喂给它、断言必抛——防止这道闸恒真（对拍拆自校验的手工验证也走
 * 同一条路：把 generateWorksheet 里的 selfCheckProblems 调用注释掉 +
 * 篡改渲染，测试立刻变红）。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateProblemText,
  generateWorksheet,
  selfCheckProblems,
  type EduMathDifficulty,
  type EduMathOperation,
  type EduMathProblem,
} from "./math-worksheet-core.js";

/** 测试侧独立求值器：先乘除后加减，从左到右。与被测实现无共享代码。 */
function evalInTest(text: string): number {
  const tokens = text.replace(/=\s*$/, "").trim().split(/\s+/);
  const rpn: (number | string)[] = [];
  const stack: string[] = [];
  const prec = (op: string): number => (op === "×" || op === "÷" ? 2 : 1);
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      rpn.push(Number(tok));
    } else {
      while (stack.length > 0 && prec(stack[stack.length - 1]) >= prec(tok)) {
        rpn.push(stack.pop()!);
      }
      stack.push(tok);
    }
  }
  while (stack.length > 0) rpn.push(stack.pop()!);
  const out: number[] = [];
  for (const item of rpn) {
    if (typeof item === "number") {
      out.push(item);
    } else {
      const b = out.pop()!;
      const a = out.pop()!;
      out.push(item === "+" ? a + b : item === "-" ? a - b : item === "×" ? a * b : a / b);
    }
  }
  return out[0];
}

const GRADES = [1, 2, 3, 4, 5, 6] as const;
const OPS: EduMathOperation[] = ["add", "sub", "mul", "div", "mix"];
const DIFFS: EduMathDifficulty[] = ["basic", "challenge"];

describe("全组合正确性：各年级 × 各运算 × 各难度，答案与独立求值一致", () => {
  for (const grade of GRADES) {
    for (const operation of OPS) {
      for (const difficulty of DIFFS) {
        it(`${grade} 年级 / ${operation} / ${difficulty}`, () => {
          const sheet = generateWorksheet({ grade, operation, difficulty, count: 30, seed: 42 });
          expect(sheet.problems).toHaveLength(30);
          for (const p of sheet.problems) {
            // 独立对拍：答案正确
            expect([p.text, evalInTest(p.text)]).toEqual([p.text, p.answer]);
            // 小学口径：恒为非负整数（减法不出负数、除法整除）
            expect([p.text, Number.isInteger(p.answer) && p.answer >= 0]).toEqual([p.text, true]);
          }
        });
      }
    }
  }
});

describe("年级边界：教学范围", () => {
  it("一年级 basic：全部操作数与答案都在 20 以内，且只有加减", () => {
    const sheet = generateWorksheet({
      grade: 1,
      operation: "mix",
      difficulty: "basic",
      count: 50,
      seed: 7,
    });
    for (const p of sheet.problems) {
      expect([p.text, /[×÷]/.test(p.text)]).toEqual([p.text, false]);
      const nums = p.text.replace(/=\s*$/, "").trim().split(/\s+/).filter((t) => /^\d+$/.test(t));
      for (const n of nums) expect([p.text, Number(n) <= 20]).toEqual([p.text, true]);
      expect([p.text, p.answer <= 20]).toEqual([p.text, true]);
    }
  });

  it("二年级乘法是表内乘法：因数都在 2-9", () => {
    const sheet = generateWorksheet({
      grade: 2,
      operation: "mul",
      difficulty: "challenge",
      count: 50,
      seed: 7,
    });
    for (const p of sheet.problems) {
      const [a, , b] = p.text.replace(/=\s*$/, "").trim().split(/\s+/);
      for (const n of [Number(a), Number(b)]) {
        expect([p.text, n >= 2 && n <= 9]).toEqual([p.text, true]);
      }
    }
  });

  it("除法恒整除：被除数 = 商 × 除数", () => {
    const sheet = generateWorksheet({
      grade: 4,
      operation: "div",
      difficulty: "challenge",
      count: 50,
      seed: 9,
    });
    for (const p of sheet.problems) {
      const [dividend, , divisor] = p.text.replace(/=\s*$/, "").trim().split(/\s+/).map(Number);
      expect([p.text, p.answer * divisor]).toEqual([p.text, dividend]);
    }
  });

  it("低年级请求还没学的运算：不静默照出，调整为该年级混合并如实说明", () => {
    const sheet = generateWorksheet({
      grade: 1,
      operation: "div",
      difficulty: "basic",
      count: 20,
      seed: 3,
    });
    expect(sheet.adjusted).toContain("还没学");
    for (const p of sheet.problems) {
      expect([p.text, /[×÷]/.test(p.text)]).toEqual([p.text, false]);
    }
    // 已学运算不触发调整
    const ok = generateWorksheet({ grade: 3, operation: "div", difficulty: "basic", count: 5, seed: 3 });
    expect(ok.adjusted).toBeNull();
  });
});

describe("确定性与参数边界", () => {
  it("同 spec + 同 seed → 逐题一致；不同 seed → 卷面不同", () => {
    const a = generateWorksheet({ grade: 3, operation: "mix", difficulty: "basic", count: 20, seed: 123 });
    const b = generateWorksheet({ grade: 3, operation: "mix", difficulty: "basic", count: 20, seed: 123 });
    const c = generateWorksheet({ grade: 3, operation: "mix", difficulty: "basic", count: 20, seed: 124 });
    expect(a.problems).toEqual(b.problems);
    expect(a.problems).not.toEqual(c.problems);
  });

  it("未传 seed 也返回可复现的 seed：拿它重出得到同一卷", () => {
    const first = generateWorksheet({ grade: 2, operation: "add", difficulty: "basic", count: 10 });
    const replay = generateWorksheet({
      grade: 2,
      operation: "add",
      difficulty: "basic",
      count: 10,
      seed: first.seed,
    });
    expect(replay.problems).toEqual(first.problems);
  });

  it("参数越界抛中文错误，不静默修正", () => {
    const base = { operation: "add" as const, difficulty: "basic" as const, count: 10 };
    expect(() => generateWorksheet({ ...base, grade: 0 })).toThrow(/年级必须是 1-6/);
    expect(() => generateWorksheet({ ...base, grade: 7 })).toThrow(/年级必须是 1-6/);
    expect(() => generateWorksheet({ ...base, grade: 3, count: 0 })).toThrow(/题量必须是 1-50/);
    expect(() => generateWorksheet({ ...base, grade: 3, count: 51 })).toThrow(/题量必须是 1-50/);
    expect(() =>
      generateWorksheet({ ...base, grade: 3, count: 10, seed: -1 })
    ).toThrow(/种子必须是非负整数/);
    expect(() =>
      generateWorksheet({ grade: 3, operation: "pow" as EduMathOperation, difficulty: "basic", count: 5 })
    ).toThrow(/未知运算类型/);
  });

  it("五六年级 mix 挑战卷出现三数带优先级的算式，且答案按先乘除后加减", () => {
    const sheet = generateWorksheet({
      grade: 6,
      operation: "mix",
      difficulty: "challenge",
      count: 50,
      seed: 11,
    });
    const threeTerm = sheet.problems.filter((p) => p.text.split(/\s+/).length > 4);
    expect(threeTerm.length).toBeGreaterThan(0);
    for (const p of threeTerm) {
      expect([p.text, evalInTest(p.text)]).toEqual([p.text, p.answer]);
    }
  });
});

describe("自校验自身不是恒真的", () => {
  it("篡改一道题的答案 → selfCheckProblems 必抛", () => {
    const sheet = generateWorksheet({ grade: 3, operation: "mul", difficulty: "basic", count: 5, seed: 1 });
    const corrupted: EduMathProblem[] = sheet.problems.map((p, i) =>
      i === 2 ? { ...p, answer: p.answer + 1 } : p
    );
    expect(() => selfCheckProblems(corrupted)).toThrow(/EDU_MATH_SELF_CHECK_FAILED/);
  });

  it("篡改题面（渲染路径坏了）→ 同样必抛", () => {
    const sheet = generateWorksheet({ grade: 2, operation: "add", difficulty: "basic", count: 3, seed: 1 });
    const corrupted = sheet.problems.map((p, i) =>
      i === 0 ? { ...p, text: "1 + 1 =" } : p
    );
    // 1 + 1 = 2 与原答案几乎不可能撞上；万一撞上（seed 固定，不会），改 seed 即可
    expect(corrupted[0].answer).not.toBe(2);
    expect(() => selfCheckProblems(corrupted)).toThrow(/EDU_MATH_SELF_CHECK_FAILED/);
  });

  it("evaluateProblemText 拒绝解析不了的题面（防「解析失败当 0 分母通过」）", () => {
    expect(() => evaluateProblemText("1 + =")).toThrow(/EDU_MATH_PARSE_FAILED/);
    expect(() => evaluateProblemText("a + b =")).toThrow(/EDU_MATH_PARSE_FAILED/);
    expect(() => evaluateProblemText("1 % 2 =")).toThrow(/EDU_MATH_PARSE_FAILED/);
  });
});

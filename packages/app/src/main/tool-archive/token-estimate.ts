/**
 * 中文优先的 token 估算（纯函数，零依赖）。
 *
 * ## 为什么不能照抄 `chars / 4`
 *
 * 参考实现（maka-agent `context-budget-helpers.ts:13`）用的是
 * `Math.ceil(chars / 4)`，注释写着 "intentionally conservative for mixed
 * text"。那个常数是按**英文**标定的：英文一个 token 差不多就是 4 个字符。
 * 中文完全不同——BPE（cl100k / o200k 一系）在 UTF-8 字节上做合并，一个汉字
 * 占 3 个字节，常用字合并后落在 1–2 token，生僻字更高。于是 `chars / 4`
 * 对纯中文低估 **6 倍**（1 字 0.25 token vs 实际 ~1.5 token）。
 *
 * 低估的方向对他们是安全的（少剪 = 保留原文），对我们是**危险**的：我们是
 * 中文优先产品，阈值 2048 会一直到约 12000 真实 token 才触发，等于这道闸
 * 形同虚设。所以常数必须重新标定。
 *
 * ## 标定依据（2026-08-05 实测，见任务报告）
 *
 * 1. **交叉参考**：`source/hermes-studio/packages/ekko-agent/src/model/tokens.ts`
 *    在真 cl100k_base BPE 不可用 / 遇到病态长串时回落到
 *    `ceil(cjk * 1.5 + other / 4)`——那是一个**按真实 tokenizer 输出对齐过**
 *    的启发式（PR1640 记录：普通文本仍走精确 tiktoken 路径，"token estimates
 *    for the common case are unchanged"）。我们采同一组常数，理由是它有真
 *    tokenizer 背书，而本仓不引入任何 tokenizer 依赖（零新增运行时依赖）。
 * 2. **字节级推导**：CJK 字符 UTF-8 恒 3 字节；字节级 BPE 未合并即 3 token，
 *    常用字合并到 1–2 token。1.5 取在这条带的中位，与「1 字 ≈ 1–2 token」
 *    的经验值一致。
 * 3. **本仓实测倍数**（同一段文本两种估算之比）：纯中文 6.00x、本仓中文注释
 *    2.27x、`list_entities×50` 全属性 JSON 1.51x、纯 ASCII JSON 1.00x。
 *    纯 ASCII 恒等于旧口径，说明重标定只影响含中文的那一半，不误伤英文。
 *
 * 估算永远只是估算：它宁可**高估**（多归档一点）也不要低估，因为低估的
 * 失败形态是「上下文被撑爆」，高估的失败形态只是「多读一次归档」。
 */

/**
 * CJK 判定区间（码点，闭区间）。
 *
 * 与 hermes-studio 那份启发式的区间集合同源，补上了两段它漏掉的：
 * `F900–FAFF`（CJK 兼容表意文字）与 `FE30–FE4F`（CJK 兼容形式），
 * 以及 SIP 平面的扩展汉字 `20000–3FFFF`（生僻字、人名用字真的会出现在
 * HA 实体名里）。区间是**有序不重叠**的，判定走二分之外的简单线性扫描——
 * 6 段而已，线性比二分更好读，且这是每字符都要跑的热路径上唯一的分支。
 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  // 2E80–9FFF：CJK 部首补充 / 康熙部首 / CJK 符号与标点 / 平假名 / 片假名 /
  // 注音 / 韩文兼容字母 / CJK 扩展 A / CJK 统一表意文字
  [0x2e80, 0x9fff],
  [0xac00, 0xd7af], // 韩文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xffef], // 全角 / 半角形式（全角标点在中文文本里大量出现）
  [0x20000, 0x3ffff], // SIP：CJK 扩展 B–G
];

function isCjkCodePoint(codePoint: number): boolean {
  for (const [low, high] of CJK_RANGES) {
    if (codePoint < low) return false;
    if (codePoint <= high) return true;
  }
  return false;
}

/**
 * 一个 CJK 字符折算多少 token。
 *
 * 1.5 = 「常用字 1 token、次常用 2 token」的中位。与 `chars/4` 的 0.25
 * 相比是 6 倍——这就是重标定的全部内容。
 */
export const CJK_TOKENS_PER_CHAR = 1.5;

/** 非 CJK（ASCII / 拉丁 / 数字 / 符号）多少字符折算 1 token。沿用 4。 */
export const NON_CJK_CHARS_PER_TOKEN = 4;

/**
 * 按字符类别分段估算 token 数。
 *
 * 遍历**码点**（`for...of`）而不是 UTF-16 码元：扩展汉字是代理对，按码元
 * 数会把一个字算成两个，那正好又把 1.5 推到 3.0，方向虽然安全但没有依据。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    // codePointAt(0) 对 for...of 取到的每一段恒非 undefined。
    if (isCjkCodePoint(char.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other / NON_CJK_CHARS_PER_TOKEN);
}

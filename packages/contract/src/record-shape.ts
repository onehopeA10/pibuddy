/**
 * 对象形状的**双向**声明（"加字段忘更新解码器" → 编译错误）。
 *
 * ## 这个文件在回答什么
 *
 * zod 的 `.strict()` 解决的是运行期的一半问题：多一个键会被拒。但它解决不了
 * 另一半——**给类型加一个字段之后，手写的解码 / 投影函数忘了跟着改**。那种
 * 遗漏在运行期的表现是「新字段悄悄地不生效」或「新字段被原样透传出去而没有
 * 任何校验」，两种都不报错。
 *
 * `defineObjectShape<T>()` 用类型体操把这件事挪到编译期：调用方必须把 T 的
 * **全部必需键**与**全部可选键**分别列全，少列一个，`Covers<...>` 会把参数
 * 类型变成一个带 `__missingKeys__` 的对象，赋值失败 → `tsc` 报错。于是
 * 「往 `CapabilityGrant` 加一个字段」这件事，必须在解码器这里也走一遍。
 *
 * `hasExactShape` 是它的运行期一半，且是**双向**的：
 *
 *   1. `required` 里的键必须全部存在（少一个即拒）；
 *   2. 出现的每一个键都必须在 `allowed` 里（**多一个即拒**）。
 *
 * 第 2 条不是洁癖：一条从磁盘读回来的记录如果带着解码器不认识的键，那意味着
 * 它要么是被别的版本写的、要么是被人手改过——两种情况下"按我认识的字段解释
 * 它"都是在**编造语义**。拒绝比猜测便宜。
 *
 * ## 与 zod 的分工
 *
 * zod 负责值的类型与取值范围；本文件负责键集合的精确性与"演进时不会忘"。
 * 两者叠加使用（先 `hasExactShape` 挡键集合，再 zod 挡值），不互相替代。
 *
 * 手法取自参考实现 `record-schema.ts:26-50`。
 */

/**
 * T 是联合类型时，只要**任一成员**里 K 是可选的，就算可选。
 *
 * 判定 union 必须分配式展开（`T extends unknown ? ... : never`），否则
 * `Pick<A|B, K>` 会先塌成一个交集形态，可选性信息在那一步就丢了。
 */
type IsOptionalInAnyMember<T extends object, K extends keyof T> = T extends unknown
  ? Record<string, never> extends Pick<T, K>
    ? true
    : false
  : never;

type RequiredKey<T extends object> = {
  [K in keyof T]-?: true extends IsOptionalInAnyMember<T, K> ? never : K;
}[keyof T] &
  string;

type OptionalKey<T extends object> = Exclude<keyof T & string, RequiredKey<T>>;

/**
 * `Actual` 必须覆盖 `Expected` 的每一个键，否则求值成一个**故意无法赋值**的
 * 对象类型，把遗漏的键名直接印在编译错误里。
 */
type Covers<Expected extends string, Actual extends string> =
  Exclude<Expected, Actual> extends never
    ? unknown
    : { readonly __missingKeys__: Exclude<Expected, Actual> };

export interface ExactObjectShape {
  readonly required: readonly string[];
  readonly allowed: ReadonlySet<string>;
}

/**
 * 声明一个 JSON 对象的精确形状。
 *
 * ```ts
 * const GRANT_SHAPE = defineObjectShape<CapabilityGrant>()(
 *   ["capabilityId", "permission", "resource", "grantedAt"],
 *   []
 * );
 * ```
 *
 * 给 `CapabilityGrant` 加一个字段而不改这里 → 编译错误（而不是运行期惊喜）。
 */
export function defineObjectShape<T extends object>() {
  return <
    const Required extends readonly RequiredKey<T>[],
    const Optional extends readonly OptionalKey<T>[],
  >(
    required: Required & Covers<RequiredKey<T>, Required[number]>,
    optional: Optional & Covers<OptionalKey<T>, Optional[number]>
  ): ExactObjectShape => ({
    required: required as readonly string[],
    allowed: new Set<string>([...(required as readonly string[]), ...(optional as readonly string[])]),
  });
}

/** 纯数据对象（非 null、非数组）。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * 双向检查：必需键都在 **且** 所有出现的键都被允许。
 *
 * 用 `Object.hasOwn` 而不是 `in`：后者会走原型链，一条挂了 `toString` 的
 * 记录会被判成"有 toString 这个键"，那种判定说明不了任何事。
 */
export function hasExactShape(value: Record<string, unknown>, shape: ExactObjectShape): boolean {
  return (
    shape.required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => shape.allowed.has(key))
  );
}

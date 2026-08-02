/**
 * vitest workspace 声明。
 *
 * 这里指向仓库根本身（"."），使根 vitest.config.ts 的 test.include /
 * test.exclude 成为**唯一**的测试发现真相源（CT-21）。
 *
 * 不写成 ["packages/*"]：那样每个包会各自成为一个 project 并回落到 vitest
 * 默认 include，根配置的 include 反而失效，"唯一配置" 就名存实亡；且
 * packages/ 下存在非目录条目（pi-sdk.zip、tsconfig.base.json）会让该 glob 报错。
 */
export default ["."];

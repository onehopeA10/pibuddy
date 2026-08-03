import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

/**
 * 仓库根唯一 vitest 配置（CT-21）。
 *
 * include 同时覆盖两种放置约定：
 *   - packages/<pkg>/src/**\/*.spec.ts  （就近放置）
 *   - packages/<pkg>/test/**\/*.spec.ts （集中放置）
 *
 * 全计划禁止任何其它任务新建第二个 vitest 配置。
 * ./source 下的 codex / hermes-studio 是只读参考树，不在 pnpm-workspace.yaml
 * 的 packages/* 内，其自带的 vitest.config.ts 必须被排除。
 */
export default defineConfig({
  // 组件单测要编译 .vue 单文件组件。加在这里而不是新建第二份配置：
  // CT-21 规定全仓只有这一个 vitest 配置，一旦分家，packages/app/test/ 下
  // 的 spec 会整批脱离发现范围，而 `pnpm -w test` 仍然退出 0。
  // 没有这个插件，任何 import 了 .vue 的 spec 会在解析期就失败 —— 而失败的
  // 表现是「1 个文件跑不起来」，很容易被当成环境问题忽略过去。
  plugins: [vue()],
  // 与 electron.vite.config.ts / tsconfig.web.json 的 paths 保持一致：
  // 渲染进程代码里 @contract 不再只是类型导入（parseEnvelope 是运行时函数），
  // 没有这个别名，任何 import 了 store 的测试都会在解析期就失败。
  resolve: {
    alias: {
      "@sdk": resolve(__dirname, "packages/pi-sdk/src/types.ts"),
      "@contract": resolve(__dirname, "packages/contract/src/index.ts"),
    },
  },
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
    /**
     * 两个 project，仍在**同一个配置文件**里（CT-21：全仓只有这一份配置）。
     *
     * 分开的原因：`perf` 里那两个文件断言的是**墙钟时间**（首屏 query
     * < 200ms、setImmediate 回调 < 50ms）。和另外 86 个测试文件并发跑时，
     * 它们测到的是整机争用而不是被测代码 —— 单独跑 1.4s / 2.5s，混在全量
     * 里并发跑直接撞 20s 超时。
     *
     * 时绿时红的性能测试比没有更糟：会被当成「又抽风了」忽略掉，还顺带训练
     * 所有人无视红灯。让它独占执行，测出来的数才有意义。
     *
     * 两个 project 都被 `vitest run` 执行，因此 check-test-discovery 的
     * 「发现数 ⊇ 磁盘数」不变 —— 没有任何 spec 因此脱离范围。
     */
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.{test,spec}.ts",
            "packages/*/test/**/*.{test,spec}.ts",
          ],
          exclude: [
            "**/node_modules/**",
            "source/**",
            "**/dist/**",
            "**/out/**",
            "**/*.bench.test.ts",
            "**/*.perf.test.ts",
            "**/pi-resources/resource-scanner.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "perf",
          include: [
            "packages/*/src/**/*.bench.test.ts",
            "packages/*/src/**/*.perf.test.ts",
            "packages/app/src/main/pi-resources/resource-scanner.test.ts",
          ],
          exclude: ["**/node_modules/**", "source/**", "**/dist/**", "**/out/**"],
          // 独占：不与其它文件抢 CPU，墙钟断言才代表被测代码本身
          fileParallelism: false,
          // 超时只是外壳，真正要判的是里面的墙钟断言（如 setImmediate < 50ms）。
          // 卡在 20s 超时会让断言根本没机会执行，看到的红灯说明不了任何问题。
          testTimeout: 90000,
          hookTimeout: 90000,
        },
      },
    ],
  },
});

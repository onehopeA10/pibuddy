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
    include: [
      "packages/*/src/**/*.{test,spec}.ts",
      "packages/*/test/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "source/**", "**/dist/**", "**/out/**"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});

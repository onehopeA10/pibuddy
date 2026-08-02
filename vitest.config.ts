import { defineConfig } from "vitest/config";
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

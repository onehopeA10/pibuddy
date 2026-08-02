import { defineConfig } from "vitest/config";

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

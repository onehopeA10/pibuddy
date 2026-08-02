import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    // pi-sdk / contract 是源码形式的 workspace 包，必须随主进程一起打包；
    // 漏加会构建通过但运行时报「无法解析的 external」
    plugins: [externalizeDepsPlugin({ exclude: ["@pibuddy/pi-sdk", "@pibuddy/contract"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 沙箱化的 preload 只能是 CommonJS：Electron 的 ESM preload（.mjs）
        // 明确只在 sandbox:false 下生效，开了 sandbox 就会静默不加载，
        // window.piBuddy 直接变 undefined。SEC-001 要求 sandbox:true，
        // 因此 preload 必须产出 .cjs。
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@sdk": resolve(__dirname, "../pi-sdk/src/types.ts"),
        "@contract": resolve(__dirname, "../contract/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
        output: {
          // 把大依赖拆成独立 chunk，减小主包解析时间
          manualChunks(id: string) {
            if (id.includes("naive-ui")) return "naive-ui";
            if (id.includes("highlight.js")) return "hljs";
            if (id.includes("markdown-it")) return "markdown";
            return undefined;
          },
        },
      },
    },
    plugins: [vue()],
  },
});

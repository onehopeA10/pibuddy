import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    // pi-sdk 随主进程一起打包；其余依赖保持 external
    plugins: [externalizeDepsPlugin({ exclude: ["@pibuddy/pi-sdk"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@sdk": resolve(__dirname, "../pi-sdk/src/types.ts"),
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

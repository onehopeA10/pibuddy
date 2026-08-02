import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    // pi-sdk / contract 是源码形式的 workspace 包，必须随主进程一起打包；
    // 漏加会构建通过但运行时报「无法解析的 external」
    plugins: [externalizeDepsPlugin({ exclude: ["@pibuddy/pi-sdk", "@pibuddy/contract"] })],
    build: {
      rollupOptions: {
        // search-entry 是 utility process 的入口（FS-101 的内容搜索）。
        // 它必须是**独立的产物文件**：utilityProcess.fork 收的是一个磁盘上
        // 的 js 路径，不声明成第二个 input 的话，它会被打进 index.js 里，
        // fork 时报「找不到 search-entry.js」——而那是运行时才暴露的。
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "search-entry": resolve(__dirname, "src/main/workspace/search-entry.ts"),
        },
      },
    },
  },
  preload: {
    // 与 main 同理，且在 preload 上更致命：sandbox:true 的 preload 里 require
    // 只认 electron 与少数几个内建模块，解析不到 workspace 包时**整个 preload
    // 静默失败**，window.piBuddy 变成 undefined，界面停在空白且控制台没有堆栈。
    // TASK-007 让 preload 开始把 CHANNELS 当值用（此前只是类型导入，编译期就
    // 消失了），契约包因此必须随 preload 一起打进产物。
    plugins: [externalizeDepsPlugin({ exclude: ["@pibuddy/contract"] })],
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

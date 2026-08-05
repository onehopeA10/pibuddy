/**
 * 崩溃对拍子进程的模块解析钩子。**仅供测试使用。**
 *
 * 子进程要用裸 node 直接跑 crash-child.ts（Node 24 原生剥离类型）。但 Node 的
 * ESM 解析不做扩展名补全，而仓库里的 TS 源码一律写无扩展名的相对导入
 * （moduleResolution: "Bundler"）。这个钩子只做一件事：把 `./foo` 补成
 * `./foo.ts`（前提是该文件真实存在）。
 *
 * 为什么不改成在源码里写 `.ts` 扩展名：那会牵动 tsconfig（allowImportingTsExtensions）
 * 和 electron-vite 的解析行为，为了一个测试进程去动全仓的导入约定不划算。
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.(m|c)?(j|t)s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

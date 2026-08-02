import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import type { PiSpawn } from "@pibuddy/pi-sdk";

/**
 * 定位 pi CLI 入口。
 * 优先使用应用自带的 @earendil-works/pi-coding-agent（免安装、版本可控），
 * 通过 ELECTRON_RUN_AS_NODE 用 Electron 内置 Node 运行其 dist/cli.js；
 * 找不到时回退到系统全局安装的 pi 命令。
 */
export function buildPiSpawn(): PiSpawn {
  try {
    const require = createRequire(import.meta.url);
    const indexJs = require.resolve("@earendil-works/pi-coding-agent");
    const cliJs = path.join(path.dirname(indexJs), "cli.js");
    if (fs.existsSync(cliJs)) {
      return {
        command: process.execPath,
        prefixArgs: [cliJs],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  } catch {
    // 落到全局 pi
  }
  const isWin = process.platform === "win32";
  return { command: isWin ? "pi.cmd" : "pi", shell: isWin };
}

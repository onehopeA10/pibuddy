#!/usr/bin/env node
/**
 * 本地 fake 更新源（仅供开发期验证更新状态机）。
 *
 * 用法：
 *   node packages/app/scripts/fake-update-server.mjs           # 默认 127.0.0.1:8788
 *   PIBUDDY_FAKE_UPDATE_FEED=http://127.0.0.1:8788/ npx electron packages/app
 *
 * ## 为什么需要它
 *
 * M4 的真实出口门禁（签名 → 公证 → clean VM 上真的从 N 升到 N+1）在没有
 * 签名凭据的环境里结构性不可达。但**状态机本身**的正确性不该因此无人验证：
 * idle → checking → available → downloading → downloaded 这条链路上的每一次
 * 状态跃迁、进度回填、刷新恢复，都可以用一个本地 feed + 一个假安装包跑通。
 *
 * 它伪造的是 electron-builder generic provider 的三件东西：
 *   1. latest.yml —— 版本、文件名、sha512、体积、发布时间、发布说明
 *   2. 安装包本体 —— 一坨可控大小的随机字节，sha512 与 latest.yml 严格一致
 *   3. .blockmap  —— 差分下载探测；这里直接 404，updater 会回落到全量下载
 *
 * **发布说明刻意带上 HTML 与 javascript: 协议**：净化那条路只有在真的
 * 收到脏数据时才被验证到。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.FAKE_UPDATE_PORT ?? 8788);
const VERSION = process.env.FAKE_UPDATE_VERSION ?? "0.2.0";
/** 假安装包体积。给 8MB 是为了让进度条真的走几帧，而不是一瞬间跳到 100%。 */
const SIZE = Number(process.env.FAKE_UPDATE_SIZE ?? 8 * 1024 * 1024);
const FILE = `PiBuddy-Setup-${VERSION}.exe`;

// 固定种子的伪随机内容：每次启动内容一致，sha512 才对得上
const payload = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) payload[i] = (i * 31 + 7) & 0xff;
const sha512 = crypto.createHash("sha512").update(payload).digest("base64");

const releaseNotes = [
  "<p>本次更新：</p>",
  "<ul><li>修复了若干问题</li><li>新增语音输入</li></ul>",
  // 这三条是给 sanitizeReleaseNotes 用的脏数据样本
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:void(0)">点我</a>',
  "<script>alert(1)</script>",
].join("");

const latestYml = [
  `version: ${VERSION}`,
  "files:",
  `  - url: ${FILE}`,
  `    sha512: ${sha512}`,
  `    size: ${SIZE}`,
  `path: ${FILE}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  `releaseNotes: ${JSON.stringify(releaseNotes)}`,
  "",
].join("\n");

const server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  console.log(`[fake-feed] ${req.method} ${url}`);

  if (url.endsWith("latest.yml") || url.endsWith("latest-mac.yml")) {
    res.writeHead(200, {
      "content-type": "text/yaml",
      "content-length": Buffer.byteLength(latestYml),
    });
    res.end(latestYml);
    return;
  }

  if (url.endsWith(FILE)) {
    // 分片慢慢发：一次性 end() 的话进度事件只有一帧，进度条验证不了
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": SIZE,
    });
    const CHUNK = 256 * 1024;
    let offset = 0;
    const tick = () => {
      if (offset >= SIZE) {
        res.end();
        return;
      }
      res.write(payload.subarray(offset, Math.min(offset + CHUNK, SIZE)));
      offset += CHUNK;
      setTimeout(tick, 30);
    };
    tick();
    return;
  }

  // .blockmap 一律 404：updater 回落到全量下载，这正是我们要验的那条路
  res.writeHead(404).end("not found");
});

/**
 * 顺手写一份 dev-app-update.yml。
 *
 * 光靠 setFeedURL 只够走完「检查」这一段：electron-updater 在未打包环境里
 * **下载**时会去读 <appPath>/dev-app-update.yml，读不到就抛 ENOENT，而那个
 * 错误在我们的分类器里落到 unsupported —— 界面上表现为「发现新版本」之后
 * 一点下载就变「当前运行方式不支持自动更新」。打包产物里这个文件由
 * electron-builder 生成为 app-update.yml，与本文件无关。
 */
const APP_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const devConfig = path.join(APP_DIR, "dev-app-update.yml");
fs.writeFileSync(
  devConfig,
  ["provider: generic", `url: http://127.0.0.1:${PORT}/`, "channel: latest", ""].join("\n")
);
console.log(`[fake-feed] 已写入 ${devConfig}`);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-feed] http://127.0.0.1:${PORT}/  version=${VERSION} size=${SIZE}`);
  console.log(`[fake-feed] sha512=${sha512}`);
});

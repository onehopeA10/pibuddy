/**
 * 一次性图标生成脚本：把生成的 logo 转成 electron-builder 需要的图标文件。
 *
 * 用 Electron 自带的 nativeImage 解码（源文件其实是 JPEG，虽然叫 .png），
 * 重采样出多尺寸 PNG，再手工拼一个多尺寸 .ico —— 仓库里没有 ImageMagick /
 * sharp，借 electron 的图像栈最省事。
 *
 * 产物（build/ 是 electron-builder.yml 的 buildResources）：
 *   build/icon.png   1024×1024，linux / 通用
 *   build/icon.ico   多尺寸（16..256），win
 *   build/icons/     16..512 png，linux 桌面条目用
 *
 * 用法：  node scripts/make-icon.cjs <源图路径>
 * （本脚本要在 electron 运行时里跑：ELECTRON_RUN_AS_NODE 不行，需要 nativeImage，
 *   所以用 `electron scripts/make-icon.cjs` 的方式启动，见下方 main。）
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = process.argv[2] || "C:/Users/yehh/.cursor/projects/d-selftool-pi-ui/assets/pibuddy-icon.png";
const BUILD_DIR = path.join(__dirname, "..", "build");

// 手工拼 ICO：ICONDIR + 每个尺寸一个 ICONDIRENTRY + PNG 数据段。
// 256 在 ICO 里记为 0（一字节宽度）。PNG 直接内嵌（Vista+ 支持）。
function buildIco(pngBySize) {
  const sizes = Object.keys(pngBySize).map(Number).sort((a, b) => a - b);
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  const dataParts = [];
  for (const size of sizes) {
    const png = pngBySize[size];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // data size
    entry.writeUInt32LE(offset, 12); // data offset（第 12 字节，不是 10）
    entries.push(entry);
    dataParts.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...dataParts]);
}

async function main() {
  const { app, nativeImage } = require("electron");
  await app.whenReady();

  const src = nativeImage.createFromPath(SRC);
  if (src.isEmpty()) {
    console.error("源图解码失败:", SRC);
    app.exit(1);
    return;
  }
  const srcSize = src.getSize();
  console.log(`源图 ${srcSize.width}x${srcSize.height}`);

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(path.join(BUILD_DIR, "icons"), { recursive: true });

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBySize = {};
  for (const size of icoSizes) {
    pngBySize[size] = src.resize({ width: size, height: size, quality: "best" }).toPNG();
  }

  // 1024 主图（linux / 通用）
  const png1024 = src.resize({ width: 1024, height: 1024, quality: "best" }).toPNG();
  fs.writeFileSync(path.join(BUILD_DIR, "icon.png"), png1024);

  // win ico
  fs.writeFileSync(path.join(BUILD_DIR, "icon.ico"), buildIco(pngBySize));

  // linux 桌面条目各尺寸
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const png =
      pngBySize[size] ?? src.resize({ width: size, height: size, quality: "best" }).toPNG();
    fs.writeFileSync(path.join(BUILD_DIR, "icons", `${size}x${size}.png`), png);
  }

  console.log("已生成:");
  for (const f of ["icon.png", "icon.ico", ...fs.readdirSync(path.join(BUILD_DIR, "icons")).map((f) => `icons/${f}`)]) {
    const full = path.join(BUILD_DIR, f);
    console.log(`  build/${f}  ${fs.statSync(full).length} bytes`);
  }
  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

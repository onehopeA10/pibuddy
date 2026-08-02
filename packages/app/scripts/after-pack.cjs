/**
 * electron-builder afterPack 钩子：把 pi 运行时的 node_modules 补进产物。
 *
 * 为什么需要这一步：electron-builder 的 extraResources 会跳过被复制目录里名为
 * node_modules 的子目录，即使显式写了 filter: ["**\/*"] 也一样（实测：
 * resources/pi-runtime 源 19371 个文件 → 产物只剩 885 个，node_modules 整个消失，
 * 启动 pi 直接 ERR_MODULE_NOT_FOUND: Cannot find package 'cross-spawn'）。
 *
 * 依赖必须落在 <runtimeRoot>/node_modules 下才能被 Node 解析到，改名字不可行，
 * 所以在打包完成后手动补一次复制，并校验文件数量与源一致。
 */
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const SRC = path.join(appRoot, "resources", "pi-runtime", "node_modules");

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

exports.default = async function afterPack(context) {
  const dest = path.join(context.appOutDir, "resources", "pi-runtime", "node_modules");

  if (!fs.existsSync(SRC)) {
    throw new Error(
      `[after-pack] 缺少 ${SRC}，请先运行 node scripts/prepare-pi-runtime.mjs`
    );
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(SRC, dest, { recursive: true, dereference: true, force: true });

  const srcCount = countFiles(SRC);
  const destCount = countFiles(dest);
  if (srcCount !== destCount) {
    throw new Error(
      `[after-pack] pi 运行时依赖复制不完整：源 ${srcCount} 个文件，产物 ${destCount} 个`
    );
  }
  console.log(`  • pi runtime deps copied  files=${destCount} to=${dest}`);
};

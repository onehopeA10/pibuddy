/**
 * 全仓唯一的原子写实现（裁定3 前置）。
 *
 * workspace 记录（TASK-007）、settings.json（TASK-008）、auth.json（TASK-014）、
 * health marker（TASK-013）四处一律 import 本函数，不得各写一份。
 *
 * 写入序列：写 <file>.tmp → fsyncSync(fd) → renameSync(tmp, file)。
 * 少了 fsync，rename 之后掉电仍可能拿到空文件；少了 rename，读者会看到
 * 半截 JSON。两步都是必需的。
 */
import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 同一条写入序列的字节形态（FS-101 的文件保存走这里）。
 *
 * 用户的源文件比设置文件更经不起半截写：编辑器保存到一半掉电，留下的是
 * 一个被截断的 .ts。writeJsonAtomic 委托到本函数，全仓仍然只有这一条
 * 「写文件」的实现。
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  const text = data;

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w");
    if (typeof text === "string") fs.writeFileSync(fd, text, "utf8");
    else fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不上就算了，下面还要删文件 */
      }
    }
    // 失败时必须清掉 .tmp：留在磁盘上会让下一次写入的 openSync("w") 之外的
    // 任何读者（如 support-bundle 收集）把半截文件当成有效产物。
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* 本来就没建出来 */
    }
    throw err;
  }
}

/**
 * WSL UNC 路径的纯函数工具（R5.1，内核设施）。
 *
 * ## 为什么住在内核而不是 main/terminal
 *
 * 两个消费方跨了能力边界：workspace-registry（内核，注册 WSL 内目录时归一
 * UNC 形态）与 coding.terminal（能力包，把 workspace root 映射成 `wsl --cd`
 * 的 Linux 路径）。能力包 import 内核合法，反过来不行——所以纯路径逻辑收在
 * 这里，spawn wsl.exe 的那一半（要 process.shell）住在 main/terminal/wsl.ts。
 *
 * ## \\wsl$ 与 \\wsl.localhost 是同一个目录的两个名字
 *
 * 真机实测（Win11 + Node 24）：`fs.realpath` 对两种形态都**原样返回**、不做
 * 互相归一，而 `path.relative` 把它们视作两台不同主机（返回绝对路径）。不在
 * 注册入口归一的话，同一个 WSL 目录会派生出两个 workspaceId，各带一套
 * ignore 策略 / 历史会话——表现是「换个写法打开，我的设置全没了」且不报错。
 * 这里统一归一成现代形态 `\\wsl.localhost\<distro>\...`。
 *
 * 参考实现：source/PiDeck-maestro/src/main/wsl/WslPaths.ts（许可无限制）。
 */
import { normalize as normalizePosix } from "node:path/posix";

export interface ParsedWslUncPath {
  distro: string;
  /** 归一化后的绝对 Linux 路径（`/` 开头，无尾斜杠；根为 "/"） */
  linuxPath: string;
}

function normalizeLinuxPath(p: string): string {
  const normalized = normalizePosix(p.replace(/\\/g, "/"));
  if (normalized === "." || normalized === "/") return "/";
  return normalized.replace(/\/+$/, "");
}

/**
 * 解析 WSL UNC 路径。兼容 `\\wsl$\` 与 `\\wsl.localhost\` 两种前缀，
 * 以及正斜杠写法（`//wsl$/...`）。非 WSL UNC 返回 null。
 */
export function parseWslUncPath(p: string): ParsedWslUncPath | null {
  const match = p.match(/^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i);
  if (!match) return null;
  const remainder = match[2]?.replace(/[\\/]+/g, "/") ?? "";
  return {
    distro: match[1],
    linuxPath: normalizeLinuxPath(`/${remainder}`),
  };
}

/** 这条路径是否指向 WSL 内部（两种 UNC 前缀之一）。 */
export function isWslUncPath(p: string): boolean {
  return parseWslUncPath(p) !== null;
}

/** Linux 绝对路径 → `\\wsl.localhost\<distro>\...` UNC（Windows 侧访问用）。 */
export function linuxPathToWslUnc(linuxPath: string, distro: string): string {
  const normalized = normalizeLinuxPath(linuxPath);
  const suffix = normalized === "/" ? "" : normalized.replace(/^\//, "").replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}${suffix ? `\\${suffix}` : ""}`;
}

/**
 * 把 WSL UNC 归一成 `\\wsl.localhost\` 形态（反斜杠、无尾斜杠）。
 *
 * 非 WSL UNC 的输入**原样返回**：本函数只消灭 `\\wsl$` 与 `\\wsl.localhost`
 * 的双重身份，不承担任何别的规范化（那是 realpath 的事）。
 */
export function normalizeWslUnc(p: string): string {
  const parsed = parseWslUncPath(p);
  if (!parsed) return p;
  return linuxPathToWslUnc(parsed.linuxPath, parsed.distro);
}

/**
 * 把一个 Windows 侧路径映射成「在 `distro` 里 spawn shell 时的起始目录」。
 *
 * 规则（供 `wsl.exe --cd <dir>` 使用）：
 *   - 同一 distro 的 WSL UNC → 对应的 Linux 路径（真机实测 `--cd /tmp/x` 生效）；
 *   - **别的** distro 的 UNC → `~`：跨发行版的路径在目标发行版里不存在，
 *     传过去 wsl.exe 会报错或落到不可预期的目录，回落到用户主目录最诚实；
 *   - 盘符路径 `C:\foo` → `/mnt/c/foo`（drvfs 默认挂载约定）；
 *   - 其它（相对路径 / 非 WSL 网络路径）→ `~`。
 */
export function wslStartDirFor(windowsCwd: string, distro: string): string {
  const unc = parseWslUncPath(windowsCwd);
  if (unc) {
    return unc.distro.toLowerCase() === distro.toLowerCase() ? unc.linuxPath : "~";
  }
  const drive = windowsCwd.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
  if (drive) {
    const suffix = drive[2]?.replace(/[\\/]+/g, "/") ?? "";
    return normalizeLinuxPath(`/mnt/${drive[1].toLowerCase()}/${suffix}`);
  }
  return "~";
}

/**
 * WSL 发行版检测与终端接入（R5.1，coding.terminal 的扩展）——**不 import electron**。
 *
 * ## 为什么归入 coding.terminal 而不是独立能力包
 *
 * 枚举发行版本身就要 spawn `wsl.exe`（process.shell 语义），而它唯一的运行期
 * 消费面是「开终端时可选进 WSL shell」——权限、通道、UI 全部与 coding.terminal
 * 重合。为一条查询通道立一个新能力包，要陪葬一份 manifest / Profile 归属 /
 * 权限映射 / drift 对账，收益为零。workspace 选 WSL 目录**不经**这里：系统
 * 文件夹选择框本来就能浏览 `\\wsl$`，内核的 workspace-registry 直接收 UNC。
 *
 * ## 懒检测（硬约束）
 *
 * 本模块没有任何模块加载期副作用：只有 `terminal:wsl-distros` /
 * `terminal:profiles` 真的被调用时才第一次 spawn `wsl.exe -l -v`，结果带 TTL
 * 缓存。无 WSL 机器：wsl.exe 不存在 → 直接返回 `{available:false}`，零子进程、
 * 零报错；启动路径完全不经过这里。
 *
 * ## `wsl -l -v` 的 UTF-16LE 坑
 *
 * wsl.exe 的标准输出是 **UTF-16LE 无 BOM**（真机录制样本见
 * test/terminal-wsl.spec.ts）。按 utf8 读出来是 `N\0A\0M\0E\0…`，逐行 split
 * 后每个字符间夹一个 NUL——这里必须以 buffer 拿输出、按 NUL 字节占比判定
 * 编码再解码（设置 WSL_UTF8=1 只有新版 WSL 认，不能依赖）。
 *
 * 参考实现：source/PiDeck-maestro/src/main/index.ts 的 wslListDistros /
 * src/main/wsl/WslEnvironment.ts（许可无限制）。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import type { TerminalProfile, TerminalWslDistrosResult, WslDistro } from "@pibuddy/contract";

import { isWslUncPath, wslStartDirFor } from "../wsl-paths.js";

/** WSL shell profile id 的前缀（`wsl:Ubuntu-22.04`）。tab 元数据的 shellId 即记它。 */
export const WSL_PROFILE_PREFIX = "wsl:";

/** 发行版名的保守字符集（注册名不含空格；首字符必须字母数字，防 `-d` 后跟出一个开关形态的串）。 */
const DISTRO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ------------------------------------------------------------------ 纯函数

/**
 * 解码 wsl.exe 的输出。
 *
 * 判据：偶数位（UTF-16LE 的高字节位）NUL 占比过半 → UTF-16LE；否则按 utf8
 * （用户设了 WSL_UTF8=1 的新版 WSL）。顺带剥 BOM。
 */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  let nulHigh = 0;
  for (let i = 1; i < buf.length; i += 2) {
    if (buf[i] === 0) nulHigh++;
  }
  const text =
    nulHigh > buf.length / 4 ? buf.toString("utf16le") : buf.toString("utf8");
  return text.replace(/^\uFEFF/, "");
}

/**
 * 解析 `wsl -l -v` 的（已解码）文本输出。
 *
 * 形如：
 *
 *       NAME              STATE           VERSION
 *     * Ubuntu-22.04      Running         2
 *       docker-desktop    Running         2
 *
 * 规则：`*` 开头 = 默认发行版；表头行（首个非空行且不带 `*`）跳过；名字必须
 * 过保守字符集（顺带把本地化的错误提示文本整段挡掉——「没有已安装的发行版」
 * 那类输出解析结果就是空表，而不是一条乱码发行版）。
 */
export function parseWslListVerbose(text: string): WslDistro[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trimEnd())
    .filter((line) => line.trim().length > 0);
  const out: WslDistro[] = [];
  let sawFirst = false;
  for (const line of lines) {
    const isDefault = line.trimStart().startsWith("*");
    const body = line.replace(/^\s*\*/, "").trim();
    const first = !sawFirst;
    sawFirst = true;
    // 首个非空行若不带 *，按表头处理（NAME STATE VERSION，可能本地化）。
    if (first && !isDefault) continue;
    const tokens = body.split(/\s+/).filter(Boolean);
    const name = tokens[0] ?? "";
    if (!DISTRO_NAME_RE.test(name)) continue;
    out.push({
      name,
      isDefault,
      state: tokens[1] ?? "",
      version: tokens[2] ?? "",
    });
  }
  return out;
}

/**
 * 解析出可信的 wsl.exe 绝对路径。
 *
 * 32 位进程要经 Sysnative 绕过 System32 的文件系统重定向（否则拿到的是不存在
 * 的 32 位副本）。全都不存在返回 null —— null 即「这台机器没有 WSL」。
 */
export function resolveWslCommand(
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
  exists: (p: string) => boolean = existsSync
): string | null {
  const systemRoot = env.SystemRoot || "C:\\Windows";
  const candidates =
    arch === "ia32"
      ? [join(systemRoot, "Sysnative", "wsl.exe"), join(systemRoot, "System32", "wsl.exe")]
      : [join(systemRoot, "System32", "wsl.exe")];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** `wsl:<distro>` → distro 名；不是 WSL profile 或名字非法时返回 null。 */
export function parseWslProfileId(profileId: string): string | null {
  if (!profileId.startsWith(WSL_PROFILE_PREFIX)) return null;
  const distro = profileId.slice(WSL_PROFILE_PREFIX.length);
  return DISTRO_NAME_RE.test(distro) ? distro : null;
}

/** 一次 spawn 的完整描述（pty-manager 直接拿去喂 node-pty）。 */
export interface SpawnPlan {
  file: string;
  args: string[];
  cwd: string;
}

/**
 * 按 shell 种类修正 spawn 计划（纯函数，真机行为见 R5.1 实测记录）。
 *
 * WSL profile：起始目录经 `--cd <linux path>` 表达（workspace 在 C:\ 下映射
 * 到 /mnt/c/...；在同发行版 UNC 下映射回 Linux 路径；跨发行版回落 `~`），
 * 而 PTY 自身的 Windows cwd 换成用户主目录——ConPTY 对 UNC cwd 的兼容性
 * 不归我们赌，真实意图已由 `--cd` 承载。
 *
 * 非 WSL shell：原样透传。已知坑：workspace 在 WSL UNC 下时 cmd.exe 不支持
 * UNC cwd（自己回落到 C:\Windows 并打印警告），PowerShell / Git Bash 正常。
 */
export function planSpawn(
  shell: { id: string; file: string; args: string[] },
  cwd: string
): SpawnPlan {
  const distro = parseWslProfileId(shell.id);
  if (distro === null) return { file: shell.file, args: shell.args, cwd };
  return {
    file: shell.file,
    args: [...shell.args, "--cd", wslStartDirFor(cwd, distro)],
    cwd: isWslUncPath(cwd) ? os.homedir() : cwd,
  };
}

// ------------------------------------------------------------------ 枚举（懒 + 缓存）

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; encoding: "buffer" },
  callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void
) => unknown;

export interface WslEnumOptions {
  execFile?: ExecFileLike;
  platform?: NodeJS.Platform;
  command?: string | null;
  timeoutMs?: number;
}

const UNAVAILABLE: TerminalWslDistrosResult = { available: false, distros: [] };

/** 缓存 TTL：发行版装卸不是高频事件，30s 内的重复查询直接吃缓存。 */
const WSL_CACHE_TTL_MS = 30_000;

let cache: { at: number; value: Promise<TerminalWslDistrosResult> } | null = null;

/** 仅供单测：清掉枚举缓存。 */
export function __resetWslCache(): void {
  cache = null;
}

async function enumerate(options: WslEnumOptions): Promise<TerminalWslDistrosResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return UNAVAILABLE;
  const command = options.command !== undefined ? options.command : resolveWslCommand();
  if (!command) return UNAVAILABLE;
  const run = options.execFile ?? (execFile as unknown as ExecFileLike);
  return new Promise<TerminalWslDistrosResult>((resolve) => {
    try {
      run(
        command,
        ["-l", "-v"],
        { timeout: options.timeoutMs ?? 10_000, windowsHide: true, encoding: "buffer" },
        (error, stdout) => {
          // wsl.exe 存在但列不出（没装发行版 / 内核缺失）：exit code -1 且
          // stdout 是一段本地化提示——解析结果为空表。available 仍为 true：
          // 「有 WSL 没发行版」和「没有 WSL」对 UI 是两句不同的话。
          const distros = Buffer.isBuffer(stdout)
            ? parseWslListVerbose(decodeWslOutput(stdout))
            : [];
          if (error && distros.length === 0) {
            const code = (error as NodeJS.ErrnoException).code;
            // 连可执行文件都起不来（被删 / 被策略挡）：按不可用处理。
            if (code === "ENOENT" || code === "EACCES") {
              resolve(UNAVAILABLE);
              return;
            }
          }
          resolve({ available: true, distros });
        }
      );
    } catch {
      resolve(UNAVAILABLE); // spawn 自身抛错也不许把无 WSL 用户的调用炸掉
    }
  });
}

/**
 * 枚举 WSL 发行版（懒 + TTL 缓存 + 永不抛错）。
 *
 * 注入了 options 的调用（单测）绕过缓存，真实调用共享缓存——避免用户在
 * 终端面板里每开一次下拉就 spawn 一个 wsl.exe。
 */
export function listWslDistros(options?: WslEnumOptions): Promise<TerminalWslDistrosResult> {
  if (options) return enumerate(options);
  const now = Date.now();
  if (cache && now - cache.at < WSL_CACHE_TTL_MS) return cache.value;
  const value = enumerate({});
  cache = { at: now, value };
  return value;
}

/**
 * WSL 发行版 → 追加在本机 shell 之后的 terminal profiles。
 *
 * 非 Windows / 无 WSL 时为空数组——渲染侧因此**结构上**不会出现 WSL 选项，
 * 不需要平台分支。
 */
export async function wslTerminalProfiles(): Promise<TerminalProfile[]> {
  const result = await listWslDistros();
  return result.distros.map((d) => ({
    id: `${WSL_PROFILE_PREFIX}${d.name}`,
    label: `WSL · ${d.name}${d.isDefault ? "（默认）" : ""}`,
  }));
}

/**
 * 从 profileId 构造 WSL 的 ShellProfile（供 pty-manager.resolveShell 同步调用）。
 *
 * 起始目录不在这里定：spawn 前由 `planSpawn` 按 tab 的 cwd 补 `--cd`。
 * 名字只过保守字符集，不强求已枚举——枚举是异步的，而 open 是同步路径；
 * 一个不存在的发行版名会让 wsl.exe 立刻退出并把原因打在终端里，比在这里
 * 静默吞掉更诚实。
 */
export function wslShellProfile(
  profileId: string
): { id: string; label: string; file: string; args: string[] } | null {
  if (process.platform !== "win32") return null;
  const distro = parseWslProfileId(profileId);
  if (distro === null) return null;
  const command = resolveWslCommand();
  if (!command) return null;
  return {
    id: profileId,
    label: `WSL · ${distro}`,
    file: command,
    args: ["-d", distro],
  };
}

/**
 * 权限提示的**投影与再推导**（SEC-003 硬化）。
 *
 * ## 这个文件在回答什么
 *
 * `permission.ts` 回答「谁批准了什么」的数据形态；本文件回答一个更锋利的
 * 问题：**用户在弹窗上看到的那串字符，和真正会被批准/执行的那件事，是不是
 * 同一件事**。三条独立的失败模式，三段独立的判据：
 *
 *   1. **落库记录不可信**（再推导边界）。`capability_grants` 是一列 JSON 文本，
 *      `JSON.parse` 把任何形状都原样交回来。一条被手改过的记录
 *      （`{"permission":"network.local","resource":null}`）就绕开了
 *      `decidePermission` 在写入前做的全部校验——那条校验拦的正是「授权整个
 *      内网」。因此**读回时用同一个 assert 重新推导语义**：权限原子合法、
 *      resource 形态合法、能力确实声明过该权限、字段集合精确。任何一条不符，
 *      该记录被拒绝使用并留审计，而不是静默信任。
 *
 *   2. **截断会改变语义**（所见即所批）。展示串有字节上界，超界就要截断；
 *      而 `rm -rf /x && echo <8KB>` 截断之后可能变成一条看起来无害的
 *      `echo`。用户批准的是「他看到的那条」，执行的是「完整的那条」——两者
 *      不是同一件事。所以：**截断后必须重新分类，类别一旦改变就拒绝弹窗**
 *      （fail-closed），而不是弹一个会误导用户的框。
 *
 *   3. **视觉伪装**（Trojan Source）。BiDi 覆写字符（`\u202a-\u202e`、
 *      `\u2066-\u2069`）能让终端 / 浏览器把 `rm -rf /` 渲染成完全不同的样子。
 *      一个只做「字符串原样显示」的确认框，在这种输入面前是**帮凶**。因此
 *      所有进确认框与审计日志的字符串一律先剥控制字符与 BiDi 覆写字符。
 *
 * ## 分类**只决定措辞，不决定放行**
 *
 * `categorizeShellCommand` 永不返回 "safe"。理由与参考实现
 * （`permission.ts:114-125`）一致，且我们无意重新论证一遍：从一个静态字符串
 * 判定图灵完备 shell 的运行时效果是**不可判定**的。任何「前缀看起来安全就
 * 放行」的白名单都能被参数里藏执行绕过（`echo $(rm x)`、`` echo `rm x` ``、
 * PowerShell 的 `echo (Set-Content x)`），连"只读"的 `git status` 都可能触发
 * fsmonitor 钩子。因此本文件的分类**只有一个用途**：让危险确认框的措辞更准
 * （删除 / 提权 / 改历史 / 泛化）。放行与否由第五道闸 + PermissionEngine 决定，
 * 与分类结果无关。漏掉一个 pattern 的代价是"措辞不够精确"，不是"绕过"。
 */
import { z } from "zod";

import { isCapabilityPermission } from "./capability.js";
import { isMcpShellGrant, parseMcpGrantResource } from "./mcp.js";
import {
  isPiResourcesShellGrant,
  parsePiPackageGrantResource,
} from "./pi-resources.js";
import {
  capabilityGrantSchema,
  isDangerousPermission,
  parseLocalEndpointResource,
  type CapabilityGrant,
} from "./permission.js";
import { defineObjectShape, hasExactShape, isPlainRecord } from "./record-shape.js";

// ---------------------------------------------------------------- 有界化常量

/**
 * 各类展示串的字节上界。
 *
 * 分开定义而不是共用一个 MAX：一个 capabilityId 长到 4KB 说明它已经不是
 * capabilityId 了（应当直接拒），而一条 8KB 的命令是完全正常的（应当截断后
 * 再分类）。两种输入用同一个阈值，只能同时对其中一种做错事。
 */
/** 能力 id（`<namespace>.<name>`）。超界即拒——id 是机器生成的，不做截断。 */
export const PERMISSION_REVIEW_CAPABILITY_ID_MAX_BYTES = 256;
/** 权限原子（`process.shell` / `network:api.example.com`）。超界即拒。 */
export const PERMISSION_REVIEW_PERMISSION_MAX_BYTES = 256;
/** 资源（路径 / `host:port`）。超界即拒——resource 参与 grant 匹配，截断即改语义。 */
export const PERMISSION_REVIEW_PATH_MAX_BYTES = 4 * 1024;
/** 命令的**展示**上界。超界会被截断，随后必须重新分类（见文件头第 2 条）。 */
export const PERMISSION_REVIEW_COMMAND_MAX_BYTES = 4 * 1024;
/**
 * 命令的**输入**上界。
 *
 * 与展示上界分开：展示要截断，但一条 10MB 的"命令"根本不该进到分类器里
 * （分段扫描是 O(n)，但把 10MB 送进一个确认框这件事本身就不成立）。超界即拒。
 */
export const PERMISSION_REVIEW_COMMAND_INPUT_MAX_BYTES = 64 * 1024;
/** 泛型参数 / 审计 detail 一类的自由文本。超界截断。 */
export const PERMISSION_REVIEW_ARGUMENT_MAX_BYTES = 2 * 1024;

// ---------------------------------------------------------------- 字符净化

/**
 * 不得原样出现在任何确认框 / 审计日志里的字符。
 *
 *   - `\u0000-\u001f`、`\u007f-\u009f`：C0/C1 控制字符。ESC 能重画终端，
 *     `\r` 能把已经打出去的一行覆盖掉。
 *   - `\u061c`、`\u200e`、`\u200f`：隐式方向标记。
 *   - `\u2028`、`\u2029`：行/段分隔符（JS 里是换行，很多渲染器里不是）。
 *   - `\u202a-\u202e`、`\u2066-\u2069`：**BiDi 覆写与隔离**。这一组是
 *     Trojan Source 的核心：它们能让同一串字节在屏幕上渲染成任意别的顺序，
 *     于是「弹窗里显示的命令」与「真正执行的命令」可以完全无关。
 *
 * 替换成可见的 `\u{XXXX}` 而不是直接删掉：删掉会让"这里原本有东西"这个
 * 事实一起消失，而那正是用户需要看见的信号。
 */
export const UNSAFE_REVIEW_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

const UTF8 = new TextEncoder();

/** UTF-8 字节长度。 */
export function utf8ByteLength(value: string): number {
  return UTF8.encode(value).byteLength;
}

/** 把控制字符与 BiDi 覆写字符替换成可见转义（不删除）。 */
export function sanitizeReviewText(value: string): string {
  return value.replace(
    UNSAFE_REVIEW_CHARACTER,
    (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`
  );
}

/** 该串是否已经是"净化后的自身"（即不含任何需要转义的字符）。 */
export function isCanonicalReviewText(value: string): boolean {
  return sanitizeReviewText(value) === value;
}

/**
 * 按 UTF-8 字节数截断，**不切碎码位**。
 *
 * 逐码位累加而不是 `slice(0, n)`：后者按 UTF-16 单元切，会把一个 emoji 劈成
 * 两个孤立代理项，落到日志里是一个乱码字节序列。
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const size = UTF8.encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    text += character;
    bytes += size;
  }
  return text;
}

/** 一段展示串的投影结果。 */
export interface ReviewTextProjection {
  /** 净化 + 截断之后，真正会被显示出去的那一串 */
  readonly text: string;
  /** 净化之后、截断之前的字节数（用于「共 N 字节，已截断」这类提示） */
  readonly bytes: number;
  readonly truncated: boolean;
}

/** 净化 → 截断。两步的顺序不可换：先截断会把一个转义序列切成半截。 */
export function projectReviewText(value: string, maxBytes: number): ReviewTextProjection {
  const safe = sanitizeReviewText(value);
  const bytes = utf8ByteLength(safe);
  if (bytes <= maxBytes) return { text: safe, bytes, truncated: false };
  return { text: truncateUtf8(safe, maxBytes), bytes, truncated: true };
}

// ---------------------------------------------------------------- 命令分类

/**
 * 危险命令的类别。
 *
 * **注意这里没有、也不会有 `safe`**（见文件头「分类只决定措辞」）。类别的
 * 唯一用途是挑一句更准的确认措辞；`shell_unsafe` 是兜底，它同样要弹窗。
 */
export const SHELL_COMMAND_CATEGORIES = [
  "privileged",
  "fs_destructive",
  "git_destructive",
  "shell_unsafe",
] as const;
export type ShellCommandCategory = (typeof SHELL_COMMAND_CATEGORIES)[number];

/** 提权 / 服务控制 / 电源 / ACL 的命令名前缀（POSIX 形态）。 */
const PRIVILEGED_PREFIXES: readonly string[] = [
  "sudo ",
  "su ",
  "chmod ",
  "chown ",
  "chgrp ",
  "mount ",
  "umount ",
  "kill ",
  "killall ",
  "systemctl ",
  "launchctl ",
  "shutdown",
  "reboot",
];

/** PowerShell / cmd 的等价形态。大小写不敏感——PowerShell 就是不敏感的。 */
const PRIVILEGED_PATTERNS: readonly RegExp[] = [
  /^(kill|stop-process|spps|taskkill)\b/i,
  /(^|\s)-verb\s+runas\b/i,
  /^((start|stop|restart|set|new|remove|suspend|resume)-service|sasv|spsv)\b/i,
  /^sc\s+(stop|start|pause|continue|delete|config|create|failure|sdset)\b/i,
  /^net\s+(stop|start|pause|continue)\b/i,
  /^(stop-computer|restart-computer)\b/i,
  /^(icacls|takeown|set-acl|runas)\b/i,
];

/** 不可逆的文件系统操作。 */
const FS_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^dd\s+/,
  /^truncate\b/,
  /^shred\b/,
  /^mkfs\b/,
  /^find\s+.*\s-delete\b/,
  /^find\s+.*\s-exec\s+.*\b(rm|shred|truncate|dd)\b/,
  /^xargs\s+.*\b(rm|shred|truncate|dd)\b/,
  /^remove-item\b/i,
  /^(rm|rmdir|ri|del|erase|rd)\b/i,
  /^(clear-content|clc)\b/i,
];

const PIPE_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\|\s*xargs\b[^\n;&|]*\b(rm|shred|truncate|dd)\b/,
  /\|\s*(sh|bash|zsh)\b/,
];

/** 会丢提交 / 改历史的 git 子命令。 */
const GIT_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^git\s+reset\s+--hard\b/,
  /^git\s+push\s+(--force|-f)\b/,
  /^git\s+branch\s+-D\b/,
  /^git\s+clean\s+-fd?\b/,
  /^git\s+checkout\s+\.\s*$/,
  /^git\s+checkout\s+--\s+\S+/,
  /^git\s+restore\s+(\.\s*$|--\s+\S+)/,
  /^git\s+rebase\s+-i\b/,
];

/**
 * 命令名可能出现的位置：开头，以及每一个语句 / 管道 / 脚本块 / 替换边界之后。
 *
 * 切分**故意不认引号**。认引号严格更差：`$( )` 与反引号在双引号内部**照样
 * 展开**，不在那里切就会漏掉 `echo "$(rm x)"`。朴素切分从不丢内容，它只是把
 * 内容切碎——每个字节都落在某个 segment 里，多切出来的边界只会增加候选，
 * 不会藏起候选。
 */
function commandSegments(cmd: string): string[] {
  return cmd
    .split(/[|;&\n(){}`]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把真正的命令让给后面那个词的包装器。 */
const WRAPPER_COMMANDS = new Set([
  "nohup",
  "nice",
  "time",
  "timeout",
  "env",
  "command",
  "exec",
  "stdbuf",
]);

/**
 * shell-in-shell：payload 是字面量时可以递归分类。
 *
 * 解释器（`python -c`、`node -e`）**故意不在此列**：我们认识 sh/pwsh/cmd 的
 * 方言，不假装能解析任意语言。
 */
const NESTED_SHELL_HEADS: ReadonlyArray<{ head: RegExp; flag: RegExp }> = [
  { head: /^(sh|bash|zsh)$/, flag: /(?:^|\s)-\w*c\s+([\s\S]+)$/ },
  { head: /^(pwsh|powershell)$/i, flag: /\s-c(?:ommand)?\s+([\s\S]+)$/i },
  { head: /^cmd$/i, flag: /\s\/[ck]\s+([\s\S]+)$/i },
];

/**
 * 把 segment 的首个 token 归一到它真正解析成的命令名：剥引号（`& 'Remove-Item' x`）、
 * 剥前导转义（`\rm`）、剥路径前缀（`/bin/rm`、`C:\...\taskkill.exe`）与 `.exe`
 * 后缀，跳过包装器及其选项参数（`nohup`、`timeout 30`、`env FOO=bar`）。
 *
 * 归一只服务于**升级**判定（更准的措辞），不存在"归一之后就算安全"的分支——
 * 本文件根本没有安全分支。
 */
function normalizeSegmentHead(segment: string): string {
  let rest = segment;
  for (let hops = 0; hops < 5; hops++) {
    const quoted = /^(['"])(.+?)\1(\s+|$)/.exec(rest);
    const bare = quoted ? null : /^(\S+)(\s*)([\s\S]*)$/.exec(rest);
    if (!quoted && !bare) return rest;
    let head = quoted ? quoted[2]! : bare![1]!;
    const tail = quoted ? rest.slice(quoted[0].length) : bare![3]!;
    head = head
      // 名字内部的引号与脱字符：被切断的 payload 残留（`"del`）、PowerShell 的
      // 引号打断（`Remove''-Item` 执行的就是 Remove-Item）、cmd 的转义符
      // （`de^l` 执行的就是 del）。只在**名字**上折叠。
      .replace(/['"^]/g, "")
      .replace(/^\\/, "")
      .replace(/^.*[\\/]/, "")
      .replace(/\.exe$/i, "");
    if (WRAPPER_COMMANDS.has(head.toLowerCase())) {
      rest = tail.replace(/^((-\S+|\S+=\S*|\d+[smhd]?)\s+)*/, "");
      continue;
    }
    return tail ? `${head} ${tail}` : head;
  }
  return rest;
}

function nestedShellPayload(segment: string): string | undefined {
  const head = /^\S*/.exec(segment)![0];
  for (const shell of NESTED_SHELL_HEADS) {
    if (!shell.head.test(head)) continue;
    const match = shell.flag.exec(segment);
    if (!match) return undefined;
    const payload = match[1]!.trim();
    const unquoted = /^(['"])([\s\S]*)\1$/.exec(payload);
    return unquoted ? unquoted[2]! : payload;
  }
  return undefined;
}

/** 首 token 归一后的 segment，外加（递归的）字面量 shell-in-shell payload。 */
function scanSegments(cmd: string, depth: number): string[] {
  const out: string[] = [];
  for (const raw of commandSegments(cmd)) {
    const segment = normalizeSegmentHead(raw);
    out.push(segment);
    if (depth === 0) continue;
    const payload = nestedShellPayload(segment);
    if (payload !== undefined) out.push(...scanSegments(payload, depth - 1));
  }
  return out;
}

function isPrivilegedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    PRIVILEGED_PREFIXES.some((p) => lower.startsWith(p)) ||
    PRIVILEGED_PATTERNS.some((re) => re.test(segment))
  );
}

/**
 * 给一条 shell 命令挑一个**措辞**类别。
 *
 * 优先级 privileged > fs_destructive > git_destructive > shell_unsafe，扫描
 * **每一个**语句 segment（首 token 已归一），因此 `cd /tmp; rm -rf stuff`、
 * `Get-ChildItem . | ForEach-Object { Remove-Item $_ }`、`& 'Remove-Item' x`
 * 都读得出"删除"。兜底 `shell_unsafe` 同样弹窗，所以漏掉一个变体只是措辞不准。
 */
export function categorizeShellCommand(cmd: string): ShellCommandCategory {
  const trimmed = cmd.trim();
  // 反引号既是切分边界（bash 命令替换，双引号内照样执行），又是 PowerShell 的
  // 名内转义（``R`M`` 执行 rm）。只切分会把 PS 的名字拆成两个无辜的半截，
  // 因此同时扫描「切分后的 segment」与「折叠掉反引号的整串」。
  const segments = scanSegments(trimmed, 2);
  if (trimmed.includes("`")) segments.push(...scanSegments(trimmed.replace(/`/g, ""), 2));
  if (segments.some(isPrivilegedSegment)) return "privileged";
  if (segments.some((s) => FS_DESTRUCTIVE_PATTERNS.some((re) => re.test(s)))) return "fs_destructive";
  if (PIPE_DESTRUCTIVE_PATTERNS.some((re) => re.test(trimmed))) return "fs_destructive";
  if (segments.some((s) => GIT_DESTRUCTIVE_PATTERNS.some((re) => re.test(s)))) {
    return "git_destructive";
  }
  return "shell_unsafe";
}

/** 该类别对应的确认框措辞（**只影响文案**）。 */
export function shellCategoryWording(category: ShellCommandCategory): string {
  switch (category) {
    case "privileged":
      return "提权 / 系统控制";
    case "fs_destructive":
      return "不可逆的文件删除或覆写";
    case "git_destructive":
      return "丢弃提交或改写 git 历史";
    case "shell_unsafe":
      return "执行任意 shell 命令";
  }
}

// ---------------------------------------------------------------- 投影错误

/**
 * 投影失败 = **拒绝弹窗**。
 *
 * 单列一个错误类型而不是复用 Error：调用方必须能把"这次不能弹窗"与"弹窗时
 * 出了别的错"区分开。前者是 fail-closed 的正常结果（拒绝这次动作），后者是 bug。
 */
export class PermissionPromptProjectionError extends Error {
  constructor(reason: string) {
    super(`PERMISSION_PROMPT_REJECTED: ${reason}`);
    this.name = "PermissionPromptProjectionError";
  }
}

// ---------------------------------------------------------------- 提示投影

/** 一次待裁决申请的原始输入。 */
export interface PermissionPromptInput {
  capabilityId: string;
  permission: string;
  resource: string | null;
  /**
   * 发起申请时的工作区。带工作区资源轴的权限必须与它逐字一致，防止用户切换
   * 项目后把 A 的弹窗授权给 B。普通无资源权限可省略。
   */
  workspaceId?: string | null;
  /**
   * 危险命令原文（终端 / git 之类的消费者提供）。
   *
   * 给了命令，就意味着弹窗要把它显示出来——于是「截断后类别必须不变」这条
   * 判据生效。没有命令时该字段为 null / 省略。
   */
  command?: string | null;
}

/** 命令的展示投影 + 它自身所属的类别。 */
export interface PermissionCommandReview {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  /** 展示串**自身**的类别；与原命令的类别相等（不等时投影已经抛错） */
  readonly category: ShellCommandCategory;
  /** 供确认框使用的措辞 */
  readonly wording: string;
}

/** 可以安全显示给用户的一份权限申请视图。 */
export interface PermissionPromptView {
  readonly capabilityId: string;
  readonly permission: string;
  readonly resource: string | null;
  readonly command: PermissionCommandReview | null;
  readonly dangerous: boolean;
}

/** 能携带命令的权限——其余权限带命令即视为身份不符（见参考实现的 assertToolSemantics）。 */
const COMMAND_BEARING_PERMISSIONS = new Set(["process.shell", "process.git"]);

/**
 * 校验一个**不做截断**的字段：必须非空、必须在界内、必须已经是净化后的自身。
 *
 * 为什么不截断：`capabilityId` / `permission` / `resource` 三者都**参与授权
 * 匹配**（`grantCovers` 按字符串相等比）。显示一个被截断过的 resource、批准
 * 完整的那一条，正是这个文件要消灭的那类错误。因此这三个字段一律 fail-closed。
 */
function canonicalField(value: string, maxBytes: number, label: string): string {
  if (value.length === 0) throw new PermissionPromptProjectionError(`${label} 为空`);
  if (utf8ByteLength(value) > maxBytes) {
    throw new PermissionPromptProjectionError(`${label} 超出 ${maxBytes} 字节上界`);
  }
  if (!isCanonicalReviewText(value)) {
    throw new PermissionPromptProjectionError(`${label} 含控制字符或 BiDi 覆写字符`);
  }
  return value;
}

/** 带工作区资源轴的两类权限共用同一条「可解析 + 归属一致」判据。 */
function boundPermissionResourceIssue(
  capabilityId: string,
  permission: string,
  resource: string | null,
  workspaceId?: string | null
): string | null {
  if (isMcpShellGrant(capabilityId, permission)) {
    const parsed = parseMcpGrantResource(resource ?? "");
    if (parsed === null) return "MCP 的 process.shell 必须绑定具体工作区、服务器与执行配置";
    if (workspaceId !== undefined && (workspaceId === null || parsed.workspaceId !== workspaceId)) {
      return "MCP 授权资源所属工作区与本次申请不一致";
    }
  }
  if (isPiResourcesShellGrant(capabilityId, permission)) {
    const parsed = parsePiPackageGrantResource(resource ?? "");
    if (parsed === null) return "Pi 包操作的 process.shell 必须绑定动作、作用域、工作区与包规格";
    if (workspaceId !== undefined && (workspaceId === null || parsed.workspaceId !== workspaceId)) {
      return "Pi 包操作授权资源所属工作区与本次申请不一致";
    }
  }
  return null;
}

/**
 * 把一次权限申请投影成"可以安全显示"的视图。**任何不一致都抛错 = 拒绝弹窗**。
 *
 * 判据（顺序即优先级）：
 *   1. capabilityId / permission / resource 有界、无控制字符与 BiDi 覆写字符；
 *   2. permission 是合法的权限原子（`isCapabilityPermission`）；
 *   3. `network.local` 的 resource 必须是具体的 `host:port`（通配 = 整个内网）；
 *   4. 带命令时，permission 必须真的是能执行命令的那两条之一（身份一致）；
 *   5. **命令截断之后必须仍属同一个类别**——否则用户看到的那条命令，其危险
 *      程度与真正要执行的那条不同，这个框弹出去就是在误导人。
 */
export function projectPermissionPrompt(input: PermissionPromptInput): PermissionPromptView {
  const capabilityId = canonicalField(
    input.capabilityId,
    PERMISSION_REVIEW_CAPABILITY_ID_MAX_BYTES,
    "capabilityId"
  );
  const permission = canonicalField(
    input.permission,
    PERMISSION_REVIEW_PERMISSION_MAX_BYTES,
    "permission"
  );
  if (!isCapabilityPermission(permission)) {
    throw new PermissionPromptProjectionError(`permission "${permission}" 不是合法的权限原子`);
  }

  let resource: string | null = null;
  if (input.resource !== null && input.resource !== undefined) {
    resource = canonicalField(input.resource, PERMISSION_REVIEW_PATH_MAX_BYTES, "resource");
  }
  if (permission === "network.local" && parseLocalEndpointResource(resource ?? "") === null) {
    throw new PermissionPromptProjectionError("network.local 必须绑定具体 host:port");
  }
  const boundIssue = boundPermissionResourceIssue(
    capabilityId,
    permission,
    resource,
    input.workspaceId
  );
  if (boundIssue !== null) throw new PermissionPromptProjectionError(boundIssue);

  const raw = input.command ?? null;
  let command: PermissionCommandReview | null = null;
  if (raw !== null) {
    if (!COMMAND_BEARING_PERMISSIONS.has(permission)) {
      throw new PermissionPromptProjectionError(`权限 "${permission}" 不该携带命令`);
    }
    if (raw.length === 0) throw new PermissionPromptProjectionError("命令为空");
    if (utf8ByteLength(raw) > PERMISSION_REVIEW_COMMAND_INPUT_MAX_BYTES) {
      throw new PermissionPromptProjectionError(
        `命令超出 ${PERMISSION_REVIEW_COMMAND_INPUT_MAX_BYTES} 字节输入上界`
      );
    }
    // 真正会被执行的那条命令属于哪一类。
    const category = categorizeShellCommand(raw);
    // 会被显示出去的那条串（净化 + 截断）。
    const projection = projectReviewText(raw, PERMISSION_REVIEW_COMMAND_MAX_BYTES);
    // 所见即所批：显示串**自身**必须仍属同一类别，否则拒绝弹窗。
    const shownCategory = categorizeShellCommand(projection.text);
    if (shownCategory !== category) {
      throw new PermissionPromptProjectionError(
        `截断后类别由 ${category} 变为 ${shownCategory}，拒绝展示会误导用户的确认框`
      );
    }
    command = {
      text: projection.text,
      bytes: projection.bytes,
      truncated: projection.truncated,
      category,
      wording: shellCategoryWording(category),
    };
  }

  return Object.freeze({
    capabilityId,
    permission,
    resource,
    command,
    dangerous: isDangerousPermission(permission),
  });
}

// ---------------------------------------------------------------- 再推导

/**
 * `CapabilityGrant` 的精确字段集合。
 *
 * 给 `CapabilityGrant` 加一个字段而不改这里 → **编译错误**（`defineObjectShape`
 * 的类型体操），而不是"新字段被原样透传、没人校验"。
 */
export const CAPABILITY_GRANT_SHAPE = defineObjectShape<CapabilityGrant>()(
  ["capabilityId", "permission", "resource", "grantedAt"],
  []
);

/** 再推导需要的外部事实：某能力 manifest **声明**过哪些权限。 */
export interface CapabilityGrantReviewDeps {
  declaredPermissions(capabilityId: string): ReadonlySet<string>;
  /** 这条持久授权实际存在哪个工作区；资源轴内嵌的 id 必须与它一致。 */
  workspaceId?: string | null;
}

export type CapabilityGrantReview =
  | { readonly ok: true; readonly grant: CapabilityGrant }
  | { readonly ok: false; readonly reason: string };

/**
 * 从存储读回一条授权记录时**重新推导**它的语义。
 *
 * 与写入路径（`decidePermission`）走的是**同一组判据**——这正是要点：一条
 * 记录只有在"现在重新推一遍仍然成立"的前提下才可用。落库那一刻它合法，不能
 * 证明现在它仍然合法：能力可能已经不再声明这条权限，磁盘上的那一行可能被人
 * 手改过（`capability_grants` 就是一列 JSON 文本，`JSON.parse` 什么形状都收）。
 *
 * 返回 `{ok:false, reason}` 而不是抛错：调用方要能**逐条**拒绝并留审计，一条
 * 坏记录不该让整张授权表读不出来。
 */
export function reviewCapabilityGrant(
  value: unknown,
  deps: CapabilityGrantReviewDeps
): CapabilityGrantReview {
  if (!isPlainRecord(value)) return { ok: false, reason: "不是纯数据对象" };
  // 双向：必需键都在 + 没有多余键。多余键意味着这条记录是别的版本 / 别人写的，
  // "按我认识的字段解释它"等于在编造语义。
  if (!hasExactShape(value, CAPABILITY_GRANT_SHAPE)) {
    return { ok: false, reason: `字段集合与 CapabilityGrant 不符：[${Object.keys(value).join(", ")}]` };
  }
  const parsed = capabilityGrantSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `字段类型非法：${z.prettifyError(parsed.error).split("\n")[0] ?? ""}` };
  }
  const grant = parsed.data;

  if (utf8ByteLength(grant.capabilityId) > PERMISSION_REVIEW_CAPABILITY_ID_MAX_BYTES) {
    return { ok: false, reason: "capabilityId 超出字节上界" };
  }
  if (!isCanonicalReviewText(grant.capabilityId)) {
    return { ok: false, reason: "capabilityId 含控制字符或 BiDi 覆写字符" };
  }
  if (utf8ByteLength(grant.permission) > PERMISSION_REVIEW_PERMISSION_MAX_BYTES) {
    return { ok: false, reason: "permission 超出字节上界" };
  }
  // 权限原子合法：一条 `permission: "process.shell; rm -rf /"` 的记录在写入路径
  // 上根本产生不了，读回时也不该被当成 process.shell 用。
  if (!isCapabilityPermission(grant.permission)) {
    return { ok: false, reason: `permission "${grant.permission}" 不是合法的权限原子` };
  }
  if (grant.resource !== null) {
    if (utf8ByteLength(grant.resource) > PERMISSION_REVIEW_PATH_MAX_BYTES) {
      return { ok: false, reason: "resource 超出字节上界" };
    }
    if (!isCanonicalReviewText(grant.resource)) {
      return { ok: false, reason: "resource 含控制字符或 BiDi 覆写字符" };
    }
  }
  // resource 形态合法：`network.local` 的 null-resource 在写入路径上被
  // decidePermission 结构性拒绝（通配 = 整个内网）。读回时若不重推这一条，
  // 一次手改数据库就把那道判据整个绕过去了。
  if (
    grant.permission === "network.local" &&
    parseLocalEndpointResource(grant.resource ?? "") === null
  ) {
    return { ok: false, reason: "network.local 授权未绑定具体 host:port" };
  }
  const boundIssue = boundPermissionResourceIssue(
    grant.capabilityId,
    grant.permission,
    grant.resource,
    deps.workspaceId
  );
  if (boundIssue !== null) return { ok: false, reason: boundIssue };
  // 能力确实声明过该权限（manifest 上界）。能力被降级 / 权限被从 manifest 拿掉
  // 之后，旧的落库授权必须随之失效，而不是继续生效到下一次有人想起来清理。
  if (!deps.declaredPermissions(grant.capabilityId).has(grant.permission)) {
    return {
      ok: false,
      reason: `能力 "${grant.capabilityId}" 未声明权限 "${grant.permission}"`,
    };
  }

  // 重建对象而不是把 parsed.data 直接交出去：交出去的是一份**由校验过的字段
  // 组装出来的**记录，不带任何来自磁盘的残留。
  return {
    ok: true,
    grant: Object.freeze({
      capabilityId: grant.capabilityId,
      permission: grant.permission,
      resource: grant.resource,
      grantedAt: grant.grantedAt,
    }),
  };
}

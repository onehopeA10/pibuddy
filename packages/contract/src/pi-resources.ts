/**
 * Pi 资源中心与 project trust 的契约（EXT-102）。
 *
 * 三条结构性约束写在类型里，而不是写在注释里指望大家记住：
 *
 *  1. **渲染进程拿不到可执行的东西**。安装 / 卸载的入参是包规格字符串
 *     （`npm:@foo/bar@1.0.0` / `git:host/user/repo@ref` / 本地路径），不是
 *     命令行；打开目录的入参是扫描结果里的 `id`，不是路径。main 侧的
 *     package-install.ts 用 execFile（shell:false）跑白名单子命令。
 *  2. **path 单向下发**。它出现在列表里只为了让用户知道这个技能来自哪，
 *     任何 IPC 入参都不接受它 —— 和 workspace 的 displayPath 同一条纪律。
 *  3. **trust 不是工具权限**。TrustState 里刻意有 `note` 一栏承载这句话：
 *     security.md 开头就写了 project trust "is not a sandbox and it does not
 *     restrict what the model can ask tools to do"，把它显示成「安全开关」
 *     是对用户的误导。
 */
import { z } from "zod";

import { CHANNELS } from "./channels.js";

/** 资源大类。与 pi docs/packages.md 的资源种类一一对应。 */
export const piResourceKindSchema = z.enum([
  "package",
  "extension",
  "skill",
  "prompt",
  "theme",
]);
export type PiResourceKind = z.infer<typeof piResourceKindSchema>;

/**
 * 资源来源。
 *
 *  - `user`    ~/.pi/agent/ 下的全局资源与全局 settings.json 声明的条目
 *  - `project` <workspace>/.pi/ 下的资源（**必须先通过 trust 才会被 pi 加载**）
 *  - `package` 由已安装的 pi package 带进来的资源（~/.pi/agent/npm|git/…）
 */
export const piResourceSourceSchema = z.enum(["user", "project", "package"]);
export type PiResourceSource = z.infer<typeof piResourceSourceSchema>;

export const piResourceSchema = z.object({
  /** 稳定不透明 id：`${source}:${kind}:${name}` 的 sha256 前 16 位 */
  id: z.string().min(1),
  kind: piResourceKindSchema,
  name: z.string(),
  version: z.string().optional(),
  source: piResourceSourceSchema,
  /** **只用于显示**，绝不作为任何 IPC 的入参回传 */
  path: z.string(),
  enabled: z.boolean(),
  /** 同名同类的其它资源 id。pi 的去重规则是「先加载的赢」，冲突必须显式告知 */
  conflictWith: z.array(z.string()),
  /** 该条目自身的诊断（清单缺字段、目录不存在、project 未受信而不会被加载…） */
  diagnostics: z.array(z.string()),
  /** package 类资源的原始规格（`npm:@foo/bar@1.0.0`），卸载 / 版本锁要用 */
  spec: z.string().optional(),
  /** 版本是否被锁定（npm 带 @version、git 带 @ref 即为锁定） */
  pinned: z.boolean(),
});
export type PiResource = z.infer<typeof piResourceSchema>;

/**
 * MCP 管理的当前状态。
 *
 * 本轮**没有**实现 MCP 的 CRUD / 启停 / 连接测试 / OAuth 状态 / tool 列表。
 * 这个字段的存在就是为了让界面上写出「未实现」四个字，而不是渲染一个空
 * 列表冒充「你还没配过 MCP」—— 后者是同一块像素上两种完全相反的含义。
 */
export const piMcpStatusSchema = z.object({
  implemented: z.literal(false),
  note: z.string(),
});

/** ~/.pi/agent/settings.json 的 defaultProjectTrust 三态（settings.md）。 */
export const defaultProjectTrustSchema = z.enum(["ask", "always", "never"]);
export type DefaultProjectTrust = z.infer<typeof defaultProjectTrustSchema>;

export const trustDecisionSchema = z.enum(["allow", "deny"]);
export type TrustDecision = z.infer<typeof trustDecisionSchema>;

/**
 * 一个工作目录的 project trust 态。
 *
 * `needsPrompt` 的判定链（security.md:20-28）：
 *   有 project resources && 本目录或其任一祖先目录在 trust.json 中都没有决定
 *   && defaultProjectTrust === "ask"
 *
 * RPC 模式下 pi **不会**弹这个提示（security.md:30），所以这层必须由
 * PiBuddy 自己补 —— 不补的话，用户放在 .pi/skills 下的技能会毫无提示地
 * 不被加载，界面上没有任何线索。
 */
export const projectTrustStateSchema = z.object({
  workspaceId: z.string(),
  /** 是否存在需要 trust 才会被加载的 project 资源 */
  hasProjectResources: z.boolean(),
  /** 将要（或本可以）被加载的 project 资源清单，用于弹窗里逐条列出 */
  resources: z.array(z.object({ label: z.string(), path: z.string() })),
  /** trust.json 中命中的决定（含祖先目录继承）；none = 没有任何已保存决定 */
  saved: z.enum(["allow", "deny", "none"]),
  /** 命中决定的那个目录（继承自祖先时与当前目录不同） */
  savedAt: z.string().optional(),
  defaultProjectTrust: defaultProjectTrustSchema,
  /** 本次启动最终生效的决定 */
  effective: trustDecisionSchema,
  /** 是否需要向用户弹窗询问 */
  needsPrompt: z.boolean(),
  /** 固定文案：信任不等于工具权限 */
  note: z.string(),
});
export type ProjectTrustState = z.infer<typeof projectTrustStateSchema>;

export const piResourceScanResultSchema = z.object({
  resources: z.array(piResourceSchema),
  trust: projectTrustStateSchema,
  mcp: piMcpStatusSchema,
  scannedAt: z.number(),
  /** 扫描过程中的目录级错误（权限不足、settings.json 解析失败…），不抛异常吞掉 */
  errors: z.array(z.string()),
});
export type PiResourceScanResult = z.infer<typeof piResourceScanResultSchema>;

export const workspaceScopedRequestSchema = z.object({
  workspaceId: z.string().min(1),
});

export const piResourceSetEnabledRequestSchema = z.object({
  workspaceId: z.string().min(1),
  id: z.string().min(1),
  enabled: z.boolean(),
});

/**
 * 安装 / 卸载的入参。
 *
 * `spec` 会在 main 侧再过一次注入校验（shell 元字符一律拒绝）；
 * 这里的 max(200) 只是第一道，不是唯一一道。
 */
export const piPackageCommandRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    spec: z.string().min(1).max(200),
    /** project 作用域写 .pi/settings.json，**必须先通过 trust** */
    scope: z.enum(["user", "project"]),
  })
  .superRefine((value, ctx) => {
    const issue = piPackageSpecIssue(value.spec);
    if (issue !== null) ctx.addIssue({ code: "custom", path: ["spec"], message: issue });
  });

export const piPackageCommandResultSchema = z.object({
  ok: z.boolean(),
  /** 命令的合并输出（已截断），失败时用户要能看到真因 */
  output: z.string(),
  /** 失败原因的机器可读形式：injection / not-trusted / exec-failed / … */
  reason: z.string().optional(),
});
export type PiPackageCommandResult = z.infer<typeof piPackageCommandResultSchema>;

// ------------------------------------------------------- 第五道闸：权限需求

/**
 * Pi 资源中心属于不可关闭的平台内核，不是 capability manifest。权限模型仍以
 * `capabilityId` 为主体键，因此用一个不进能力注册表的保留主体表达它的上界，
 * 与 `kernel.git-probe` 同一机制。
 */
export const PI_RESOURCES_CAPABILITY_ID = "kernel.pi-resources";
export const PI_RESOURCES_PERMISSION = "process.shell";

/** 真正到达 `execFile` 的两条通道；其余 scan / trust / open-dir 不启动进程。 */
export const PI_RESOURCES_GATED_CHANNELS = [
  CHANNELS.piResourcesInstall,
  CHANNELS.piResourcesRemove,
] as const;

export type PiPackagePermissionAction = "install" | "remove";

const PI_PACKAGE_SPEC_UNSAFE_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const PI_PACKAGE_SPEC_INJECTION_RE = /;|&&|\||`|\$\(|&/u;
const PI_PACKAGE_PREFIXES = ["npm:", "git:", "https://", "ssh://"] as const;
const WORKSPACE_PERMISSION_ID_RE = /^[a-f0-9]{32}$/;

function looksLikePackagePath(spec: string): boolean {
  return (
    spec.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(spec) ||
    spec.startsWith("./") ||
    spec.startsWith(".\\")
  );
}

/**
 * 包规格的单一校验口径。权限资源、IPC schema 与 `execFile` 前的最后一道输入
 * 校验都调用它，避免一边批准了、另一边却按不同语法执行。
 */
export function piPackageSpecIssue(spec: unknown): string | null {
  if (typeof spec !== "string" || spec.trim().length === 0) return "包规格为空";
  if (spec.length > 200) return "包规格超过 200 个字符";
  if (PI_PACKAGE_SPEC_UNSAFE_RE.test(spec)) return "包规格含控制字符或 BiDi 覆写字符";
  if (PI_PACKAGE_SPEC_INJECTION_RE.test(spec)) return "包规格含 shell 控制符";
  if (!PI_PACKAGE_PREFIXES.some((prefix) => spec.startsWith(prefix)) && !looksLikePackagePath(spec)) {
    return "包规格前缀不被接受，只支持 npm:、git:、https://、ssh:// 或本地路径";
  }
  return null;
}

/**
 * 精确授权轴：动作、作用域、工作区与包规格缺一不可。spec 取剩余全部字符，
 * 不按冒号继续切分，因为 npm scope、Git URL 与 Windows 路径都合法含冒号。
 */
export function piPackagePermissionResource(
  action: PiPackagePermissionAction,
  scope: "user" | "project",
  workspaceId: string,
  spec: string
): string {
  if (!WORKSPACE_PERMISSION_ID_RE.test(workspaceId)) {
    throw new Error("PI_PACKAGE_PERMISSION_RESOURCE_INVALID: workspaceId");
  }
  const issue = piPackageSpecIssue(spec);
  if (issue !== null) throw new Error(`PI_PACKAGE_PERMISSION_RESOURCE_INVALID: ${issue}`);
  return `pi-package:${action}:${scope}:${workspaceId}:${spec}`;
}

export interface PiPackageGrantResource {
  action: PiPackagePermissionAction;
  scope: "user" | "project";
  workspaceId: string;
  spec: string;
}

export function parsePiPackageGrantResource(raw: string): PiPackageGrantResource | null {
  const match = /^pi-package:(install|remove):(user|project):([a-f0-9]{32}):([\s\S]+)$/u.exec(raw);
  if (!match) return null;
  const [, action, scope, workspaceId, spec] = match;
  if (piPackageSpecIssue(spec) !== null) return null;
  return {
    action: action as PiPackagePermissionAction,
    scope: scope as "user" | "project",
    workspaceId,
    spec,
  };
}

export function isPiResourcesShellGrant(capabilityId: string, permission: string): boolean {
  return capabilityId === PI_RESOURCES_CAPABILITY_ID && permission === PI_RESOURCES_PERMISSION;
}

export const piResourceIdRequestSchema = z.object({
  workspaceId: z.string().min(1),
  id: z.string().min(1),
});

export const trustDecideRequestSchema = z.object({
  workspaceId: z.string().min(1),
  decision: trustDecisionSchema,
  /** true = 写入 trust.json（跨应用共享，终端里的 pi 也会读到）；false = 只影响本次运行 */
  remember: z.boolean(),
});

// ---------- Extension UI 的两条新推送通道 ----------

/** 某一条弹窗失效。reason 决定渲染侧给用户看哪句话。 */
export const piUiExpirePayloadSchema = z.object({
  id: z.string().min(1),
  reason: z.enum(["timeout", "generation", "runtime-gone"]),
});
export type PiUiExpirePayload = z.infer<typeof piUiExpirePayloadSchema>;

/** 整代作废。 */
export const piUiExpireAllPayloadSchema = z.object({
  generation: z.number().int().nonnegative(),
  reason: z.enum(["generation", "runtime-gone"]),
});
export type PiUiExpireAllPayload = z.infer<typeof piUiExpireAllPayloadSchema>;

/**
 * pi:ui-respond 的返回。
 *
 * 改造前这条通道返回 void，主进程直写 stdin、失败静默吞掉 —— 用户点了
 * 「确定」，弹窗关了，助手那边什么都没发生，而界面上没有任何线索。
 */
export const extensionUiRespondResultSchema = z.object({
  ok: z.boolean(),
  reason: z.enum(["expired", "no-runtime"]).optional(),
});
export type ExtensionUiRespondResult = z.infer<typeof extensionUiRespondResultSchema>;

/** pi:ui-pending 的返回：主进程侧的扩展 UI 快照。 */
export const extUiSnapshotSchema = z.object({
  requests: z.array(z.object({ type: z.literal("extension_ui_request") }).loose()),
  statuses: z.array(z.object({ key: z.string(), text: z.string() })),
  widgets: z.array(
    z.object({
      key: z.string(),
      lines: z.array(z.string()),
      placement: z.enum(["aboveEditor", "belowEditor"]),
    })
  ),
  title: z.string(),
  editorText: z.string(),
});

/**
 * 快照的**线上形状**。
 *
 * 名字带 Wire 后缀是为了和 main 侧那个类型分开：那边的 `requests` 是强类型
 * 的 `ExtensionUiRequest[]`，这里在 IPC 边界上只能校验到「是个带 type 的
 * 对象」。两处同名会被 check-contract-uniqueness 判成契约漂移，而它们确实
 * 不是同一个东西。
 */
export type ExtUiSnapshotWire = z.infer<typeof extUiSnapshotSchema>;

/**
 * 扩展弹窗失效后给用户看的固定文案。
 *
 * 定在契约里而不是散在组件里：这句话同时是 c[8] 的 UI-observable 判据，
 * 组件与单测必须引同一个常量，否则「改了组件、测试还绿」。
 */
export const UI_EXPIRED_HINT = "助手已不再等待这个回答";

/** trust 对话框里必须出现的固定说明。 */
export const TRUST_NOT_PERMISSION_NOTE =
  "信任不等于工具权限：信任只决定 pi 是否加载这个项目里的设置、技能与扩展，" +
  "它不会限制助手之后能对你的文件和命令行做什么。";

/**
 * updater 原始错误 → 七类错误码 + 可重试性 + 用户可读文案。
 *
 * ## 为什么必须穷尽
 *
 * electron-updater 的错误是一堆没有稳定 `code` 的 Error：有的带
 * `net::ERR_*`，有的带 node 的 errno，有的只有一句英文。UI 侧需要回答的
 * 只有两个问题：「这是什么毛病」和「点重试有没有用」。
 *
 * 分类函数的 switch 有 default 分支落到 'unknown'，这不是防御性代码 ——
 * 返回 undefined 时界面会渲染出一条既没有文案也没有重试按钮的空错误，
 * 用户看到的是「更新失败」四个字加一片空白。
 */
import { UPDATE_ERROR_MESSAGES, type UpdateErrorCode } from "@pibuddy/contract";

export interface UpdateErrorInfo {
  code: UpdateErrorCode;
  /** 点「重试」是否可能成功。网络类可重试，签名 / 元数据类不可 */
  retryable: boolean;
  /** 直接展示给用户的中文说明 */
  message: string;
  /** 原始错误文本（脱敏后进日志与「复制诊断信息」，不直接展示） */
  detail: string;
}

/** 把任意 unknown 拍成可搜索的文本（含 node errno 与嵌套 cause）。 */
function errorText(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause && cause !== err ? ` | ${errorText(cause)}` : "";
    return `${code} ${err.message}${causeText}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 按优先级匹配的分类规则。
 *
 * 顺序不可随意调换：签名 / 磁盘 / 权限这三类的特征串都很具体，必须排在
 * 泛化的网络规则之前 —— 「下载到一半磁盘满了」的报文里往往同时出现
 * download 与 ENOSPC，先撞上网络规则的话用户会被告知「检查网络」，
 * 然后无论重试多少次都失败。
 */
const RULES: ReadonlyArray<{ code: UpdateErrorCode; re: RegExp }> = [
  // 完整性 / 签名：最具体，排最前
  {
    code: "signature",
    re: /sha512|checksum mismatch|not signed|signature (verification )?(failed|mismatch)|ERR_UPDATER_INVALID_SIGNATURE|publisher ?name/i,
  },
  // 磁盘
  { code: "disk", re: /ENOSPC|no space left|EROFS|disk (is )?full|EDQUOT/i },
  // 权限
  { code: "permission", re: /EACCES|EPERM|permission denied|access is denied|elevate/i },
  // 本环境不支持自更新
  {
    code: "unsupported",
    re: /is not packaged|dev-app-update\.yml|app-update\.yml|ERR_UPDATER_ASAR|Skip checkForUpdates|not supported/i,
  },
  // 元数据 / feed 解析
  {
    code: "metadata",
    re: /ERR_UPDATER_INVALID_UPDATE_INFO|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|cannot parse|unable to find latest|latest(-mac|-linux)?\.yml|no published versions|HttpError: 4\d\d/i,
  },
  // 网络：最泛化，排最后
  {
    code: "network",
    re: /net::ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|getaddrinfo|timed? ?out|HttpError: 5\d\d|certificate/i,
  },
];

/** 把原始错误分到七类之一。无法归类时返回 'unknown'（绝不返回 undefined）。 */
export function classifyUpdaterError(err: unknown): UpdateErrorCode {
  const text = errorText(err);
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.code;
  }
  return "unknown";
}

/**
 * 错误码 → 可重试性与文案。
 *
 * default 分支存在的唯一理由：`code` 来自跨进程 / 跨版本的数据，编译期的
 * 联合类型在运行时不存在。落到 default 时按 'unknown' 处理，而不是返回
 * undefined 让 UI 渲染一片空白。
 */
export function describeUpdateError(code: UpdateErrorCode): Omit<UpdateErrorInfo, "detail"> {
  switch (code) {
    case "network":
    case "disk":
    case "permission":
    case "unknown":
      return { code, retryable: true, message: UPDATE_ERROR_MESSAGES[code] };
    case "signature":
    case "metadata":
    case "unsupported":
      // 这三类重试一百次也是同样的结果。给一个点了没用的「重试」按钮，
      // 比不给按钮更糟：用户会一直点，然后认定这软件坏了。
      return { code, retryable: false, message: UPDATE_ERROR_MESSAGES[code] };
    default:
      return { code: "unknown", retryable: true, message: UPDATE_ERROR_MESSAGES.unknown };
  }
}

/** 分类 + 描述。UpdateService 的错误路径只调这一个函数。 */
export function mapUpdaterError(err: unknown): UpdateErrorInfo {
  const code = classifyUpdaterError(err);
  return { ...describeUpdateError(code), detail: errorText(err).trim() };
}

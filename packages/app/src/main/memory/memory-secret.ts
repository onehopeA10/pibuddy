/**
 * 记忆内容的准入判定：secret 拦下、敏感路径标记（MEM-101 第一版）。
 *
 * ## 为什么 secret 一律不落库，而不是「落库但标敏感」
 *
 * 一把密钥一旦落进记忆库，它就多了一处可以被检索、被导出、被（一旦有 bug）
 * 注入进提示词的落点。而记忆的正当用途从来不是「记住我的 API key」——那是
 * secret-store（safeStorage 加密、只进不出）的事。因此这里对 secret 的处置是
 * **直接拒绝保存**，把它挡在库外，而不是收进来再小心翼翼地不用它。
 *
 * ## 敏感路径为什么只标记不拒绝
 *
 * 「我的私钥在 ~/.ssh/id_rsa」这句话本身不是密钥，用户可能真的想记住它。
 * 但把它顺手塞进每一轮提示词显然不合适。因此标 `sensitive`：留在库里可查可删，
 * 但默认不注入、正文不进命中记录、不进日志。
 *
 * ## 判据是一组保守的正则，不追求完备
 *
 * 完备的 secret 检测不存在。这里的目标是挡住**常见形态**（各家 API key 前缀、
 * 私钥 PEM 头、高熵长串、`password=` 赋值），把明显的东西拦下。漏网的靠用户
 * 自己不往记忆里贴密钥这条常识兜底；误伤（把一段正常文本判成 secret）的代价
 * 只是一句「疑似密钥，未保存」的提示，用户改一下措辞即可。
 */

/** 各家常见 API key / token 前缀。命中即判 secret。 */
const SECRET_PREFIXES = [
  /\bsk-[a-z0-9]{16,}/i, // OpenAI 及一众兼容端点
  /\bgh[posr]_[A-Za-z0-9]{20,}/, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS 临时凭证
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\bya29\.[0-9A-Za-z_-]+/, // Google OAuth token
  /\bglpat-[0-9A-Za-z_-]{20,}/, // GitLab PAT
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];

/** 私钥 / 凭证块的 PEM 头。 */
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/;

/** `password = xxx` / `api_key: xxx` / `secret=xxx` 这类明文赋值。 */
const ASSIGNMENT_RE =
  /\b(pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*\S{6,}/i;

/**
 * 高熵长串：连续 32+ 位的 base64 / hex，且字符构成足够杂。
 *
 * 单看长度会误伤长 URL、长中文；这里额外要求「同时有大小写或数字混杂」，
 * 把「一段普通英文句子」排除掉。
 */
function hasHighEntropyToken(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    const token = m[0];
    const classes =
      (/[a-z]/.test(token) ? 1 : 0) +
      (/[A-Z]/.test(token) ? 1 : 0) +
      (/[0-9]/.test(token) ? 1 : 0);
    // 至少两类字符混杂才算「像密钥」，否则一串纯小写单词不该被误判。
    if (classes >= 2) return true;
  }
  return false;
}

/** 敏感路径 / 文件特征：私钥文件、凭证目录、环境变量文件。 */
const SENSITIVE_PATH_RE =
  /(\.ssh\/|id_rsa\b|id_ed25519\b|\.env(\.|\b)|\.pem\b|\.p12\b|\.pfx\b|\.keychain\b|credentials\b|\/etc\/shadow\b|\.aws\/)/i;

export interface ContentVerdict {
  /** true = 拒绝保存（疑似密钥） */
  rejected: boolean;
  /** rejected 时的可读原因 */
  reason?: string;
  /** 非拒绝但疑似敏感（敏感路径）：落库但默认不注入 */
  sensitive: boolean;
}

/** 判定一段将要保存的内容。 */
export function classifyContent(content: string): ContentVerdict {
  if (PRIVATE_KEY_RE.test(content)) {
    return { rejected: true, reason: "内容像是一段私钥，未保存到记忆。", sensitive: false };
  }
  if (SECRET_PREFIXES.some((re) => re.test(content))) {
    return { rejected: true, reason: "内容像是一把 API 密钥 / 令牌，未保存到记忆。", sensitive: false };
  }
  if (ASSIGNMENT_RE.test(content)) {
    return { rejected: true, reason: "内容像是一条密码 / 密钥赋值，未保存到记忆。", sensitive: false };
  }
  if (hasHighEntropyToken(content)) {
    return { rejected: true, reason: "内容里有一段疑似密钥的高熵字符串，未保存到记忆。", sensitive: false };
  }
  if (SENSITIVE_PATH_RE.test(content)) {
    return { rejected: false, sensitive: true };
  }
  return { rejected: false, sensitive: false };
}

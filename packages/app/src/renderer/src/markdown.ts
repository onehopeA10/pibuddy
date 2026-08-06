import MarkdownIt from "markdown-it";
// 只引入常用语言子集（约 35 种），完整版 highlight.js 会让包体多出 ~1MB
import hljs from "highlight.js/lib/common";

/**
 * 单条内容渲染的字节上限（SEC-005）。
 * 模型或工具可以吐出几 MB 的输出，全量塞进 DOM 会把渲染进程主线程打死。
 */
export const MAX_TOOL_OUTPUT_BYTES = 65536;

/** 链接允许的 scheme。javascript:/file:/data:/vbscript:/search-ms: 等一律剥掉 href。 */
const LINK_SCHEME_ALLOWLIST = ["https:", "http:", "mailto:"];
/** 图片允许的 scheme：本地附件走 data:，运行时对象走 blob:。 */
const IMAGE_SRC_ALLOWLIST = ["https:", "data:", "blob:"];

function schemeOf(raw: string): string | null {
  // 相对路径（无 scheme）在 file:// 下没有意义，统一按不合法处理
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(raw.trim());
  return m ? m[1].toLowerCase() : null;
}

// 显式标注类型：highlight 回调里用到了 md.utils，不标注会让 md 落进
// "在自身初始化器中被引用" 的循环推断，整个文件退化成 any（TS7022 + 一串 TS7006）
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    // 必须自己吐出 <pre class="hljs"> 外壳：只返回 tokens 的话 highlight.js
    // 主题里挂在 .hljs 上的背景/前景色一条都不会生效（代码块看起来是裸的）。
    // lang 已被 hljs.getLanguage 校验过，是已知语言名，不会带引号注入。
    if (lang && hljs.getLanguage(lang)) {
      try {
        const value = hljs.highlight(code, { language: lang }).value;
        return `<pre class="hljs"><code class="language-${lang}">${value}</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

/** 链接白名单判定（SEC-005）。true 表示可以保留 href。 */
export function validateLink(raw: string): boolean {
  const scheme = schemeOf(raw);
  if (scheme === null) return false;
  return LINK_SCHEME_ALLOWLIST.includes(scheme);
}

/**
 * 刻意让 markdown-it 自带的 validateLink 恒放行，把过滤下沉到 renderer 规则里。
 *
 * 原因：markdown-it 的 validateLink 返回 false 时不会生成 link token，
 * `[x](javascript:alert(1))` 会被**原样**输出成文本，危险 URL 反而留在了 DOM 里。
 * 放行到 token 阶段再剥掉 href，输出是干净的 `<a>x</a>`，URL 整体消失。
 */
md.validateLink = () => true;

// 外链在系统浏览器中打开（主进程 setWindowOpenHandler → openExternalSafely 承接）
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet("href") ?? "";
  if (!validateLink(href)) {
    // 非白名单 scheme：连同 href 一起丢弃，渲染成不可点击的普通文本
    const i = token.attrIndex("href");
    if (i >= 0) token.attrs?.splice(i, 1);
    token.attrSet("data-blocked-link", "1");
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// 图片 src 白名单：只允许 https / data: / blob:，file: 与 javascript: 一律剥掉
const defaultImage =
  md.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  const scheme = schemeOf(src);
  const safeDataImage = /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src);
  if (scheme === null || !IMAGE_SRC_ALLOWLIST.includes(scheme) || (scheme === "data:" && !safeDataImage)) {
    const i = token.attrIndex("src");
    if (i >= 0) token.attrs?.splice(i, 1);
  }
  return defaultImage(tokens, idx, options, env, self);
};

/**
 * 把超长输出按**字节**截断到 MAX_TOOL_OUTPUT_BYTES 以内，保留末尾（结论通常在末尾）。
 * 按字节而非字符，因为中文一个字符 3 字节，按字符算会低估 3 倍。
 */
export function truncateToolOutput(text: string): string {
  const bytes = new TextEncoder().encode(text ?? "");
  if (bytes.length <= MAX_TOOL_OUTPUT_BYTES) return text ?? "";
  let start = bytes.length - MAX_TOOL_OUTPUT_BYTES;
  // 对齐到 UTF-8 字符边界，避免解码出替换字符反而把字节数撑回去
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  const tail = new TextDecoder("utf-8").decode(bytes.subarray(start));
  return `…（内容过长已截断，省略前 ${start} 字节）\n${tail}`;
}

// 已完成消息块的渲染结果缓存：流式期间只有最后一个（不断变化的）块会 miss，
// 其余块与历史消息全部命中缓存，避免每次组件重渲染都重新解析 markdown
const cache = new Map<string, string>();
const MAX_CACHE = 300;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
let cacheBytes = 0;

function entryBytes(key: string, html: string): number {
  return new TextEncoder().encode(key).byteLength + new TextEncoder().encode(html).byteLength;
}

export function clearMarkdownCache(): void {
  cache.clear();
  cacheBytes = 0;
}

export function renderMarkdown(text: string): string {
  const key = text ?? "";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = md.render(key);
  cache.set(key, html);
  cacheBytes += entryBytes(key, html);
  while (cache.size > MAX_CACHE || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const oldHtml = cache.get(oldest) ?? "";
    cache.delete(oldest);
    cacheBytes -= entryBytes(oldest, oldHtml);
  }
  return html;
}

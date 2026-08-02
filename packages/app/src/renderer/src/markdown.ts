import MarkdownIt from "markdown-it";
// 只引入常用语言子集（约 35 种），完整版 highlight.js 会让包体多出 ~1MB
import hljs from "highlight.js/lib/common";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        /* fall through */
      }
    }
    return "";
  },
});

// 外链在系统浏览器中打开
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// 已完成消息块的渲染结果缓存：流式期间只有最后一个（不断变化的）块会 miss，
// 其余块与历史消息全部命中缓存，避免每次组件重渲染都重新解析 markdown
const cache = new Map<string, string>();
const MAX_CACHE = 300;

export function renderMarkdown(text: string): string {
  const key = text ?? "";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = md.render(key);
  cache.set(key, html);
  if (cache.size > MAX_CACHE) {
    cache.delete(cache.keys().next().value as string);
  }
  return html;
}

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeMarkdownHtml } from "./markdown";

describe("markdown 出口消毒", () => {
  it("javascript: 链接被剥掉 href", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("data-blocked-link");
  });

  it("sanitizeMarkdownHtml 删除 script 并剥 on* 属性", () => {
    const dirty = `<p onclick="evil()">hi</p><script type="text/plain">xss</script><img src="https://a.test/x.png" onerror="evil()">`;
    const clean = sanitizeMarkdownHtml(dirty);
    expect(clean.toLowerCase()).not.toContain("script");
    expect(clean.toLowerCase()).not.toContain("onclick");
    expect(clean.toLowerCase()).not.toContain("onerror");
    expect(clean).toContain("hi");
  });
});

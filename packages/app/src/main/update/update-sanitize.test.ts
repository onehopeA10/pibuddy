/**
 * 发布说明当不可信内容处理。
 *
 * releaseNotes 来自远端 feed。直接 v-html 进渲染进程，等价于把 XSS 入口开在
 * 一个开着 contextBridge 的窗口上 —— 那扇窗户后面是 window.piBuddy 的
 * 全部能力。因此净化在 main 侧做一次，渲染侧只做纯文本插值。
 */
import { describe, expect, it } from "vitest";

import { sanitizeReleaseNotes } from "@pibuddy/contract";

describe("sanitizeReleaseNotes", () => {
  const SAMPLES = [
    `<img src=x onerror=alert(1)>`,
    `<a href="javascript:void(0)">点我</a>`,
    `<script>alert(1)</script>`,
  ];

  for (const raw of SAMPLES) {
    it(`剥干净：${raw.slice(0, 28)}`, () => {
      const out = sanitizeReleaseNotes(raw);
      expect(out).not.toContain("<");
      expect(out.toLowerCase()).not.toContain("javascript:");
    });
  }

  it("script 的内容整段剥掉，不留 alert(1) 当正文", () => {
    expect(sanitizeReleaseNotes(`<script>alert(1)</script>`)).toBe("");
  });

  it("保留正文与换行", () => {
    const out = sanitizeReleaseNotes(`<p>修复了若干问题</p><br/><p>新增语音输入</p>`);
    expect(out).toContain("修复了若干问题");
    expect(out).toContain("新增语音输入");
    expect(out).not.toContain("<");
  });

  it("GitHub 的多版本聚合数组也能处理", () => {
    const out = sanitizeReleaseNotes([
      { version: "2.0.0", note: "<b>大更新</b>" },
      { version: "1.9.0", note: "小修小补" },
    ]);
    expect(out).toContain("大更新");
    expect(out).toContain("小修小补");
    expect(out).not.toContain("<");
  });

  it("null / undefined 返回空串而不是 'null'", () => {
    expect(sanitizeReleaseNotes(null)).toBe("");
    expect(sanitizeReleaseNotes(undefined)).toBe("");
  });

  it("被空白拆开的 java script: 也拦得住", () => {
    expect(sanitizeReleaseNotes("java\nscript:alert(1)").toLowerCase()).not.toContain(
      "javascript:"
    );
  });
});

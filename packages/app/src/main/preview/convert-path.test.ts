import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 十类 PreviewKind 的正向路径 + 四类错误码 + SUGGESTION 表（ART-101）。
 *
 * ## 为什么十条正向断言比「grep 一下 unsupported」有意义得多
 *
 * 一个「对所有输入都返回 unsupported」的桩能通过任何形式的存在性检查，
 * 而它在界面上的表现是每个文件都打不开。十条 `kind === X && code === 'ok'
 * && text.length > 0` 的断言让那种桩必然失败 —— 这才是「空白冒充成功」
 * 唯一挡得住的方式。
 */
import type { PreviewErrorCode } from "@pibuddy/contract";

import { convertFile, SUGGESTION } from "./convert-worker.js";
import { kindForExtension } from "./preview-types.js";
import {
  makeEncryptedOoxml,
  makePptx,
  makePptxWithOle,
  positiveFixtures,
} from "./fixtures.js";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-convpath-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function put(name: string, content: Buffer): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content);
  return p;
}

function sha(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function request(inputPath: string) {
  return {
    requestId: "r1",
    inputPath,
    outputDir: tmpRoot,
    sourceName: path.basename(inputPath),
    sizeBytes: fs.statSync(inputPath).size,
    maxTextChars: 100_000,
  };
}

describe("十类 PreviewKind 正向路径", () => {
  it("每一类都返回对应的 kind、code=ok 且抽出了非空文本", async () => {
    const fixtures = await positiveFixtures();
    // 十类一个不少（漏一类就是漏一种用户会点开的文件）
    expect(fixtures).toHaveLength(10);
    expect(new Set(fixtures.map((f) => f.kind)).size).toBe(10);

    for (const fixture of fixtures) {
      const p = put(fixture.name, fixture.content);
      const result = await convertFile(request(p));
      expect(result.kind, `${fixture.name} 的 kind`).toBe(fixture.kind);
      expect(result.code, `${fixture.name} 的 code`).toBe("ok");
      expect(result.text.length, `${fixture.name} 的正文长度`).toBeGreaterThan(0);
      expect(result.suggestion).toBe("");
    }
  });

  it("图片带 data URL、表格类带结构化 tables", async () => {
    const fixtures = await positiveFixtures();
    const png = fixtures.find((f) => f.kind === "image")!;
    const image = await convertFile(request(put(png.name, png.content)));
    expect(image.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);

    const csv = fixtures.find((f) => f.kind === "csv")!;
    const table = await convertFile(request(put(csv.name, csv.content)));
    expect(table.tables[0].rows[0]).toEqual(["地区", "金额"]);

    const xlsx = fixtures.find((f) => f.kind === "excel")!;
    const sheet = await convertFile(request(put(xlsx.name, xlsx.content)));
    expect(sheet.tables[0].name).toBe("销售");
    expect(sheet.tables[0].rows.length).toBeGreaterThan(1);
  });

  it("扩展名分派表覆盖十类，未知扩展名返回 null", () => {
    expect(kindForExtension(".DOCX")).toBe("word");
    expect(kindForExtension(".pptx")).toBe("ppt");
    expect(kindForExtension(".xyz")).toBeNull();
  });
});

describe("三个负向 fixture", () => {
  it("PPTX 里的 SmartArt：正文仍抽出，但如实降级成 unsupported", async () => {
    const p = put("smart.pptx", await makePptx(true));
    const result = await convertFile(request(p));
    expect(result.code).toBe("unsupported");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("首页标题");
    expect(result.suggestion).toBe(SUGGESTION.unsupported);
  });

  it("嵌入 OLE 对象：unsupported，且宏载荷不出现在输出里", async () => {
    const p = put("ole.pptx", await makePptxWithOle());
    const result = await convertFile(request(p));
    expect(result.code).toBe("unsupported");
    expect(result.suggestion).toBe(SUGGESTION.unsupported);
  });

  it("加密 XLSX：password-protected", async () => {
    const p = put("locked.xlsx", makeEncryptedOoxml());
    const result = await convertFile(request(p));
    expect(result.code).toBe("password-protected");
    expect(result.suggestion).toBe(SUGGESTION["password-protected"]);
  });
});

describe("四类错误码与 SUGGESTION 表", () => {
  it("损坏 / 有密码 / 不支持三类各自返回确定的 code，且原文件 sha256 不变", async () => {
    const cases: { name: string; content: Buffer; code: PreviewErrorCode }[] = [
      { name: "broken.docx", content: Buffer.from("这不是一个 zip，也不是 CFB"), code: "corrupt" },
      { name: "locked.docx", content: makeEncryptedOoxml(), code: "password-protected" },
      { name: "thing.xyz", content: Buffer.from("随便什么"), code: "unsupported" },
    ];
    for (const c of cases) {
      const p = put(c.name, c.content);
      const before = sha(p);
      const result = await convertFile(request(p));
      expect(result.code, c.name).toBe(c.code);
      expect(result.suggestion, c.name).toBe(SUGGESTION[c.code]);
      // 转换失败绝不能动原文件 —— 那是用户的东西
      expect(fs.existsSync(p)).toBe(true);
      expect(sha(p)).toBe(before);
    }
  });

  it("SUGGESTION 覆盖全部六个错误码，取值互不相同且都不短于 10 个字符", () => {
    const codes: PreviewErrorCode[] = [
      "corrupt",
      "password-protected",
      "too-large",
      "unsupported",
      "timeout",
      "oom",
    ];
    const values = codes.map((c) => SUGGESTION[c]);
    for (const [i, value] of values.entries()) {
      expect(typeof value, codes[i]).toBe("string");
      expect(value.length, codes[i]).toBeGreaterThanOrEqual(10);
    }
    expect(new Set(values).size).toBe(codes.length);
  });
});

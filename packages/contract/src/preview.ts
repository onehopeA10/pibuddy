/**
 * 安全预览的契约（ART-101）。
 *
 * ## 为什么 `code` 和 `kind` 是两个字段
 *
 * 「这是个什么东西」和「这次转换成不成」是正交的两件事。PPTX 里的
 * SmartArt 抽不出文本，但正文仍然抽得出来 —— 那是 `kind: "ppt"` +
 * `code: "unsupported"` + 非空 `text`。把两者揉成一个枚举的话，这种
 * 「大部分成了、有一小块没成」的真实情况只能二选一地撒谎：要么报成功
 * 而用户不知道少了东西，要么报失败而把已经抽出来的正文一起扔掉。
 *
 * ## 为什么错误码要配一张建议表
 *
 * `code: "password-protected"` 对写代码的人是完整信息，对用户是一句
 * 天书。SUGGESTION 表（住在 main/preview/convert-worker.ts）把每个 code
 * 映射到一句能据以行动的中文，界面直接显示那句话 —— 单测断言界面文案
 * 与常量表逐字相等，因此不存在「代码里有分类、界面上还是一片空白」。
 */
import { z } from "zod";

/**
 * 第一版覆盖的十类可预览内容。
 *
 * `media-metadata` 是刻意的：音视频**只读容器头里的元数据**（时长、
 * 分辨率、编码），不解码任何一帧。解码是把一个攻击者可控的字节流喂给
 * 一个 C 解码器，那是本任务整套隔离想要避免的事。
 */
export const previewKindSchema = z.enum([
  "markdown",
  "text",
  "json",
  "csv",
  "image",
  "media-metadata",
  "pdf",
  "word",
  "excel",
  "ppt",
]);
export type PreviewKind = z.infer<typeof previewKindSchema>;

/**
 * 转换失败的六种分类。
 *
 * 分类的唯一标准是「用户接下来该做什么」不同：corrupt 让他找源文件，
 * password-protected 让他先解密，too-large 让他用别的程序开，
 * unsupported 让他换个格式，timeout / oom 让他重试或换更小的文件。
 */
export const previewErrorCodeSchema = z.enum([
  "corrupt",
  "password-protected",
  "too-large",
  "unsupported",
  "timeout",
  "oom",
]);
export type PreviewErrorCode = z.infer<typeof previewErrorCodeSchema>;

/** 结果码：成功是 `ok`，其余六种见 previewErrorCodeSchema。 */
export const previewCodeSchema = z.enum([
  "ok",
  "corrupt",
  "password-protected",
  "too-large",
  "unsupported",
  "timeout",
  "oom",
]);
export type PreviewCode = z.infer<typeof previewCodeSchema>;

/**
 * 表格类内容的结构化摘要（CSV / Excel 用）。
 *
 * 与 `text` 并存而不是取代它：`text` 是所有类型都有的、可直接渲染的
 * 保底形态，`table` 是能画成表格时的加料。渲染侧永远可以只看 text。
 */
export const previewTableSchema = z.object({
  /** 工作表 / 分片名。CSV 恒为 "" */
  name: z.string(),
  rows: z.array(z.array(z.string())),
  truncated: z.boolean(),
});
export type PreviewTable = z.infer<typeof previewTableSchema>;

/**
 * 一次转换的结果。
 *
 * `text` 在**任何** code 下都可能非空 —— 见文件头关于 SmartArt 的说明。
 * 渲染侧的判据是「text 非空就渲染 text，code !== 'ok' 就同时显示建议」，
 * 而不是「失败就不渲染」。
 */
export const previewResultSchema = z.object({
  kind: previewKindSchema,
  code: previewCodeSchema,
  /** 可直接渲染的纯文本 / Markdown。转换失败时可能仍有部分内容 */
  text: z.string(),
  /** 给用户看的可行动建议。code === 'ok' 时为空串 */
  suggestion: z.string(),
  /**
   * 与内容本身无关、但用户必须看到的提示。第一版只有一类：
   * 「这份文档带了宏 / 远程模板 / 外部链接 / 数据连接，我们没读也没执行」。
   *
   * 它**不能**混进 `text` —— 表格类的渲染分支只画 tables 不画 text，
   * 混在里面的话，一个带宏的 xlsm 在界面上会一个字的警告都没有，
   * 而 docx 却有。同一件事在两种文件上表现不同，就是没人会发现的那种缺陷。
   */
  notices: z.array(z.string()),
  /** 表格类的结构化视图（最多前若干行） */
  tables: z.array(previewTableSchema),
  /** 图片类：`data:` URL；其余类型为 null */
  dataUrl: z.string().nullable(),
  /** 源文件显示名 */
  sourceName: z.string(),
  sizeBytes: z.number().nonnegative(),
  /** 转换耗时（ms），供诊断 */
  elapsedMs: z.number().nonnegative(),
});
export type PreviewResult = z.infer<typeof previewResultSchema>;

/**
 * 预览目标。
 *
 * 两种表达方式，都不含绝对路径：
 *   - `token` —— attachment-registry 签发的一次性能力凭证（CT-17）；
 *   - `workspaceId` + `relativePath` —— 工作区内的文件，main 侧经
 *     resolveInWorkspace 收容（CT-18）。
 *
 * 两个都不传即在 schema 之后被 handler 拒绝：这里不用 union 表达
 * 「二选一」是因为 `.shape` 必须能被单测按键名检查（c[19]）。
 */
export const previewTargetSchema = z.object({
  token: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  relativePath: z.string().optional(),
});
export type PreviewTarget = z.infer<typeof previewTargetSchema>;

/** preview:close 的入参。previewId 是 preview:open 返回的不透明句柄。 */
export const previewCloseRequestSchema = z.object({
  previewId: z.string().min(1),
});

/** preview:open 的返回：一个不透明句柄 + 首次转换结果。 */
export const previewHandleSchema = z.object({
  previewId: z.string().min(1),
  result: previewResultSchema,
});
export type PreviewHandle = z.infer<typeof previewHandleSchema>;

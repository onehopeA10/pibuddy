---
name: office-doc-convert
description: 文档格式转换技能。当用户要求把 Markdown、Word（docx）、PDF、HTML 互相转换时使用（如 md 转 PDF、md 转 Word、Word 转 md）。先检测机器上有没有 pandoc：有则用 pandoc 走最稳的路；没有则用技能自带的零依赖 md→HTML 脚本 + Edge 无头打印生成 PDF 等降级路线。各格式的真实支持度在技能内有明确矩阵，不支持的转换如实告知，不硬转出坏文件。转换结果写新文件，绝不覆盖原文档。
---

# 文档格式转换

把用户的文档在 Markdown / Word / PDF / HTML 之间转换。核心纪律：**每条转换路先探测工具是否存在，选真的走得通的那条；走不通的如实说，不硬转出一个打不开的文件。**

## 第一步：探测工具

按顺序跑一遍（都探测完再选路线，结果告诉用户一句即可）：

```bash
pandoc --version        # 全能转换器（多数机器没装）
node --version          # 跑本技能自带脚本需要
```

Windows 上再探测 Edge（预装于 Win10/11，用于 HTML→PDF）：

```powershell
$edge = @("$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
```

## 支持矩阵（如实的那份）

| 转换 | 有 pandoc | 没 pandoc（降级路线） |
|---|---|---|
| md → HTML | `pandoc 输入.md -s -o 输出.html` | 自带脚本 `scripts/md-to-html.mjs`（零依赖，支持标题/列表/表格/代码块/图片，打印友好样式） |
| md → PDF | 经 HTML：先转 HTML，再 Edge 无头打印（pandoc 直出 PDF 需要 LaTeX，不可假设存在） | 同左：脚本转 HTML → Edge 打印 PDF |
| md → Word | `pandoc 输入.md -o 输出.docx`（真 docx，最稳） | **给不出真 docx**。交付 HTML 并告诉用户「用 Word 打开这个 HTML → 另存为 .docx」，两步、无损排版基础样式；装了 Word 时也可用 COM 自动化代劳（见 references/word-com.md） |
| Word → md | `pandoc 输入.docx -t gfm -o 输出.md` | 装了 Word：COM 把 docx 另存为筛选过的 HTML，你再把 HTML 折成 Markdown。没装 Word：如实说明此路不通，建议用户复制文本内容给你 |
| Word → PDF | `pandoc` 不走这条；装了 Word 用 COM 的 ExportAsFixedFormat（见 references/word-com.md） | 同左；没装 Word 则不支持 |
| HTML → PDF | Edge 无头打印（见下） | 同左 |
| PDF → md/文本 | **两种情况都不支持**。PDF 是排版终点不是数据源：pandoc 不吃 PDF 输入。如实告知，可建议用户用 Word 打开 PDF（Word 2013+ 能转）后走 Word → md | 同左 |

## HTML → PDF：Edge 无头打印（Windows）

```powershell
& $edge --headless --disable-gpu --print-to-pdf="C:\完整路径\输出.pdf" "file:///C:/完整路径/输入.html"
```

要点：两个路径都要**绝对路径**；命令返回后确认输出文件真的存在且大小 > 0 再报成功；中文正常（走系统字体）。macOS/Linux 上等价的是 Chrome/Chromium 的同名参数，找不到浏览器时如实降级为「交付 HTML，用户用浏览器自己打印成 PDF（Ctrl+P → 另存为 PDF）」——这条永远走得通。

## 自带脚本 md-to-html.mjs

与本 SKILL.md 同目录的 `scripts/md-to-html.mjs`（从技能加载路径定位绝对路径）：

```bash
node scripts/md-to-html.mjs 输入.md [输出.html] [--title 文档标题]
```

支持：标题、粗斜体、行内代码、围栏代码块、有序/无序列表（一层嵌套）、表格、引用、分隔线、链接、图片（相对路径图片会按原样引用，转 PDF 前确认图片与 HTML 在同一相对位置）。**不支持**：脚注、数学公式、任务列表勾选框（原样保留文本）。输出内嵌中文友好的打印样式（宋体/微软雅黑回退、A4 页边距）。

## 操作纪律

- 结果写**新文件**，与原文档同目录、名字带目标格式（`会议纪要.md` → `会议纪要.pdf`）；目标已存在时加序号，绝不覆盖。
- 转换完自检：输出文件存在、大小合理（>0 且不是只有几十字节的空壳）；PDF 额外提醒用户打开瞄一眼排版。
- 批量转换先列文件清单让用户确认，再逐个转，最后汇总成功/失败。
- 降级路线要**先说后做**：「你机器上没有 pandoc，我用内置方案转，表格和图片没问题，脚注会保留为普通文本」——预期管理是转换质量的一部分。

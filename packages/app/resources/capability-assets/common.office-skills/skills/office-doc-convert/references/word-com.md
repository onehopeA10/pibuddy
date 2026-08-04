# Word COM 自动化（仅限装了桌面版 Word 的 Windows）

pandoc 缺席时，装了 Word 的机器可以让 Word 本尊代劳。跑之前告诉用户
「我要调用你机器上的 Word 来转换」。路径一律绝对路径。

## docx → PDF

```powershell
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Open("C:\完整路径\输入.docx", $false, $true)  # ReadOnly
  $doc.ExportAsFixedFormat("C:\完整路径\输出.pdf", 17)                  # 17 = wdExportFormatPDF
} finally {
  $doc.Close($false)
  $word.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
```

## docx → HTML（供折成 Markdown）

```powershell
# 10 = wdFormatFilteredHTML：过滤掉 Office 私有标记的干净 HTML，适合再折成 Markdown
$doc.SaveAs2("C:\完整路径\中转.html", 10)
```

拿到 HTML 后由你（agent）把标题 / 列表 / 表格 / 粗斜体折成 Markdown 交付；
Word 生成的 HTML 里 class / style 噪声照样不少，只保留结构语义即可。

## HTML → docx（md → docx 的降级末段）

```powershell
$doc = $word.Documents.Open("C:\完整路径\输入.html")
$doc.SaveAs2("C:\完整路径\输出.docx", 16)   # 16 = wdFormatDocumentDefault (.docx)
```

## 通用要点

- COM 创建抛错 = 没装 Word：不要重试，退回人工路线（用户用 Word/WPS 手动另存）。
- ReadOnly 打开源文档，绝不改用户原件。
- 结束务必 `Quit()` 并释放 COM 引用，否则留下看不见的 WINWORD.EXE 进程占着文件。
- WPS 的 COM ProgID 与 Word 不同（`KWPS.Application`），本参考不覆盖；探测到用户只装
  WPS 时如实说明并走人工路线。

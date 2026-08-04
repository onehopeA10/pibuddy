# xlsx → CSV 自动转换（仅限装了 Excel 的 Windows）

用 PowerShell 驱动本机 Excel（COM 自动化）把工作簿另存为 CSV。**前提**：Windows +
已安装桌面版 Excel。跑之前告诉用户「我要调用你机器上的 Excel 来转换」。

```powershell
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $wb = $excel.Workbooks.Open("C:\完整路径\输入.xlsx")
  foreach ($ws in $wb.Worksheets) {
    # 62 = xlCSVUTF8（UTF-8 带 BOM 的 CSV；老 Excel 不认 62 时退回 6 = xlCSV，编码为本地 ANSI）
    $ws.SaveAs("C:\完整路径\输入-$($ws.Name).csv", 62)
  }
} finally {
  $wb.Close($false)
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
```

要点：

- 路径必须是**绝对路径**（COM 的当前目录不是 shell 的当前目录）。
- 每个工作表各出一份 CSV，文件名带工作表名。
- `SaveAs(..., 62)` 在 Excel 2016 以前会抛错——捕获后改用 `6`，并提醒用户产物编码是
  本地 ANSI（GBK），后续处理时按 GBK 读。
- 结束务必 `Quit()`，否则留下看不见的 EXCEL.EXE 进程占着文件。
- 没装 Excel（COM 创建抛错）时不要重试：直接退回「让用户在 Excel/WPS 里另存为 CSV」
  的人工路线。WPS 同样能另存为 CSV，但它的 COM ProgID 不同，本脚本不覆盖。

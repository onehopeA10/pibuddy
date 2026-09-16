/**
 * 紧凑时长：`12s` / `2m32s` / `1h03m`。
 *
 * 给「已完成 2m32s」这类一眼扫过的标签用，所以只保留两级单位、不出小数。
 * 负数与 NaN 一律按 0 处理——时间戳缺失或时钟回拨不该在界面上显示成 "-3s"。
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

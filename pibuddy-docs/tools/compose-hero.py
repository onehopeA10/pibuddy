"""把真实界面嵌进空 MacBook 外框。界面只缩小、不放大。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
FRAME = ROOT / "macbook-frame.png"
UI = ROOT.parent / "docs" / "public" / "screens" / "chat-workspace.png"
OUT = ROOT.parent / "docs" / "public" / "screens" / "hero-laptop.png"


def detect_screen(gray: np.ndarray) -> tuple[int, int, int, int]:
    h, w = gray.shape
    mid_y0, mid_y1 = int(h * 0.32), int(h * 0.68)
    col_dark = (gray[mid_y0:mid_y1] < 22).mean(axis=0) > 0.88
    xs = np.where(col_dark)[0]
    if xs.size == 0:
        raise SystemExit("未检测到屏幕列")
    x0, x1 = int(xs[0]), int(xs[-1])

    mid_x0, mid_x1 = int(w * 0.38), int(w * 0.62)
    row_dark = (gray[:, mid_x0:mid_x1] < 22).mean(axis=1) > 0.88
    ys = np.where(row_dark)[0]
    if ys.size == 0:
        raise SystemExit("未检测到屏幕行")
    y0, y1 = int(ys[0]), int(ys[-1])

    # 顶部留出摄像头，四周略收进玻璃内沿（按屏幕高度比例，适配 2x 外框）
    top = max(16, (y1 - y0) // 36)
    pad = max(4, (x1 - x0) // 280)
    y0 += top
    y1 -= pad
    x0 += pad
    x1 -= pad
    return x0, y0, x1, y1


def cover_fit(src: Image.Image, width: int, height: int) -> Image.Image:
    sw, sh = src.size
    scale = max(width / sw, height / sh)
    # 只缩小：屏幕比截图大时居中贴原图，黑边留给外框
    if scale > 1:
        canvas = Image.new("RGB", (width, height), (8, 8, 10))
        canvas.paste(src, ((width - sw) // 2, (height - sh) // 2))
        return canvas
    nw = max(1, int(round(sw * scale)))
    nh = max(1, int(round(sh * scale)))
    resized = src.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - width) // 2)
    top = max(0, (nh - height) // 2)
    return resized.crop((left, top, left + width, top + height))


def main() -> None:
    frame = Image.open(FRAME).convert("RGBA")
    ui = Image.open(UI).convert("RGB")
    # 外框放大到接近界面像素，避免 1280 图在视网膜屏上再被浏览器拉糊
    scale = 2
    frame = frame.resize((frame.size[0] * scale, frame.size[1] * scale), Image.Resampling.LANCZOS)
    gray = np.array(frame.convert("L"))
    x0, y0, x1, y1 = detect_screen(gray)
    sw, sh = x1 - x0 + 1, y1 - y0 + 1
    print(f"screen {x0},{y0} {sw}x{sh}  ui {ui.size[0]}x{ui.size[1]}")

    fitted = cover_fit(ui, sw, sh)
    radius = max(8, min(sw, sh) // 70)
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), radius=radius, fill=255)

    screen = Image.new("RGBA", (sw, sh))
    screen.paste(fitted)
    frame.paste(screen, (x0, y0), mask)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frame.convert("RGB").save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} {frame.size[0]}x{frame.size[1]}")


if __name__ == "__main__":
    main()

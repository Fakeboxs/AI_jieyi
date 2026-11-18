"""Generate NSIS wizard art (BMP, 24-bit) so the installer doesn't ship the 2005 default.

  sidebar.bmp  164x314  (left panel on every page)
  header.bmp   150x57   (top-right header on inner pages)
"""
from PIL import Image, ImageDraw, ImageFont

OUT = r"D:\project\jieyi\src-tauri\icons"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"

TEAL_TOP = (15, 118, 110)
TEAL_BOTTOM = (8, 74, 70)
ACCENT = (251, 146, 60)


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def gradient(w, h, top, bottom):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img


def draw_mark(d, cx, cy, size, color=(255, 255, 255), width=3):
    """Scanner-frame mark: four clean L-shaped corner brackets."""
    m = size // 2
    arm = max(4, int(size * 0.36))
    w = max(2, int(width))
    for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        x = cx + dx * m
        y = cy + dy * m
        # horizontal arm (runs inward, thickness goes inward vertically)
        d.rectangle(
            [min(x, x - dx * arm), min(y, y - dy * w),
             max(x, x - dx * arm), max(y, y - dy * w)],
            fill=color,
        )
        # vertical arm
        d.rectangle(
            [min(x, x - dx * w), min(y, y - dy * arm),
             max(x, x - dx * w), max(y, y - dy * arm)],
            fill=color,
        )


# ---------------- sidebar 164x314
W, H = 164, 314
img = gradient(W, H, TEAL_TOP, TEAL_BOTTOM)
d = ImageDraw.Draw(img)
# soft band
for y in range(H):
    d.line([(0, y), (W, y)], fill=img.getpixel((0, y)))
d.rectangle([0, 0, W, 74], fill=(255, 255, 255))
draw_mark(d, 26, 30, 26, color=TEAL_TOP, width=3)
d.ellipse([96, 16, 106, 26], fill=ACCENT)
d.text((46, 12), "截译", font=font(FONT_BOLD, 24), fill=(10, 62, 58))
d.text((47, 44), "JieYi · 截图即译", font=font(FONT_REG, 10), fill=(96, 128, 126))

lines = ["截图即译", "Ctrl + Alt + S", "公式 · 表格 · 代码", "一键复制"]
y = 104
for i, line in enumerate(lines):
    f = font(FONT_BOLD, 15) if i == 0 else font(FONT_REG, 11)
    color = (255, 255, 255) if i < 2 else (198, 230, 226)
    d.text((16, y), line, font=f, fill=color)
    y += 30 if i == 0 else 22

d.text((16, H - 26), "v0.1.0", font=font(FONT_REG, 10), fill=(170, 205, 201))
img.convert("RGB").save(f"{OUT}\\sidebar.bmp", "BMP")

# ---------------- header 150x57
HW, HH = 150, 57
himg = Image.new("RGB", (HW, HH), (255, 255, 255))
hd = ImageDraw.Draw(himg)
draw_mark(hd, 26, 28, 30, color=TEAL_TOP, width=3)
hd.text((48, 10), "截译", font=font(FONT_BOLD, 18), fill=(10, 62, 58))
hd.text((48, 34), "截图即译", font=font(FONT_REG, 10), fill=(110, 140, 138))
hd.line([(0, HH - 3), (HW, HH - 3)], fill=TEAL_TOP, width=3)
himg.save(f"{OUT}\\header.bmp", "BMP")

print("written sidebar.bmp / header.bmp")

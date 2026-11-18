"""Generate the app / tray icons (teal scan-frame mark)."""
from PIL import Image, ImageDraw

OUT = r"D:\project\jieyi\src-tauri\icons"
S = 1024


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # base: teal rounded square with a subtle vertical gradient
    top = (20, 184, 166)
    bottom = (13, 116, 110)
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        gd.line([(0, y), (S, y)], fill=c + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.24), fill=255)
    img.paste(grad, (0, 0), mask)

    # scan brackets
    m = int(S * 0.20)          # margin
    arm = int(S * 0.17)        # bracket arm length
    w = int(S * 0.052)         # stroke
    white = (255, 255, 255, 240)
    d.rounded_rectangle([m, m, m + int(S * 0.30), m + int(S * 0.30)], radius=int(S * 0.06), outline=None)
    # clear the corners we do not want, then draw L-shaped brackets
    img2 = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d2 = ImageDraw.Draw(img2)
    for cx, cy, dx, dy in [
        (m, m, 1, 1),
        (S - m, m, -1, 1),
        (m, S - m, 1, -1),
        (S - m, S - m, -1, -1),
    ]:
        hx = sorted([cx, cx + dx * arm])
        vy = sorted([cy, cy + dy * arm])
        d2.rounded_rectangle([hx[0], vy[0], hx[1], cy + (w if dy > 0 else 0)], radius=w // 2, fill=white)
        d2.rounded_rectangle([min(cx, cx + dx * w), min(cy, cy + dy * arm), max(cx, cx + dx * w), max(cy, cy + dy * arm)], radius=w // 2, fill=white)
    img.alpha_composite(img2)

    # text baseline (three lines) = what the app translates
    line_c = (255, 255, 255, 225)
    lx0, lx1 = int(S * 0.34), int(S * 0.66)
    for i, yy in enumerate((0.40, 0.50, 0.60)):
        x1 = lx1 if i < 2 else int(S * 0.55)
        d.rounded_rectangle([lx0, int(S * yy), x1, int(S * yy) + int(S * 0.032)], radius=int(S * 0.016), fill=line_c)

    # accent dot
    r = int(S * 0.055)
    cx, cy = int(S * 0.74), int(S * 0.28)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(251, 146, 60, 255))

    return img.resize((size, size), Image.LANCZOS)


for s, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png"), (512, "icon.png"), (256, "Square150x150Logo.png")]:
    make(s).save(f"{OUT}\\{name}")

icon = make(256).convert("RGBA")
icon.save(f"{OUT}\\icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icons written to", OUT)

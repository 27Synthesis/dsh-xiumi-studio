# -*- coding: utf-8 -*-
"""秀米工作台 应用图标生成器（可重复执行）。"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'desktop', 'build')
os.makedirs(OUT_DIR, exist_ok=True)

INK = (34, 40, 47, 255)        # 墨：#22282F
RED_TOP = (155, 50, 39, 255)   # 朱砂（上）
RED_BOT = (116, 32, 26, 255)   # 朱砂（下）
CREAM = (250, 246, 238, 255)
GOLD = (201, 162, 39, 255)

FONTS = [
    r'C:\Windows\Fonts\STZHONGS.TTF',
    r'C:\Windows\Fonts\simhei.ttf',
    r'C:\Windows\Fonts\msyhbd.ttc',
]

def font_for(px):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, px)
            except Exception:
                continue
    return ImageFont.load_default()

def draw_icon(size, style='red'):
    """在 4x 画布上画，再缩回 size，保证圆角与笔画边缘平滑。"""
    S = size * 4
    big = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    r = int(S * 0.235)          # 圆角半径：跟界面左上角那枚「米」方章一致

    if style == 'red':
        # 竖向渐变底
        grad = Image.new('RGBA', (1, S))
        for y in range(S):
            t = y / max(1, S - 1)
            c = tuple(int(RED_TOP[i] * (1 - t) + RED_BOT[i] * t) for i in range(3)) + (255,)
            grad.putpixel((0, y), c)
        grad = grad.resize((S, S), Image.BILINEAR)
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
        big.paste(grad, (0, 0), mask)
        # 顶部一道很轻的高光，让方块有一点纸的厚度
        hl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(hl).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(255, 255, 255, 18))
        big = Image.alpha_composite(big, hl)
        glyph_color = CREAM
        frame = (GOLD[0], GOLD[1], GOLD[2], 70)
    else:
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
        big.paste(Image.new('RGBA', (S, S), INK), (0, 0), mask)
        glyph_color = CREAM
        frame = (250, 246, 238, 60)

    # 注意：alpha_composite 会返回新图，ImageDraw 必须在那之后再取一次，
    # 否则字会画到被丢掉的那张上（第一版就这么白画了）。
    d = ImageDraw.Draw(big)

    # 内描边（细金线）：小尺寸下会糊，所以 < 32px 不画
    if size >= 32:
        inset = int(S * 0.085)
        w = max(2, int(S * 0.006))
        d.rounded_rectangle([inset, inset, S - 1 - inset, S - 1 - inset],
                            radius=max(4, r - inset // 2), outline=frame, width=w)

    # 「米」字：视觉重心略上移一点点，看起来才居中
    f = font_for(int(S * 0.58))
    bbox = d.textbbox((0, 0), '米', font=f)
    gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (S - gw) / 2 - bbox[0]
    y = (S - gh) / 2 - bbox[1] - int(S * 0.012)
    d.text((x, y), '米', font=f, fill=glyph_color)

    return big.resize((size, size), Image.LANCZOS)

sizes = [256, 128, 64, 48, 40, 32, 24, 16]
master = draw_icon(1024)
frames = [draw_icon(s) for s in sizes]
ico_path = os.path.join(OUT_DIR, 'icon.ico')
master.save(ico_path, format='ICO', sizes=[(s, s) for s in sizes])
master.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT_DIR, 'icon.png'))
master.save(os.path.join(OUT_DIR, 'icon-1024.png'))
print('ICO', ico_path, os.path.getsize(ico_path), 'bytes')

# 预览表：白底 + 深底各一排，方便看小尺寸是否还认得出来
def sheet():
    pad, gap = 24, 18
    cell = 256
    W = pad * 2 + len(sizes) * (cell + gap)
    H = pad * 2 + 2 * (cell + 28) + gap
    img = Image.new('RGBA', (W, H), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, H // 2, W, H], fill=(28, 32, 38, 255))
    f = font_for(20)
    for row in range(2):
        for i, (s, fr) in enumerate(zip(sizes, frames)):
            # 小尺寸放大到 cell 展示时用 NEAREST，看得出像素感
            if s < 64:
                shown = fr.resize((cell, cell), Image.NEAREST)
            else:
                shown = fr.resize((cell, cell), Image.LANCZOS)
            x = pad + i * (cell + gap)
            y = pad + row * (cell + 28) + row * gap
            img.alpha_composite(shown, (x, y))
            txt = str(s) + 'px'
            d.text((x + 4, y + cell + 4), txt, font=f, fill=(60, 60, 60, 255) if row == 0 else (230, 230, 230, 255))
    img.convert('RGB').save(os.path.join(OUT_DIR, 'icon-sheet.png'))
    print('SHEET ok')

sheet()

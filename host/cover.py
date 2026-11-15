# -*- coding: utf-8 -*-
"""封面 / 次图生成：渐变底 + 几何装饰 + 中文标题排版。仅依赖 Pillow。"""
import sys, json, os, io
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES_BOLD = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyhbd.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\SourceHanSansSC-Bold.otf",
    r"C:\Windows\Fonts\arialbd.ttf",
]
FONT_CANDIDATES_SERIF = [
    r"C:\Windows\Fonts\STZHONGS.TTF",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\STSONG.TTF",
]
FONT_CANDIDATES_REG = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyh.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
]

def pick(cands):
    for p in cands:
        if os.path.exists(p):
            return p
    return None

def hex2rgb(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def mix(a, b, r):
    return tuple(int(a[i]*r + b[i]*(1-r)) for i in range(3))

def gradient(size, c1, c2, diagonal=True):
    w, h = size
    base = Image.new('RGB', size, c1)
    d = ImageDraw.Draw(base)
    steps = w + h if diagonal else h
    for i in range(steps):
        t = i / max(1, steps - 1)
        col = mix(c1, c2, t)
        if diagonal:
            d.line([(i, 0), (0, i)], fill=col, width=1)
            d.line([(min(i, w), max(0, i - w)), (max(0, i - h) + h, min(h, i))], fill=col, width=1)
        else:
            d.line([(0, i), (w, i)], fill=col, width=1)
    return base

def wrap(draw, text, font, max_w, max_lines=3):
    lines, cur = [], ''
    for ch in text:
        if ch == '\n':
            lines.append(cur); cur = ''
            continue
        test = cur + ch
        if draw.textlength(test, font=font) <= max_w or not cur:
            cur = test
        else:
            lines.append(cur); cur = ch
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while lines[-1] and draw.textlength(lines[-1] + '…', font=font) > max_w:
            lines[-1] = lines[-1][:-1]
        lines[-1] = lines[-1] + '…'
    return lines

def build(spec):
    W, H = 900, 383
    c1, c2 = hex2rgb(spec['bg1']), hex2rgb(spec['bg2'])
    ink, sub, accent = hex2rgb(spec['ink']), hex2rgb(spec['sub']), hex2rgb(spec.get('accent', spec['ink']))
    img = gradient((W, H), c1, c2)
    d = ImageDraw.Draw(img, 'RGBA')

    # 几何装饰：右上大圆、右下细弧、左下小圆
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.ellipse([W-250, -180, W+120, 190], fill=(255, 255, 255, 16))
    ld.ellipse([W-170, -100, W+40, 110], outline=(255, 255, 255, 40), width=1)
    ld.ellipse([-60, H-70, 80, H+70], fill=(255, 255, 255, 10))
    for i in range(6):
        x = W - 300 + i * 46
        ld.line([(x, H-1), (x+30, H-1)], fill=(255, 255, 255, 60), width=2)
    img = Image.alpha_composite(img.convert('RGBA'), layer).convert('RGB')
    d = ImageDraw.Draw(img, 'RGBA')

    # 细边框
    d.rectangle([22, 22, W-22, H-22], outline=(255, 255, 255, 46), width=1)

    fb = pick(FONT_CANDIDATES_BOLD)
    fs = pick(FONT_CANDIDATES_SERIF) or fb
    fr = pick(FONT_CANDIDATES_REG) or fb

    kicker = spec.get('kicker') or ''
    date = spec.get('date') or ''
    title = spec.get('title') or ''
    subtitle = spec.get('subtitle') or ''

    x = 64
    y = 56
    if kicker:
        f = ImageFont.truetype(fr, 16)
        kx = x
        for ch in kicker:
            d.text((kx, y), ch, font=f, fill=mix(ink, c2, 0.72))
            kx += d.textlength(ch, font=f) + 5
        y += 34

    size = 50
    f_title = ImageFont.truetype(fs, size)
    lines = wrap(d, title, f_title, W - 150, 2)
    while len(lines) > 2 and size > 34:
        size -= 4
        f_title = ImageFont.truetype(fs, size)
        lines = wrap(d, title, f_title, W - 150, 2)
    ty = y
    for ln in lines:
        d.text((x, ty), ln, font=f_title, fill=ink)
        ty += int(size * 1.32)

    ty += 10
    d.line([(x, ty), (x + 42, ty)], fill=accent, width=3)
    ty += 22

    if subtitle:
        f_sub = ImageFont.truetype(fr, 18)
        subs = wrap(d, subtitle, f_sub, W - 170, 2)
        for ln in subs:
            d.text((x, ty), ln, font=f_sub, fill=sub)
            ty += 30

    if date:
        f_d = ImageFont.truetype(fr, 14)
        d.text((x, H - 62), date, font=f_d, fill=mix(sub, c2, 0.9))

    out = spec['out']
    img.save(out, 'PNG', optimize=True)

    # 正方形次图（朋友圈 / 分享卡）
    S = 500
    sq = gradient((S, S), c1, c2)
    sd = ImageDraw.Draw(sq, 'RGBA')
    sq_layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sl = ImageDraw.Draw(sq_layer)
    sl.ellipse([S-160, -120, S+90, 130], fill=(255, 255, 255, 18))
    sl.ellipse([-70, S-90, 90, S+70], fill=(255, 255, 255, 10))
    sq = Image.alpha_composite(sq.convert('RGBA'), sq_layer).convert('RGB')
    sd = ImageDraw.Draw(sq, 'RGBA')
    sd.rectangle([18, 18, S-18, S-18], outline=(255, 255, 255, 46), width=1)
    if kicker:
        f = ImageFont.truetype(fr, 13)
        sd.text((40, 44), kicker, font=f, fill=mix(ink, c2, 0.7))
    f_sq = ImageFont.truetype(fs, 40)
    sq_lines = wrap(sd, title, f_sq, S - 80, 3)
    total = len(sq_lines) * 52
    yy = (S - total) // 2 - 10
    for ln in sq_lines:
        sd.text((40, yy), ln, font=f_sq, fill=ink)
        yy += 52
    sd.line([(40, yy + 8), (40 + 36, yy + 8)], fill=accent, width=3)
    sq.save(spec['out_square'], 'PNG', optimize=True)
    return {'cover': spec['out'], 'square': spec['out_square']}

if __name__ == '__main__':
    spec_path = sys.argv[1]
    with io.open(spec_path, 'r', encoding='utf-8') as f:
        spec = json.load(f)
    print(json.dumps(build(spec), ensure_ascii=False))

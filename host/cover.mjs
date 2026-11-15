/**
 * 封面生成：900×383 公众号首图 + 500×500 分享方图（Pillow 渲染，编辑部通稿风）。
 *
 * 渲染器源码内嵌在本文件里，运行时按内容 hash 落到系统临时目录再执行：封面逻辑
 * 跟着 cover.mjs 一起走，不会因为少装一个 .py 就静默没有封面。配色仍然只来自
 * themes.mjs（bg1/bg2/ink/sub 取 theme.cover，金色取 theme.gold），本文件不写死色值。
 *
 * 找不到带 Pillow 的 Python 时明确失败，不静默降级成"没有封面"——公众号没有封面
 * 发不出去，静默降级只会让人到发布那一步才发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getTheme } from './themes.mjs';

const CANDIDATES = [
  process.env.XIUMI_PYTHON,
  path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
  'python3',
  'python',
].filter(Boolean);

let cachedPython = null;

function tryRun(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export async function findPython() {
  if (cachedPython) return cachedPython;
  for (const bin of CANDIDATES) {
    if (bin.includes(path.sep) && !fs.existsSync(bin)) continue;
    const out = await tryRun(bin, ['-c', 'import PIL,sys;print(sys.version_info[0])'], 15000);
    if (!out.error && out.stdout.trim().startsWith('3')) {
      cachedPython = bin;
      return bin;
    }
  }
  return null;
}

const RENDERER = String.raw`# -*- coding: utf-8 -*-
"""dsh-xiumi 封面渲染（编辑部 / 正式通稿风）：公众号首图 900x383 与分享方图 500x500。
只依赖 Pillow。语言：裁切角标、细分隔线、宋/黑大标题、主题色小标签、方印、纸纹颗粒。
标题自动缩号 + 标点感知的均衡断行 + 硬约束不溢出画布。"""
import sys, json, io, os, re
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FDIR = r"C:\Windows\Fonts"
FONTS = {
    'serif':  ['STZHONGS.TTF', 'STSONG.TTF', 'simsunb.ttf', 'simsun.ttc', 'msyhbd.ttc'],
    'sans_b': ['msyhbd.ttc', 'Dengb.ttf', 'simhei.ttf', 'STXIHEI.TTF'],
    'sans':   ['msyh.ttc', 'Deng.ttf', 'simhei.ttf'],
    'kai':    ['STKAITI.TTF', 'STFANGSO.TTF', 'msyh.ttc'],
}
_FC = {}

def fnt(kind, size):
    key = (kind, int(size))
    if key in _FC:
        return _FC[key]
    for name in FONTS.get(kind, FONTS['sans']):
        p = os.path.join(FDIR, name)
        if os.path.exists(p):
            try:
                f = ImageFont.truetype(p, int(size))
                _FC[key] = f
                return f
            except Exception:
                continue
    f = ImageFont.load_default(int(size))
    _FC[key] = f
    return f

def hx(s):
    s = str(s or '').strip().lstrip('#')
    if len(s) == 3:
        s = ''.join(c * 2 for c in s)
    if len(s) != 6:
        return (40, 40, 40)
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (40, 40, 40)

def blend(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def A(c, a):
    return (c[0], c[1], c[2], int(max(0, min(255, a))))

def lum(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

ASCII_RUN = re.compile(r"[A-Za-z0-9][A-Za-z0-9.%:+#/@_'\-]*")
BREAK_STOP = set('，。、；：！？）》」』】”’…—·,.!?:;)]%')
NO_START = set('，。、；：！？）》」』】”’…·,.;:!?)]%')
CONNECT = set('的了着过是在还又再就都也才而但并与其之以于向从对把被让使给和及或所各每该此')
NO_END = set('（《「『【“‘([')

LEX = set(w for w in '''
学校 学院 大学 学生 学期 学年 学术 学科 学位 教师 教学 教育 教材 教务 校历
工作 会议 通知 方案 意见 规定 办法 制度 文件 报告 总结 计划 安排 部署 落实 推进
建设 发展 改革 管理 服务 保障 组织 队伍 培训 专题 活动 文化 精神 思想 理论 研究
课题 项目 校园 班级 年级 社团 志愿 实践 创新 创业 就业 招生 毕业 迎新 军训 表彰
评选 奖励 处分 安全 稳定 卫生 健康 心理 体育 文艺 晚会 讲座 论坛 研讨 交流 合作
国际 社会 人民 国家 地方 历史 文献 档案 数字 人文 中心 实验 代表 纪念 庆祝 举办
开展 召开 参加 出席 主持 讲话 致辞 宣传 新闻 媒体 网站 平台 系统 数据 信息 网络
技术 设备 工程 质量 水平 能力 素质 人才 培养 学风 班风 党建 团建 支部 党员 干部
群众 师生 校友 校庆 开学 假期 值班 防控 应急 演练 检查 督导 考核 评审 申报 立项
'''.split() if len(w) == 2)

def atomize(text):
    out, i, n = [], 0, len(text)
    while i < n:
        m = ASCII_RUN.match(text, i)
        if m:
            out.append(m.group(0))
            i = m.end()
        else:
            out.append(text[i])
            i += 1
    return out

def w_atoms(d, atoms, font, tracking):
    if not atoms:
        return 0.0
    return sum(d.textlength(a, font=font) for a in atoms) + tracking * (len(atoms) - 1)

BOUNDS = []

def draw_atoms(d, xy, atoms, font, fill, tracking, anchor='ls'):
    x, y = xy
    for a in atoms:
        d.text((x, y), a, font=font, fill=fill, anchor=anchor)
        wv = d.textlength(a, font=font)
        try:
            bx = font.getbbox(a, anchor=anchor)
            BOUNDS.append((x + bx[0], y + bx[1], x + bx[2], y + bx[3]))
        except Exception:
            BOUNDS.append((x, y - font.size, x + wv, y))
        x += wv + tracking
    return x - tracking

def visual_len(atoms):
    n = 0.0
    for a in atoms:
        if len(a) == 1 and ord(a) > 127:
            n += 1.0
        else:
            n += max(0.55, len(a) * 0.55)
    return n

def break_by_width(d, text, font, tracking, max_w):
    lines = []
    for para in str(text).split('\n'):
        atoms = atomize(para)
        if not atoms:
            continue
        start = 0
        while start < len(atoms):
            end = start
            last_break = None
            while end < len(atoms) and w_atoms(d, atoms[start:end + 1], font, tracking) <= max_w:
                if atoms[end] in BREAK_STOP or atoms[end] == ' ':
                    last_break = end + 1
                end += 1
            if end == start:
                end = start + 1
            elif last_break and end < len(atoms) and last_break - start >= max(2, int((end - start) * 0.55)):
                end = last_break
            elif end < len(atoms):
                floor_i = start + max(2, int((end - start) * 0.62))
                for p in range(end, floor_i - 1, -1):
                    if p >= len(atoms):
                        continue
                    if atoms[p - 1] + atoms[p] in LEX:
                        continue
                    if atoms[p] in NO_START or atoms[p] in CONNECT or atoms[p - 1] in NO_END:
                        continue
                    end = p
                    break
            seg = atoms[start:end]
            while seg and seg[0] == ' ':
                seg = seg[1:]
            while seg and seg[-1] == ' ':
                seg = seg[:-1]
            if seg:
                lines.append(seg)
            start = end
            if len(lines) > 16:
                return lines
    return lines

def split_n(d, atoms, font, tracking, max_w, n):
    """把 atoms 均衡切成 n 行（最小化最长行宽，标点感知）。不可行返回 None。"""
    m = len(atoms)
    if n <= 1 or m <= 1:
        return [list(atoms)] if m else []
    pre = [0.0] * (m + 1)
    for i, a in enumerate(atoms):
        pre[i + 1] = pre[i] + d.textlength(a, font=font)

    def line_w(i, j):
        return pre[j] - pre[i] + tracking * (j - i - 1)

    def can_break(j):
        if j <= 0 or j >= m:
            return True
        return atoms[j] not in NO_START and atoms[j] not in CONNECT and atoms[j - 1] not in NO_END

    INF = float('inf')
    dp = [[INF] * (n + 1) for _ in range(m + 1)]
    cut = [[0] * (n + 1) for _ in range(m + 1)]
    dp[m][0] = 0.0
    for i in range(m - 1, -1, -1):
        for k in range(1, n + 1):
            best, bj = INF, 0
            for j in range(i + 1, m + 1):
                if j < m and not can_break(j):
                    continue
                wv = line_w(i, j)
                if wv > max_w:
                    break
                rest = dp[j][k - 1]
                if rest == INF:
                    continue
                v = max(wv, rest)
                if v < best - 0.5:
                    best, bj = v, j
            dp[i][k] = best
            cut[i][k] = bj
    if dp[0][n] == INF:
        return None
    w_star = dp[0][n]
    cap = min(max_w, w_star + max(6.0, w_star * 0.07))
    target = line_w(0, m) / n
    NONE = None
    d2 = [[NONE] * (n + 1) for _ in range(m + 1)]
    c2 = [[0] * (n + 1) for _ in range(m + 1)]
    d2[m][0] = (0, 0.0)
    for i in range(m - 1, -1, -1):
        for k in range(1, n + 1):
            best = NONE
            bj = 0
            for j in range(i + 1, m + 1):
                if j < m and not can_break(j):
                    continue
                wv = line_w(i, j)
                if wv > cap:
                    break
                rest = d2[j][k - 1]
                if rest is NONE:
                    continue
                cutpen = 1 if (j < m and atoms[j - 1] + atoms[j] in LEX) else 0
                cand = (rest[0] + cutpen, rest[1] + (wv - target) ** 2)
                if best is NONE or cand < best:
                    best = cand
                    bj = j
            d2[i][k] = best
            c2[i][k] = bj
    pick = c2 if d2[0][n] is not NONE else cut
    out, i, k = [], 0, n
    while k > 0:
        j = pick[i][k]
        if j <= i:
            return None
        seg = list(atoms[i:j])
        while seg and seg[0] == ' ':
            seg = seg[1:]
        while seg and seg[-1] == ' ':
            seg = seg[:-1]
        if seg:
            out.append(seg)
        i, k = j, k - 1
    return out

def ellipsize(d, atoms, font, tracking, max_w):
    out = list(atoms)
    while out and w_atoms(d, out + ['…'], font, tracking) > max_w:
        out.pop()
    while out and out[-1] in BREAK_STOP:
        out.pop()
    return out + ['…']

def clip_lines(d, lines, font, tracking, max_w):
    return [ln if w_atoms(d, ln, font, tracking) <= max_w else ellipsize(d, ln, font, tracking, max_w) for ln in lines]

def deorphan(d, lines, font, tracking, max_w):
    if len(lines) >= 2 and len(lines[-1]) <= 1 and len(lines[-2]) >= 3:
        moved = lines[-2].pop()
        lines[-1].insert(0, moved)
        if w_atoms(d, lines[-1], font, tracking) > max_w:
            lines[-1].pop(0)
            lines[-2].append(moved)
    return lines

# ---------------- 背景 ----------------
def gradient_h(size, c1, c2, power=0.85):
    w, h = size
    img = Image.new('RGB', size, c1)
    d = ImageDraw.Draw(img)
    for x in range(w):
        d.line([(x, 0), (x, h)], fill=blend(c1, c2, (x / max(1, w - 1)) ** power))
    return img

def radial_mask(size, center, radius, strength, power=1.7):
    w, h = size
    m = Image.new('L', size, 0)
    d = ImageDraw.Draw(m)
    r = max(4.0, float(radius))
    steps = max(28, min(110, int(r / 3)))
    cx, cy = center
    for i in range(steps, 0, -1):
        t = i / steps
        a = int(strength * ((1.0 - t) ** power))
        if a <= 0:
            continue
        rad = r * t
        d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=a)
    return m.filter(ImageFilter.GaussianBlur(max(2, int(r / 40))))

def h_gradient_alpha(size, a_left, a_right, power=1.0):
    w, h = size
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    for x in range(w):
        v = a_left + (a_right - a_left) * ((x / max(1, w - 1)) ** power)
        d.line([(x, 0), (x, h)], fill=int(max(0, min(255, v))))
    return m

def tint(size, color, mask):
    layer = Image.new('RGBA', size, A(color, 255))
    layer.putalpha(mask)
    return layer

def grain_layer(size, strength):
    n = Image.effect_noise(size, 30).convert('L')
    light = n.point(lambda v: int(max(0, v - 128) * strength / 128))
    dark = n.point(lambda v: int(max(0, 128 - v) * strength / 128))
    out = Image.new('RGBA', size, A((255, 255, 255), 255))
    out.putalpha(light)
    dk = Image.new('RGBA', size, A((0, 0, 0), 255))
    dk.putalpha(dark)
    return Image.alpha_composite(out, dk)

def palette(spec):
    bg1, bg2 = hx(spec.get('bg1')), hx(spec.get('bg2'))
    # 配色全部由 JS 侧从 themes.mjs 取好传进来，这里不做任何兜底（兜底会静默过期）
    ink = hx(spec['ink'])
    sub = hx(spec['sub'])
    gold = hx(spec['gold'])
    accent = hx(spec['accent'])
    mid = blend(bg1, bg2, 0.5)
    light_bg = lum(mid) > 150
    if abs(lum(gold) - lum(mid)) < 46:
        gold = blend(ink, gold, 0.55)
    return dict(bg1=bg1, bg2=bg2, ink=ink, sub=sub, gold=gold, accent=accent, mid=mid,
                light_bg=light_bg, deep=blend(bg1, (0, 0, 0), 0.5))

STYLE = {
    'zhusha':  dict(kicker='chip',  title_font='serif',  track=0.045, motif='rings',
                    marks='crop', scrim=112, glow=1.0, grain=12, rule_w=48, cap=68, floor=26, max_lines=3, seal=True),
    'qingci':  dict(kicker='bracket',  title_font='serif',  track=0.05,  motif='shards',
                    marks='crop', scrim=98,  glow=1.05, grain=11, rule_w=44, cap=68, floor=26, max_lines=3, seal=True),
    'molan':   dict(kicker='bar',   title_font='sans_b', track=0.02,  motif='grid',
                    marks='crop', scrim=98,  glow=0.9,  grain=10, rule_w=52, cap=64, floor=24, max_lines=3, seal=True),
    'yingfen': dict(kicker='pill',  title_font='serif',  track=0.05,  motif='petals',
                    marks='frame', scrim=138, glow=1.1, grain=11, rule_w=44, cap=68, floor=26, max_lines=3, seal=True),
    'subai':   dict(kicker='plain', title_font='sans_b', track=0.03,  motif='rule',
                    marks='crop', scrim=26,  glow=0.5,  grain=7,  rule_w=40, cap=64, floor=24, max_lines=3, seal=True),
}

def style_for(theme_id):
    return dict(STYLE.get(str(theme_id or ''), STYLE['zhusha']))

def make_bg(size, pal, st):
    w, h = size
    base = gradient_h(size, blend(pal['bg1'], (0, 0, 0), 0.16), pal['bg2'], 0.9)
    top_mask = Image.linear_gradient('L').resize((w, h), Image.BICUBIC).point(lambda v: int(64 * (1 - v / 255.0)))
    img = Image.composite(Image.new('RGB', size, blend(pal['bg1'], (0, 0, 0), 0.32)), base, top_mask).convert('RGBA')
    glow = radial_mask(size, (w * 0.92, h * 0.02), max(w, h) * 0.62, 44 * st['glow'], 1.9)
    img = Image.alpha_composite(img, tint(size, blend(pal['bg2'], (255, 255, 255), 0.62), glow))
    scrim = h_gradient_alpha(size, st['scrim'], 0, 1.6)
    img = Image.alpha_composite(img, tint(size, blend(pal['bg1'], (0, 0, 0), 0.46), scrim))
    vig = radial_mask(size, (w * 0.5, h * 0.46), max(w, h) * 0.80, 52, 2.6)
    img = Image.alpha_composite(img, tint(size, (0, 0, 0), vig))
    return Image.alpha_composite(img, grain_layer(size, st['grain'])).convert('RGB')

# ---------------- 装饰 ----------------
def draw_marks(d, size, pal, st, inset=20, arm=26):
    w, h = size
    col = A(pal['ink'], 78)
    if st['marks'] == 'crop':
        for x, y, sx, sy in [(inset, inset, 1, 1), (w - inset, inset, -1, 1), (inset, h - inset, 1, -1), (w - inset, h - inset, -1, -1)]:
            d.line([(x, y), (x + sx * arm, y)], fill=col, width=1)
            d.line([(x, y), (x, y + sy * arm)], fill=col, width=1)
    elif st['marks'] == 'frame':
        d.rounded_rectangle([inset, inset, w - inset, h - inset], radius=12, outline=A(pal['ink'], 92), width=1)

def draw_motif(d, size, pal, st):
    w, h = size
    m, gold, ink = st['motif'], pal['gold'], pal['ink']
    if m == 'rings':
        d.ellipse([w - 150, -80, w + 120, 190], fill=A(ink, 20), outline=A(ink, 40), width=2)
        cx, cy, r = w - 132, 152, 72
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=A(gold, 165), width=1)
        d.ellipse([cx - r + 19, cy - r + 19, cx + r - 19, cy + r - 19], outline=A(ink, 58), width=1)
        d.polygon([(cx, cy - 10), (cx + 10, cy), (cx, cy + 10), (cx - 10, cy)], fill=A(gold, 235))

    elif m == 'shards':
        d.line([(w - 152, 46), (w - 152, 214)], fill=A(gold, 155), width=1)
        d.line([(w - 141, 46), (w - 141, 214)], fill=A(ink, 28), width=1)
        d.line([(w - 152, 214), (w - 62, 214)], fill=A(ink, 42), width=1)
        for i, y in enumerate([74, 118, 162]):
            d.line([(w - 186, y), (w - 158, y)], fill=A(ink, 48 - i * 6), width=1)
    elif m == 'grid':
        for i in range(3):
            for j in range(3):
                x, y = w - 202 + i * 24, 56 + j * 24
                d.ellipse([x - 1.8, y - 1.8, x + 1.8, y + 1.8], fill=A(ink, 74))
        d.rectangle([w - 208, 146, w - 124, 224], outline=A(ink, 62), width=1)
        d.rectangle([w - 208, 146, w - 176, 152], fill=A(gold, 240))
    elif m == 'petals':
        d.ellipse([w - 238, 18, w - 58, 198], fill=A(ink, 26))
        d.ellipse([w - 214, 118, w - 150, 182], fill=A(ink, 18))
        cx, cy = w - 150, 112
        d.ellipse([cx - 46, cy - 46, cx + 46, cy + 46], outline=A(gold, 172), width=1)
        d.ellipse([cx - 62, cy - 62, cx + 62, cy + 62], outline=A(ink, 30), width=1)
    elif m == 'rule':
        d.rectangle([w - 208, 44, w - 100, 152], outline=A(ink, 34), width=1)
        d.rectangle([w - 198, 54, w - 110, 142], outline=A(ink, 16), width=1)
        d.rectangle([w - 212, 40, w - 203, 49], fill=A(ink, 215))

def draw_motif_square(d, size, pal, st):
    w, h = size
    m, gold, ink = st['motif'], pal['gold'], pal['ink']
    if m == 'rings':
        d.ellipse([w - 104, 16, w + 46, 166], fill=A(ink, 18))
        cx, cy, r = w - 58, 74, 30
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=A(gold, 168), width=1)
        d.polygon([(cx, cy - 6), (cx + 6, cy), (cx, cy + 6), (cx - 6, cy)], fill=A(gold, 232))
    elif m == 'shards':
        d.line([(w - 96, 34), (w - 96, 112)], fill=A(gold, 155), width=1)
        d.line([(w - 88, 34), (w - 88, 112)], fill=A(ink, 28), width=1)
        d.line([(w - 96, 112), (w - 42, 112)], fill=A(ink, 40), width=1)
        for i, y in enumerate([52, 74, 96]):
            d.line([(w - 116, y), (w - 100, y)], fill=A(ink, 44 - i * 6), width=1)
    elif m == 'grid':
        for i in range(3):
            for j in range(3):
                x, y = w - 106 + i * 18, 32 + j * 18
                d.ellipse([x - 1.5, y - 1.5, x + 1.5, y + 1.5], fill=A(ink, 74))
        d.rectangle([w - 114, 60, w - 58, 114], outline=A(ink, 54), width=1)
        d.rectangle([w - 114, 60, w - 92, 65], fill=A(gold, 236))
    elif m == 'petals':
        d.ellipse([w - 156, 4, w - 20, 140], fill=A(ink, 24))
        cx, cy = w - 58, 70
        d.ellipse([cx - 32, cy - 32, cx + 32, cy + 32], outline=A(gold, 170), width=1)
        d.ellipse([cx - 44, cy - 44, cx + 44, cy + 44], outline=A(ink, 26), width=1)
    else:
        d.rectangle([w - 118, 30, w - 56, 92], outline=A(ink, 34), width=1)
        d.rectangle([w - 110, 38, w - 64, 84], outline=A(ink, 16), width=1)
        d.line([(w - 87, 30), (w - 87, 112)], fill=A(ink, 44), width=1)
        d.rectangle([w - 91, 26, w - 83, 34], fill=A(ink, 210))
        d.line([(w - 87, 112), (w - 40, 112)], fill=A(ink, 26), width=1)

def kicker_h(st, kf):
    return kf.size + 15 if st['kicker'] in ('chip', 'pill') else kf.size + 8

def draw_kicker(d, xy, text, kf, pal, st):
    x, y = xy
    kind, ink, gold = st['kicker'], pal['ink'], pal['gold']
    atoms = atomize(text)
    tr = 3
    tw = w_atoms(d, atoms, kf, tr)
    h = kicker_h(st, kf)
    cy = y + h / 2
    if kind == 'chip':
        d.rounded_rectangle([x, y, x + tw + 26, y + h], radius=3, fill=A(ink, 40), outline=A(ink, 92), width=1)
        draw_atoms(d, (x + 13, cy), atoms, kf, A(ink, 245), tr, 'lm')
    elif kind == 'pill':
        d.rounded_rectangle([x, y, x + tw + 30, y + h], radius=h / 2, fill=A(ink, 46))
        draw_atoms(d, (x + 15, cy), atoms, kf, A(ink, 248), tr, 'lm')
    elif kind == 'bracket':
        draw_atoms(d, (x + 11, cy), atoms, kf, A(ink, 242), tr, 'lm')
        d.line([(x + 2, cy - 7), (x + 2, cy + 7)], fill=A(gold, 210), width=1)
        d.line([(x + 11 + tw + 8, cy - 7), (x + 11 + tw + 8, cy + 7)], fill=A(gold, 210), width=1)
    elif kind == 'bar':
        d.rectangle([x, y + 2, x + 4, y + h - 2], fill=A(gold, 240))
        draw_atoms(d, (x + 15, cy), atoms, kf, A(ink, 240), tr, 'lm')
    else:
        d.rectangle([x, cy - 3, x + 6, cy + 3], fill=A(gold, 215))
        draw_atoms(d, (x + 17, cy), atoms, kf, A(ink, 208), tr + 1, 'lm')

def draw_seal(d, box, chars, pal, st):
    x, y, s = box
    col = pal['gold'] if st['motif'] != 'rule' else pal['ink']
    d.rectangle([x, y, x + s, y + s], outline=A(col, 205), width=2)
    d.rectangle([x + 5, y + 5, x + s - 5, y + s - 5], outline=A(col, 74), width=1)
    chars = (chars or '')[:2]
    if not chars:
        c = s / 2
        d.rectangle([x + c - 6, y + c - 6, x + c + 6, y + c + 6], fill=A(col, 215))
        return
    f = fnt('serif', int(s * 0.34))
    if len(chars) == 1:
        d.text((x + s / 2, y + s / 2), chars, font=f, fill=A(col, 240), anchor='mm')
    else:
        step = s * 0.42
        top = y + s / 2 - step / 2
        for i, ch in enumerate(chars):
            d.text((x + s / 2, top + i * step), ch, font=f, fill=A(col, 240), anchor='mm')

# ---------------- 排版 ----------------
def cap_metrics(font):
    b = font.getbbox('国', anchor='ls')
    return b[1], b[3]  # 相对基线的上/下缘

def fit_title(d, text, kind, max_w, max_h, max_lines, cap, floor, track_ratio, prefer_min=2):
    atoms = atomize(text)
    explicit = '\n' in str(text)
    pref = 1 if (explicit or visual_len(atoms) < 7) else max(2, min(prefer_min, max_lines))
    best = None
    size = int(cap)
    while size >= floor:
        if best is not None and size <= best['score']:
            break
        font = fnt(kind, size)
        tr = max(1, int(round(size * track_ratio)))
        top, bot = cap_metrics(font)
        line_h = int(round(size * 1.34))
        for n in range(pref, max_lines + 1):
            if explicit:
                lines = break_by_width(d, text, font, tr, max_w)
                if len(lines) > max_lines:
                    continue
                lines = clip_lines(d, lines, font, tr, max_w)
            else:
                lines = split_n(d, atoms, font, tr, max_w, n)
                if lines is None:
                    continue
            block_h = (len(lines) - 1) * line_h + (bot - top)
            if block_h > max_h:
                continue
            score = size / (1.0 + 0.12 * (len(lines) - pref))
            if best is None or score > best['score'] + 1e-6:
                best = dict(size=size, font=font, track=tr, lines=lines, line_h=line_h,
                            block_h=block_h, top=top, bot=bot, score=score)
        size -= 1
    if best is not None:
        return best
    # 兜底：最小号仍放不下 → 保宽不保行
    font = fnt(kind, floor)
    tr = max(1, int(round(floor * track_ratio)))
    top, bot = cap_metrics(font)
    line_h = int(round(floor * 1.3))
    lines = break_by_width(d, text, font, tr, max_w)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    lines = clip_lines(d, lines, font, tr, max_w)
    while len(lines) > 1 and (len(lines) - 1) * line_h + (bot - top) > max_h:
        lines.pop()
        lines[-1] = ellipsize(d, lines[-1], font, tr, max_w)
    lines = clip_lines(d, lines, font, tr, max_w)
    block_h = (len(lines) - 1) * line_h + (bot - top)
    return dict(size=floor, font=font, track=tr, lines=lines, line_h=line_h, block_h=block_h, top=top, bot=bot)

def draw_title(d, x, top_visual, t, fill):
    base0 = top_visual - t['top']
    for i, ln in enumerate(t['lines']):
        draw_atoms(d, (x, base0 + i * t['line_h']), ln, t['font'], fill, t['track'], 'ls')

def build_cover(spec, out):
    W, H = 900, 383
    pal, st = palette(spec), style_for(spec.get('theme'))
    base = make_bg((W, H), pal, st)
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    draw_motif(d, (W, H), pal, st)
    draw_marks(d, (W, H), pal, st)

    ML, TOP, RIGHT, BOT = 80, 46, 668, 302
    text_w = RIGHT - ML
    kicker = (spec.get('kicker') or '').strip()
    subtitle = (spec.get('subtitle') or '').strip()
    title = (spec.get('title') or '').strip() or '未命名图文'

    kf = fnt('sans', 14)
    kh = kicker_h(st, kf) if kicker else 0
    sf = fnt('sans', 17)
    str_ = 1
    sub_lines = []
    if subtitle:
        sub_lines = break_by_width(d, subtitle, sf, str_, text_w - 2)
        if len(sub_lines) > 2:
            sub_lines = sub_lines[:2]
            sub_lines[-1] = ellipsize(d, sub_lines[-1], sf, str_, text_w - 2)
        sub_lines = clip_lines(d, sub_lines, sf, str_, text_w - 2)
    st_top, st_bot = cap_metrics(sf)
    sub_line_h = 27
    sub_h = (len(sub_lines) - 1) * sub_line_h + (st_bot - st_top) if sub_lines else 0

    gap_k = 20 if kicker else 0
    gap_r = 16
    est_gap = 22
    fixed0 = kh + gap_k + 3 + gap_r + (est_gap + sub_h if sub_lines else 0)
    t = fit_title(d, title, st['title_font'], text_w, BOT - TOP - fixed0, st['max_lines'], st['cap'], st['floor'], st['track'])
    gap_s = max(24, int(t['size'] * 0.42)) if sub_lines else 0
    fixed = kh + gap_k + 3 + gap_r + (gap_s + sub_h if sub_lines else 0)
    total = fixed + t['block_h']
    offset = int(max(0, min(26, (BOT - TOP - total) * 0.32)))

    x = ML
    y = TOP + offset
    if kicker:
        draw_kicker(d, (x, y), kicker, kf, pal, st)
        y += kh + gap_k
    d.rectangle([x, y, x + st['rule_w'], y + 3], fill=A(pal['gold'], 238))
    y += 3 + gap_r
    draw_title(d, x, y, t, A(pal['ink'], 248))
    y += t['block_h']
    if sub_lines:
        y += gap_s
        for i, ln in enumerate(sub_lines):
            draw_atoms(d, (x, y + i * sub_line_h - st_top), ln, sf, A(pal['sub'], 234), str_, 'ls')

    fy = H - 58
    d.line([(x, fy), (RIGHT, fy)], fill=A(pal['ink'], 48), width=1)
    d.rectangle([x, fy - 2, x + 8, fy + 1], fill=A(pal['gold'], 225))
    date = (spec.get('date') or '').strip()
    if date:
        df = fnt('sans', 13)
        dt, db = cap_metrics(df)
        draw_atoms(d, (x, H - 38 - dt), atomize(date), df, A(pal['sub'], 218), 1, 'ls')
    if st['seal']:
        draw_seal(d, (W - 96, fy - 64, 64), (spec.get('seal') or '').strip(), pal, st)

    img = Image.alpha_composite(base.convert('RGBA'), ov).convert('RGB')
    img.save(out, 'PNG', optimize=True)
    return dict(size=t['size'], lines=[''.join(v) for v in t['lines']], line_h=t['line_h'],
                block_h=int(t['block_h']), offset=offset, sub=[''.join(v) for v in sub_lines],
                title_bottom=int(y), bottom_limit=BOT)

def build_square(spec, out):
    S = 500
    pal, st = palette(spec), style_for(spec.get('theme'))
    base = make_bg((S, S), pal, st)
    ov = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    draw_motif_square(d, (S, S), pal, st)
    draw_marks(d, (S, S), pal, st, 18, 22)

    ML, RIGHT = 58, 444
    text_w = RIGHT - ML
    kicker = (spec.get('kicker') or '').strip()
    title = (spec.get('title') or '').strip() or '未命名图文'
    kf = fnt('sans', 13)
    kh = kicker_h(st, kf) if kicker else 0
    fixed = kh + (18 if kicker else 0) + 3 + 22
    t = fit_title(d, title, st['title_font'], text_w, 356 - 40 - fixed, 4, 54, 22, st['track'])
    total = fixed + t['block_h']
    y = max(134, int((360 - total) / 2) + 30)
    x = ML
    if kicker:
        draw_kicker(d, (x, y), kicker, kf, pal, st)
        y += kh + 18
    d.rectangle([x, y, x + st['rule_w'], y + 3], fill=A(pal['gold'], 238))
    y += 3 + 22
    draw_title(d, x, y, t, A(pal['ink'], 248))

    fy = 440
    d.line([(x, fy), (RIGHT, fy)], fill=A(pal['ink'], 48), width=1)
    d.rectangle([x, fy - 2, x + 8, fy + 1], fill=A(pal['gold'], 225))
    date = (spec.get('date') or '').strip()
    if date:
        df = fnt('sans', 13)
        dt, db = cap_metrics(df)
        draw_atoms(d, (x, fy + 20 - dt), atomize(date), df, A(pal['sub'], 218), 1, 'ls')
    if st['seal']:
        draw_seal(d, (RIGHT - 52, fy - 54, 54), (spec.get('seal') or '').strip(), pal, st)

    img = Image.alpha_composite(base.convert('RGBA'), ov).convert('RGB')
    img.save(out, 'PNG', optimize=True)

def check_bounds(size, margin=8):
    W, H = size
    bad = []
    for (x0, y0, x1, y1) in BOUNDS:
        if x0 < margin - 0.5 or x1 > W - margin + 0.5 or y0 < margin - 0.5 or y1 > H - margin + 0.5:
            bad.append([round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)])
    return bad


def normalize(spec):
    spec = dict(spec or {})
    spec['seal'] = (spec.get('seal') or '').strip() or seal_from(spec.get('kicker'))
    if not spec.get('gold'):
        spec['gold'] = spec['accent']
    return spec


def render(spec):
    spec = normalize(spec)
    del BOUNDS[:]
    L = build_cover(spec, spec['out'])
    bad_cover = check_bounds((900, 383))
    del BOUNDS[:]
    build_square(spec, spec['out_square'])
    bad_sq = check_bounds((500, 500))
    return dict(cover=spec['out'], square=spec['out_square'], layout=L, overflow={'cover': bad_cover, 'square': bad_sq})

SEAL_WORDS = ['讲座', '论坛', '研讨', '招新', '晚会', '会议', '通知', '公示', '部署', '培训', '比赛',
              '活动', '简报', '特稿', '访谈', '专题', '表彰', '方案', '总结', '预告', '回顾', '读书',
              '观影', '志愿', '迎新', '毕业', '专访', '观察', '手记', '述评', '消息', '通讯']

def seal_from(kicker):
    s = re.sub(r'[\s·—]+', '', str(kicker or ''))
    if len(s) >= 2 and s[-2:] in SEAL_WORDS:
        return s[-2:]
    return ''

if __name__ == '__main__':
    with io.open(sys.argv[1], 'r', encoding='utf-8') as fh:
        print(json.dumps(render(json.load(fh)), ensure_ascii=False))
`;

let cachedScript = null;

/** 把内嵌渲染器按内容 hash 落到临时目录，避免每次生成都重写文件。 */
function rendererFile() {
  if (cachedScript && fs.existsSync(cachedScript)) return cachedScript;
  const hash = crypto.createHash('sha256').update(RENDERER).digest('hex').slice(0, 12);
  const file = path.join(os.tmpdir(), 'dsh-xiumi-cover-' + hash + '.py');
  if (!fs.existsSync(file)) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, RENDERER, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (!fs.existsSync(file)) throw e;
    }
  }
  cachedScript = file;
  return file;
}

export async function makeCover({ project, dir, log }) {
  const python = await findPython();
  if (!python) throw new Error('找不到带 Pillow 的 Python，无法生成封面。可设置环境变量 XIUMI_PYTHON 指向 python 可执行文件。');
  const theme = getTheme(project.theme || 'zhusha');
  const cover = theme.cover || {};
  fs.mkdirSync(dir, { recursive: true });
  const specFile = path.join(dir, 'cover-spec.json');
  const spec = {
    theme: theme.id,
    // 主题没写封面配色时从主题自身的字段派生，绝不在这里另抄一套字面色
    bg1: cover.bg1 || theme.ink,
    bg2: cover.bg2 || theme.accent,
    ink: cover.ink || theme.paper,
    sub: cover.sub || theme.wash,
    gold: theme.gold || theme.accent,
    accent: theme.accent,
    kicker: project.kicker || '',
    date: project.date || '',
    title: project.title || '',
    subtitle: project.subtitle || '',
    seal: '',
    out: path.join(dir, 'cover.png'),
    out_square: path.join(dir, 'square.png'),
  };
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
  const result = await tryRun(python, [rendererFile(), specFile], 60000);
  if (result.error) {
    throw new Error('封面生成失败：' + (result.stderr || result.error.message).slice(0, 400));
  }
  if (log) log('[xiumi] 封面已生成：' + spec.out);
  return { cover: spec.out, square: spec.out_square };
}

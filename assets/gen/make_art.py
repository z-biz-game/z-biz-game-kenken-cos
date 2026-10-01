#!/usr/bin/env python3
"""聪明格（KenKen）的美术资产生成器——图标全套、社交卡、两张游戏内纹理，一条命令重画。

为什么仓里要有这份脚本，而不是「手工画好 PNG 提交」：图标是玩家第一眼看到的东西，
它必须和 canvas 里的盘是同一个游戏。手工 PNG 会在某次改色板之后悄悄变脏（token 换了、
图标还是老配色），而这份脚本每次运行都从 `js/theme.js` 现场读色板，于是「图标和游戏
不像一个东西」这件事在结构上不可能发生。`--check` 会把这条承诺变成一次退出码。

视觉母题：笼。粗线把盘切成一个个笼子、左上角写着琥珀色的目标数与运算符——这就是聪明格
区别于数独的那一件事，所以图标画的必须是**粗线笼 + 线索**，而不是一张普通网格。
小尺寸全部由 1024 母图 LANCZOS 派生，不给某一档单独再画一套（那会长出六种风格的图标）。

零外部依赖：字形只用 Pillow ≥10.1 内嵌的可缩放默认字体 `load_default(size=…)`，
不碰任何系统字体——否则同一行命令在别的机器上会画出不同的字。图里不放中文：
母题本身会说话，而 CJK 字体是这类脚本最常见的不可复现来源。

纹理的颗粒是脚本自带的 LCG，不用 `random`，所以 grain.png 的字节在谁手上都一样。

用法（在工作仓根）:
    python3 assets/gen/make_art.py           # 重画全部（幂等：字节相同就不写盘）
    python3 assets/gen/make_art.py --check   # 只校验现有 PNG 是否还等于当前色板画出来的
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import struct
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as e:  # 说清缺什么，别让人去猜
    sys.exit('需要 Pillow（生成美术资产的构建期工具；产品运行时仍然零依赖）：%s' % e)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
THEME = os.path.join(REPO, 'js', 'theme.js')

MASTER = 1024                       # App Store / manifest 的最大档，其余由它派生
SIZES = [512, 192, 180, 96, 64, 48, 32, 16]
MASKABLE = [512, 192]               # Android 自适应图标：内容缩进 80% 安全区
OG = (1200, 630)

# ---- 题面：一张 4 阶盘就是母题本体 --------------------------------------------------------
# 笼子划分与线索是编好的（和 js/engine 的出题器无关——图标要的是确定性，不是随机性）。
# 数字排成一个合法拉丁方，放大看不会出现「同一行两个 3」这种外行破绽：
#   1 2 3 4 / 3 4 1 2 / 2 1 4 3 / 4 3 2 1（每行每列都是 1..4 各一次）
CAGE_MAP = [
    [0, 0, 1, 1],
    [2, 3, 3, 1],
    [2, 3, 4, 4],
    [5, 5, 5, 4],
]
DIGITS = [
    [1, 2, 3, 4],
    [3, 4, 1, 2],
    [2, 1, 4, 3],
    [4, 3, 2, 1],
]
# 乘号用 ASCII 的 x：内嵌字体没有 U+00D7（画出来是一个方框，512 母图上实测），
# 而「不许出现读不出的字」比「和 canvas 的 OpGlyph 逐字符相同」更硬。
CAGE_LABEL = ['3+', '24x', '6x', '6+', '10+', '12x']
SELECTED = (1, 1)                              # 选中格的琥珀框：一个图标里只留一处「正在做的事」
SOLVED_CAGE = 5                                # 这一笼描一圈绿（「算对了」在盘上是 success 色）


def rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(c1, c2, t):
    return tuple(round(a + (b - a) * t) for a, b in zip(c1, c2))


def token(raw):
    """theme.js 里的一条色值 → (r, g, b, a)。两种写法都得认：十六进制，和 rgba() 串。
    只认前者的生成器会在色板加了一条半透明 token 之后当场看不见它。"""
    raw = raw.strip()
    if raw.startswith('#'):
        return rgb(raw) + (255,)
    m = re.match(r'rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)', raw)
    if not m:
        sys.exit('看不懂这条色值：%r（生成器只认十六进制与 rgba()）' % raw)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), round(float(m.group(4)) * 255))


def paint(pal, name, alpha_mul=1.0):
    r, g, b, a = token(pal[name])
    return (r, g, b, max(0, min(255, round(a * alpha_mul))))


def cage_cells(ci):
    return [(r, c) for r in range(4) for c in range(4) if CAGE_MAP[r][c] == ci]


def cage_at(r, c):
    return -1 if (r < 0 or r > 3 or c < 0 or c > 3) else CAGE_MAP[r][c]


def load_palette():
    src = open(THEME, encoding='utf-8').read()
    block = re.search(r'export const Palette = \{(.*?)\n\};', src, re.S)
    if not block:
        sys.exit('js/theme.js 里找不到 Palette —— 色板的唯一出处变了，先改这里再画图')
    pal = dict(re.findall(r"(\w+)\s*:\s*'([^']+)'", block.group(1)))
    need = ('bgTop', 'bgBottom', 'surface', 'line', 'lineHeavy', 'ink', 'accent', 'info', 'success',
            'cageTint', 'cageTintAlt')
    for k in need:
        if k not in pal:
            sys.exit('Palette 缺 %s，图没法画' % k)
        token(pal[k])          # 现在就验，别等画到一半才炸
    return pal


def font(size):
    return ImageFont.load_default(size=size)


def draw_text(d, text, size, fill, box):
    """把字居中放进 box（[x0,y0,x1,y1]）。度量走 getbbox，不猜基线。"""
    f = font(size)
    x0, y0, x1, y1 = box
    w = d.textlength(text, font=f)
    bb = f.getbbox(text)
    d.text((x0 + (x1 - x0 - w) / 2, y0 + (y1 - y0 - (bb[3] - bb[1])) / 2 - bb[1]), text, font=f, fill=fill)


def gradient(size, pal):
    """上深下浅的墨蓝底：和 css/game.css 的 linear-gradient(180deg, bg-top, bg-bottom 62%, surface) 同一条线。"""
    top, mid, bot = rgb(pal['bgTop']), rgb(pal['bgBottom']), rgb(pal['surface'])
    img = Image.new('RGBA', (size, size), top + (255,))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        c = mix(top, mid, t / 0.62) if t <= 0.62 else mix(mid, bot, (t - 0.62) / 0.38)
        row = c + (255,)
        for x in range(size):
            px[x, y] = row
    return img


def new_layer(size):
    """半透明必须走图层：PIL 的 ImageDraw 拿到 rgba 填充色时是**直接改写像素的 alpha**，
    不是合成——照着 canvas 的直觉往下画，结果就是笼底把渐变背景抹成一块半透明的糊。
    所以每一组画法各铺一张透明层，画完再 alpha_composite，语义才和 ctx.fill() 一致。"""
    return Image.new('RGBA', (size, size), (0, 0, 0, 0))


def draw_board(img, pal, inset=0.13):
    """把一张 4 阶聪明格画进 img（就地）。inset 是画布边到盘外的留白比例。"""
    size = img.width
    pad = round(size * inset)
    box_w = size - pad * 2
    cell = box_w / 4.0
    x0, y0 = pad, pad
    heavy = max(3, round(cell * 0.11))
    hair = max(1, round(size / 512))
    line = paint(pal, 'line', 0.8)
    line_heavy = paint(pal, 'lineHeavy')
    ink = paint(pal, 'ink')
    accent = paint(pal, 'accent')

    base = new_layer(size)
    bd = ImageDraw.Draw(base)
    bd.rounded_rectangle([x0 - heavy, y0 - heavy, x0 + box_w + heavy, y0 + box_w + heavy],
                         radius=round(size * 0.055), fill=paint(pal, 'surface'))
    # 笼子底色：奇偶交替，只动透明度不引入新色相（js/render/board.js 同一条理由）。
    # 2.0 是图标专属的增益：盘上 5% 的底色是给「一格 40px 的满屏」用的，
    # 摊到 1024 的图标上就什么都没有了——同一件事在不同尺度上要的不同。
    for ci in range(len(CAGE_LABEL)):
        tint = 'cageTintAlt' if ci % 2 else 'cageTint'
        for (r, c) in cage_cells(ci):
            bd.rectangle([x0 + c * cell + 1, y0 + r * cell + 1, x0 + (c + 1) * cell - 1, y0 + (r + 1) * cell - 1],
                         fill=paint(pal, tint, 2.0))
    img.alpha_composite(base)

    seams = new_layer(size)
    sd = ImageDraw.Draw(seams)
    # 细网格：只画同笼内部的接缝，让「这几格是一伙的」有边界感
    for r in range(4):
        for c in range(4):
            if cage_at(r, c) == cage_at(r, c + 1):
                sd.line([x0 + (c + 1) * cell, y0 + r * cell + 2, x0 + (c + 1) * cell, y0 + (r + 1) * cell - 2],
                        fill=line, width=hair)
            if cage_at(r, c) == cage_at(r + 1, c):
                sd.line([x0 + c * cell + 2, y0 + (r + 1) * cell, x0 + (c + 1) * cell - 2, y0 + (r + 1) * cell],
                        fill=line, width=hair)
    # 粗笼边：对面不属于同笼（或在盘外），就是边界
    for r in range(4):
        for c in range(4):
            ci = CAGE_MAP[r][c]
            L, T, R, B = x0 + c * cell, y0 + r * cell, x0 + (c + 1) * cell, y0 + (r + 1) * cell
            h2 = heavy / 2
            if cage_at(r - 1, c) != ci:
                sd.line([L - h2, T, R + h2, T], fill=line_heavy, width=heavy)
            if cage_at(r + 1, c) != ci:
                sd.line([L - h2, B, R + h2, B], fill=line_heavy, width=heavy)
            if cage_at(r, c - 1) != ci:
                sd.line([L, T - h2, L, B + h2], fill=line_heavy, width=heavy)
            if cage_at(r, c + 1) != ci:
                sd.line([R, T - h2, R, B + h2], fill=line_heavy, width=heavy)
    img.alpha_composite(seams)

    marks = new_layer(size)
    md = ImageDraw.Draw(marks)
    # 线索：左上角「目标数 + 运算符」。琥珀色，图标的记忆点就在这几处小字上
    for ci, label in enumerate(CAGE_LABEL):
        r, c = cage_cells(ci)[0]
        bx = [x0 + c * cell + cell * 0.06, y0 + r * cell + cell * 0.04,
              x0 + c * cell + cell * 0.66, y0 + r * cell + cell * 0.40]
        md.rounded_rectangle(bx, radius=round(cell * 0.06), fill=paint(pal, 'bgTop', 0.92))
        draw_text(md, label, max(9, round(cell * 0.25)), accent, bx)
    # 数字：墨白为主；选中格用琥珀框，算对的笼描一圈绿
    for r in range(4):
        for c in range(4):
            L, T = x0 + c * cell, y0 + r * cell
            if CAGE_MAP[r][c] == SOLVED_CAGE:
                md.rounded_rectangle([L + 3, T + 3, L + cell - 3, T + cell - 3], radius=round(cell * 0.10),
                                     outline=paint(pal, 'success', 0.6), width=max(1, round(cell * 0.03)))
            box = [L + cell * 0.16, T + cell * 0.32, L + cell * 0.84, T + cell * 0.98]
            draw_text(md, str(DIGITS[r][c]), round(cell * 0.52),
                      accent if (r, c) == SELECTED else ink, box)
            if (r, c) == SELECTED:
                md.rounded_rectangle([L + 2, T + 2, L + cell - 2, T + cell - 2], radius=round(cell * 0.12),
                                     outline=accent, width=max(2, round(cell * 0.05)))
    img.alpha_composite(marks)
    return img


def square(img, s):
    return img.resize((s, s), Image.LANCZOS)


def maskable(master, s, pal):
    out = gradient(s, pal)
    inner = round(s * 0.64)
    out.alpha_composite(square(master, inner), ((s - inner) // 2, (s - inner) // 2))
    return out


def favicon(master, s):
    """小尺寸先按母图坐标裁掉外圈留白再缩——否则 16px 上只剩一团糊，笼边全化掉。"""
    size = master.width
    pad = round(size * 0.13)
    box_w = size - pad * 2
    return square(master.crop((pad, pad, pad + box_w, pad + box_w)), s)


def make_grain(pal):
    """256×256 可平铺颗粒：给纯色的深色底一点纸感。
    对称补点（镜像位置取同一 alpha）保证四边相接处看不出接缝。"""
    n = 256
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    px = img.load()
    seed = 0x4B454E4B  # 'KENK'

    def rnd():
        nonlocal seed
        seed = (1103515245 * seed + 12345) & 0x7FFFFFFF
        return seed

    ink = rgb(pal['ink'])
    for _ in range(n * n // 26):
        x, y, a = rnd() % n, rnd() % n, 4 + rnd() % 5
        for (xx, yy) in {(x, y), (n - 1 - x, y), (x, n - 1 - y), (n - 1 - x, n - 1 - y)}:
            px[xx, yy] = (ink[0], ink[1], ink[2], max(px[xx, yy][3], a))
    return img


def make_cage_motif(pal):
    """512×512 线稿笼纹：胜利/暂停遮罩的水印（CSS 当 background-image 用）。
    只画线不画数字，垫在文字底下不会打架。"""
    s = 512
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cell = s / 4
    grid = paint(pal, 'line', 0.35)
    heavy = paint(pal, 'accent', 0.6)
    for i in range(5):
        d.line([0, i * cell, s, i * cell], fill=grid, width=1)
        d.line([i * cell, 0, i * cell, s], fill=grid, width=1)
    w = max(3, round(s * 0.016))
    for r in range(4):
        for c in range(4):
            ci = CAGE_MAP[r][c]
            L, T, R, B = c * cell, r * cell, (c + 1) * cell, (r + 1) * cell
            if cage_at(r - 1, c) != ci:
                d.line([L, T, R, T], fill=heavy, width=w)
            if cage_at(r + 1, c) != ci:
                d.line([L, B, R, B], fill=heavy, width=w)
            if cage_at(r, c - 1) != ci:
                d.line([L, T, L, B], fill=heavy, width=w)
            if cage_at(r, c + 1) != ci:
                d.line([R, T, R, B], fill=heavy, width=w)
    return img


def make_og(pal):
    """社交卡 1200×630：左半是盘，右半是字。og:image 在抓取端普遍不支持透明，必须铺满实底。"""
    w, h = OG
    img = Image.new('RGBA', (w, h), rgb(pal['bgTop']) + (255,))
    d = ImageDraw.Draw(img)
    left, right = rgb(pal['bgTop']), rgb(pal['bgBottom'])
    for x in range(w):
        c = mix(left, right, x / (w - 1))
        d.line([x, 0, x, h], fill=c + (255,))
    side = h - 120
    sub = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    draw_board(sub, pal, inset=0.10)
    img.alpha_composite(sub, (60, 60))
    d = ImageDraw.Draw(img)
    tx = 60 + side + 60
    draw_text(d, 'KENKEN', 92, rgb(pal['ink']) + (255,), [tx, 140, w - 60, 250])
    draw_text(d, 'SMART CAGE PUZZLES', 40, rgb(pal['accent']) + (255,), [tx, 258, w - 60, 320])
    d.line([tx, 340, w - 60, 340], fill=rgb(pal['line']) + (255,), width=2)
    rows = [('UNIQUE', 'one solution every board'),
            ('FOUR', 'local rules, no guessing'),
            ('MEASURED', 'difficulty, not labels')]
    for i, (k, v) in enumerate(rows):
        y = 360 + i * 56
        draw_text(d, k, 30, rgb(pal['info']) + (255,), [tx, y, tx + 230, y + 40])
        draw_text(d, v, 30, rgb(pal['ink']) + (255,), [tx + 240, y, w - 60, y + 40])
    return img


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def ihdr(path):
    with open(path, 'rb') as fh:
        head = fh.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        raise SystemExit('%s 不是 PNG' % path)
    return struct.unpack('>II', head[16:24])


def plan(pal):
    master = gradient(MASTER, pal)
    draw_board(master, pal)
    out = [('icons/icon-1024.png', master)]
    out += [('icons/icon-%d.png' % s, square(master, s)) for s in SIZES]
    out += [('icons/icon-maskable-%d.png' % s, maskable(master, s, pal)) for s in MASKABLE]
    out += [('icons/apple-touch-icon.png', square(master, 180)),
            ('icons/favicon-32.png', favicon(master, 32)),
            ('icons/favicon-16.png', favicon(master, 16)),
            ('icons/og.png', make_og(pal)),
            ('assets/img/grain.png', make_grain(pal)),
            ('assets/img/cage-motif.png', make_cage_motif(pal))]
    return out


def build(check_only=False):
    pal = load_palette()
    rows = []
    for rel, img in plan(pal):
        path = os.path.join(REPO, rel)
        want = png_bytes(img)
        have = open(path, 'rb').read() if os.path.exists(path) else None
        if check_only:
            if have is None:
                rows.append((rel, 'MISSING', 0, 0))
            else:
                w, h = ihdr(path)
                rows.append((rel, 'SAME' if have == want else 'DRIFT', w, h))
            continue
        if have != want:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as fh:
                fh.write(want)
        w, h = ihdr(path)
        rows.append((rel, hashlib.sha256(want).hexdigest()[:12], w, h))
    for rel, tag, w, h in rows:
        print('%-32s %-13s %dx%d' % (rel, tag, w, h))
    if check_only:
        bad = [r for r in rows if r[1] in ('MISSING', 'DRIFT')]
        print('check: %d 张，%d 张与当前色板画出来的不一致' % (len(rows), len(bad)))
        return 1 if bad else 0
    with open(os.path.join(HERE, 'art-manifest.json'), 'w') as fh:
        json.dump({'master': MASTER, 'og': list(OG), 'palette': {k: pal[k] for k in sorted(pal)},
                   'files': [r[0] for r in rows]}, fh, indent=1)
    print('-> %d 张已落盘（重复运行应当得到同一批 sha256）' % len(rows))
    return 0


if __name__ == '__main__':
    raise SystemExit(build('--check' in sys.argv))

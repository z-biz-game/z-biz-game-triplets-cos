#!/usr/bin/env python3
"""同或异 Triplets 的美术资产工厂：一张母图 + 全套派生位图，全部落在盘上是真的 PNG。

为什么是脚本而不是一次性手工导出：出货的字节必须能在任何一台机器上重铸成**同一批数**。
`tools/check-assets.mjs`（零依赖）吃本脚本一并写出的 `assets/manifest.json`，逐张核 PNG
签名、IHDR 宽高与 sha256；任何一张被手改或删掉，那道门就红。`--verify` 是 PIL 侧的同款
对账：重新渲染到临时目录，与盘上字节比 sha，不同就 exit 1。

视觉母题（和玩法同源，不是凭空的装饰）：
  1. 颜色全部取自 js/theme.js 的 Palette（field/tintA/tintB/gridLine/border/given/player/
     note/bgTop/bgBottom/accent/info）。下面 P 那张表是手抄的，因为脚本不 import JS；
     改了 theme.js 就要改这里，`tools/check-assets.mjs` 会把两边都在的 hex 对一遍。
  2. 形状就是那三个符号，比例与 js/render/board.js 的 drawGlyph/glyphProbe 同源：
     方块半边 0.27 格、圆半径 0.24 格、三角半宽 0.32 / 半高 0.28 格（theme.js 的 Board）。
  3. 母题本体是「被切成三格一块的盘面」：粗蓝跨区轮廓 + 一块 L 形区域里住着 ■ ● ▲，
     背后压细格线 —— 说的就是题面那三条规则。

产出清单（相对仓根，全部真 PNG）：
  icons/icon-1024.png / icon-512.png / icon-192.png / icon-maskable-512.png
  icons/apple-touch-icon.png(180) / icon-96.png / favicon-32.png / favicon-16.png
  assets/textures/grain-256.png  —— 可平铺噪声纹理，css/game.css 贴在 body/panel 上
  assets/img/triad-sprite.png    —— 576×192 三帧 sprite（■ ● ▲），HUD 笔指示器吃它
  assets/img/og-image.png        —— 1200×630 社交卡
  assets/manifest.json           —— 上面每张的 {w,h,bytes,sha256,role} + 字体读数

用法： python3 assets/gen/gen_art.py           # 重铸全套
       python3 assets/gen/gen_art.py --verify  # 重铸并与盘上字节对 sha，不写文件
依赖： Pillow（组合里 make_icons.py 同款）。缺 Pillow 时当场 exit 2 说明原因，不静默产出假图。
"""
import hashlib
import json
import os
import random
import sys
import tempfile

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    print('FATAL: 需要 Pillow（python3 -m pip install pillow）才能重铸美术资产；'
          '没有它这个脚本产不出任何字节。', file=sys.stderr)
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT_REAL = os.path.abspath(os.path.join(HERE, '..', '..'))
ROOT = ROOT_REAL

SS = 4                 # 母图超采样：按 4096² 画完再 LANCZOS 收到 1024，边缘不靠抗锯齿骗人
MASTER = 1024
MASTER_PX = MASTER * SS

# ── 色源：与 js/theme.js 的 Palette 逐条对照（改一边就要改另一边）────────────────────
P = {
    'bgTop': (0x07, 0x0A, 0x14),
    'bgBottom': (0x12, 0x1A, 0x2C),
    'surface': (0x0F, 0x15, 0x26),
    'surfaceLift': (0x18, 0x20, 0x36),
    'line': (0x24, 0x30, 0x50),
    'ink': (0xF2, 0xF5, 0xFB),
    'field': (0x12, 0x1B, 0x2E),
    'tintA': (0x1C, 0x27, 0x40),
    'tintB': (0x22, 0x30, 0x52),
    'gridLine': (0x0A, 0x0F, 0x1C),
    'border': (0x4E, 0x74, 0xC8),
    'given': (0xF2, 0xF5, 0xFB),
    'player': (0x2E, 0xD5, 0x73),
    'note': (0xB8, 0xA8, 0x8F),
    'accent': (0xFF, 0xC8, 0x5C),
    'info': (0x7B, 0xB8, 0xFF),
}

# 字形比例：与 js/theme.js 的 Board.* 同一批数
GLYPH = {'squareHalf': 0.27, 'circleR': 0.24, 'triHalf': 0.32, 'triHalfHeight': 0.28}

ROLES = {
    'icons/icon-1024.png': '母图 1024（商店/物料源图）',
    'icons/icon-512.png': 'PWA icon 512（purpose any）',
    'icons/icon-192.png': 'PWA icon 192（purpose any）',
    'icons/icon-maskable-512.png': 'PWA icon 512（purpose maskable，母题收进 80% 安全区）',
    'icons/apple-touch-icon.png': 'iOS apple-touch-icon 180',
    'icons/icon-96.png': '桌面/任务栏 96',
    'icons/favicon-32.png': 'favicon 32',
    'icons/favicon-16.png': 'favicon 16',
    'assets/textures/grain-256.png': '游戏内纹理：body/panel 的噪声层（可平铺，接缝不存在）',
    'assets/img/triad-sprite.png': '游戏内 sprite：576×192 三帧（■ ● ▲），HUD 笔指示器',
    'assets/img/og-image.png': 'og:image / twitter:image 社交卡 1200×630',
}


def sc(color, f):
    return tuple(max(0, min(255, int(round(c * f)))) for c in color)


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


def vgrad(draw, w, h, top, bottom):
    """竖线性渐变：和 css 里 body 那条 linear-gradient 同方向。"""
    for i in range(h):
        draw.line([(0, i), (w, i)], fill=mix(top, bottom, i / (h - 1) if h > 1 else 0))


def glyph(draw, sym, cx, cy, r, color):
    """三种符号的唯一画法，比例与 js/render/board.js 的 drawGlyph 一致（r = 方块半边）。"""
    if sym == 0:
        draw.rectangle([cx - r, cy - r, cx + r, cy + r], fill=color)
    elif sym == 1:
        rr = r * GLYPH['circleR'] / GLYPH['squareHalf']
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=color)
    else:
        hw = r * GLYPH['triHalf'] / GLYPH['squareHalf']
        hh = r * GLYPH['triHalfHeight'] / GLYPH['squareHalf']
        draw.polygon([(cx, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh)], fill=color)


def draw_regions(dl, cw, ox, oy, cols, rows, blocks, glyphs=(), grid_back=True):
    """把「三格一块的区域」画出来：底纹 → 细格线 → 跨区轮廓 → 符号。

    顺序与 js/render/board.js 的 draw() 第 2/3/4/6 步同源，所以图标上的那张盘和
    游戏里那张盘不是两套画法。blocks 是 [(三格坐标, 底纹令牌)]，只有**跨区**共边才描
    粗蓝线，同区共边不描 —— 这一条就是玩法里「粗蓝线是分组的全部证据」。
    """
    owner = {}
    for idx, (cells, _tint) in enumerate(blocks):
        if len(cells) != 3:
            raise SystemExit('一块区域必须恰好三格，给了 %d 格' % len(cells))
        for c in cells:
            if c in owner:
                raise SystemExit('同一格被两块区域占了：%s' % (c,))
            owner[c] = idx

    if grid_back:
        gw = max(2, int(cw * 0.02))
        span = int(max(ox, oy) / cw) + max(cols, rows) + 2
        for i in range(-span, span + 1):
            gx = ox + i * cw
            dl.line([(gx, 0), (gx, dl.im.size[1])], fill=P['gridLine'], width=gw)
            gy = oy + i * cw
            dl.line([(0, gy), (dl.im.size[0], gy)], fill=P['gridLine'], width=gw)

    for idx, (cells, tint) in enumerate(blocks):
        col = P[tint]
        for (a, b) in cells:
            dl.rectangle([ox + a * cw, oy + b * cw, ox + (a + 1) * cw, oy + (b + 1) * cw], fill=col)

    # 区域内部的细分隔线（格还是格，但不说分组）
    gw = max(2, int(cw * 0.016))
    for (a, b), idx in owner.items():
        for (da, db) in [(1, 0), (0, 1)]:
            if owner.get((a + da, b + db)) == idx:
                x0, y0 = ox + (a + da) * cw, oy + (b + db) * cw
                if da:
                    dl.line([(x0, y0 - cw), (x0, y0)], fill=P['gridLine'], width=gw)
                else:
                    dl.line([(x0 - cw, y0), (x0, y0)], fill=P['gridLine'], width=gw)

    bw = max(3, int(cw * 0.085))  # theme.js Board.borderWidth = 0.085，与 edgeBand 同一条式子
    for (a, b), idx in owner.items():
        x0, y0 = ox + a * cw, oy + b * cw
        for (da, db) in [(1, 0), (0, 1)]:
            nb = owner.get((a + da, b + db), 'outside')
            if nb == idx or nb == 'outside':
                continue  # 同区不画；窗口外由下面那圈外框收口
            if da:
                dl.line([(x0 + cw, y0), (x0 + cw, y0 + cw)], fill=P['border'], width=bw)
            else:
                dl.line([(x0, y0 + cw), (x0 + cw, y0 + cw)], fill=P['border'], width=bw)
    dl.rectangle([ox, oy, ox + cols * cw, oy + rows * cw], outline=P['border'], width=bw)

    for (a, b), sym in glyphs:
        cx = ox + a * cw + cw / 2
        cy = oy + b * cw + cw / 2
        glyph(dl, sym, cx, cy, cw * 0.36, [P['player'], P['given'], P['note']][sym] + (255,))


# 母题那张 3×3 窗：一块 I 形 + 两块 L 形（三格一块，直的和拐的都算），■ ● ▲ 住在右下角那块 L 里。
BADGE_BLOCKS = [
    ([(1, 1), (1, 2), (2, 2)], 'tintB'),
    ([(1, 0), (2, 0), (2, 1)], 'tintA'),
    ([(0, 0), (0, 1), (0, 2)], 'field'),
]
BADGE_GLYPHS = [((1, 1), 0), ((1, 2), 1), ((2, 2), 2)]


def badge(k, maskable=False):
    """圆角 badge：渐变底 → 叠上母题 → 按圆角裁 alpha → 收边描环。"""
    rad = 0 if maskable else int(MASTER_PX * 0.185)

    base = Image.new('RGBA', (MASTER_PX, MASTER_PX), P['bgTop'] + (255,))
    vgrad(ImageDraw.Draw(base), MASTER_PX, MASTER_PX, P['bgTop'], P['bgBottom'])

    layer = Image.new('RGBA', (MASTER_PX, MASTER_PX), (0, 0, 0, 0))
    cw = int(MASTER_PX * 0.21)
    ox = int((MASTER_PX - cw * 3) / 2)
    oy = int((MASTER_PX - cw * 3) / 2)
    if maskable:  # 母题收进中心 80% 安全区，四周由系统遮罩裁
        inner = Image.new('RGBA', (MASTER_PX, MASTER_PX), (0, 0, 0, 0))
        draw_regions(ImageDraw.Draw(inner), cw, ox, oy, 3, 3, BADGE_BLOCKS, BADGE_GLYPHS)
        side = int(MASTER_PX * 0.80)
        inner = inner.resize((side, side), Image.LANCZOS)
        off = int((MASTER_PX - side) / 2)
        layer.paste(inner, (off, off), inner)
    else:
        draw_regions(ImageDraw.Draw(layer), cw, ox, oy, 3, 3, BADGE_BLOCKS, BADGE_GLYPHS)

    out = Image.alpha_composite(base, layer)
    if rad:
        clip = Image.new('L', (MASTER_PX, MASTER_PX), 0)
        ImageDraw.Draw(clip).rounded_rectangle([0, 0, MASTER_PX - 1, MASTER_PX - 1], radius=rad, fill=255)
        out = Image.composite(out, Image.new('RGBA', (MASTER_PX, MASTER_PX), (0, 0, 0, 0)), clip)
    od = ImageDraw.Draw(out)
    bw = max(3, int(cw * 0.085))
    if not maskable:
        od.rounded_rectangle([bw // 2, bw // 2, MASTER_PX - 1 - bw // 2, MASTER_PX - 1 - bw // 2],
                             radius=rad, outline=P['border'], width=bw)
        od.rounded_rectangle([0, 0, MASTER_PX - 1, MASTER_PX - 1], radius=rad,
                             outline=P['line'], width=max(2, int(MASTER_PX * 0.008)))
    return out.resize((k, k), Image.LANCZOS)


def grain(k=256, seed=20261002, amp=22):
    """可平铺噪声纹理：3×3 复制后模糊、再取中间那块 —— 接缝因此不存在。"""
    rnd = random.Random(seed)
    tile = Image.new('RGBA', (k, k), (0, 0, 0, 0))
    pxi = tile.load()
    for y in range(k):
        for x in range(k):
            pxi[x, y] = (255, 255, 255, min(255, int(round(abs(rnd.gauss(0, amp))))))
    big = Image.new('RGBA', (k * 3, k * 3), (0, 0, 0, 0))
    for oy in range(3):
        for ox in range(3):
            big.paste(tile, (ox * k, oy * k))
    mid = big.filter(ImageFilter.GaussianBlur(1.6)).crop((k, k, k * 2, k * 2))
    # 纯白噪声直接贴会显脏，压到 info 那一档色温上并把 alpha 再收一半
    tinted = Image.new('RGBA', (k, k), (0, 0, 0, 0))
    src, dst = mid.load(), tinted.load()
    for y in range(k):
        for x in range(k):
            a = src[x, y][3]
            dst[x, y] = (P['info'][0], P['info'][1], P['info'][2], min(255, int(a * 0.42)))
    return tinted


def sprite(k=192):
    """三帧 sprite（■ ● ▲），透明底；HUD 用 background-position 取帧。"""
    img = Image.new('RGBA', (k * 3, k), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for sym in range(3):
        cx, cy = sym * k + k // 2, k // 2
        col = [P['player'], P['given'], P['note']][sym]
        r = int(k * 0.44)
        d.rounded_rectangle([cx - r, cy - r, cx + r, cy + r], radius=int(k * 0.16), fill=sc(col, 0.55) + (46,))
        d.rounded_rectangle([cx - r, cy - r, cx + r, cy + r], radius=int(k * 0.16), outline=col + (120,), width=3)
        glyph(d, sym, cx, cy, int(k * 0.30), col + (255,))
    return img


CJK_FONTS = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
]
LATIN_FONTS = [
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]


def pick_font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size), p
        except Exception:
            continue
    return ImageFont.load_default(size), 'PIL:load_default'


def cjk_ok(font):
    """字面真的画得出汉字吗：两个不同汉字都得有墨，而且墨迹不同。"""
    a = Image.new('L', (120, 120), 0)
    b = Image.new('L', (120, 120), 0)
    try:
        ImageDraw.Draw(a).text((10, 10), '同', font=font, fill=255)
        ImageDraw.Draw(b).text((10, 10), '异', font=font, fill=255)
    except Exception:
        return False
    return a.tobytes() != b.tobytes() and sum(a.getdata()) > 200 and sum(b.getdata()) > 200


def og_card():
    """1200×630 社交卡：左边三条规则说人话，右边那张 6×3 的盘是真能摆出来的六块三格区域。"""
    W, H = 1200, 630
    img = Image.new('RGBA', (W, H), P['bgTop'] + (255,))
    d = ImageDraw.Draw(img)
    vgrad(d, W, H, P['bgTop'], P['bgBottom'])

    cw = 68
    ox, oy = W - cw * 6 - 40, (H - cw * 3) // 2 + 6
    blocks = []
    for i, c0 in enumerate((0, 2, 4)):  # 三个 2×3 砖块，每块切成两块 L 形三格区 ⇒ 六块区域、18 格
        blocks.append(([(c0, 0), (c0 + 1, 0), (c0 + 1, 1)], 'tintB' if i % 2 == 0 else 'tintA'))
        blocks.append(([(c0, 1), (c0, 2), (c0 + 1, 2)], 'tintA' if i % 2 == 0 else 'tintB'))
    glyphs = [((1, 0), 0), ((3, 1), 1), ((5, 0), 2)]

    f_big, fp1 = pick_font(CJK_FONTS, 92)
    f_mid, fp2 = pick_font(CJK_FONTS, 29)
    f_mono, fp3 = pick_font(['/System/Library/Fonts/Menlo.ttc',
                             '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'] + LATIN_FONTS, 21)

    d.text((60, 132), '同或异', font=f_big, fill=P['ink'] + (255,))
    d.text((62, 246), 'Triplets · 三格区域的推理', font=f_mid, fill=P['info'] + (255,))
    yy = 316
    for ln in ['每块区域恰好三格：要么三个同号，要么三个全异',
               '跨区域相邻的两格必须不同，没有别的规则',
               '每一盘都被独立穷举计数器数过唯一解']:
        d.text((62, yy), ln, font=f_mid, fill=sc(P['ink'], 0.74) + (255,))
        yy += 44
    d.text((62, H - 70), 'github.com/z-biz-game/z-biz-game-triplets-cos', font=f_mono, fill=P['note'] + (255,))

    draw_regions(d, cw, ox, oy, 6, 3, blocks, glyphs, grid_back=False)
    for i in range(7):
        d.line([(ox + i * cw, oy - 12), (ox + i * cw, oy)], fill=P['gridLine'], width=2)
    d.rounded_rectangle([3, 3, W - 4, H - 4], radius=26, outline=P['line'], width=3)
    return img, (fp1, fp2, fp3)


def write(path, im, manifest):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    tmp = full + '.tmp.png'
    im.save(tmp, 'PNG', optimize=True)
    os.replace(tmp, full)
    raw = open(full, 'rb').read()
    if not raw.startswith(b'\x89PNG\r\n\x1a\n'):
        raise SystemExit('写出来的不是 PNG 签名：%s' % path)
    manifest[path] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                      'w': im.size[0], 'h': im.size[1], 'role': ROLES.get(path, '')}
    return len(raw)


def main():
    global ROOT
    verify = '--verify' in sys.argv
    if verify:
        ROOT = tempfile.mkdtemp(prefix='triplets-art-')

    manifest, total = {}, 0
    for path, k in [('icons/icon-1024.png', 1024), ('icons/icon-512.png', 512), ('icons/icon-192.png', 192),
                    ('icons/apple-touch-icon.png', 180), ('icons/icon-96.png', 96),
                    ('icons/favicon-32.png', 32), ('icons/favicon-16.png', 16)]:
        total += write(path, badge(k), manifest)
    total += write('icons/icon-maskable-512.png', badge(512, maskable=True), manifest)
    total += write('assets/textures/grain-256.png', grain(), manifest)
    total += write('assets/img/triad-sprite.png', sprite(), manifest)
    card, fonts = og_card()
    total += write('assets/img/og-image.png', card, manifest)

    cjk = 'YES' if cjk_ok(pick_font(CJK_FONTS, 40)[0]) else 'NO(退拉丁/默认字面)'
    payload = {'generator': 'assets/gen/gen_art.py', 'supersample': SS, 'fonts': list(fonts),
               'cjk_text': cjk, 'palette_source': 'js/theme.js Palette', 'files': manifest}

    if verify:
        bad = []
        for rel, meta in manifest.items():
            disk = os.path.join(ROOT_REAL, rel)
            if not os.path.exists(disk):
                bad.append('%s 不在盘上' % rel)
            elif hashlib.sha256(open(disk, 'rb').read()).hexdigest() != meta['sha256']:
                bad.append('%s 字节与重铸结果不一致' % rel)
        print('VERIFY %s：重铸 %d 张，与盘上字节%s（合计 %d 字节）' % (
            'ok' if not bad else 'FAIL', len(manifest), '全部一致' if not bad else '有出入', total))
        for b in bad:
            print('  MISMATCH', b)
        print('cjk=%s fonts=%s' % (cjk, ','.join(fonts)))
        sys.exit(1 if bad else 0)

    mpath = os.path.join(ROOT, 'assets', 'manifest.json')
    os.makedirs(os.path.dirname(mpath), exist_ok=True)
    with open(mpath, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write('\n')
    print('WROTE %d 张位图，合计 %d 字节；manifest=assets/manifest.json' % (len(manifest), total))
    print('cjk=%s fonts=%s' % (cjk, ','.join(fonts)))
    for rel, meta in sorted(manifest.items()):
        print('  %-36s %5dx%-5d %8d B  %s' % (rel, meta['w'], meta['h'], meta['bytes'], meta['sha256'][:12]))


if __name__ == '__main__':
    main()

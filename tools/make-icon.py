# -*- coding: utf-8 -*-
"""
生成应用图标 assets/app.ico（多尺寸）+ docs/icon-preview.png

设计：iOS 蓝渐变圆角方块 + 白色对勾，与托盘图标、安装器保持同一套视觉。
每个尺寸单独绘制（4x 超采样后缩小），避免小尺寸糊成一团。

用法：python tools/make-icon.py
"""
import os
import struct
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ICO = os.path.join(ROOT, 'assets', 'app.ico')
OUT_PNG = os.path.join(ROOT, 'docs', 'icon-preview.png')

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 4                      # 超采样倍数
TOP = (66, 161, 255)        # #42A1FF
BOTTOM = (0, 98, 212)       # #0062D4


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_icon(px):
    s = px * SS
    pad = int(round(s * 0.035))
    box = s - pad * 2
    radius = int(round(box * 0.235))

    # 竖向渐变底
    grad = Image.linear_gradient('L').resize((box, box), Image.LANCZOS)
    grad = ImageOps.colorize(grad, black=TOP, white=BOTTOM).convert('RGBA')
    grad.putalpha(rounded_mask(box, radius))

    # 顶部柔和高光
    gloss = Image.new('L', (box, box), 0)
    ImageDraw.Draw(gloss).ellipse(
        [-box * 0.35, -box * 0.92, box * 1.35, box * 0.55], fill=64)
    gloss = gloss.filter(ImageFilter.GaussianBlur(box * 0.07))
    gloss = ImageChops.multiply(gloss, grad.getchannel('A'))   # 只画在圆角内

    overlay = Image.new('RGBA', (box, box), (255, 255, 255, 0))
    overlay.putalpha(gloss)
    card = Image.alpha_composite(grad, overlay)

    # 白色对勾
    d = ImageDraw.Draw(card)
    w = max(2, int(round(box * 0.135)))
    pts = [(box * 0.255, box * 0.525), (box * 0.425, box * 0.690), (box * 0.755, box * 0.315)]
    d.line(pts, fill=(255, 255, 255, 255), width=w, joint='curve')
    for p in (pts[0], pts[2]):
        r = w / 2.0
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, 255))

    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    canvas.paste(card, (pad, pad), card)
    return canvas.resize((px, px), Image.LANCZOS)


def main():
    os.makedirs(os.path.dirname(OUT_ICO), exist_ok=True)
    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)

    frames = []
    for size in SIZES:
        img = draw_icon(size)
        import io
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        frames.append(buf.getvalue())
        if size == 256:
            img.save(OUT_PNG, 'PNG')

    n = len(SIZES)
    header = struct.pack('<HHH', 0, 1, n)
    offset = 6 + 16 * n
    entries = b''
    for size, data in zip(SIZES, frames):
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(OUT_ICO, 'wb') as f:
        f.write(header + entries + b''.join(frames))

    print('wrote %s (%.1f KB, %d sizes)' % (OUT_ICO, os.path.getsize(OUT_ICO) / 1024.0, n))
    print('wrote %s' % OUT_PNG)


if __name__ == '__main__':
    main()

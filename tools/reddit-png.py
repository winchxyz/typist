# PNGs of the final Reddit text art (shots/reddit/*-plain.txt) to attach to a post, 1080 x 1350.
#   python tools/reddit-png.py  -> shots/reddit/typist-reddit-{dots,letters}-{dark,light}.png
# Braille as exact dots (what phones show), letters in Geist Mono. The art is the text as pasted,
# only drawn big; nothing is added to it.
import os
from PIL import Image, ImageDraw, ImageFont

D = 'shots/reddit'
MONO = os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Windows\Fonts\GeistMono-VariableFont_wght.ttf')
W, H, MARGIN = 1080, 1350, 90
THEMES = {'dark': ((14, 14, 16), (236, 233, 226)), 'light': ((250, 249, 246), (24, 24, 27))}
SLOTS = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
SS = 3  # supersampling for smooth dots and glyphs

def dots(text, bg, ink):
    rows = text.split('\n')
    cols = max(len(r) for r in rows)
    pitch = min((W - 2 * MARGIN) / (cols * 2), (H - 2 * MARGIN) / (len(rows) * 4)) * SS
    r = pitch * 0.36
    im = Image.new('RGB', (W * SS, H * SS), bg)
    d = ImageDraw.Draw(im)
    ox = (W * SS - cols * 2 * pitch) / 2
    oy = (H * SS - len(rows) * 4 * pitch) / 2
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            b = ord(ch) - 0x2800
            if b <= 0 or b > 255:
                continue
            for k, (sx, sy) in enumerate(SLOTS):
                if b >> k & 1:
                    cx = ox + (x * 2 + sx + 0.5) * pitch
                    cy = oy + (y * 4 + sy + 0.5) * pitch
                    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ink)
    return im.resize((W, H), Image.LANCZOS)

def letters(text, bg, ink, lh=1.3):
    rows = text.split('\n')
    cols = max(len(r) for r in rows)
    probe = ImageFont.truetype(MONO, 100)
    em = probe.getlength('M') / 100            # advance per px of font size
    size = min((W - 2 * MARGIN) / (cols * em), (H - 2 * MARGIN) / (len(rows) * lh)) * SS
    font = ImageFont.truetype(MONO, int(size))
    cw, line = font.getlength('M'), size * lh
    im = Image.new('RGB', (W * SS, H * SS), bg)
    d = ImageDraw.Draw(im)
    ox = (W * SS - cols * cw) / 2
    oy = (H * SS - len(rows) * line) / 2
    for y, row in enumerate(rows):
        d.text((ox, oy + y * line), row, font=font, fill=ink)
    return im.resize((W, H), Image.LANCZOS)

for name, fn in (('dots', dots), ('letters', letters)):
    text = open(f'{D}/{name}-plain.txt', encoding='utf-8').read()
    for theme, (bg, ink) in THEMES.items():
        out = f'{D}/typist-reddit-{name}-{theme}.png'
        fn(text, bg, ink).save(out, optimize=True)
        print(out, os.path.getsize(out) // 1024, 'KB')

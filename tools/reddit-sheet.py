# Contact sheets of the Reddit text-art candidates (shots/reddit/cand_*.txt).
#   python tools/reddit-sheet.py            -> shots/reddit/sheet_dots.png, sheet_letters.png
# Braille is drawn as exact dots (the phone look, independent of this PC's Braille font);
# letters in Geist Mono, the site's own monospace face.
import json, os
from PIL import Image, ImageDraw, ImageFont

D = 'shots/reddit'
MONO = os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Windows\Fonts\GeistMono-VariableFont_wght.ttf')
UI = r'C:\Windows\Fonts\segoeui.ttf'
BG, INK, LABEL = (17, 17, 19), (236, 234, 229), (150, 146, 140)
SLOTS = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]

def draw_dots(text, pitch=4.0, r=1.45, bg=BG, ink=INK, pad=12):
    rows = text.split('\n')
    cols = max(len(x) for x in rows)
    W, H = int(cols * 2 * pitch + 2 * pad), int(len(rows) * 4 * pitch + 2 * pad)
    im = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(im)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            b = ord(ch) - 0x2800
            if b <= 0 or b > 255:
                continue
            for k, (sx, sy) in enumerate(SLOTS):
                if b >> k & 1:
                    cx = pad + (x * 2 + sx + 0.5) * pitch
                    cy = pad + (y * 4 + sy + 0.5) * pitch
                    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ink)
    return im

def draw_letters(text, size=11, lh=1.3, bg=BG, ink=INK, pad=12):
    font = ImageFont.truetype(MONO, size)
    rows = text.split('\n')
    cw = font.getlength('M')
    W, H = int(max(len(x) for x in rows) * cw + 2 * pad), int(len(rows) * size * lh + 2 * pad)
    im = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(im)
    for y, row in enumerate(rows):
        d.text((pad, pad + y * size * lh), row, font=font, fill=ink)
    return im

def sheet(kind, per_row):
    cands = [c for c in json.load(open(f'{D}/candidates.json', encoding='utf-8')) if c['name'].startswith(kind)]
    tiles = []
    for c in cands:
        t = open(f"{D}/cand_{c['name']}.txt", encoding='utf-8').read()
        im = draw_dots(t) if kind == 'dots' else draw_letters(t)
        tiles.append((c['name'], im))
    tw = max(im.width for _, im in tiles); th = max(im.height for _, im in tiles) + 26
    n = len(tiles); rows = (n + per_row - 1) // per_row
    S = Image.new('RGB', (per_row * (tw + 16) + 16, rows * (th + 16) + 16), (40, 40, 44))
    d = ImageDraw.Draw(S); f = ImageFont.truetype(UI, 14)
    for i, (name, im) in enumerate(tiles):
        x = 16 + (i % per_row) * (tw + 16); y = 16 + (i // per_row) * (th + 16)
        d.text((x, y), name, font=f, fill=LABEL)
        S.paste(im, (x, y + 22))
    S.save(f'{D}/sheet_{kind}.png')
    print(kind, S.size)

if __name__ == '__main__':
    sheet('dots', 4)
    sheet('letters', 4)

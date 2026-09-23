// Files of the art: .txt, PNG, SVG and a standalone HTML page, plus the download helper.
//
// Every file draws the Grid (dots, glyphs, colour blocks), never the photo. Cell sizes come from
// the target's metrics (targets.js FIT: fontPx x cellEm wide, fontPx x lineEm tall), the same
// numbers the preview uses, so a file looks like the preview. PNG goes through js/raster.js
// drawGrid (the film's geometry); SVG repeats that geometry as circles / merged rects / text rows.
// No DOM at import time: node tests import this module (only exportPNG and downloadBlob touch it).

import { FIT, formatFor } from './targets.js';
import { brailleGeometry, BLOCK_MASK, drawGrid } from './raster.js';

export const INK = '#17171a';
export const PAPER = '#ffffff';
export const MONO_STACK = '"Geist Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, '
  + '"DejaVu Sans Mono", "Liberation Mono", monospace';
// HTML Braille is drawn by the viewer's fonts: ones whose 256 patterns share one width first.
// Windows only has Segoe UI Symbol, which draws U+2800 narrower (see SPEC "Device finding").
export const BRAILLE_STACK = '"Apple Braille", "Noto Sans Symbols 2", "DejaVu Sans", "Segoe UI Symbol", sans-serif';

const MAX_SIDE = 8192;
const MAX_AREA = 16777216;       // iOS Safari's canvas limit (4096 x 4096)

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const num = v => { const r = Math.round(v * 100) / 100; return String(Object.is(r, -0) ? 0 : r); };
const hex = v => '#' + ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');
const MODE_NAME = { braille: 'Braille', ascii: 'ASCII', blocks: 'block' };

/** Short description for titles and aria-labels. */
export const describe = grid => `${MODE_NAME[grid.mode] || 'Text'} art, ${grid.cols} by ${grid.rows} characters`;

/** Cell size in px for a grid on a target (preview metrics) at `scale`; explicit cellW/cellH win. */
export function cellMetrics(grid, { target = 'plain', scale = 1, cellW, cellH } = {}) {
  const f = (FIT[target] && FIT[target][grid.mode]) || FIT.plain[grid.mode] || FIT.plain.braille;
  return {
    cellW: cellW ?? f.fontPx * f.cellEm * scale,
    cellH: cellH ?? f.fontPx * f.lineEm * scale,
    fontPx: f.fontPx * scale, lineEm: f.lineEm,
  };
}

// ------------------------------------------------------------------------------------ names

const COMBINING = /[̀-ͯ]/g;
const slug = s => String(s ?? '').normalize('NFKD').replace(COMBINING, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * 'typist-ig-26x15.png' from ({ target: 'ig', cols: 26, rows: 15 }, 'png') (a payload works) or
 * from (['ig', '26x15'], '.png').
 */
export function fileName(parts = [], ext = '') {
  if (parts && typeof parts === 'object' && !Array.isArray(parts)) {
    const p = parts;
    parts = [p.target || 'plain', p.cols && p.rows ? `${p.cols}x${p.rows}` : ''];
  }
  const bits = [].concat(parts).map(slug).filter(Boolean);
  if (bits[0] === 'typist') bits.shift();
  const base = ['typist', ...bits].join('-').slice(0, 96).replace(/-+$/, '');
  const e = String(ext || '').replace(/^\.+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e ? `${base}.${e}` : base;
}

// ------------------------------------------------------------------------------------ txt

const isGrid = g => g && typeof g === 'object' && g.cp && g.cols >= 0;

/** Plain text of the art: formatFor('plain') rows (LF only, no BOM, no trailing newline). */
export function plainText(src) {
  if (typeof src === 'string') return src;
  if (isGrid(src)) return formatFor('plain', src).text;
  return String((src && src.text) || '');
}

/** .txt Blob. Pass the Grid (or a formatFor('plain') payload): a Telegram payload has fences. */
export function exportTxt(src) {
  return new Blob([plainText(src)], { type: 'text/plain;charset=utf-8' });
}

// ------------------------------------------------------------------------------------ blocks

/**
 * Block art as rectangles in half-cell units: { bg: [...], fg: [...] }, each { x, y, w, h, fill }.
 * Horizontal runs of equal colour merge per half row, and a run continues downwards while the
 * next half row has the same run. fill is null for monochrome quadrants (the ink colour).
 * Quadrants painted in their cell's own background colour are dropped (they cannot be seen).
 */
export function blockRects(grid) {
  const { cols, rows, cp, fg, bg } = grid;
  const merge = (lines) => {
    const out = [];
    let prev = new Map();
    lines.forEach((runs, y) => {
      const cur = new Map();
      for (const r of runs) {
        const key = r.x + ':' + r.w + ':' + r.fill;
        const open = prev.get(key);
        if (open) { open.h++; cur.set(key, open); } else {
          const rect = { x: r.x, y, w: r.w, h: 1, fill: r.fill };
          out.push(rect);
          cur.set(key, rect);
        }
      }
      prev = cur;
    });
    return out;
  };
  const bgLines = [];
  if (bg) {
    for (let row = 0; row < rows; row++) {
      const runs = [];
      for (let c = 0; c < cols; c++) {
        const f = hex(bg[row * cols + c]), last = runs[runs.length - 1];
        if (last && last.fill === f && last.x + last.w === 2 * c) last.w += 2;
        else runs.push({ x: 2 * c, w: 2, fill: f });
      }
      bgLines.push(runs, runs.map(r => ({ ...r })));     // two half rows per cell row
    }
  }
  const fgLines = [];
  for (let sy = 0; sy < 2 * rows; sy++) {
    const row = sy >> 1, runs = [];
    for (let sx = 0; sx < 2 * cols; sx++) {
      const i = row * cols + (sx >> 1);
      const mask = BLOCK_MASK.get(cp[i]) ?? 0;
      const bit = ((sy & 1) << 1) | (sx & 1);            // UL=0, UR=1, LL=2, LR=3
      if (!((mask >> bit) & 1)) continue;
      const fill = fg ? hex(fg[i]) : null;
      if (bg && fill === hex(bg[i])) continue;
      const last = runs[runs.length - 1];
      if (last && last.fill === fill && last.x + last.w === sx) last.w++;
      else runs.push({ x: sx, w: 1, fill });
    }
    fgLines.push(runs);
  }
  return { bg: merge(bgLines), fg: merge(fgLines) };
}

// ------------------------------------------------------------------------------------ svg

/**
 * SVG string. Braille = one circle per raised dot; blocks = merged rects; ASCII = one <text> per
 * row in a monospace stack, stretched to the exact row width (textLength) so columns stay put.
 * opts: { ink, paper (null = transparent), target, scale, cellW, cellH, pad, font, dotR, title }
 */
export function exportSVG(grid, opts = {}) {
  const { ink = INK, paper = PAPER, pad = 0, font = MONO_STACK, dotR = 0.32 } = opts;
  const { cellW: cw, cellH: ch } = cellMetrics(grid, opts);
  const { cols, rows, cp } = grid;
  const W = cols * cw + 2 * pad, H = rows * ch + 2 * pad;
  const title = opts.title || describe(grid);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${num(W)}" height="${num(H)}" `
    + `viewBox="0 0 ${num(W)} ${num(H)}" role="img" aria-label="${esc(title)}">`, `<title>${esc(title)}</title>`];
  if (paper) out.push(`<rect width="${num(W)}" height="${num(H)}" fill="${esc(paper)}"/>`);
  if (grid.mode === 'braille') {
    const { r, centers } = brailleGeometry(cw, ch, dotR);
    const rs = num(r);
    out.push(`<g fill="${esc(ink)}">`);
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < cols; c++) {
        const v = cp[row * cols + c];
        const bits = v >= 0x2800 && v <= 0x28ff ? v - 0x2800 : 0;
        if (!bits) continue;
        const ox = pad + c * cw, oy = pad + row * ch;
        for (let k = 0; k < 8; k++) {
          if ((bits >> k) & 1) out.push(`<circle cx="${num(ox + centers[k][0])}" cy="${num(oy + centers[k][1])}" r="${rs}"/>`);
        }
      }
    }
    out.push('</g>');
  } else if (grid.mode === 'blocks') {
    const hw = cw / 2, hh = ch / 2;
    const rect = (r, fill) => `<rect x="${num(pad + r.x * hw)}" y="${num(pad + r.y * hh)}" width="${num(r.w * hw)}" `
      + `height="${num(r.h * hh)}"${fill ? ` fill="${fill}"` : ''}/>`;
    const { bg, fg } = blockRects(grid);
    out.push(`<g shape-rendering="crispEdges" fill="${esc(ink)}">`);
    for (const r of bg) out.push(rect(r, r.fill));
    for (const r of fg) out.push(rect(r, r.fill));
    out.push('</g>');
  } else {
    // One x per glyph, anchored at the cell centre (as raster.js draws it): the grid is exact in
    // any viewer and any monospace font, and spaces need no whitespace handling to keep columns.
    const lines = plainText(grid).split('\n');
    const px = Math.min(cw / 0.6, ch / 1.05);           // monospace advance ~0.6 em
    const xs = Array.from({ length: cols }, (_, c) => num(pad + (c + 0.5) * cw)).join(' ');
    out.push(`<g fill="${esc(ink)}" font-family="${esc(font)}" font-size="${num(px)}" text-anchor="middle" `
      + 'style="font-variant-ligatures:none;font-kerning:none">');
    lines.forEach((line, row) => {
      const y = pad + row * ch + ch / 2 + 0.28 * px;      // baseline that centres the em box
      out.push(`<text xml:space="preserve" x="${xs}" y="${num(y)}">${esc(line)}</text>`);
    });
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}

// ------------------------------------------------------------------------------------ html

// Block cells in HTML are drawn by CSS, not by the font: Windows has no monospace font with the
// quadrants (Consolas falls back to Segoe UI Symbol, another width), so glyph art shears there.
// Each cell is a fixed-size inline-block whose quadrants are gradient layers in --f (the fg /
// ink) over --b (the bg); the character itself stays inside, transparent, so copy still works.
const QUAD_POS = ['0 0', '100% 0', '0 100%', '100% 100%'];   // UL, UR, LL, LR
function quadCss() {
  const rules = [];
  for (let m = 1; m < 16; m++) {
    const on = [0, 1, 2, 3].filter(k => (m >> k) & 1);
    const full = m === 15;
    const layers = full ? ['linear-gradient(var(--f),var(--f))'] : on.map(() => 'linear-gradient(var(--f),var(--f))');
    rules.push(`.q${m.toString(16)}{background-image:${layers.join(',')};background-size:${full ? '100% 100%' : on.map(() => '50% 50%').join(',')};`
      + `background-position:${full ? '0 0' : on.map(k => QUAD_POS[k]).join(',')}}`);
  }
  return rules.join('\n');
}

const cellHtml = v => {
  const mask = BLOCK_MASK.get(v) ?? 0;
  const ch = mask ? String.fromCodePoint(v) : ' ';
  return mask ? `<b class="q${mask.toString(16)}">${ch}</b>` : `<b>${ch}</b>`;
};

/**
 * Block rows as HTML: <span class> runs of equal fg + bg (colour) holding one <b> per cell.
 * Monochrome grids (or colour: false) get no spans: the cells use the page's ink.
 * -> { rows: string[], css: string, runs: number }
 */
export function colourSpans(grid, { colour = true } = {}) {
  const { cols, rows, cp } = grid;
  const fg = colour ? grid.fg : null, bg = colour ? grid.bg : null;
  const classes = new Map();
  const cls = (f, b) => {
    const key = f + '/' + b;
    let n = classes.get(key);
    if (n == null) { n = 'c' + classes.size.toString(36); classes.set(key, n); }
    return n;
  };
  const out = [];
  let runs = 0;
  for (let row = 0; row < rows; row++) {
    let s = '', open = null, buf = '';
    const flush = () => { if (open != null) { s += `<span class="${open}">${buf}</span>`; runs++; } buf = ''; };
    for (let c = 0; c < cols; c++) {
      const i = row * cols + c;
      if (fg || bg) {
        const k = cls(fg ? hex(fg[i]) : 'currentColor', bg ? hex(bg[i]) : 'transparent');
        if (k !== open) { flush(); open = k; }
        buf += cellHtml(cp[i]);
      } else s += cellHtml(cp[i]);
    }
    flush();
    out.push(s);
  }
  const css = [...classes].map(([key, n]) => {
    const [f, b] = key.split('/');
    return `.${n}{--f:${f};--b:${b}}`;
  }).join('\n');
  return { rows: out, css, runs };
}

// Braille on Windows: Segoe UI Symbol draws U+2800 about 0.1 em narrower than the dot patterns,
// which shears the art. Blank runs sit in <i>; this measures the two widths in the viewer's own
// font and pads each blank by the difference (0 wherever the font is uniform).
const BRAILLE_FIX = '<script>(function(){var p=document.querySelector("pre"),a=document.createElement("span"),'
  + 'b=document.createElement("span");a.textContent="\\u2800".repeat(40);b.textContent="\\u28ff".repeat(40);'
  + 'p.append(a,b);var g=(b.getBoundingClientRect().width-a.getBoundingClientRect().width)/40;a.remove();b.remove();'
  + 'if(Math.abs(g)>0.05)p.style.setProperty("--gap",g+"px")})()</script>';

/**
 * A standalone HTML page with the art in a <pre>, in the target's font size and line height (FIT).
 *   Braille  the text itself (blank runs in <i>, padded on fonts whose blank is narrower)
 *   ASCII    the text itself in a monospace stack
 *   blocks   one fixed-size cell per character drawn with CSS quadrants; colour grids group the
 *            cells in spans merging runs of equal fg / bg (colour: false = monochrome)
 * opts: { ink, paper, colour, target, title, font }
 */
export function exportHTML(grid, opts = {}) {
  const { ink = INK, paper = PAPER } = opts;
  const m = cellMetrics(grid, opts);
  const title = opts.title || describe(grid);
  const font = opts.font || (grid.mode === 'braille' ? BRAILLE_STACK : MONO_STACK);
  let body, extra = '', script = '';
  if (grid.mode === 'blocks') {
    const colour = !!(grid.fg || grid.bg) && opts.colour !== false;
    const spans = colourSpans(grid, { colour });
    body = spans.rows.join('\n');
    const cw = num(m.cellW / m.fontPx), lh = m.lineEm;
    extra = `\npre{--f:${ink};--b:transparent}\npre b{display:inline-block;width:${cw}em;height:${lh}em;vertical-align:top;`
      + 'overflow:hidden;color:transparent;font-weight:inherit;background-color:var(--b);background-repeat:no-repeat}\n'
      + quadCss() + (spans.css ? '\n' + spans.css : '');
  } else if (grid.mode === 'braille') {
    body = esc(plainText(grid)).replace(/⠀+/g, r => `<i>${r}</i>`);
    extra = '\npre i{font-style:normal;letter-spacing:var(--gap,0)}';
    script = '\n' + BRAILLE_FIX;
  } else {
    body = esc(plainText(grid));
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
html{background:${paper || 'transparent'};color:${ink}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
pre{margin:0;max-width:100%;overflow-x:auto;font-family:${font};font-size:${num(m.fontPx)}px;line-height:${m.lineEm};letter-spacing:0;font-kerning:none;font-variant-ligatures:none;tab-size:1}${extra}
</style>
</head>
<body>
<pre role="img" aria-label="${esc(title)}">${body}</pre>${script}
</body>
</html>
`;
}

// ------------------------------------------------------------------------------------ png

function makeCanvas(w, h) {
  if (globalThis.document) {
    const c = globalThis.document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new globalThis.OffscreenCanvas(w, h);
}
const toPNG = c => (c.convertToBlob ? c.convertToBlob({ type: 'image/png' })
  : new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png')));

// Web fonts (Geist Mono) must be loaded before raster.js measures them: it caches the fit.
async function fontReady(font, px) {
  const fonts = globalThis.document && globalThis.document.fonts;
  if (!fonts || !fonts.load) return;
  const t = new Promise(res => setTimeout(res, 1500));
  try { await Promise.race([fonts.load(`${Math.max(1, Math.round(px))}px ${font}`, 'M@#'), t]); } catch { /* system font */ }
}

/**
 * PNG Blob of the art. scale 2 = twice the preview metrics. transparent: no paper (colour blocks
 * still paint their own background). pad: margin in px (default one row height).
 * opts: { target, scale, ink, paper, transparent, pad, cellW, cellH, font, dotR }
 */
export async function exportPNG(grid, opts = {}) {
  const { ink = INK, paper = PAPER, transparent = false, font = MONO_STACK, dotR = 0.32 } = opts;
  let { cellW: cw, cellH: ch } = cellMetrics(grid, { scale: 2, ...opts });
  let pad = opts.pad ?? Math.round(ch);
  const size = () => [Math.ceil(grid.cols * cw + 2 * pad), Math.ceil(grid.rows * ch + 2 * pad)];
  let [W, H] = size();
  const k = Math.min(1, MAX_SIDE / Math.max(W, H), Math.sqrt(MAX_AREA / (W * H)));
  if (k < 1) { cw *= k; ch *= k; pad *= k; [W, H] = size(); }
  if (grid.mode === 'ascii') await fontReady(font, Math.min(cw / 0.6, ch / 1.05));
  const canvas = makeCanvas(Math.max(1, W), Math.max(1, H));
  const ctx = canvas.getContext('2d');
  if (!transparent && paper) { ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H); }
  drawGrid(ctx, grid, { x: pad, y: pad, cellW: cw, cellH: ch, ink, paper: null, font, dotR });
  const blob = await toPNG(canvas);
  if (canvas.width !== undefined && canvas.getContext) { canvas.width = 0; canvas.height = 0; }   // Safari frees now
  return blob;
}

export const svgBlob = svg => new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
export const htmlBlob = html => new Blob([html], { type: 'text/html;charset=utf-8' });

// ------------------------------------------------------------------------------------ download

/** Save a Blob through the browser's download flow. */
export function downloadBlob(blob, filename) {
  const d = globalThis.document;
  const url = URL.createObjectURL(blob);
  const a = d.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  d.body.append(a);            // Firefox only follows attached links
  a.click();
  a.remove();
  // Safari and Firefox read the URL after click() returns; revoke well afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

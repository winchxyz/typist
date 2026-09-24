// Chat previews: the art as it will look where it is pasted, at 1:1 CSS px on a phone-wide screen.
//
// The chrome is generic (DOM + CSS, class names .pv-*, the platform named in a text label, never a
// logo). The art is never drawn with the viewer's own fonts: Braille is exact dots (raster.js
// brailleGeometry) on the TARGET's cell metrics (targets.js FIT), so what fits here fits there, and
// the viewer's Braille font (Segoe UI Symbol on Windows draws U+2800 narrower) cannot lie.
// Rows wider than the text column wrap exactly as the app's text would: Braille has no break
// opportunities (U+2800 is a letter to the line breaker), so a row breaks at the cell that
// overflows; ASCII in a Telegram pre block breaks after spaces (pre-wrap: spaces hang at the line
// end), and mid-word only when a word alone is too wide. A wrapped row gets a red band and its row
// number in the gutter.
//
// Everything above renderPreview() is pure (node tests: tests/preview.test.mjs).

import { FIT, TARGETS } from './targets.js';
import { brailleGeometry, drawGrid } from './raster.js';

/** Segoe UI Symbol (every Windows app): U+2800 is 0.651 em wide, every dot pattern 0.753 em. */
export const WIN_BLANK_EM = 0.651, WIN_DOT_EM = 0.753;
export const WIN_BLANK_RATIO = WIN_BLANK_EM / WIN_DOT_EM;
/** Instagram folds tall comments behind "more" (same threshold as targets.js 'ig-more'). */
export const IG_MORE_ROWS = 12;
/** Set once the paste kit shows where (and whether) Instagram folds a tall comment. */
export const IG_FOLD_MEASURED = false;
export const MONO = '"Geist Mono", ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace';
const MONO_FALLBACK = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace';
const EPS = 1e-6;

const fitOf = (id, mode) => {
  const f = FIT[id] || FIT.plain;
  return f[mode] || f.braille || FIT.plain[mode] || FIT.plain.braille;
};

/**
 * Cell size on the target: width fontPx x cellEm, height fontPx x lineEm. On Windows a Braille
 * blank is WIN_BLANK_RATIO as wide as a dot cell (the shear); nothing else changes width.
 */
export function cellMetrics(target, mode, device = 'ios') {
  const f = fitOf(target, mode);
  const cellW = f.fontPx * f.cellEm, cellH = f.fontPx * f.lineEm;
  const shear = device === 'windows' && mode === 'braille';
  return { fontPx: f.fontPx, cellW, cellH, blankW: shear ? cellW * WIN_BLANK_RATIO : cellW, shear };
}

/**
 * Width of the target's text column in CSS px (the art's line box), consistent with maxCols():
 * exactly maxCols cells fit, one more wraps. phone: 360 | 390 | 430 | 'desktop'; plain = no limit.
 */
export function textWidth(target, mode, phone = 390) {
  if (target === 'plain') return Infinity;
  const f = fitOf(target, mode);
  const cw = f.fontPx * f.cellEm;
  if (phone === 'desktop') return f.chatDesktop != null ? f.chatDesktop : (f.desktop + 0.5) * cw;
  if (f.cols && f.cols[phone]) return (f.cols[phone] + 0.5) * cw;
  const [scale, minus] = f.text;
  return scale * phone - minus;
}

/**
 * Width of the whole preview screen in CSS px: the phone, or for the desktop apps a window just
 * wide enough for their text column (the inverse of the FIT text rule).
 */
export function screenWidth(target, mode, phone = 390) {
  if (typeof phone === 'number') return phone;
  const f = fitOf(target, mode);
  const [scale, minus] = f.text;
  return Math.ceil((textWidth(target, mode, phone) + minus) / scale);
}

/** Advance of each cell of one row. */
export function cellWidths(cells, m) {
  const w = new Float64Array(cells.length);
  for (let i = 0; i < cells.length; i++) w[i] = m.shear && cells[i] === 0x2800 ? m.blankW : m.cellW;
  return w;
}

/**
 * Break one row into lines of at most maxW px, the way a text engine would.
 * breakSpaces: break opportunities after a run of U+0020 (ASCII in pre-wrap); spaces hang, so they
 * never overflow a line. Without it (Braille, blocks) the row breaks at the cell that overflows.
 * Returns [{ start, end, xs: Float64Array (x of each cell from the line start), width }].
 */
export function wrapRow(cells, widths, maxW, breakSpaces = false) {
  const n = cells.length, out = [];
  let start = 0;
  while (start < n) {
    let x = 0, i = start, brk = -1;
    for (; i < n; i++) {
      const space = breakSpaces && cells[i] === 0x20;
      if (breakSpaces && i > start && !space && cells[i - 1] === 0x20) brk = i;
      if (!space && i > start && x + widths[i] > maxW + EPS) break;
      x += widths[i];
    }
    const end = i < n && brk > start ? brk : i;
    const xs = new Float64Array(end - start);
    let ax = 0, width = 0;
    for (let k = start; k < end; k++) {
      xs[k - start] = ax;
      ax += widths[k];
      // hanging spaces do not widen the line box
      if (!(breakSpaces && cells[k] === 0x20)) width = ax;
    }
    out.push({ start, end, xs, width: Math.min(width, maxW) });
    start = end;
  }
  if (!out.length) out.push({ start: 0, end: 0, xs: new Float64Array(0), width: 0 });
  return out;
}

/**
 * Lay out every row: rows = arrays of code points. Returns
 *   { lines: [{ row, start, end, xs, width }], rowLine: first line index per row, rowSpan: lines per
 *     row, wrappedRows: 0-based rows that took more than one line, width, height, cellW, cellH }
 */
export function layoutArt(rows, mode, m, maxW) {
  const lines = [], rowLine = [], rowSpan = [], wrappedRows = [];
  let width = 0;
  const breakSpaces = mode === 'ascii';
  rows.forEach((cells, r) => {
    const parts = wrapRow(cells, cellWidths(cells, m), maxW, breakSpaces);
    rowLine.push(lines.length);
    rowSpan.push(parts.length);
    if (parts.length > 1) wrappedRows.push(r);
    for (const p of parts) { lines.push({ row: r, ...p }); width = Math.max(width, p.width); }
  });
  return { lines, rowLine, rowSpan, wrappedRows, width, height: lines.length * m.cellH, cellW: m.cellW, cellH: m.cellH };
}

/**
 * Single-line chats (Twitch, YouTube live chat) have no line breaks: the message is one paragraph,
 * the rows are words (unbroken runs of Braille) joined by single spaces, and the chat's word wrap
 * decides where each one lands. Lay that out like the chat does, greedy, first line after the
 * username (`firstIndent`). A row wider than the chat itself breaks inside (overflow-wrap), which
 * destroys the art: it is split like wrapRow and reported in wrappedRows.
 *   -> the layoutArt shape, plus per-line `line` / `x0`, `lineCount` and `stacked` (every row on a
 *      line of its own, the only case where the art survives)
 */
export function layoutFlow(rows, mode, m, { chatW, firstIndent = 0, spaceW = 0 } = {}) {
  const lines = [], rowLine = [], rowSpan = [], wrappedRows = [];
  let line = 0, x = firstIndent, right = 0, stacked = true;
  const onLine = new Map();
  rows.forEach((cells, r) => {
    const widths = cellWidths(cells, m);
    let w = 0;
    for (const v of widths) w += v;
    if (x > 0 && x + w > chatW + EPS) { line++; x = 0; }
    if (w > chatW + EPS) {
      // too wide even alone: the chat breaks the word at its edge
      const parts = wrapRow(cells, widths, chatW, false);
      if (x > 0) { line++; x = 0; }
      rowLine.push(line); rowSpan.push(parts.length); wrappedRows.push(r);
      for (const pt of parts) { lines.push({ row: r, ...pt, line, x0: 0 }); right = Math.max(right, pt.width); line++; }
      line--; x = parts[parts.length - 1].width + spaceW;
      stacked = false;
      return;
    }
    const xs = new Float64Array(cells.length);
    let ax = 0;
    for (let k = 0; k < cells.length; k++) { xs[k] = ax; ax += widths[k]; }
    lines.push({ row: r, start: 0, end: cells.length, xs, width: w, line, x0: x });
    rowLine.push(line); rowSpan.push(1);
    onLine.set(line, (onLine.get(line) || 0) + 1);
    right = Math.max(right, x + w);
    x += w + spaceW;
  });
  for (const n of onLine.values()) if (n > 1) stacked = false;
  const lineCount = rows.length ? line + 1 : 0;
  return { lines, rowLine, rowSpan, wrappedRows, width: Math.min(Math.max(right, 1), chatW), height: lineCount * m.cellH,
           cellW: m.cellW, cellH: m.cellH, lineCount, stacked };
}

/**
 * The chat widths in which rows of these widths stack one per line: a row must fit (width >= the
 * widest row) and two rows plus a space must not (width < narrowest + space + narrowest).
 */
export function flowRange(rowWidths, spaceW) {
  if (!rowWidths.length) return { min: 0, max: Infinity };
  const widest = Math.max(...rowWidths), narrowest = Math.min(...rowWidths);
  return { min: widest, max: rowWidths.length > 1 ? 2 * narrowest + spaceW : Infinity };
}

/**
 * Windows shear per row: how far the row's first dot sits left of where a phone draws it
 * (0 or negative px), = -(blanks before it) x (dot width - blank width). Rows without dots: 0.
 */
export function shearOffsets(rows, m) {
  return rows.map(cells => {
    let k = 0;
    for (const c of cells) { if (c !== 0x2800) break; k++; }
    return k === cells.length || !m.shear ? 0 : -k * (m.cellW - m.blankW);
  });
}

/**
 * The art rows exactly as pasted (fence stripped) as code point arrays. A single-line chat's
 * message is one line of words: each word is a row, the blank lead-in first.
 */
export function payloadRows(payload, grid) {
  let mode = (payload && payload.mode) || (grid && grid.mode) || 'braille';
  let rows;
  if (payload && typeof payload.text === 'string') {
    let body = payload.text;
    if (mode === 'ascii') body = body.replace(/^```\n/, '').replace(/\n```$/, '');
    if (payload.target === 'reddit') body = body.split('\n').map(l => l.replace(/^ {4}/, '')).join('\n');
    const flow = !!(TARGETS[payload.target] && TARGETS[payload.target].flow);
    rows = body.split(flow ? ' ' : '\n').map(l => Array.from(l, ch => ch.codePointAt(0)));
  } else if (grid) {
    rows = [];
    for (let r = 0; r < grid.rows; r++) rows.push(Array.from(grid.cp.subarray(r * grid.cols, (r + 1) * grid.cols)));
  } else rows = [];
  return { mode, rows };
}

const PLACE = {
  ig: 'an Instagram comment', x: 'an X post', xlong: 'an X long post', tg: 'a Telegram message',
  tgc: 'a Telegram channel post', plain: 'a text file', reddit: 'a Reddit comment', ytc: 'a YouTube comment',
  steamc: 'a Steam comment', steamp: 'a Steam profile summary', steamb: 'a Steam Custom Info Box',
  ytlive: 'YouTube live chat', twitch: 'Twitch chat',
};
export function ariaLabel(target, cols, rows, { caption = false, wrapped = 0, phone = 390 } = {}) {
  const place = target === 'tgc' && caption ? 'a Telegram photo caption' : PLACE[target] || 'a post';
  let s = `Text art of your photo, ${cols} by ${rows} characters, for ${place}`;
  if (wrapped) s += `. ${wrapped} ${wrapped === 1 ? 'row wraps' : 'rows wrap'} on a ${phone} px screen`;
  return s;
}

// ---------------------------------------------------------------------------------- palettes
// Platform-like, not copied: white / near-black grounds, the platform's text colour for the dots.
const PAL = {
  ig: {
    light: { bg: '#ffffff', head: '#ffffff', text: '#0c1014', muted: '#737373', line: '#ececec', accent: '#3b7bf5', avatar: '#dcdde1', glyph: '#ffffff' },
    dark: { bg: '#000000', head: '#000000', text: '#f5f5f5', muted: '#a8a8a8', line: '#262626', accent: '#6aa3ff', avatar: '#3a3b3f', glyph: '#8e8f94' },
  },
  x: {
    light: { bg: '#ffffff', head: 'rgba(255,255,255,.92)', text: '#0f1419', muted: '#536471', line: '#eff3f4', accent: '#1d8cd8', avatar: '#cfd9de', glyph: '#ffffff' },
    dark: { bg: '#000000', head: 'rgba(0,0,0,.9)', text: '#e7e9ea', muted: '#71767b', line: '#2f3336', accent: '#3aa0ec', avatar: '#333639', glyph: '#8b8f93' },
  },
  tg: {
    light: { bg: '#dfe6ed', head: '#ffffff', text: '#0b0d0f', muted: '#707579', line: '#e4e7ea', accent: '#2f86de',
             bubble: '#e3f6d3', meta: '#4f9a4a', card: '#ffffff', cardMeta: '#8a9199', pre: 'rgba(40,90,30,.08)', preBar: '#6cb562',
             avatar: 'linear-gradient(160deg,#8fc7f7,#4c8fd6)', glyph: '#ffffff' },
    dark: { bg: '#0f1720', head: '#17212b', text: '#f5f7fa', muted: '#7f91a4', line: '#0d141b', accent: '#6ab2f2',
            bubble: '#2a4f73', meta: '#8fb3d9', card: '#1a2633', cardMeta: '#71849a', pre: 'rgba(0,0,0,.22)', preBar: '#7fb9ee',
            avatar: 'linear-gradient(160deg,#6a9fd6,#3b6ea8)', glyph: '#ffffff' },
  },
  plain: {
    light: { bg: '#f2f0eb', head: '#faf9f6', text: '#17171a', muted: '#6e6a63', line: '#e3dfd7', accent: '#2448c8', card: '#ffffff' },
    dark: { bg: '#161514', head: '#1f1e1c', text: '#edeae4', muted: '#a19c93', line: '#2e2c29', accent: '#8aa6ff', card: '#232220' },
  },
};
PAL.rd = {
  light: { bg: '#ffffff', head: '#ffffff', text: '#101517', muted: '#5c6c73', line: '#e6ebed', accent: '#2f6fd6',
           avatar: '#d7dde0', glyph: '#ffffff', code: '#eef1f3' },
  dark: { bg: '#0d1113', head: '#0d1113', text: '#eaf0f2', muted: '#8a9ba3', line: '#232b2f', accent: '#7ab0ff',
          avatar: '#2f3a3f', glyph: '#9aa8ae', code: '#1b2226' },
};
PAL.yt = {
  light: { bg: '#ffffff', head: '#ffffff', text: '#0f0f0f', muted: '#606060', line: '#e5e5e5', accent: '#1a63d8', avatar: '#d9d9d9', glyph: '#ffffff' },
  dark: { bg: '#0f0f0f', head: '#0f0f0f', text: '#f1f1f1', muted: '#aaaaaa', line: '#272727', accent: '#6db3ff', avatar: '#3f3f3f', glyph: '#aaaaaa' },
};
// Steam has no light mode: both themes show its dark slate
const STEAM = { bg: '#1b1f25', head: '#171a1f', text: '#c6d0db', muted: '#7d8894', line: '#2a3038', accent: '#8fc4e8',
                avatar: '#39424d', glyph: '#9aa6b2', card: '#232830' };
PAL.steam = { light: STEAM, dark: STEAM };
PAL.chat = {
  light: { bg: '#f7f7f8', head: '#ffffff', text: '#0e0e10', muted: '#53535f', line: '#e3e3e8', accent: '#6b3fd1', avatar: '#dcdce1', glyph: '#ffffff' },
  dark: { bg: '#18181b', head: '#1f1f23', text: '#efeff1', muted: '#adadb8', line: '#2c2c31', accent: '#b294ff', avatar: '#3a3a3d', glyph: '#adadb8' },
};
const FAMILY = { ig: 'ig', x: 'x', xlong: 'x', tg: 'tg', tgc: 'tg', plain: 'plain', reddit: 'rd', ytc: 'yt',
                 steamc: 'steam', steamp: 'steam', steamb: 'steam', ytlive: 'chat', twitch: 'chat' };
const BAD = { light: { band: 'rgba(209,31,31,.14)', pill: '#d11f1f', pillText: '#ffffff' },
              dark: { band: 'rgba(255,123,112,.16)', pill: '#ff7b70', pillText: '#2a0c09' } };
const FONTS = {
  ios: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif',
  android: 'Roboto, "Google Sans Text", system-ui, "Segoe UI", sans-serif',
  windows: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
};
const RADIUS = { ios: 22, android: 18, windows: 8 };

export function palette(target, theme = 'light') {
  return PAL[FAMILY[target] || 'plain'][theme === 'dark' ? 'dark' : 'light'];
}

// ---------------------------------------------------------------------------------- DOM
const CSS = `
.pv{position:relative;overflow:hidden;background:var(--pv-bg);color:var(--pv-text);font:400 15px/1.3 var(--pv-font);
  border-radius:var(--pv-r);-webkit-font-smoothing:antialiased;text-align:left;isolation:isolate;
  box-shadow:0 0 0 1px var(--pv-edge),0 18px 40px -22px rgba(0,0,0,.35)}
.pv *{box-sizing:border-box}
.pv svg{display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.pv-head{position:relative;display:flex;align-items:center;gap:10px;height:52px;padding:0 12px;background:var(--pv-head);
  border-bottom:1px solid var(--pv-line)}
.pv-head .pv-back{width:22px;height:22px;flex:none;color:var(--pv-text)}
.pv-titles{min-width:0;display:flex;flex-direction:column;line-height:1.2}
.pv-title{font-weight:600;font-size:16px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-sub{font-size:12.5px;color:var(--pv-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-ios .pv-head.pv-center .pv-titles{position:absolute;left:56px;right:56px;align-items:center;text-align:center}
.pv-grab{position:absolute;top:6px;left:50%;width:36px;height:4px;margin-left:-18px;border-radius:2px;background:var(--pv-line)}
.pv-av{flex:none;border-radius:50%;background:var(--pv-avatar);color:var(--pv-glyph);display:grid;place-items:center;overflow:hidden}
.pv-av svg{fill:currentColor;stroke:none}
.pv-av b{font:600 15px/1 var(--pv-font);color:#fff}
.pv-muted{color:var(--pv-muted)}
.pv-artwrap{position:relative}
.pv-art{position:relative;z-index:1;display:block}
.pv-band{position:absolute;left:-2000px;right:-2000px;z-index:0;background:var(--pv-band);pointer-events:none}
.pv-over{position:absolute;z-index:1;background:var(--pv-band);pointer-events:none}
.pv-edge{position:absolute;top:-8px;bottom:-4px;z-index:3;width:0;border-left:1.5px dashed var(--pv-pill);pointer-events:none}
.pv-edge span{position:absolute;top:-16px;left:5px;font:600 10.5px/14px var(--pv-font);color:var(--pv-pill);white-space:nowrap}
.pv-rowno{position:absolute;right:calc(100% + 4px);z-index:2;height:15px;min-width:17px;padding:0 4px;border-radius:5px;
  background:var(--pv-pill);color:var(--pv-pill-text);font:700 10px/15px var(--pv-font);text-align:center;
  font-variant-numeric:tabular-nums;pointer-events:none}
.pv-fold{position:absolute;left:0;right:0;z-index:2;height:0;border-top:1.5px dashed var(--pv-fold);pointer-events:none}
.pv-fold span{position:absolute;right:0;top:-10px;padding:0 0 0 8px;background:var(--pv-fold-bg);color:var(--pv-fold);
  font:600 13px/18px var(--pv-font)}
.pv-chip{position:absolute;z-index:3;top:8px;right:8px;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;
  border:0;border-radius:14px;background:rgba(20,20,22,.78);color:#fff;font:600 12.5px/1 var(--pv-font);cursor:pointer;
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.pv-dark .pv-chip{background:rgba(245,245,247,.9);color:#111}

.pv-ig .pv-head{height:58px;justify-content:center;padding-top:6px}
.pv-ig .pv-titles{align-items:center;text-align:center}
.pv-ytrow{position:relative;display:grid;grid-template-columns:36px auto;column-gap:12px;padding:14px 16px 8px}
.pv-ytrow .pv-av{width:36px;height:36px}
.pv-ytname{display:flex;gap:6px;align-items:baseline;font-size:12.5px;line-height:18px;margin-bottom:4px}
.pv-ytname b{font-weight:500}
.pv-ytacts{display:flex;align-items:center;gap:18px;height:34px;margin-top:4px;font-size:12px;font-weight:500;color:var(--pv-muted)}
.pv-ytacts span{display:inline-flex;align-items:center;gap:6px}
.pv-ytacts svg{width:16px;height:16px}
.pv-stbox{margin:12px;padding:10px 12px 12px;border-radius:4px;background:var(--pv-card)}
.pv-stname{display:flex;align-items:center;gap:8px;font-size:12.5px;line-height:18px;margin-bottom:8px}
.pv-stname i{flex:none;width:28px;height:28px;border-radius:3px;background:var(--pv-avatar)}
.pv-stname b{font-weight:600;color:var(--pv-accent)}
.pv-stlabel{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--pv-muted);margin-bottom:8px}
.pv-chat{display:flex;flex-direction:column;gap:6px;padding:10px 10px 12px}
.pv-chatmsg{font-size:13px;line-height:20px}
.pv-chatmsg b{font-weight:700;color:var(--pv-accent)}
.pv-chatart{position:relative}
.pv-chatname{position:absolute;left:0;top:0;z-index:2;font-weight:700;font-size:13px;color:var(--pv-accent);white-space:nowrap}
.pv-flowcap{margin-top:6px;font-size:11.5px;line-height:16px;color:var(--pv-muted)}
.pv-rdrow{position:relative;padding:12px 14px 10px 14px}
.pv-rdname{display:flex;align-items:center;gap:7px;font-size:12.5px;line-height:18px;margin-bottom:8px}
.pv-rdname .pv-av{width:24px;height:24px}
.pv-rdname b{font-weight:600}
.pv-rdcode{position:relative;padding:9px 10px;border-radius:6px;background:var(--pv-code);overflow:hidden}
.pv-rdacts{display:flex;align-items:center;gap:14px;height:34px;margin-top:6px;font-size:12px;font-weight:600;color:var(--pv-muted)}
.pv-rdacts span{display:flex;align-items:center;gap:5px}
.pv-rdacts svg{width:16px;height:16px}
.pv-igrow{position:relative;display:grid;grid-template-columns:32px auto;column-gap:12px;padding:14px 0 16px 16px}
.pv-igrow .pv-av{width:32px;height:32px}
.pv-igname{font-size:13px;line-height:18px;margin-bottom:2px}
.pv-igname b{font-weight:600}
.pv-igfoot{display:flex;gap:16px;margin-top:6px;font-size:12px;font-weight:600;color:var(--pv-muted)}
.pv-igheart{position:absolute;top:30px;right:10px;width:15px;height:15px;color:var(--pv-muted)}
.pv-igcompose{display:flex;align-items:center;gap:10px;margin:0 12px 12px;padding:0 6px 0 0;height:44px}
.pv-igcompose .pv-av{width:32px;height:32px}
.pv-igcompose i{flex:1;height:40px;border:1px solid var(--pv-line);border-radius:20px;font:400 14px/38px var(--pv-font);
  font-style:normal;color:var(--pv-muted);padding-left:14px}

.pv-xpost{display:grid;grid-template-columns:40px auto;column-gap:12px;padding:12px 16px 4px 16px;border-bottom:1px solid var(--pv-line)}
.pv-xpost .pv-av{width:40px;height:40px}
.pv-xname{display:flex;align-items:center;gap:4px;font-size:15px;line-height:20px;white-space:nowrap}
.pv-xname b{font-weight:700}
.pv-xname .pv-more{margin-left:auto;width:18px;height:18px;color:var(--pv-muted)}
.pv-xpost .pv-artwrap{margin-top:3px}
.pv-xacts{display:flex;justify-content:space-between;align-items:center;height:40px;margin-top:4px;color:var(--pv-muted);
  font-size:13px;font-variant-numeric:tabular-nums}
.pv-xacts span{display:flex;align-items:center;gap:5px}
.pv-xacts svg{width:18px;height:18px}

.pv-tg .pv-body{padding:10px 8px 12px;background:var(--pv-bg)}
.pv-tg .pv-head .pv-av{width:36px;height:36px}
.pv-tgday{display:table;margin:2px auto 10px;padding:3px 9px;border-radius:11px;background:rgba(0,0,0,.18);color:#fff;
  font:600 12.5px/16px var(--pv-font)}
.pv-dark .pv-tgday{background:rgba(255,255,255,.08);color:var(--pv-muted)}
.pv-bubble{position:relative;width:max-content;max-width:100%;margin-left:auto;padding:7px 12px 5px;background:var(--pv-bubble);
  border-radius:17px 17px 5px 17px;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.pv-android .pv-bubble{border-radius:14px 14px 4px 14px}
.pv-windows .pv-bubble{border-radius:10px 10px 3px 10px}
.pv-tgmeta{display:flex;justify-content:flex-end;align-items:center;gap:3px;margin-top:3px;font-size:12px;line-height:14px;
  color:var(--pv-meta);font-variant-numeric:tabular-nums}
.pv-tgmeta svg{width:17px;height:15px;stroke-width:1.7}
.pv-pre{position:relative;padding:7px 8px 7px 11px;border-radius:7px;background:var(--pv-pre)}
.pv-pre::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:7px 0 0 7px;background:var(--pv-prebar)}
.pv-bubble .pv-pre{margin:2px -6px 0}
.pv-card{position:relative;margin:0 auto;padding:8px 12px 6px;background:var(--pv-card);border-radius:15px;overflow:visible;
  box-shadow:0 1px 1px rgba(0,0,0,.08)}
.pv-android .pv-card{border-radius:12px}
.pv-windows .pv-card{border-radius:8px}
.pv-media{margin:-8px -12px 8px;height:156px;border-radius:inherit;border-bottom-left-radius:0;border-bottom-right-radius:0;overflow:hidden;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--pv-media-a),var(--pv-media-b));color:rgba(255,255,255,.75)}
.pv-media svg{width:34px;height:34px;stroke-width:1.5}
.pv-media img{width:100%;height:100%;object-fit:cover}
.pv-card .pv-tgmeta{color:var(--pv-cardmeta)}
.pv-card .pv-pre{margin:2px -4px 0}

.pv-plain .pv-body{padding:14px}
.pv-paper{overflow:hidden;padding:16px;background:var(--pv-card);border-radius:10px;box-shadow:0 0 0 1px var(--pv-line)}
.pv-paper canvas{max-width:100%;height:auto}

/* the app's tools sit in the header row (phones): no back arrow / avatar, the title centred between them */
.pv-head.pv-tools{height:56px;padding:0 12px}
.pv-head.pv-tools .pv-back,.pv-head.pv-tools .pv-av,.pv-head.pv-tools .pv-grab{display:none}
.pv-head.pv-tools .pv-titles{position:absolute;left:var(--pv-inset);right:var(--pv-inset);align-items:center;text-align:center}
.pv-head.pv-tools .pv-titles>*{max-width:100%}
/* a note from the app about this preview (dark mode shows the art as a negative) */
.pv-banner{display:flex;align-items:center;gap:8px;min-height:40px;padding:6px 8px 6px 14px;font:500 13px/1.3 var(--pv-font);
  background:rgba(36,72,200,.10);color:#2448c8;border-bottom:1px solid var(--pv-line)}
.pv-dark .pv-banner{background:rgba(138,166,255,.14);color:#b3c4ff}
.pv-banner span{flex:1;min-width:0}
.pv-banner button{flex:none;height:32px;padding:0 12px;border-radius:16px;border:1px solid currentColor;background:transparent;
  color:inherit;font:600 13px/1 var(--pv-font);cursor:pointer;position:relative}
.pv-banner button::after{content:"";position:absolute;inset:-6px}
/* Instagram "more": a mark in the avatar gutter, rows past it faded (the art itself stays clean) */
.pv-igfold{position:absolute;z-index:2;left:-44px;width:34px;pointer-events:none;border-top:1.5px dashed var(--pv-muted)}
.pv-igfold span{position:absolute;left:0;top:3px;font:600 11.5px/14px var(--pv-font);color:var(--pv-muted)}
`;

let styled = false;
function injectStyle(doc) {
  if (styled && doc.getElementById('pv-style')) return;
  const s = doc.createElement('style');
  s.id = 'pv-style';
  s.textContent = CSS;
  doc.head.appendChild(s);
  styled = true;
}

const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/>',
  reply: '<path d="M20.5 11.5c0 3.9-3.8 7-8.5 7-1.2 0-2.3-.2-3.4-.6L4 19.5l1.3-3.6a6.6 6.6 0 0 1-1.8-4.4c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/>',
  repost: '<path d="M16.5 3.5l3 3-3 3"/><path d="M19.5 6.5H8a3 3 0 0 0-3 3V11"/><path d="M7.5 20.5l-3-3 3-3"/><path d="M4.5 17.5H16a3 3 0 0 0 3-3V13"/>',
  views: '<path d="M5 20v-8M10 20V5M15 20v-5M20 20V9"/>',
  share: '<path d="M12 3.5v11M7.5 8L12 3.5 16.5 8"/><path d="M5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-5.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  checks: '<path d="M2.5 12.5l3.8 3.8L14 8.5"/><path d="M10.8 15.8l.9.8L19.5 8.5"/>',
  up: '<path d="M12 4.5l6.5 7.5h-4v7h-5v-7h-4z"/>',
  thumb: '<path d="M7.5 10.5v9h-3v-9zM7.5 10.5l3.6-6.2c1.2 0 2.1 1 1.9 2.2l-.6 3.4h5.3c1.1 0 1.9 1 1.7 2.1l-1.2 6.2c-.2.8-.9 1.3-1.7 1.3H7.5"/>',
  thumbdown: '<path d="M16.5 13.5v-9h3v9zM16.5 13.5l-3.6 6.2c-1.2 0-2.1-1-1.9-2.2l.6-3.4H6.3c-1.1 0-1.9-1-1.7-2.1l1.2-6.2c.2-.8.9-1.3 1.7-1.3h8.9"/>',
  down: '<path d="M12 19.5l6.5-7.5h-4v-7h-5v7h-4z"/>',
  eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.8 16.5l4.7-4.7 4 4 2.8-2.8 4.9 4.9"/><circle cx="15.5" cy="9.3" r="1.5"/>',
};
const svg = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
const PERSON = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:72%;height:72%;margin-top:22%"><circle cx="12" cy="8" r="4.6"/><path d="M2.5 24c.6-5.6 4.6-9 9.5-9s8.9 3.4 9.5 9z"/></svg>';

function el(doc, tag, cls, html) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function measureText(doc, font, text) {
  try {
    const ctx = doc.createElement('canvas').getContext('2d');
    ctx.font = font;
    const w = ctx.measureText(text).width;
    if (w > 0) return w;
  } catch { /* no canvas */ }
  return text.length * 7.6;
}

function header(doc, { title, sub, back = true, center = false, avatar = null }) {
  const h = el(doc, 'div', 'pv-head' + (center ? ' pv-center' : ''));
  if (back) h.insertAdjacentHTML('beforeend', svg('back', 'pv-back'));
  if (avatar) h.appendChild(avatar);
  const t = el(doc, 'div', 'pv-titles');
  t.appendChild(el(doc, 'div', 'pv-title')).textContent = title;
  if (sub) t.appendChild(el(doc, 'div', 'pv-sub')).textContent = sub;
  h.appendChild(t);
  return h;
}

const TITLES = {
  ig: { title: 'Comments', sub: 'Instagram' },
  x: { title: 'Post', sub: 'X' },
  xlong: { title: 'Post', sub: 'X · long post (Premium)' },
  tg: { title: 'Alex', sub: 'Telegram · online' },
  tgc: { title: 'Your channel', sub: 'Telegram channel · 1,204 subscribers' },
  plain: { title: 'Text file', sub: '' },
  reddit: { title: 'Comments', sub: 'Reddit' },
  ytc: { title: 'Comments', sub: 'YouTube' },
  steamc: { title: 'Comments', sub: 'Steam' },
  steamp: { title: 'Profile', sub: 'Steam · summary' },
  steamb: { title: 'Profile', sub: 'Steam · Custom Info Box' },
  ytlive: { title: 'Live chat', sub: 'YouTube' },
  twitch: { title: 'Stream chat', sub: 'Twitch' },
};

/**
 * Draw the laid-out art on a canvas at devicePixelRatio.
 * fadeFrom: first line drawn at `fadeAlpha` (X long below the fold).
 */
function paintArt(canvas, lay, rows, mode, ink, dpr, { family = MONO, fadeFrom = Infinity, fadeAlpha = 0.35, grid = null } = {}) {
  const W = Math.max(1, Math.ceil(lay.width)), H = Math.max(1, Math.ceil(lay.height));
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const { cellW, cellH } = lay;
  if (mode === 'braille') {
    // one path per alpha: thousands of dots in one fill
    const { r, centers } = brailleGeometry(cellW, cellH);
    const pass = (from, to, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ink;
      ctx.beginPath();
      for (let li = from; li < to; li++) {
        const L = lay.lines[li], cells = rows[L.row], y = (L.line ?? li) * cellH, x0 = L.x0 || 0;
        for (let k = L.start; k < L.end; k++) {
          const v = cells[k];
          const bits = v > 0x2800 && v <= 0x28ff ? v - 0x2800 : 0;
          if (!bits) continue;
          const ox = x0 + L.xs[k - L.start];
          for (let b = 0; b < 8; b++) {
            if (!((bits >> b) & 1)) continue;
            const cx = ox + centers[b][0], cy = y + centers[b][1];
            ctx.moveTo(cx + r, cy);
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
          }
        }
      }
      ctx.fill();
    };
    const n = lay.lines.length, f = Math.min(n, fadeFrom);
    pass(0, f, 1);
    if (f < n) pass(f, n, fadeAlpha);
    ctx.globalAlpha = 1;
    return;
  }
  // letters and blocks are uniform cells: one drawGrid per line (raster.js does glyph fitting)
  lay.lines.forEach((L, li) => {
    const n = L.end - L.start;
    if (!n) return;
    const src = rows[L.row];
    const cp = Uint32Array.from(src.slice(L.start, L.end));
    let fg = null, bg = null;
    if (grid && grid.fg && grid.cols === src.length) {
      const o = L.row * grid.cols;
      fg = grid.fg.subarray(o + L.start, o + L.end);
      bg = grid.bg ? grid.bg.subarray(o + L.start, o + L.end) : null;
    }
    ctx.globalAlpha = li >= fadeFrom ? fadeAlpha : 1;
    drawGrid(ctx, { mode, cols: n, rows: 1, cp, fg, bg }, { x: (L.x0 || 0) + L.xs[0], y: (L.line ?? li) * cellH, cellW, cellH, ink, font: family });
  });
  ctx.globalAlpha = 1;
}

/**
 * Render the preview into `host` (its content is replaced).
 *   { target, payload: formatFor() result, grid, device: 'ios'|'android'|'windows', theme: 'light'|'dark',
 *     phone: 360|390|430, opts: formatFor opts ({ caption, blank }), chip: { label, onClick } (optional),
 *     media: image URL for a channel caption (optional), dpr (optional, default devicePixelRatio) }
 * Returns { wrappedRows (0-based), cellW, cellH, lines, width, height, shear }.
 */
export function renderPreview(host, {
  target = 'ig', payload = null, grid = null, device = 'ios', theme = 'light', phone = 390, opts = {},
  chip = null, media = null, dpr = null, inset = 0, banner = null, wrapView = 'edge',
} = {}) {
  const doc = host.ownerDocument;
  injectStyle(doc);
  const { mode, rows } = payloadRows(payload, grid);
  let m = cellMetrics(target, mode, device);
  const flow = !!(TARGETS[target] && TARGETS[target].flow);
  // a stream chat on Windows is the desktop chat column
  const maxW = textWidth(target, mode, flow && device === 'windows' ? 'desktop' : phone);
  let lay, flowInfo = null;
  if (flow) {
    const f = FIT[target] && FIT[target][mode] ? FIT[target][mode] : {};
    const spaceW = (f.spaceEm || 0.27) * m.fontPx;
    const nameW = measureText(doc, `700 ${m.fontPx}px ${FONTS[device] || FONTS.ios}`, target === 'twitch' ? 'you:' : 'you');
    lay = layoutFlow(rows, mode, m, { chatW: maxW, firstIndent: nameW + spaceW, spaceW });
    const widths = rows.map(cells => { let w = 0; for (const v of cellWidths(cells, m)) w += v; return w; });
    flowInfo = { chatW: maxW, range: flowRange(widths, spaceW) };
    lay.width = maxW;
  } else lay = layoutArt(rows, mode, m, maxW);
  // Too wide for the screen: reflowed rows turn the art into a wall of broken lines nobody can
  // judge. By default the art stays whole, scaled into the column, with the screen's edge drawn
  // where the rows would break and the part past it tinted ('edge'); 'wrap' shows the reflow.
  const wrappedRows = lay.wrappedRows;
  let edge = null;
  if (!flow && wrappedRows.length && target !== 'plain' && wrapView !== 'wrap') {
    const full = layoutArt(rows, mode, m, Infinity);
    const s = Math.min(1, maxW / full.width);
    m = { ...m, cellW: m.cellW * s, cellH: m.cellH * s, blankW: m.blankW * s };
    lay = layoutArt(rows, mode, m, Infinity);
    edge = { x: maxW * s, rows: wrappedRows };
  }
  // a file has no text column: the whole art is shown, scaled into the frame (paper padding 16,
  // body padding 14 on each side)
  if (target === 'plain') {
    const room = (typeof phone === 'number' ? phone : 390) - 2 * 14 - 2 * 16;
    if (lay.width > room) {
      const k = room / lay.width;
      m = { ...m, cellW: m.cellW * k, cellH: m.cellH * k, blankW: m.blankW * k };
      lay = layoutArt(rows, mode, m, Infinity);
    }
  }
  const pal = palette(target, theme);
  const bad = BAD[theme === 'dark' ? 'dark' : 'light'];
  const fam = FAMILY[target] || 'plain';
  const caption = target === 'tgc' && !!(opts && opts.caption);
  const cols = (payload && payload.cols) || (grid && grid.cols) || (rows[0] ? rows[0].length : 0);
  const nRows = (payload && payload.rows) || (grid && grid.rows) || rows.length;
  const ratio = dpr || (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;

  // ---- screen
  const screen = el(doc, 'div', `pv pv-${fam} pv-t-${target} pv-${device} pv-${theme === 'dark' ? 'dark' : 'light'}`);
  const vars = {
    '--pv-bg': pal.bg, '--pv-head': pal.head, '--pv-text': pal.text, '--pv-muted': pal.muted, '--pv-line': pal.line,
    '--pv-avatar': pal.avatar || pal.line, '--pv-glyph': pal.glyph || pal.muted, '--pv-bubble': pal.bubble || pal.bg,
    '--pv-meta': pal.meta || pal.muted, '--pv-card': pal.card || pal.bg, '--pv-cardmeta': pal.cardMeta || pal.muted,
    '--pv-pre': pal.pre || 'transparent', '--pv-prebar': pal.preBar || pal.accent, '--pv-code': pal.code || 'transparent',
    '--pv-accent': pal.accent,
    '--pv-band': bad.band, '--pv-pill': bad.pill, '--pv-pill-text': bad.pillText,
    '--pv-font': FONTS[device] || FONTS.ios, '--pv-r': (RADIUS[device] ?? 18) + 'px',
    '--pv-edge': theme === 'dark' ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)',
    '--pv-media-a': theme === 'dark' ? '#2c3e52' : '#b9cde0', '--pv-media-b': theme === 'dark' ? '#1b2836' : '#8eaac6',
  };
  const screenW = screenWidth(target, mode, phone);
  screen.style.width = screenW + 'px';
  for (const k in vars) screen.style.setProperty(k, vars[k]);

  // ---- the art: canvas + marks, in a box exactly as wide as the text it replaces
  const art = el(doc, 'canvas', 'pv-art');
  art.setAttribute('role', 'img');
  art.setAttribute('aria-label', ariaLabel(target, cols, nRows, { caption, wrapped: wrappedRows.length, phone }));
  const wrap = el(doc, 'div', 'pv-artwrap');
  wrap.appendChild(art);
  const colW = Number.isFinite(maxW) ? maxW : lay.width;
  // IG and X lay text in a full-width column; bubbles and cards shrink to the art
  if (fam === 'ig' || fam === 'x' || fam === 'yt' || fam === 'steam') wrap.style.width = colW + 'px';
  else wrap.style.width = Math.ceil(lay.width) + 'px';
  if (edge) {
    // the screen's edge: every row that runs past it breaks there on the real screen
    for (const r of edge.rows) {
      const tint = el(doc, 'div', 'pv-over');
      tint.style.left = edge.x + 'px';
      tint.style.top = (lay.rowLine[r] * m.cellH) + 'px';
      tint.style.width = Math.max(0, lay.width - edge.x) + 'px';
      tint.style.height = m.cellH + 'px';
      tint.setAttribute('aria-hidden', 'true');
      wrap.appendChild(tint);
    }
    const line = el(doc, 'div', 'pv-edge');
    line.style.left = edge.x + 'px';
    line.setAttribute('aria-hidden', 'true');
    line.appendChild(el(doc, 'span')).textContent = phone === 'desktop' ? 'window edge' : 'screen edge';
    wrap.appendChild(line);
  }
  if (flow && !lay.stacked) {
    const perLine = new Map();
    for (const L of lay.lines) perLine.set(L.line, (perLine.get(L.line) || 0) + 1);
    for (const [line, n] of perLine) {
      if (n < 2) continue;
      const band = el(doc, 'div', 'pv-band');
      band.style.top = (line * m.cellH + 1) + 'px'; band.style.height = (m.cellH - 2) + 'px';
      band.setAttribute('aria-hidden', 'true');
      wrap.appendChild(band);
    }
  }
  for (const r of edge ? [] : lay.wrappedRows) {
    const top = lay.rowLine[r] * m.cellH, h = lay.rowSpan[r] * m.cellH;
    const band = el(doc, 'div', 'pv-band');
    // 1 px short at each end, so two wrapped rows in a row still read as two bands
    band.style.top = (top + 1) + 'px'; band.style.height = (h - 2) + 'px';
    const no = el(doc, 'div', 'pv-rowno');
    no.textContent = String(r + 1);
    no.style.top = (top + (m.cellH - 15) / 2) + 'px';
    band.setAttribute('aria-hidden', 'true'); no.setAttribute('aria-hidden', 'true');
    wrap.append(band, no);
  }
  // folds: X long "Show more" (certain, rows below fade) and Instagram's "more" for tall comments
  let fadeFrom = Infinity;
  const addFold = (row, label, colour, bg) => {
    if (row == null || row <= 0 || row >= rows.length) return;
    const f = el(doc, 'div', 'pv-fold');
    f.style.top = (lay.rowLine[row] * m.cellH) + 'px';
    f.style.setProperty('--pv-fold', colour);
    f.style.setProperty('--pv-fold-bg', bg);
    f.setAttribute('aria-hidden', 'true');
    f.appendChild(el(doc, 'span')).textContent = label;
    wrap.appendChild(f);
  };
  if (target === 'xlong' && payload && payload.foldRow != null) {
    addFold(payload.foldRow, 'Show more', pal.accent, pal.bg);
    fadeFrom = lay.rowLine[payload.foldRow] ?? Infinity;
  }
  // Instagram's fold point for tall comments is not measured yet (paste kit); until it is, the
  // preview draws the whole comment rather than fading rows that may well show in full.
  const igMore = IG_FOLD_MEASURED && target === 'ig' && (rows.length > IG_MORE_ROWS ||
    (payload && (payload.warnings || []).some(w => w.code === 'ig-more')));
  if (igMore) {
    const row = Math.min(IG_MORE_ROWS, rows.length - 1);
    if (row > 0 && Number.isFinite(lay.rowLine[row])) {
      const f = el(doc, 'div', 'pv-igfold');
      f.style.top = (lay.rowLine[row] * m.cellH) + 'px';
      f.setAttribute('aria-hidden', 'true');
      f.appendChild(el(doc, 'span')).textContent = 'more';
      wrap.appendChild(f);
      fadeFrom = Math.min(fadeFrom, lay.rowLine[row]);
    }
  }

  let chipEl = null;
  if (chip && chip.label) {
    chipEl = el(doc, 'button', 'pv-chip');
    chipEl.type = 'button';
    chipEl.textContent = chip.label;
    if (chip.onClick) chipEl.addEventListener('click', chip.onClick);
  }

  // ---- chrome per platform
  const t = TITLES[target] || TITLES.plain;
  const head = h => {
    if (inset > 0) { h.classList.add('pv-tools'); h.style.setProperty('--pv-inset', inset + 'px'); }
    screen.appendChild(h);
    if (banner && banner.text) {
      const b = el(doc, 'div', 'pv-banner');
      b.appendChild(el(doc, 'span')).textContent = banner.text;
      if (banner.action) {
        const btn = el(doc, 'button');
        btn.type = 'button';
        btn.textContent = banner.action;
        if (banner.onAction) btn.addEventListener('click', banner.onAction);
        b.appendChild(btn);
      }
      screen.appendChild(b);
    }
  };
  const avatar = (size, letter) => {
    const a = el(doc, 'div', 'pv-av');
    a.style.width = a.style.height = size + 'px';
    if (letter) a.innerHTML = `<b>${letter}</b>`; else a.innerHTML = PERSON;
    return a;
  };
  if (fam === 'ig') {
    const h = header(doc, { ...t, back: false, center: true });
    h.prepend(el(doc, 'span', 'pv-grab'));
    head(h);
    const row = el(doc, 'div', 'pv-igrow');
    row.appendChild(avatar(32));
    const col = el(doc, 'div', 'pv-col');
    col.appendChild(el(doc, 'div', 'pv-igname', '<b>you</b> <span class="pv-muted">now</span>'));
    col.appendChild(wrap);
    col.appendChild(el(doc, 'div', 'pv-igfoot', '<span>Reply</span>'));
    row.appendChild(col);
    row.insertAdjacentHTML('beforeend', svg('heart', 'pv-igheart'));
    if (chipEl) row.appendChild(chipEl);
    screen.appendChild(row);
    // the compose row is scenery: phones (tools in the header) spend the height on the art
    if (!(inset > 0)) {
      const comp = el(doc, 'div', 'pv-igcompose');
      comp.appendChild(avatar(32));
      comp.appendChild(el(doc, 'i', '', 'Add a comment…'));
      screen.appendChild(comp);
    }
  } else if (fam === 'x') {
    head(header(doc, { ...t, center: true }));
    const post = el(doc, 'div', 'pv-xpost');
    post.appendChild(avatar(40));
    const col = el(doc, 'div', 'pv-col');
    col.appendChild(el(doc, 'div', 'pv-xname', `<b>You</b><span class="pv-muted">@you · now</span>${svg('more', 'pv-more')}`));
    col.appendChild(wrap);
    col.appendChild(el(doc, 'div', 'pv-xacts',
      `<span>${svg('reply')}</span><span>${svg('repost')}</span><span>${svg('heart')}</span><span>${svg('views')}</span><span>${svg('share')}</span>`));
    post.appendChild(col);
    if (chipEl) { post.style.position = 'relative'; post.appendChild(chipEl); }
    screen.appendChild(post);
  } else if (fam === 'tg') {
    const channel = target === 'tgc';
    head(header(doc, { ...t, avatar: avatar(36, channel ? 'Y' : 'A') }));
    const body = el(doc, 'div', 'pv-body');
    const holder = mode === 'ascii' ? el(doc, 'div', 'pv-pre') : null;
    if (holder) holder.appendChild(wrap);
    if (channel) {
      body.appendChild(el(doc, 'div', 'pv-tgday', 'Today'));
      const card = el(doc, 'div', 'pv-card');
      // the card is the text column + its padding, as wide as a channel post gets
      card.style.width = (Math.ceil(colW) + 24 + (holder ? 15 : 0)) + 'px';
      if (caption) {
        const pic = el(doc, 'div', 'pv-media');
        if (typeof media === 'string') { const img = doc.createElement('img'); img.alt = ''; img.src = media; pic.appendChild(img); }
        else pic.innerHTML = svg('image');
        card.appendChild(pic);
      }
      card.appendChild(holder || wrap);
      card.appendChild(el(doc, 'div', 'pv-tgmeta', `${svg('eye')}<span>1.2K</span><span>&nbsp;9:41</span>`));
      if (chipEl) card.appendChild(chipEl);
      body.appendChild(card);
    } else {
      body.appendChild(el(doc, 'div', 'pv-tgday', 'Today'));
      const bubble = el(doc, 'div', 'pv-bubble');
      bubble.appendChild(holder || wrap);
      bubble.appendChild(el(doc, 'div', 'pv-tgmeta', `<span>9:41</span>${svg('checks')}`));
      if (chipEl) bubble.appendChild(chipEl);
      body.appendChild(bubble);
    }
    screen.appendChild(body);
  } else if (fam === 'yt') {
    head(header(doc, { ...t, center: true }));
    const row = el(doc, 'div', 'pv-ytrow');
    row.appendChild(avatar(36));
    const col = el(doc, 'div', 'pv-col');
    col.appendChild(el(doc, 'div', 'pv-ytname', '<b>@you</b><span class="pv-muted">1 minute ago</span>'));
    col.appendChild(wrap);
    col.appendChild(el(doc, 'div', 'pv-ytacts', `<span>${svg('thumb')}1</span><span>${svg('thumbdown')}</span><span>Reply</span>`));
    row.appendChild(col);
    if (chipEl) row.appendChild(chipEl);
    screen.appendChild(row);
  } else if (fam === 'steam') {
    head(header(doc, { ...t, center: true }));
    const box = el(doc, 'div', 'pv-stbox');
    if (target === 'steamc') box.appendChild(el(doc, 'div', 'pv-stname', '<i></i><b>you</b><span class="pv-muted">Just now</span>'));
    else box.appendChild(el(doc, 'div', 'pv-stlabel')).textContent = target === 'steamb' ? 'Custom Info Box' : 'Summary';
    box.appendChild(wrap);
    if (chipEl) { box.style.position = 'relative'; box.appendChild(chipEl); }
    screen.appendChild(box);
  } else if (fam === 'chat') {
    head(header(doc, { ...t, center: true }));
    const body = el(doc, 'div', 'pv-chat');
    const colon = target === 'twitch' ? ':' : '';
    for (const [n, msg] of [['nightowl', 'that jump was clean'], ['mira_k', 'gg'], ['pixelfox', 'art incoming?']]) {
      const line = el(doc, 'div', 'pv-chatmsg');
      line.appendChild(el(doc, 'b')).textContent = n + colon;
      line.appendChild(doc.createTextNode(' ' + msg));
      body.appendChild(line);
    }
    const msg = el(doc, 'div', 'pv-chatart');
    msg.style.width = Math.round(flowInfo.chatW) + 'px';
    const name = el(doc, 'b', 'pv-chatname');
    name.textContent = 'you' + colon;
    name.style.lineHeight = m.cellH + 'px';
    msg.append(name, wrap);
    body.appendChild(msg);
    const r = flowInfo.range;
    body.appendChild(el(doc, 'div', 'pv-flowcap')).textContent = Number.isFinite(r.max)
      ? `Lines up in chats ${Math.ceil(r.min)}–${Math.floor(r.max)} px wide · this chat is ${Math.round(flowInfo.chatW)} px`
      : `This chat is ${Math.round(flowInfo.chatW)} px wide`;
    if (chipEl) { msg.appendChild(chipEl); }
    screen.appendChild(body);
  } else if (fam === 'rd') {
    head(header(doc, { ...t, center: true }));
    const row = el(doc, 'div', 'pv-rdrow');
    const name = el(doc, 'div', 'pv-rdname');
    name.appendChild(avatar(24));
    name.insertAdjacentHTML('beforeend', '<b>you</b><span class="pv-muted">· now</span>');
    row.appendChild(name);
    // a code block is a full-width box that scrolls sideways; the art sits at its left
    const code = el(doc, 'div', 'pv-rdcode');
    code.appendChild(wrap);
    row.appendChild(code);
    row.appendChild(el(doc, 'div', 'pv-rdacts',
      `<span>${svg('up')}1${svg('down')}</span><span>${svg('reply')}Reply</span><span>${svg('share')}Share</span>`));
    if (chipEl) row.appendChild(chipEl);
    screen.appendChild(row);
  } else {
    head(header(doc, { title: t.title, sub: `typist-${target === 'plain' ? 'file' : target}-${cols}x${nRows}.txt`, back: false }));
    const body = el(doc, 'div', 'pv-body');
    const paper = el(doc, 'div', 'pv-paper');
    paper.appendChild(wrap);
    if (chipEl) { paper.style.position = 'relative'; paper.appendChild(chipEl); }
    body.appendChild(paper);
    screen.appendChild(body);
  }
  host.replaceChildren(screen);

  // ---- paint (ASCII waits for Geist Mono; until then a fallback face, never a stale measurement)
  const ink = pal.text;
  const paint = family => paintArt(art, lay, rows, mode, ink, ratio, { family, fadeFrom, grid });
  if (mode === 'ascii' && doc.fonts && !doc.fonts.check(`${m.fontPx}px "Geist Mono"`)) {
    paint(MONO_FALLBACK);
    doc.fonts.load(`${m.fontPx}px "Geist Mono"`).then(f => { if (f.length && art.isConnected) paint(MONO); }).catch(() => {});
  } else paint(MONO);

  return { wrappedRows, cellW: m.cellW, cellH: m.cellH, lines: lay.lines.length,
           width: lay.width, height: lay.height, shear: m.shear, textWidth: maxW, screenWidth: screenW,
           edge: edge ? edge.x : null, stacked: flow ? lay.stacked : null, flowRange: flowInfo ? flowInfo.range : null };
}


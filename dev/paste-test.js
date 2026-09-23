// Real-device paste test kit. Two halves:
//  1. buildSuite(): every payload, built with the app's own modules (targets.js formatFor / rowsFor /
//     autoFit, links.js, convert.js + samples.js for real art), so the phone sees what the app ships.
//  2. kitRuntime(data): the page itself. Self-contained (no imports, no module scope) because
//     ?bake=1 inlines its source with the payloads as JSON into one file that works on its own.

import { createConverter } from '../js/convert.js';
import { encodeBraille } from '../js/dither.js';
import { loadSample } from '../js/samples.js';

const KIT_VERSION = 1;
const SITE_URL = 'https://winchxyz.github.io/typist/';
const B0 = 0x2800;
const BLANK = '⠀';
const FULL = '⣿';

// ---- the app's modules, with a flagged stand-in while one is missing --------------------------
// targets.js / count.js / links.js are written in parallel; the kit must still run (and say so
// loudly) if one is absent, so a phone test is never silently run against stand-in code.
const modules = {};
async function tryImport(name) {
  try { const m = await import(`../js/${name}.js`); modules[name] = 'real'; return m; } catch (e) {
    modules[name] = 'fallback (' + String(e.message || e).slice(0, 80) + ')';
    return null;
  }
}
const realTargets = await tryImport('targets');
const realCount = await tryImport('count');
const realLinks = await tryImport('links');

const X_W1 = [[0x0000, 0x10FF], [0x2000, 0x200D], [0x2010, 0x201F], [0x2032, 0x2037]];
const FB = {
  utf16Length: s => s.length,
  xWeightedLength(s) {
    let n = 0;
    for (const ch of s.normalize('NFC')) {
      const c = ch.codePointAt(0);
      n += X_W1.some(([a, b]) => c >= a && c <= b) ? 1 : 2;
    }
    return n;
  },
  LIMIT: { ig: 2200, x: 280, xlong: 25000, tg: 4096, tgc: 4096 },
  PHONE_COLS: { ig: 28, x: 30, xlong: 30, tg: 32, tgc: 32 },
  cellAspect: (t, mode) => (mode === 'ascii' ? 0.46 : 0.55),
  rowsFor: (cols, aspect) => Math.max(1, Math.round(cols * aspect)),
  lines(grid, blank) {
    const out = [];
    for (let r = 0; r < grid.rows; r++) {
      let s = '';
      for (let c = 0; c < grid.cols; c++) {
        let cp = grid.cp[r * grid.cols + c];
        if (grid.mode === 'braille' && (cp === B0 || cp === 0x20)) cp = blank === 'dot' ? 0x2840 : B0;
        s += String.fromCodePoint(cp);
      }
      out.push(s);
    }
    return out;
  },
  formatFor(target, grid, opts = {}) {
    const limit = target === 'tgc' && opts.caption ? 1024 : FB.LIMIT[target];
    let text, html = null;
    if (grid.mode === 'ascii') {
      const rows = FB.lines(grid).map(r => r.replace(/`/g, "'"));
      text = '```\n' + rows.join('\n') + '\n```';
      html = '<pre>' + escHtml(rows.join('\n')) + '</pre>';
    } else {
      text = FB.lines(grid, opts.blank).join('\n');
    }
    const count = target.startsWith('x') ? FB.xWeightedLength(text) : text.length;
    return { text, html, count, limit, fits: count <= limit, cols: grid.cols, rows: grid.rows, warnings: [] };
  },
  autoFit(target, mode, opts = {}) {
    const a = FB.cellAspect(target, mode);
    for (let cols = FB.PHONE_COLS[target]; cols > 4; cols--) {
      const rows = FB.rowsFor(cols, a);
      const cells = cols * rows + (rows - 1) + (mode === 'ascii' ? 8 : 0);
      const cost = target.startsWith('x') ? cols * rows * 2 + rows - 1 : cells;
      const limit = target === 'tgc' && opts.caption ? 1024 : FB.LIMIT[target];
      if (cost <= limit) return { cols, rows };
    }
    return { cols: 8, rows: 4 };
  },
  xIntentUrl: (text, path = 'post', url = null) => {
    const q = new URLSearchParams({ text });
    if (url) q.set('url', url);
    return `https://x.com/intent/${path}?${q}`.replace(/\+/g, '%20');
  },
  tgShareUrl: (text, url = SITE_URL) =>
    `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
};

// A real function that throws or returns the wrong shape must not take the whole kit down: fall back
// for that call and record it, so the banner says which payloads are not the app's.
function guarded(name, real, fb, valid) {
  if (!real) return fb;
  return (...args) => {
    try {
      const r = real(...args);
      if (valid(r)) return r;
      throw new Error('unexpected result ' + JSON.stringify(r).slice(0, 60));
    } catch (e) {
      modules.targets = `real, but ${name} fell back (${String(e.message || e).slice(0, 80)})`;
      return fb(...args);
    }
  };
}
const T = {
  formatFor: guarded('formatFor', realTargets?.formatFor, FB.formatFor, r => r && typeof r.text === 'string' && Number.isFinite(r.count)),
  autoFit: guarded('autoFit', realTargets?.autoFit, FB.autoFit, r => r && r.cols > 0 && r.rows > 0),
  rowsFor: realTargets?.rowsFor || FB.rowsFor,
  cellAspect: realTargets?.cellAspect || FB.cellAspect,
};
const utf16 = realCount?.utf16Length || FB.utf16Length;
const xWeighted = realCount?.xWeightedLength || FB.xWeightedLength;
const countOf = (target, text) => (target.startsWith('x') ? xWeighted(text) : utf16(text));
const limitOf = (target, opts = {}) => {
  const t = realTargets?.TARGETS?.[target];
  if (target === 'tgc' && opts.caption) return 1024;
  return (t && t.limit) || FB.LIMIT[target];
};
const unitOf = target => (target.startsWith('x') ? 'weighted' : 'UTF-16');

// links.js contract is not in SPEC yet: accept the likely names, else build the URL here.
function xIntent(text, path, url = null) {
  const f = realLinks?.xIntentUrl;
  if (f) {
    const u = f(text, url ? { url } : undefined);
    const alt = String(u).replace(/\/intent\/(post|tweet)\b/, `/intent/${path}`);
    // strip a url param the helper may add when the card wants text only
    if (!url) { const o = new URL(alt); o.searchParams.delete('url'); return o.href.replace(/\+/g, '%20'); }
    return alt;
  }
  modules.links = modules.links === 'real' ? 'real (no xIntentUrl)' : modules.links;
  return FB.xIntentUrl(text, path, url);
}
function tgShare(text) {
  const f = realLinks?.tgShareUrl || realLinks?.telegramShareUrl;
  return f ? f(text, SITE_URL) : FB.tgShareUrl(text);
}

function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---- dot drawing -> Braille Grid (encoded by the app's own dither.js encoder) ---------------------
function dotCanvas(cols, rows) {
  const W = cols * 2, H = rows * 4;
  const d = new Uint8Array(W * H);
  return {
    W, H, d,
    set(x, y) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) d[y * W + x] = 1; },
    rect(x0, y0, w, h) {
      for (let x = x0; x < x0 + w; x++) { this.set(x, y0); this.set(x, y0 + h - 1); }
      for (let y = y0; y < y0 + h; y++) { this.set(x0, y); this.set(x0 + w - 1, y); }
    },
    line(x0, y0, x1, y1) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
      for (let i = 0; i <= n; i++) this.set(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
    },
    ellipse(cx, cy, rx, ry) {
      for (let i = 0; i < 720; i++) { const a = i / 720 * Math.PI * 2; this.set(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
    },
    grid() { const g = encodeBraille(d, W, H); return { mode: 'braille', cols: g.cols, rows: g.rows, cp: g.cp, fg: null, bg: null, ink: g.ink }; },
  };
}
function gridFromRows(rows) {   // rows: arrays of code points, same length
  const cols = rows[0].length;
  const cp = new Uint32Array(cols * rows.length);
  rows.forEach((r, i) => cp.set(r, i * cols));
  return { mode: 'braille', cols, rows: rows.length, cp, fg: null, bg: null, ink: 0 };
}
function stackGrids(grids, cols) {   // same cols, one blank row between
  const rows = [];
  grids.forEach((g, k) => {
    if (k) rows.push(new Array(cols).fill(B0));
    for (let r = 0; r < g.rows; r++) rows.push(Array.from(g.cp.subarray(r * g.cols, (r + 1) * g.cols)));
  });
  return rows;
}

// Greedy split: join blocks with '\n' while the count stays within the limit.
function packBlocks(target, blocks, limit) {
  const out = [];
  let cur = null;
  for (const b of blocks) {
    const next = cur === null ? b : cur + '\n' + b;
    if (cur !== null && countOf(target, next) > limit) { out.push(cur); cur = b; } else cur = next;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// ---- the suite ------------------------------------------------------------------------------------
const BRAILLE_TARGETS = [
  { id: 'ig', name: 'Instagram comment', where: 'an Instagram comment box' },
  { id: 'x', name: 'X post', where: 'a new X post (you do not need to send it)' },
  { id: 'tg', name: 'Telegram message', where: 'a Telegram chat (Saved Messages is fine)' },
];

function card(o) {
  const limit = o.limit ?? limitOf(o.target, o.opts);
  const count = o.count ?? countOf(o.target, o.text);
  if (/\r/.test(o.text)) throw new Error('CR in payload ' + o.id);
  return {
    id: o.id, sec: o.sec, group: o.group || '', title: o.title, look: o.look, hint: o.hint || 'what you saw',
    kind: o.kind || 'copy', text: o.text, html: o.html || null, href: o.href || null,
    mono: !!o.mono, dark: !!o.dark, count, limit, unit: unitOf(o.target), target: o.target,
  };
}

function stairRow(n) {
  // cell count in ASCII digits + one U+2800, then n cells: full cell at both ends, a ruler between
  let s = String(n) + BLANK;
  for (let i = 1; i <= n; i++) s += i === 1 || i === n ? FULL : i % 10 === 0 ? '⠿' : '⠒';
  return s;
}

function brailleStairs(t) {
  const out = [];
  for (const W of [20, 24, 28, 32, 36]) {
    const rows = [W - 3, W - 2, W - 1, W].map(stairRow);
    const parts = packBlocks(t.id, rows, limitOf(t.id));
    parts.forEach((text, k) => out.push(card({
      id: `${t.id}.stair.${W}${parts.length > 1 ? String.fromCharCode(97 + k) : ''}`, sec: t.id, group: 'Width',
      target: t.id, text,
      title: `Width ${W - 3}–${W}${parts.length > 1 ? ` (part ${k + 1} of ${parts.length})` : ''}`,
      look: 'Each row starts with its cell count. Which is the largest count that stays on one line?',
      hint: 'largest count on one line, e.g. 27',
    })));
  }
  return out;
}

function shapesGrid() {
  const c = dotCanvas(20, 4);
  c.rect(0, 0, 12, 16);                  // box, cells 0-5
  c.line(14, 0, 25, 15);                 // diagonal, cells 7-12
  c.ellipse(33.5, 7.5, 5.5, 6.05);       // circle, cells 14-19 (0.55 aspect)
  return c.grid();
}
function columnsGrid() {
  const n = 12;
  const rows = [
    new Array(n).fill(0x28FF),
    new Array(n).fill(0x2847),                                   // left column only
    new Array(n).fill(0x28B8),                                   // right column only
    Array.from({ length: n }, (_, i) => (i % 2 ? 0x2847 : 0x28B8)), // right|left pairs should touch
    new Array(n).fill(0x28FF),
  ];
  return gridFromRows(rows);
}
function survivalGrid() {
  const n = 12;
  const full = new Array(n).fill(0x28FF), blank = new Array(n).fill(B0);
  const mid = Array.from({ length: n }, (_, i) => (i === 0 || i === n - 1 ? 0x28FF : 0x2812));
  const inset = Array.from({ length: n }, (_, i) => (i < 2 || i >= n - 2 ? B0 : 0x28FF));
  return gridFromRows([full, blank, mid, blank, blank, inset, full]);
}

function aspectBlocks(t) {
  // four square outlines, 8 cells wide, drawn for cell aspects 0.50-0.65; two per band
  const C = 8, AS = [0.5, 0.55, 0.6, 0.65], L = ['A', 'B', 'C', 'D'];
  const blocks = [];
  for (let p = 0; p < 2; p++) {
    const hs = [0, 1].map(k => Math.round(4 * C * AS[p * 2 + k]));
    const rows = Math.ceil(Math.max(...hs) / 4);
    const c = dotCanvas(C * 2 + 2, rows);
    hs.forEach((h, k) => c.rect(k * (C + 2) * 2, 0, C * 2, h));
    const f = T.formatFor(t.id, c.grid(), { blank: 'u2800' });
    const label = L[p * 2] + BLANK.repeat(C + 1) + L[p * 2 + 1];
    blocks.push(label + '\n' + f.text);
  }
  return blocks;
}

function fenceStairs(widths, back) {
  return widths.map(W => {
    const ruler = Array.from({ length: W }, (_, i) => String((i + 1) % 10)).join('');
    const rows = [];
    for (let n = W - back; n <= W; n++) {
      const lab = String(n) + ' ';
      rows.push(lab + '-'.repeat(n - lab.length - 1) + '|');
    }
    const body = [ruler, ...rows].join('\n');
    return { W, text: '```\n' + body + '\n```', html: '<pre>' + escHtml(body) + '</pre>' };
  });
}

function fenceAspect() {
  const C = 20, AS = [0.40, 0.45, 0.50, 0.55], L = ['A', 'B', 'C', 'D'];
  const parts = AS.map((a, k) => {
    const h = Math.round(C * a);
    const lines = [L[k]];
    for (let y = 0; y < h; y++) {
      lines.push(y === 0 || y === h - 1 ? '+' + '-'.repeat(C - 2) + '+' : '|' + ' '.repeat(C - 2) + '|');
    }
    return lines.join('\n');
  });
  const body = parts.join('\n\n');
  return { text: '```\n' + body + '\n```', html: '<pre>' + escHtml(body) + '</pre>' };
}

async function buildSuite() {
  const t0 = performance.now();
  const conv = createConverter();
  const bitmaps = {};
  for (const id of ['portrait', 'pet', 'landmark', 'logo']) bitmaps[id] = await loadSample(id);
  const art = (id, target, mode, fit, invert = false, opts = {}) => {
    conv.setSource(bitmaps[id]);
    const g = conv.run({}, { mode, cols: fit.cols, rows: fit.rows, tone: { invert } });
    return { g, f: T.formatFor(target, g, opts) };
  };

  const cards = [];
  const push = c => cards.push(c);

  // -- Braille targets: widths, alignment, survival, aspect, real art ---------------------------
  for (const t of BRAILLE_TARGETS) {
    brailleStairs(t).forEach(push);

    for (const [v, blank, what] of [['a', 'u2800', 'blank cells are U+2800'], ['b', 'dot', 'blank cells are ⡀ dots']]) {
      const f = T.formatFor(t.id, shapesGrid(), { blank });
      push(card({ id: `${t.id}.shapes.${v}`, sec: t.id, group: 'Alignment', target: t.id, text: f.text, count: f.count,
        title: `Box, diagonal, circle (${v.toUpperCase()}: ${what})`,
        look: 'The box has straight sides, the diagonal is one straight line, the circle is round. Nothing shears sideways.',
        hint: 'ok, or what shears' }));
    }
    {
      const f = T.formatFor(t.id, columnsGrid(), { blank: 'u2800' });
      push(card({ id: `${t.id}.cols`, sec: t.id, group: 'Alignment', target: t.id, text: f.text, count: f.count,
        title: 'Left-only and right-only columns',
        look: 'Row 2 (⡇) hugs the left of each cell, row 3 (⢸) the right. In row 4 the lines pair up in twos.',
        hint: 'ok, or which row shifted' }));
    }
    for (const [v, blank, what] of [['a', 'u2800', 'U+2800'], ['b', 'dot', '⡀ dots']]) {
      const f = T.formatFor(t.id, survivalGrid(), { blank });
      push(card({ id: `${t.id}.survive.${v}`, sec: t.id, group: 'Survival', target: t.id, text: f.text, count: f.count,
        title: `Blank rows and edges (${v.toUpperCase()}: blanks as ${what})`,
        look: '7 rows: full, blank, ruler, blank, blank, short bar inset 2 cells from both sides, full. No row lost or shifted.',
        hint: 'rows you see, e.g. 7 ok' }));
    }
    packBlocks(t.id, aspectBlocks(t), limitOf(t.id)).forEach((text, k, all) => push(card({
      id: `${t.id}.aspect${all.length > 1 ? String.fromCharCode(97 + k) : ''}`, sec: t.id, group: 'Aspect', target: t.id, text,
      title: `Which one is square?${all.length > 1 ? ` (part ${k + 1} of ${all.length})` : ''}`,
      look: 'Four outlines drawn for cell aspects A 0.50, B 0.55, C 0.60, D 0.65. Which looks most like a square?',
      hint: 'A, B, C or D' })));

    const fit = T.autoFit(t.id, 'braille', {});
    for (const inv of [false, true]) {
      const { f } = art('portrait', t.id, 'braille', fit, inv);
      push(card({ id: `${t.id}.art${inv ? '.inv' : ''}`, sec: t.id, dark: inv, group: 'Real art', target: t.id, text: f.text, count: f.count,
        title: `Portrait at auto-fit ${fit.cols} × ${fit.rows}${inv ? ', inverted' : ''}`,
        look: inv ? 'For dark mode: light dots on dark read as the face. No row wraps.'
          : 'Reads as a face in light mode. No row wraps, left edge straight.',
        hint: 'ok, or what broke' }));
    }
  }

  // -- Instagram long comments -------------------------------------------------------------------
  {
    const fit = T.autoFit('ig', 'braille', {});
    const pieces = [];
    for (const inv of [false, true]) for (const id of ['portrait', 'pet', 'landmark', 'logo']) pieces.push(art(id, 'ig', 'braille', fit, inv).g);
    const all = stackGrids(pieces, fit.cols);
    for (const goal of [1500, 2200]) {
      const nRows = Math.min(all.length, Math.floor((goal + 1) / (fit.cols + 1)));
      const f = T.formatFor('ig', gridFromRows(all.slice(0, nRows)), {});
      push(card({ id: `ig.long.${goal}`, sec: 'ig', group: 'Long comments', target: 'ig', text: f.text, count: f.count,
        title: `Long comment, ${f.count.toLocaleString('en-US')} characters`,
        look: 'Post it. Does it post? Is it hidden, collapsed behind "more", or does "Action Blocked" appear?',
        hint: 'posted / collapsed / blocked' }));
    }
  }

  // -- X intent links ----------------------------------------------------------------------------
  {
    const c = dotCanvas(12, 4);
    c.rect(0, 0, 24, 16);
    c.line(2, 2, 21, 13);
    const box = T.formatFor('x', c.grid(), {}).text;
    for (const [id, path, url, title] of [
      ['x.intent.tweet', 'tweet', null, 'Intent link: /intent/tweet'],
      ['x.intent.post', 'post', null, 'Intent link: /intent/post'],
      ['x.intent.posturl', 'post', SITE_URL, 'Intent link: /intent/post with the site link'],
    ]) {
      const href = xIntent(box, path, url);
      push(card({ id, sec: 'x', group: 'Intent links', target: 'x', text: box, kind: 'link', href,
        title, look: 'Opens the X composer (not a login page) with a 4-row box and its diagonal, line breaks kept. Try on phone and desktop.',
        hint: 'phone: ok / login page; desktop: ok' }));
    }
  }

  // -- Telegram: ASCII in a fence, share links ---------------------------------------------------
  for (const s of fenceStairs([28, 32, 36, 40, 44], 3)) {
    push(card({ id: `tg.fence.${s.W}`, sec: 'tg', group: 'Monospace width (```)', target: 'tg', text: s.text, html: s.html, mono: true,
      title: `Code block width ${s.W - 3}–${s.W}`,
      look: 'Becomes a monospace block with a digit ruler. Largest count whose row stays on one line?',
      hint: 'largest count on one line; block yes/no' }));
  }
  for (const s of fenceStairs([60, 68, 76, 84], 7)) {
    push(card({ id: `tg.fence.d${s.W}`, sec: 'tg', group: 'Desktop width (```)', target: 'tg', text: s.text, html: s.html, mono: true,
      title: `Desktop code block ${s.W - 7}–${s.W}`,
      look: 'Telegram Desktop / Web. Largest count whose row stays on one line? Try both Copy buttons.',
      hint: 'largest count; plain or HTML worked' }));
  }
  {
    const body = ['0123456789', '    ^ 4 spaces before', '        ^ 8 spaces before', '  x  x  x  (2 spaces each)'].join('\n');
    push(card({ id: 'tg.fence.lead', sec: 'tg', group: 'Monospace width (```)', target: 'tg', mono: true,
      text: '```\n' + body + '\n```', html: '<pre>' + escHtml(body) + '</pre>',
      title: 'Leading spaces in a code block',
      look: 'The ^ marks sit under 4 and 8; the x marks keep 2 spaces between them.', hint: 'ok, or what moved' }));
    const fa = fenceAspect();
    push(card({ id: 'tg.fence.aspect', sec: 'tg', group: 'Monospace width (```)', target: 'tg', mono: true, text: fa.text, html: fa.html,
      title: 'Which code-block box is square?',
      look: 'Four boxes drawn for monospace cell aspects A 0.40, B 0.45, C 0.50, D 0.55. Which looks most like a square?',
      hint: 'A, B, C or D' }));
    const fit = T.autoFit('tg', 'ascii', {});
    for (const inv of [false, true]) {
      let f;
      try { f = art('portrait', 'tg', 'ascii', fit, inv).f; } catch (e) { f = null; console.warn('ascii art skipped', e); }
      if (!f) continue;
      push(card({ id: `tg.ascii${inv ? '.inv' : ''}`, sec: 'tg', dark: inv, group: 'Real art', target: 'tg', text: f.text, html: f.html, mono: true,
        count: f.count,
        title: `ASCII portrait in a code block, ${fit.cols} × ${fit.rows}${inv ? ', inverted' : ''}`,
        look: 'Becomes one monospace block, no row wraps, reads as a face. On desktop try both Copy buttons.',
        hint: 'block yes/no; plain or HTML' }));
    }
  }
  {
    const fit = T.autoFit('tg', 'braille', {});
    const g = art('portrait', 'tg', 'braille', fit, false).g;
    const artRows = T.formatFor('tg', g, {}).text.split('\n');
    for (const kb of [1, 2, 4, 8]) {
      const head = `Typist share test, ${kb} KB link`;
      const lines = [head];
      let text = '';
      for (let i = 0; ; i++) {
        const tryText = [...lines, artRows[i % artRows.length], `END ${kb} KB, ${i + 1} art rows`].join('\n');
        if (tgShare(tryText).length > kb * 1024 && i > 0) break;
        lines.push(artRows[i % artRows.length]);
        text = [...lines, `END ${kb} KB, ${i + 1} art rows`].join('\n');
      }
      const href = tgShare(text);
      push(card({ id: `tg.share.${kb}k`, sec: 'tg', group: 't.me share links', target: 'tg', kind: 'link', text, href,
        title: `t.me share link, ${(href.length / 1024).toFixed(1)} KB URL`,
        look: 'Opens Telegram’s share picker with the text; the last line reads END. Pick a chat and check nothing is cut.',
        hint: 'opens? END line there?' }));
    }
  }

  // -- Telegram channel ----------------------------------------------------------------------------
  {
    const fit = T.autoFit('tgc', 'braille', {});
    const pieces = [];
    for (const inv of [false, true]) for (const id of ['portrait', 'pet', 'landmark', 'logo']) pieces.push(art(id, 'tgc', 'braille', fit, inv).g);
    const all = stackGrids(pieces, fit.cols);
    for (const [id, caption, goal, title, look] of [
      ['tgc.caption', true, 1024, 'Media caption', 'Attach any photo in a channel, paste this as its caption. Does all of it fit?'],
      ['tgc.post', false, 4096, 'Channel post', 'Paste into a channel post. Does it go out as one message, rows unwrapped?'],
    ]) {
      const opts = caption ? { caption: true } : {};
      const nRows = Math.min(all.length, Math.floor((goal + 1) / (fit.cols + 1)));
      const f = T.formatFor('tgc', gridFromRows(all.slice(0, nRows)), opts);
      push(card({ id, sec: 'tgc', group: '', target: 'tgc', opts, text: f.text, count: f.count, limit: limitOf('tgc', opts),
        title: `${title}, ${f.count.toLocaleString('en-US')} characters`, look, hint: 'fits / cut / refused' }));
    }
    for (const inv of [false, true]) {
      const { f } = art('portrait', 'tgc', 'braille', fit, inv);
      push(card({ id: `tgc.art${inv ? '.inv' : ''}`, sec: 'tgc', dark: inv, group: '', target: 'tgc', text: f.text, count: f.count,
        title: `Portrait at auto-fit ${fit.cols} × ${fit.rows}${inv ? ', inverted' : ''}`,
        look: 'In a channel post: no row wraps, reads as a face.', hint: 'ok, or what broke' }));
    }
  }

  Object.values(bitmaps).forEach(b => b.close && b.close());
  const sections = [
    { id: 'ig', name: 'Instagram', note: 'Paste into ' + BRAILLE_TARGETS[0].where + '. Only post the ones that say so.' },
    { id: 'x', name: 'X', note: 'Paste into ' + BRAILLE_TARGETS[1].where + '. Check the phone app and x.com on desktop.' },
    { id: 'tg', name: 'Telegram', note: 'Paste into ' + BRAILLE_TARGETS[2].where + ' and send. Check the phone app and Telegram Desktop.' },
    { id: 'tgc', name: 'Channel', note: 'Paste into a Telegram channel you own (a private test channel is fine).' },
  ];
  return {
    version: KIT_VERSION, built: new Date().toISOString(), modules: { ...modules },
    buildMs: Math.round(performance.now() - t0), sections, cards,
  };
}

// ---- the page (self-contained: ?bake=1 inlines this function's source) ---------------------------
function kitRuntime(data) {
  var KEY = 'typist-paste-kit-v' + data.version;
  var store = {};
  try { store = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { store = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* private mode */ } }
  store.results = store.results || {};
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };

  function execCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  function showManual(ui, text) {
    ui.manual.hidden = false;
    ui.manual.value = text;
    ui.manual.focus();
    ui.manual.select();
    try { ui.manual.setSelectionRange(0, text.length); } catch (e) { /* older iOS */ }
    say(ui, 'Copy was blocked. The text is selected in the box below: use your phone’s Copy.', 'bad');
  }
  function say(ui, msg, cls) { ui.msg.textContent = msg; ui.msg.className = 'msg' + (cls ? ' ' + cls : ''); }
  function copyPlain(ui, text, label) {
    var done = function () { say(ui, (label || 'Copied') + ' ✓ ' + fmt(text.length) + ' UTF-16 units. Now paste it.', 'ok'); };
    var fallback = function () { if (execCopy(text)) done(); else showManual(ui, text); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }
  function copyHtml(ui, text, html) {
    // built synchronously inside the click: Safari drops the gesture after any await
    try {
      var item = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      });
      navigator.clipboard.write([item]).then(function () {
        say(ui, 'Copied with HTML ✓ (text/plain + text/html <pre>). Paste into Telegram Desktop.', 'ok');
      }, function (e) { say(ui, 'HTML copy failed (' + (e && e.name) + '). Use plain Copy.', 'bad'); });
    } catch (e) { say(ui, 'This browser cannot write HTML to the clipboard (' + (e && e.name) + ').', 'bad'); }
  }

  var app = document.getElementById('app');
  app.textContent = '';
  var fallbackMods = Object.keys(data.modules).filter(function (k) { return data.modules[k] !== 'real'; });
  app.appendChild(el('header', null, [
    el('h1', { text: 'Typist paste test' }),
    el('p', { class: 'lede', text: 'Checks what really happens when text art is pasted into Instagram, X and Telegram on your phone.' }),
    el('ol', { class: 'steps' }, [
      el('li', { text: 'Tap Copy on a card.' }),
      el('li', { text: 'Paste it into the app named in that section and look closely.' }),
      el('li', { text: 'Tap Works or Broken, add a short note.' }),
      el('li', { text: 'At the bottom, tap Copy my results and paste them into the chat with Claude.' }),
    ]),
    el('p', { class: 'meta', text: 'Kit v' + data.version + ' · built ' + data.built.slice(0, 16).replace('T', ' ') + ' UTC · ' + data.cards.length + ' tests' }),
    fallbackMods.length ? el('p', { class: 'banner', text: 'Built with stand-in code for: ' + fallbackMods.join(', ') + '. Payloads may differ from the app.' }) : null,
  ]));

  var nav = el('nav', { class: 'jump', 'aria-label': 'Sections' });
  app.appendChild(nav);
  var secUi = {};
  var cardUi = {};

  data.sections.forEach(function (s) {
    var cards = data.cards.filter(function (c) { return c.sec === s.id; });
    var prog = el('span', { class: 'prog' });
    var navN = el('span', { class: 'n' });
    nav.appendChild(el('a', { href: '#s-' + s.id }, [s.name, navN]));
    var sec = el('section', { class: 'sec', id: 's-' + s.id }, [
      el('div', { class: 'sec-head' }, [el('h2', { text: s.name }), prog]),
      el('p', { class: 'sec-note', text: s.note }),
    ]);
    secUi[s.id] = { prog: prog, navN: navN, cards: cards };
    var lastGroup = null;
    cards.forEach(function (c) {
      if (c.group && c.group !== lastGroup) sec.appendChild(el('h3', { class: 'group', text: c.group }));
      lastGroup = c.group;
      sec.appendChild(renderCard(c));
    });
    app.appendChild(sec);
  });
  nav.appendChild(el('a', { href: '#s-results' }, ['Results']));

  function renderCard(c) {
    var ui = {};
    var r = store.results[c.id] || {};
    var over = c.count > c.limit;
    var countText = c.kind === 'link'
      ? fmt(c.href.length) + ' B URL'
      : fmt(c.count) + ' / ' + fmt(c.limit) + (c.unit === 'weighted' ? ' weighted' : '');
    ui.msg = el('p', { class: 'msg', 'aria-live': 'polite' });
    ui.manual = el('textarea', { class: 'manual', readonly: '', 'aria-label': 'Payload text to copy by hand' });
    ui.manual.hidden = true;
    var actions = el('div', { class: 'actions' });
    if (c.kind === 'link') {
      actions.appendChild(el('a', { class: 'btn primary', href: c.href, target: '_blank', rel: 'noopener', text: 'Open link' }));
      actions.appendChild(el('button', { class: 'btn grow', type: 'button', text: 'Copy link', onclick: function () { copyPlain(ui, c.href, 'Link copied'); } }));
    } else {
      actions.appendChild(el('button', { class: 'btn primary', type: 'button', text: 'Copy', 'data-copy': c.id, onclick: function () { copyPlain(ui, c.text); } }));
      if (c.html) {
        actions.appendChild(el('button', { class: 'btn grow', type: 'button', text: 'Copy with HTML (desktop)', 'data-copy-html': c.id,
          onclick: function () { copyHtml(ui, c.text, c.html); } }));
      }
    }
    var segBtns = ['ok', 'bad'].map(function (s) {
      return el('button', { type: 'button', 'data-s': s, 'aria-pressed': String(r.s === s), text: s === 'ok' ? 'Works' : 'Broken',
        onclick: function () { setStatus(c.id, store.results[c.id] && store.results[c.id].s === s ? '' : s); } });
    });
    ui.seg = segBtns;
    ui.note = el('input', { type: 'text', value: r.n || '', placeholder: c.hint, 'aria-label': 'Note for ' + c.title,
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    ui.note.addEventListener('input', function () { setNote(c.id, ui.note.value); });
    var pvText = c.kind === 'link' ? c.href : c.text;
    ui.card = el('article', { class: 'card', id: 'c-' + c.id }, [
      el('div', { class: 'card-head' }, [el('h3', { text: c.title }), el('span', { class: 'count' + (over ? ' over' : ''), text: countText })]),
      el('p', { class: 'look', text: c.look }),
      c.kind === 'link' ? el('pre', { class: 'pv', text: c.text }) : null,
      el('pre', { class: 'pv' + (c.mono ? ' mono' : '') + (c.dark ? ' dark' : '') + (c.kind === 'link' ? ' link' : ''), text: pvText, tabindex: '0', 'aria-label': 'Payload preview' }),
      actions, ui.msg, ui.manual,
      el('div', { class: 'result' }, [el('div', { class: 'seg', role: 'group', 'aria-label': 'Result' }, segBtns), ui.note]),
      el('div', { class: 'id', text: c.id }),
    ]);
    cardUi[c.id] = ui;
    paintCard(c.id);
    return ui.card;
  }
  function paintCard(id) {
    var ui = cardUi[id], r = store.results[id] || {};
    ui.seg.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-s') === r.s)); });
    ui.card.classList.toggle('s-ok', r.s === 'ok');
    ui.card.classList.toggle('s-bad', r.s === 'bad');
  }
  function setStatus(id, s) {
    var r = store.results[id] || (store.results[id] = {});
    r.s = s; tidy(id); save(); paintCard(id); progress();
  }
  function setNote(id, n) {
    var r = store.results[id] || (store.results[id] = {});
    r.n = n; tidy(id); save(); progress();
  }
  function tidy(id) { var r = store.results[id]; if (r && !r.s && !r.n) delete store.results[id]; }
  function progress() {
    Object.keys(secUi).forEach(function (k) {
      var s = secUi[k];
      var n = s.cards.filter(function (c) { return store.results[c.id]; }).length;
      s.prog.textContent = n + ' of ' + s.cards.length + ' answered';
      s.navN.textContent = n + '/' + s.cards.length;
    });
    if (out) out.textContent = resultsText();
  }

  // ---- results --------------------------------------------------------------------------------
  function device() {
    var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    return {
      ua: navigator.userAgent,
      screen: screen.width + ' x ' + screen.height + ' (viewport ' + window.innerWidth + ' px)',
      dpr: String(window.devicePixelRatio || 1),
      scheme: dark ? 'dark' : 'light',
      pointer: touch ? 'touch' : 'fine',
    };
  }
  function resultsText() {
    var d = device();
    var lines = [
      'TYPIST PASTE KIT v' + data.version + ' (built ' + data.built.slice(0, 16) + 'Z' + (fallbackMods.length ? ', stand-ins: ' + fallbackMods.join('/') : '') + ')',
      'tested on: ' + (store.device || '(not filled in)'),
      'ua: ' + d.ua,
      'screen: ' + d.screen + ', dpr ' + d.dpr + ', ' + d.scheme + ', ' + d.pointer,
    ];
    var n = 0;
    data.cards.forEach(function (c) {
      var r = store.results[c.id];
      if (!r) return;
      n++;
      lines.push(c.id + ': ' + (r.s === 'ok' ? 'WORKS' : r.s === 'bad' ? 'BROKEN' : '-') + (r.n ? ' | ' + r.n.replace(/\s+/g, ' ').trim() : ''));
    });
    lines.push(n + ' of ' + data.cards.length + ' answered');
    return lines.join('\n');
  }
  var d0 = device();
  var devInput = el('input', { id: 'dev', type: 'text', value: store.device || '', placeholder: 'e.g. iPhone 15, iOS 19, IG + X + Telegram apps', autocomplete: 'off' });
  devInput.addEventListener('input', function () { store.device = devInput.value; save(); progress(); });
  var resUi = { msg: el('p', { class: 'msg', 'aria-live': 'polite' }), manual: el('textarea', { class: 'manual', readonly: '' }) };
  resUi.manual.hidden = true;
  var out = el('pre', { class: 'out', id: 'results-text' });
  app.appendChild(el('section', { class: 'sec results', id: 's-results' }, [
    el('div', { class: 'sec-head' }, [el('h2', { text: 'Results' })]),
    el('dl', null, [
      el('dt', { text: 'Browser' }), el('dd', { text: d0.ua }),
      el('dt', { text: 'Screen' }), el('dd', { text: d0.screen }),
      el('dt', { text: 'Pixel ratio' }), el('dd', { text: d0.dpr }),
      el('dt', { text: 'Theme' }), el('dd', { text: d0.scheme + ', ' + d0.pointer }),
    ]),
    el('div', { class: 'field' }, [el('label', { for: 'dev', text: 'Phone and apps you tested with' }), devInput]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn primary', type: 'button', id: 'copy-results', text: 'Copy my results', onclick: function () { copyPlain(resUi, resultsText(), 'Results copied'); } }),
      el('button', { class: 'btn', type: 'button', text: 'Clear', onclick: function () {
        if (!confirm('Clear every result on this device?')) return;
        store = { results: {} }; save();
        Object.keys(cardUi).forEach(function (id) { cardUi[id].note.value = ''; paintCard(id); });
        devInput.value = ''; progress();
      } }),
    ]),
    resUi.msg, resUi.manual, out,
  ]));
  progress();
  window.__kit = data;
}

// ---- boot ------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
try {
  const data = await buildSuite();
  kitRuntime(data);
  if (params.has('bake')) {
    const css = await (await fetch(new URL('paste-test.css', import.meta.url))).text();
    // escape < and the two JS line separators so the JSON cannot close or break its script tag
    const BS = String.fromCharCode(92);
    const json = JSON.stringify(data).split('<').join(BS + 'u003c')
      .split(String.fromCharCode(0x2028)).join(BS + 'u2028').split(String.fromCharCode(0x2029)).join(BS + 'u2029');
    const src = kitRuntime.toString().split('</script').join('<' + BS + '/script');
    const html = [
      '<!doctype html>',
      '<!-- Typist paste test kit, baked ' + data.built + ' from dev/paste-test.html. Self-contained: no imports, no requests. -->',
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<meta name="color-scheme" content="light dark">',
      '<title>Typist paste test</title>',
      '<style>\n' + css + '</style></head><body>',
      '<div id="app"><p class="boot">Loading&hellip;</p></div>',
      '<script id="kit-data" type="application/json">' + json + '</script>',
      '<script>\n' + src + '\nkitRuntime(JSON.parse(document.getElementById(\'kit-data\').textContent));\n</script>',
      '</body></html>',
      '',
    ].join('\n');
    if (/\r/.test(html)) throw new Error('CR in baked file');
    const res = await fetch('/__file?name=paste-test.html', { method: 'POST', body: new Blob([html], { type: 'text/html' }) });
    const info = await res.json();
    window.__done = { ok: true, baked: info.bytes, cards: data.cards.length, modules: data.modules, buildMs: data.buildMs };
  } else {
    window.__done = { ok: true, cards: data.cards.length, modules: data.modules, buildMs: data.buildMs };
  }
} catch (e) {
  console.error(e);
  document.getElementById('app').textContent = 'Kit failed to build: ' + (e && e.stack || e);
  window.__done = { ok: false, error: String(e && e.stack || e) };
}

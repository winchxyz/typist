// Adversarial tests for the converter and the formatters: node tests/fuzz.test.mjs
// Everything here is checked against independent reimplementations (Braille decoder, UTF-16 and
// X weighted counters, payload rule checker), never against the module's own helpers.
// Formatter attacks are skipped (and reported) while js/targets.js / js/count.js do not exist.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createConverter, gridLines } from '../js/convert.js';
import { encodeBraille, ditherDots, DITHERS } from '../js/dither.js';
import { QUAD_CP } from '../js/blocks.js';
import { sampleFromRGBA, toneGrid, TONE_DEFAULTS, LOOKS } from '../js/tone.js';
import { asciiCells, ASCII_CHARSET, ASCII_SUB } from '../js/ascii.js';
// Timing budgets are for this machine; shared CI runners (CI=true) are slower, so they get slack
// there: the tests still catch a real slowdown without failing on a busy runner.
const PERF = process.env.CI ? 4 : 1;

let pass = 0, fail = 0, skip = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push('ok   ' + name); }
  catch (e) { fail++; out.push('FAIL ' + name + '\n     ' + String(e && e.message || e).split('\n').slice(0, 6).join('\n     ')); }
}

// ---------- seeded helpers ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const cps = s => Array.from(s, ch => ch.codePointAt(0));

// ImageData-like sources
function img(w, h, f) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p += 4) {
    const [r, g, b, a = 255] = f(x, y);
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a;
  }
  return { width: w, height: h, data };
}
const solid = (v, w = 64, h = 64, a = 255) => img(w, h, () => [v, v, v, a]);
function noise(w, h, seed) { const r = rng(seed); return img(w, h, () => { const v = (r() * 256) | 0; return [v, v, v]; }); }
function portrait(w = 600, h = 800) {
  const ell = (u, v, cx, cy, rx, ry) => ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
  return img(w, h, (x, y) => {
    const u = x / w, v = y / h;
    let c = [150, 160, 175];
    if (ell(u, v, 0.5, 0.4, 0.3, 0.27)) c = [40, 30, 25];
    if (ell(u, v, 0.5, 0.43, 0.21, 0.21)) c = [222, 180, 150];
    if (ell(u, v, 0.42, 0.4, 0.035, 0.018) || ell(u, v, 0.58, 0.4, 0.035, 0.018)) c = [30, 20, 20];
    if (ell(u, v, 0.5, 0.55, 0.06, 0.015)) c = [160, 60, 60];
    return c;
  });
}

// ---------- independent Braille decoder (from the Unicode dot numbering, not BRAILLE_BIT) ----------
// dot n (1..8) at [col, row]; its bit is n - 1
const DOT_POS = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 4: [1, 0], 5: [1, 1], 6: [1, 2], 7: [0, 3], 8: [1, 3] };
function decodeBrailleGrid(cp, cols, rows) {
  const W = cols * 2, H = rows * 4, dots = new Uint8Array(W * H);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = cp[r * cols + c];
    if (v < 0x2800 || v > 0x28ff) throw new Error(`not Braille: U+${v.toString(16)} at ${c},${r}`);
    const bits = v - 0x2800;
    for (let n = 1; n <= 8; n++) if (bits & (1 << (n - 1))) {
      const [dx, dy] = DOT_POS[n];
      dots[(r * 4 + dy) * W + c * 2 + dx] = 1;
    }
  }
  return dots;
}

function assertGridSane(g, mode, cols, rows) {
  assert.equal(g.cols, cols, 'cols');
  assert.equal(g.rows, rows, 'rows');
  assert.equal(g.cp.length, cols * rows, 'cp length');
  assert.ok(Number.isFinite(g.ink) && g.ink >= 0 && g.ink <= 1, 'ink finite in [0,1]: ' + g.ink);
  const blockSet = new Set(QUAD_CP.concat([0x2580, 0x2584, 0x2588, 0x258c, 0x2590]));
  const asciiSet = new Set(cps(ASCII_CHARSET));
  for (let i = 0; i < g.cp.length; i++) {
    const v = g.cp[i];
    if (mode === 'braille') assert.ok(v >= 0x2800 && v <= 0x28ff, `braille cell ${i} = U+${v.toString(16)}`);
    else if (mode === 'ascii') assert.ok(asciiSet.has(v), `ascii cell ${i} = U+${v.toString(16)}`);
    else assert.ok(blockSet.has(v), `block cell ${i} = U+${v.toString(16)}`);
  }
  if (g.fg) for (let i = 0; i < g.fg.length; i++) assert.ok(g.fg[i] <= 0xffffff && g.bg[i] <= 0xffffff, 'rgb range');
  if (g.tone) for (const k of ['lo', 'hi', 'gamma', 'coverage', 'std']) assert.ok(Number.isFinite(g.tone[k]), `tone.${k} = ${g.tone[k]}`);
}

const MODES = [
  { mode: 'braille', dither: 'atkinson' }, { mode: 'braille', dither: 'floyd' },
  { mode: 'braille', dither: 'bayer' }, { mode: 'braille', dither: 'threshold' },
  { mode: 'ascii', ascii: 'shape' }, { mode: 'ascii', ascii: 'ramp' },
  { mode: 'blocks', blocks: 'quad', color: true }, { mode: 'blocks', blocks: 'half', color: true },
  { mode: 'blocks', blocks: 'quad' }, { mode: 'blocks', blocks: 'half' },
];
function conv(source) { const c = createConverter(); c.setSource(source); return c; }

// =====================================================================================
// Converter
// =====================================================================================

test('bit order: 500 random dot grids round-trip through an independent decoder', () => {
  const r = rng(7);
  for (let t = 0; t < 500; t++) {
    const cols = 1 + ((r() * 9) | 0), rows = 1 + ((r() * 7) | 0), W = cols * 2, H = rows * 4;
    const dots = Uint8Array.from({ length: W * H }, () => (r() < 0.5 ? 1 : 0));
    const g = encodeBraille(dots, W, H);
    assert.deepEqual(decodeBrailleGrid(g.cp, cols, rows), dots, `grid ${cols}x${rows} #${t}`);
    const on = dots.reduce((a, b) => a + b, 0);
    assert.equal(g.ink, on / (W * H));
  }
});

test('bit order through the whole pipeline: threshold dots == decoded Grid', () => {
  const src = portrait();
  const c = conv(src);
  // 40 cols: no small-grid boost, so the reference below needs no converter internals
  const g = c.run({}, { mode: 'braille', cols: 40, rows: 16, dither: 'threshold', tone: { auto: false, detail: 0 } });
  const s = sampleFromRGBA(src.data, src.width, src.height, 80, 64, { crop: {} });
  const L = toneGrid(s, { ...TONE_DEFAULTS, auto: false, detail: 0 });
  const dots = ditherDots(L, 80, 64, 'threshold');
  assert.deepEqual(decodeBrailleGrid(g.cp, 40, 16), dots);
});

test('determinism: fresh converters, and a converter after 30 unrelated runs, give identical grids', () => {
  const src = portrait();
  const a = conv(src), b = conv(src);
  const r = rng(3);
  for (const m of MODES) {
    const opts = { ...m, cols: 24, rows: 13 };
    const ga = a.run({ x: 0.5, y: 0.45, zoom: 1.3 }, opts);
    for (let k = 0; k < 3; k++) {   // pollute b's caches with other crops, tones and sizes
      b.run({ x: r(), y: r(), zoom: 0.5 + r() * 3, rotation: r() * 360 },
        { ...MODES[(r() * MODES.length) | 0], cols: 5 + ((r() * 40) | 0), rows: 3 + ((r() * 20) | 0),
          tone: { brightness: r() * 2 - 1, contrast: r() * 2 - 1, gamma: 0.3 + r() * 2.7, edges: r(), invert: r() < 0.5 } });
    }
    const gb = b.run({ x: 0.5, y: 0.45, zoom: 1.3 }, opts);
    assert.deepEqual(gb.cp, ga.cp, JSON.stringify(m));
    if (ga.fg) { assert.deepEqual(gb.fg, ga.fg); assert.deepEqual(gb.bg, ga.bg); }
  }
});

test('memo: tone-only change never resamples; crop change always does; returning to A gives A', () => {
  const c = conv(portrait());
  const opts = { mode: 'braille', cols: 40, rows: 22 };
  const A = c.run({ x: 0.5, y: 0.5 }, opts);
  const s0 = c.stats.samples;
  const tones = [{ brightness: 0.5 }, { contrast: -0.4 }, { gamma: 2 }, { detail: 0 }, { edges: 1 }, { invert: true }, { auto: false }];
  for (const t of tones) c.run({ x: 0.5, y: 0.5 }, { ...opts, tone: t });
  assert.equal(c.stats.samples, s0, 'tone change resampled');
  for (const crop of [{ x: 0.51 }, { y: 0.49 }, { zoom: 1.01 }, { rotation: 1 }]) {
    const n = c.stats.samples;
    const g = c.run({ x: 0.5, y: 0.5, ...crop }, opts);
    assert.equal(c.stats.samples, n + 1, 'crop change did not resample: ' + JSON.stringify(crop));
    assert.equal(g.cp.length, 40 * 22);
  }
  // evict the tone LRU (8) and the sample LRU (6), then come back
  for (let k = 0; k < 10; k++) c.run({ x: 0.3 + k * 0.03 }, { ...opts, tone: { brightness: k / 10 } });
  assert.deepEqual(c.run({ x: 0.5, y: 0.5 }, opts).cp, A.cp, 'A changed after cache churn');
  // cached tone arrays must not be mutated by encoders: same key twice, every mode
  for (const m of MODES) {
    const o = { ...m, cols: 20, rows: 11, tone: { edges: 0.7 } };
    assert.deepEqual(c.run({}, o).cp, c.run({}, o).cp, JSON.stringify(m));
  }
});

test('memo: setSource with a different photo never serves the old photo', () => {
  const c = conv(solid(255));
  const white = c.run({}, { mode: 'braille', cols: 10, rows: 5 });
  c.setSource(solid(0));
  const black = c.run({}, { mode: 'braille', cols: 10, rows: 5 });
  assert.ok(white.cp.every(v => v === 0x2800) && black.cp.every(v => v === 0x28ff));
});

test('extremes: all white is blank, all black is full, in every mode (and swapped when inverted)', () => {
  for (const [v, name] of [[255, 'white'], [0, 'black']]) {
    const c = conv(solid(v));
    for (const m of MODES) {
      for (const invert of [false, true]) {
        const g = c.run({}, { ...m, cols: 12, rows: 7, tone: { invert } });
        assertGridSane(g, m.mode, 12, 7);
        const inky = (v === 0) !== invert;
        if (m.mode === 'braille') assert.ok(g.cp.every(x => x === (inky ? 0x28ff : 0x2800)), `${name} ${JSON.stringify(m)} invert=${invert}: ${gridLines(g)[0]}`);
        if (m.mode === 'blocks' && !m.color) assert.ok(g.cp.every(x => x === (inky ? 0x2588 : 0x20)), `${name} ${JSON.stringify(m)} invert=${invert}`);
        if (m.mode === 'ascii') {
          const blank = g.cp.every(x => x === 0x20);
          assert.equal(blank, !inky, `${name} ${JSON.stringify(m)} invert=${invert}: "${gridLines(g)[0]}"`);
        }
      }
    }
  }
});

test('extremes: 1 x 1 grid and 200-column grid in every mode, valid and NaN-free', () => {
  const c = conv(portrait());
  for (const m of MODES) {
    assertGridSane(c.run({}, { ...m, cols: 1, rows: 1 }), m.mode, 1, 1);
    const t0 = performance.now();
    const g = c.run({}, { ...m, cols: 200, rows: 110 });
    const ms = performance.now() - t0;
    assertGridSane(g, m.mode, 200, 110);
    assert.ok(ms < 2000 * PERF, `${JSON.stringify(m)} 200 cols took ${ms.toFixed(0)} ms`);
  }
});

test('extremes: flat grey, 1x1 photo, 4000x3 panorama, tiny zoom, crop off the photo', () => {
  const cases = [
    ['flat 128', solid(128), {}],
    ['flat 128 tiny', solid(128, 1, 1), {}],
    ['pano', img(4000, 3, x => [x % 255, 0, 0]), {}],
    ['zoom 0.001', portrait(), { zoom: 0.001 }],
    ['zoom 1e6', portrait(), { zoom: 1e6 }],
    ['off photo', portrait(), { x: 9, y: -9 }],
    ['rot 45', portrait(), { rotation: 45 }],
    ['rot -720.5', portrait(), { rotation: -720.5 }],
  ];
  for (const [name, src, crop] of cases) {
    const c = conv(src);
    for (const m of MODES) {
      const g = c.run(crop, { ...m, cols: 16, rows: 9 });
      try { assertGridSane(g, m.mode, 16, 9); } catch (e) { throw new Error(`${name} ${JSON.stringify(m)}: ${e.message}`); }
    }
  }
  const off = conv(portrait()).run({ x: 9, y: -9 }, { mode: 'braille', cols: 16, rows: 9 });
  assert.ok(off.cp.every(v => v === 0x2800), 'a crop entirely off the photo should be blank paper');
});

test('extremes: flat grey stays NaN-free and is flagged flat', () => {
  const g = conv(solid(128)).run({}, { mode: 'braille', cols: 20, rows: 11 });
  assert.ok(g.tone.flat, 'flat photo not flagged: ' + JSON.stringify(g.tone));
  const L = toneGrid(sampleFromRGBA(solid(128).data, 64, 64, 40, 44), TONE_DEFAULTS);
  assert.ok(L.every(Number.isFinite), 'NaN in toned flat grey');
});

test('transparent PNG: fully transparent is blank in both themes, half-alpha black is grey', () => {
  const c = conv(solid(0, 64, 64, 0));
  for (const m of MODES) for (const invert of [false, true]) {
    const g = c.run({}, { ...m, cols: 10, rows: 6, tone: { invert } });
    assertGridSane(g, m.mode, 10, 6);
    if (m.mode !== 'blocks' || !m.color) {
      const blank = m.mode === 'braille' ? 0x2800 : 0x20;
      assert.ok(g.cp.every(v => v === blank), `transparent ${JSON.stringify(m)} invert=${invert}: "${gridLines(g)[0]}"`);
    }
  }
  const s = sampleFromRGBA(solid(0, 8, 8, 128).data, 8, 8, 4, 4);
  assert.ok(Math.abs(s.L[5] - (1 - 128 / 255)) < 0.01, 'half-alpha black should composite to mid grey: ' + s.L[5]);
});

test('hostile tone values (NaN, out of range, strings) never give NaN or invalid glyphs', () => {
  const c = conv(portrait());
  const bad = [
    { gamma: 0 }, { gamma: -1 }, { gamma: NaN }, { gamma: 1e9 }, { brightness: NaN }, { brightness: 7 },
    { contrast: -5 }, { contrast: 9 }, { detail: 50 }, { detail: -1 }, { edges: 20 }, { contrast: NaN },
    { detail: NaN }, { gamma: '2' }, { brightness: undefined },
  ];
  const problems = [];
  for (const t of bad) {
    for (const m of [MODES[0], MODES[4], MODES[6]]) {
      try {
        const g = c.run({}, { ...m, cols: 16, rows: 9, tone: t });
        assertGridSane(g, m.mode, 16, 9);
        if (m.mode === 'braille') {
          // a hostile value must not blank or fill the whole picture of a normal photo
          const on = g.ink;
          if (on < 0.02 || on > 0.98) throw new Error('degenerate ink ' + on.toFixed(3));
        }
      } catch (e) { problems.push(`${JSON.stringify(t, (k, v) => (Number.isNaN(v) ? 'NaN' : v === undefined ? 'undefined' : v))} ${m.mode}: ${e.message}`); }
    }
  }
  assert.deepEqual(problems, []);
});

test('hostile grid sizes (cols NaN / 0 / -3 / 2.6 / "12") are clamped, never NaN-sized', () => {
  const c = conv(portrait());
  for (const [cols, rows, ec, er] of [[0, 0, 1, 1], [-3, -3, 1, 1], [2.6, 1.4, 3, 1], ['12', '6', 12, 6], [NaN, 5, null, 5], [10, NaN, 10, null]]) {
    let g;
    try { g = c.run({}, { mode: 'braille', cols, rows }); }
    catch (e) { throw new Error(`cols=${cols} rows=${rows} threw ${e.message}`); }
    assert.ok(Number.isInteger(g.cols) && g.cols >= 1 && Number.isInteger(g.rows) && g.rows >= 1,
      `cols=${cols} rows=${rows} gave ${g.cols} x ${g.rows}`);
    if (ec != null) assert.equal(g.cols, ec);
    if (er != null) assert.equal(g.rows, er);
    assert.equal(g.cp.length, g.cols * g.rows);
  }
});

test('invert symmetry: manual tone + threshold gives the exact dot complement (Braille and mono blocks)', () => {
  // an algebraic property of the soft look (plain curves); photo / poster clean backdrops per theme
  const src = noise(97, 89, 11);
  const c = conv(src);
  const tone = { look: 'soft', auto: false, detail: 0, contrast: 0, brightness: 0, gamma: 1 };
  const s = sampleFromRGBA(src.data, 97, 89, 60, 68, { crop: {} });
  const onHalf = Array.from(s.L).some(v => v === 0.5);
  const a = c.run({}, { mode: 'braille', cols: 30, rows: 17, dither: 'threshold', tone });
  const b = c.run({}, { mode: 'braille', cols: 30, rows: 17, dither: 'threshold', tone: { ...tone, invert: true } });
  if (!onHalf) for (let i = 0; i < a.cp.length; i++) assert.equal(b.cp[i] - 0x2800, 0xff ^ (a.cp[i] - 0x2800), 'cell ' + i);
  const qa = c.run({}, { mode: 'blocks', cols: 30, rows: 17, dither: 'threshold', tone });
  const qb = c.run({}, { mode: 'blocks', cols: 30, rows: 17, dither: 'threshold', tone: { ...tone, invert: true } });
  for (let i = 0; i < qa.cp.length; i++) assert.equal(QUAD_CP.indexOf(qb.cp[i]), 15 ^ QUAD_CP.indexOf(qa.cp[i]), 'block ' + i);
});

test('invert: a symmetric grey ramp reaches the same coverage in both themes (mirror mismatch reported)', () => {
  // a left-to-right grey ramp's negative is its mirror image, so dark mode must give the mirrored
  // dots and the same coverage; brightness must still move the picture in dark mode
  const grad = img(256, 256, x => [x, x, x]);
  const c = conv(grad);
  const cols = 40, rows = 22, W = 80;
  const base = { mode: 'braille', cols, rows, dither: 'threshold' };
  const a = c.run({}, { ...base, tone: { invert: false } });
  const b = c.run({}, { ...base, tone: { invert: true } });
  const da = decodeBrailleGrid(a.cp, cols, rows), db = decodeBrailleGrid(b.cp, cols, rows);
  let diff = 0;
  for (let y = 0; y < rows * 4; y++) for (let x = 0; x < W; x++) diff += da[y * W + x] !== db[y * W + (W - 1 - x)];
  out.push(`     info: light coverage ${a.tone.coverage.toFixed(3)}, dark ${b.tone.coverage.toFixed(3)}, mirrored dot mismatch ${diff}/${da.length}`);
  assert.ok(Math.abs(a.tone.coverage - b.tone.coverage) < 0.02, 'coverage differs between themes');
  // not asserted: dark mode uses v^g on the light side, not the mirror curve 1 - (1 - v)^g (design)
});

test('brightness moves dark mode on a bright photo too, every look (auto gamma on its bound must not swallow it)', () => {
  // light photo inverted = mostly lit dots; the auto solve pins at its bound. Brightness is a lighter
  // photo in both themes: fewer dots on paper, MORE lit dots in dark mode (dots are the light parts)
  const c = conv(portrait());
  const base = { mode: 'braille', cols: 40, rows: 22 };
  const problems = [];
  for (const { id } of LOOKS) {
    for (const invert of [false, true]) {
      const res = [-0.6, 0, 0.6].map(b => c.run({}, { ...base, tone: { look: id, invert, brightness: b } }));
      const [dk, mid, lt] = res.map(g => g.ink);
      // monotone with a real spread (sketch on a hard-edged face is all lines at 0: + has little to
      // lighten, so each side alone is not required to move 0.03)
      const ok = invert ? lt >= mid && mid >= dk && lt - dk > 0.06 : lt <= mid && mid <= dk && dk - lt > 0.06;
      if (!ok) problems.push(`${id} ${invert ? 'dark' : 'light'}: ink at brightness -0.6 / 0 / +0.6 = ${dk.toFixed(3)} / ${mid.toFixed(3)} / ${lt.toFixed(3)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('ASCII ramp: hostile ramps never leak non-charset glyphs (backtick-only, empty, control, non-ASCII)', () => {
  const [SX, SY] = ASCII_SUB;
  const cols = 12, rows = 6, W = cols * SX, H = rows * SY;
  const r = rng(5);
  const L = Float32Array.from({ length: W * H }, r);
  const set = new Set(ASCII_CHARSET);
  const leaks = [];
  for (const ramp of ['`', '```', '', '\t\r\n', 'é█⣿', '@\u0000 ', '﻿#.', '🙂@. ']) {
    const cp = asciiCells(L, W, H, cols, rows, { method: 'ramp', ramp });
    const bad = [...new Set(Array.from(cp).filter(v => !set.has(String.fromCodePoint(v))))];
    if (bad.length) leaks.push(`${JSON.stringify(ramp)} -> ${bad.map(v => 'U+' + v.toString(16).padStart(4, '0')).join(',')}`);
  }
  assert.deepEqual(leaks, []);
});

test('ASCII: NaN lightness never becomes NUL', () => {
  const [SX, SY] = ASCII_SUB;
  const L = new Float32Array(4 * SX * 2 * SY).fill(NaN);
  for (const method of ['shape', 'ramp']) {
    const cp = asciiCells(L, 4 * SX, 2 * SY, 4, 2, { method });
    assert.ok(Array.from(cp).every(v => v >= 0x20 && v <= 0x7e && v !== 0x60), method + ': ' + Array.from(cp));
  }
});

test('dithers on a random L never produce out-of-range bits, every method, odd sizes', () => {
  const r = rng(9);
  for (let t = 0; t < 40; t++) {
    const W = 2 * (1 + ((r() * 30) | 0)), H = 4 * (1 + ((r() * 12) | 0));
    const L = Float32Array.from({ length: W * H }, () => (r() < 0.05 ? (r() < 0.5 ? -3 : 4) : r()));
    for (const d of DITHERS) {
      const dots = ditherDots(L, W, H, d);
      assert.ok(dots.every(v => v === 0 || v === 1));
      const g = encodeBraille(dots, W, H);
      assert.deepEqual(decodeBrailleGrid(g.cp, W / 2, H / 4), dots);
    }
  }
});

// =====================================================================================
// Formatters (skipped until js/count.js and js/targets.js exist)
// =====================================================================================

let T = null, C = null, fmtMissing = '';
try { C = await import('../js/count.js'); T = await import('../js/targets.js'); }
catch (e) { fmtMissing = e.message.split('\n')[0]; }
function ftest(name, fn) {
  if (!T || !C) { skip++; out.push('SKIP ' + name + ' (' + fmtMissing + ')'); return; }
  test(name, fn);
}

// Independent X weighted count (twitter-text v3, no URLs: callers only feed URL-free text).
function xWeightRef(s) {
  let n = 0;
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0);
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}
const utf16Ref = s => s.length;
const utf8Ref = s => Buffer.byteLength(s, 'utf8');
const BRAILLE_TARGETS = ['ig', 'x', 'xlong', 'tg', 'tgc', 'ytc', 'steamc', 'steamp', 'steamb'];
const FLOW_TARGETS = ['twitch', 'ytlive'];

/** Every platform rule for a payload; returns a list of violations (empty = clean). */
function violations(text, { braille = false, fence = false, rows = null, blankDot = false } = {}) {
  const v = [];
  if (typeof text !== 'string') return ['text is not a string'];
  if (text.includes('\r')) v.push('CR');
  if (/[﻿￾￿]/.test(text)) v.push('BOM/FFFE/FFFF');
  if (text !== text.normalize('NFC')) v.push('not NFC');
  if (text.endsWith('\n')) v.push('trailing newline');
  if (text.startsWith('\n')) v.push('leading newline');
  const lines = text.split('\n');
  if (braille) {
    if (lines.some(l => l.length === 0)) v.push('empty line (collapses)');
    if (/ /.test(text)) v.push('U+0020 in Braille payload');
    if (lines.some(l => /^\s|\s$/.test(l))) v.push('whitespace at a line edge');
    for (const l of lines) for (const ch of l) {
      const c = ch.codePointAt(0);
      if (c < 0x2800 || c > 0x28ff) { v.push('non-Braille U+' + c.toString(16) + ' in art row'); break; }
    }
    const widths = new Set(lines.map(l => [...l].length));
    if (widths.size > 1) v.push('unequal row widths ' + [...widths].join('/'));
    if (blankDot && text.includes('⠀')) v.push('U+2800 left with blank: dot');
    if (rows != null && lines.length !== rows) v.push(`rows ${lines.length} != ${rows}`);
  }
  if (fence) {
    if (!text.startsWith('```\n')) v.push('fence open not "```\\n"');
    if (!text.endsWith('\n```')) v.push('fence close not "\\n```"');
    const inner = lines.slice(1, -1);
    for (const l of inner) {
      if (l.includes('`')) { v.push('backtick inside fence'); break; }
      if (/[^\x20-\x7e]/.test(l)) { v.push('non-printable/non-ASCII inside fence: ' + JSON.stringify(l.match(/[^\x20-\x7e]/)[0])); break; }
    }
    if (rows != null && inner.length !== rows) v.push(`fence rows ${inner.length} != ${rows}`);
  }
  return v;
}

test('rule checker self-test: accepts clean payloads, catches each violation', () => {
  const ok = '⠁⠀\n⠀⣿';
  assert.deepEqual(violations(ok, { braille: true, rows: 2 }), []);
  const bad = {
    CR: '⠁⠀\r\n⠀⣿', 'U+0020': '⠁ \n⠀⣿', 'empty line': '⠁⠀\n\n⠀⣿',
    unequal: '⠁\n⠀⣿', BOM: '﻿⠁⠀\n⠀⣿', 'trailing newline': ok + '\n', 'non-Braille': '⠁a\n⠀⣿',
  };
  for (const [k, s] of Object.entries(bad)) assert.ok(violations(s, { braille: true }).length > 0, 'missed ' + k);
  assert.deepEqual(violations('```\n /\\_\n(o o)\n```', { fence: true, rows: 2 }), []);
  assert.ok(violations('```\n a`b\n```', { fence: true }).length);
  assert.ok(violations('```js\n ab\n```', { fence: true }).length);
  assert.ok(violations('```\n a\u0007\n```', { fence: true }).length);
  assert.equal(xWeightRef('⠀⠀\n⠀'), 7);
  assert.equal(xWeightRef('ab\n'), 3);
  assert.equal(xWeightRef('—'), 1);
  assert.equal(xWeightRef('‰'), 2);
  assert.equal(xWeightRef('\u{1F600}'), 2);
});

// Hostile grids built by hand (a formatter must never trust the Grid).
function brailleGrid(cols, rows, f) {
  const cp = new Uint32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cp[r * cols + c] = f(c, r);
  return { mode: 'braille', cols, rows, cp, fg: null, bg: null, ink: 0.5 };
}
function hostileBrailleGrids() {
  const r = rng(21);
  return [
    ['random', brailleGrid(16, 8, () => 0x2800 + ((r() * 256) | 0))],
    ['all blank', brailleGrid(20, 10, () => 0x2800)],
    ['blank first/last rows and cols', brailleGrid(12, 6, (c, y) => (c === 0 || y === 0 || c === 11 || y === 5 ? 0x2800 : 0x28ff))],
    ['U+0020 cells', brailleGrid(10, 5, (c) => (c % 3 ? 0x20 : 0x2812))],
    ['1 x 1 blank', brailleGrid(1, 1, () => 0x2800)],
    ['1 x 30', brailleGrid(1, 30, () => 0x2800)],
    ['60 x 1', brailleGrid(60, 1, () => 0x2801)],
    ['huge', brailleGrid(200, 110, () => 0x2800 + ((r() * 256) | 0))],
  ];
}

ftest('formatFor Braille targets: every hostile grid obeys every rule, counts match independent counts', () => {
  const problems = [];
  for (const target of BRAILLE_TARGETS) for (const [name, g] of hostileBrailleGrids()) for (const opts of [{}, { blank: 'dot' }, { caption: true }]) {
    let res;
    try { res = T.formatFor(target, g, opts); } catch (e) { problems.push(`${target} ${name} threw ${e.message}`); continue; }
    const v = violations(res.text, { braille: true, rows: g.rows, blankDot: opts.blank === 'dot' });
    if (v.length) problems.push(`${target} ${name} ${JSON.stringify(opts)}: ${v.join('; ')}`);
    const ref = target === 'x' || target === 'xlong' ? xWeightRef(res.text)
      : target.startsWith('steam') ? utf8Ref(res.text) : utf16Ref(res.text);
    if (res.count !== ref) problems.push(`${target} ${name}: count ${res.count} != independent ${ref}`);
    if (res.fits !== (res.count <= res.limit)) problems.push(`${target} ${name}: fits=${res.fits} but ${res.count}/${res.limit}`);
    if (res.cols !== g.cols || res.rows !== g.rows) problems.push(`${target} ${name}: reported ${res.cols}x${res.rows}`);
    const analytic = T.countFor(target, 'braille', g.cols, g.rows, opts);
    if (analytic !== res.count) problems.push(`${target} ${name}: countFor ${analytic} != formatFor ${res.count}`);
    if (!res.fits && !res.warnings.some(w => w.level === 'error' || w.level === 'warn')) problems.push(`${target} ${name}: over budget without a warning`);
    // the art must survive: decoding the payload gives back the grid (blank / U+0020 -> U+2800 / U+2840)
    const lines = res.text.split('\n');
    for (let y = 0; y < g.rows && lines[y]; y++) {
      const row = [...lines[y]];
      for (let c = 0; c < g.cols; c++) {
        let want = g.cp[y * g.cols + c];
        if (want === 0x20 || want === 0x2800) want = opts.blank === 'dot' ? 0x2840 : 0x2800;
        if (row[c] && row[c].codePointAt(0) !== want) { problems.push(`${target} ${name}: art changed at ${c},${y}`); y = g.rows; break; }
      }
    }
  }
  assert.deepEqual(problems.slice(0, 20), []);
});

ftest('formatFor chats: every hostile grid is one line of equal Braille words, counts match', () => {
  const problems = [];
  for (const target of FLOW_TARGETS) for (const [name, g] of hostileBrailleGrids()) for (const opts of [{}, { blank: 'dot' }]) {
    let res;
    try { res = T.formatFor(target, g, opts); } catch (e) { problems.push(`${target} ${name} threw ${e.message}`); continue; }
    const t = res.text;
    if (/[\r\n]/.test(t)) problems.push(`${target} ${name}: line break in a chat message`);
    if (/  |^ | $/.test(t)) problems.push(`${target} ${name}: double or edge space`);
    if (t !== t.normalize('NFC')) problems.push(`${target} ${name}: not NFC`);
    const words = t.split(' ');
    if (words.length !== g.rows + 1) problems.push(`${target} ${name}: ${words.length} words for ${g.rows} rows`);
    if (words.some(w => [...w].length !== g.cols || [...w].some(ch => ch.codePointAt(0) < 0x2800 || ch.codePointAt(0) > 0x28ff))) {
      problems.push(`${target} ${name}: a word is not ${g.cols} Braille cells`);
    }
    if (res.count !== utf16Ref(t)) problems.push(`${target} ${name}: count ${res.count} != ${utf16Ref(t)}`);
    if (T.countFor(target, 'braille', g.cols, g.rows, opts) !== res.count) problems.push(`${target} ${name}: countFor disagrees`);
    if (res.fits !== (res.count <= res.limit)) problems.push(`${target} ${name}: fits flag`);
  }
  assert.deepEqual(problems.slice(0, 20), []);
});

ftest('formatFor X: the free budget formula 2*cols*rows + rows - 1 and 16 x 8 = 263 fits', () => {
  for (const [c, r] of [[16, 8], [15, 9], [17, 8], [1, 1], [140, 1], [1, 94]]) {
    const res = T.formatFor('x', brailleGrid(c, r, () => 0x2800));
    assert.equal(res.count, 2 * c * r + r - 1, `${c}x${r}`);
    assert.equal(res.fits, res.count <= 280, `${c}x${r}`);
    assert.equal(C.xWeightedLength(res.text), res.count);
  }
});

ftest('formatFor Telegram ASCII: fence exact, printable only, backticks and hostile code points stripped', () => {
  const hostile = [0x60, 0x00, 0x0d, 0x0a, 0x09, 0x7f, 0xfeff, 0x2800, 0x1f600, 0x41, 0x20];
  const cols = 11, rows = 4;
  const cp = new Uint32Array(cols * rows);
  for (let i = 0; i < cp.length; i++) cp[i] = hostile[i % hostile.length];
  const g = { mode: 'ascii', cols, rows, cp, fg: null, bg: null, ink: 0.3 };
  const blankRows = { mode: 'ascii', cols: 5, rows: 3, cp: new Uint32Array(15).fill(0x20), fg: null, bg: null, ink: 0 };
  for (const target of ['tg', 'tgc']) for (const grid of [g, blankRows]) {
    const res = T.formatFor(target, grid);
    const v = violations(res.text, { fence: true, rows: grid.rows });
    assert.deepEqual(v, [], `${target}: ${JSON.stringify(res.text)}`);
    assert.equal(res.count, utf16Ref(res.text), 'count includes fences');
    const inner = res.text.split('\n').slice(1, -1);
    assert.equal(new Set(inner.map(l => l.length)).size, 1, 'fence rows keep one width');
  }
});

ftest('formatFor: modes a target cannot show warn (ASCII / blocks on ig and x, blocks in a chat)', () => {
  const ascii = { mode: 'ascii', cols: 8, rows: 4, cp: new Uint32Array(32).fill(0x41), fg: null, bg: null, ink: 0.5 };
  const blocks = { mode: 'blocks', cols: 8, rows: 4, cp: new Uint32Array(32).fill(0x2588), fg: null, bg: null, ink: 1 };
  for (const [t, g] of [['ig', ascii], ['x', ascii], ['ig', blocks], ['x', blocks], ['tg', blocks]]) {
    const res = T.formatFor(t, g);
    assert.ok(res.warnings.length > 0, `${t} ${g.mode}: no warning`);
    assert.ok(!res.text.includes('\r'));
  }
});

ftest('X: URL-like ASCII counts 23 per link and warns', () => {
  assert.equal(C.xWeightedLength('a.co'), 23);
  assert.equal(C.xWeightedLength('x a.co y'), 27);
  assert.ok(C.findUrlsX('see a.b and example.com').length >= 1);
  assert.equal(C.xWeightedLength('\r\n'), 2, 'CRLF weighs 2 on X');
  assert.deepEqual(C.xInvalidChars('a﻿b￾￿').sort(), ['﻿', '￾', '￿'].sort());
  assert.equal(C.utf16Length('\u{1F600}'), 2);
});

ftest('xlong: foldRow is the first row whose end passes 280 weighted', () => {
  const g = brailleGrid(20, 30, () => 0x2800);
  const res = T.formatFor('xlong', g);
  const lines = res.text.split('\n');
  let acc = 0, fold = null;
  for (let y = 0; y < lines.length; y++) { acc += xWeightRef(lines[y]) + (y ? 1 : 0); if (acc > 280) { fold = y; break; } }
  assert.equal(res.foldRow, fold);
  assert.ok(res.warnings.length > 0, 'fold warning');
});

ftest('autoFit is maximal and consistent with countFor / maxCols / rowsFor for every target and mode', () => {
  const problems = [];
  for (const t of Object.keys(T.TARGETS)) {
    const modes = T.TARGETS[t].modes || ['braille'];
    for (const mode of modes) for (const phone of [360, 390, 430]) {
      const opts = { phone };
      const { cols, rows } = T.autoFit(t, mode, opts);
      const asp = T.cellAspect(t, mode);
      const mc = T.maxCols(t, mode, { phone });
      const lim = T.TARGETS[t].limit;
      if (rows !== T.rowsFor(cols, asp)) problems.push(`${t}/${mode}@${phone}: rows ${rows} != rowsFor(${cols})`);
      if (cols > mc) problems.push(`${t}/${mode}@${phone}: ${cols} cols > maxCols ${mc}`);
      const n = T.countFor(t, mode, cols, rows, opts);
      if (lim && n > lim) problems.push(`${t}/${mode}@${phone}: autoFit ${cols}x${rows} counts ${n} > ${lim}`);
      const c2 = cols + 1;
      if (!Number.isFinite(mc) && !(lim && Number.isFinite(lim))) continue;   // plain: nothing to be maximal against
      if (c2 <= mc && (!lim || T.countFor(t, mode, c2, T.rowsFor(c2, asp), opts) <= lim)) problems.push(`${t}/${mode}@${phone}: ${c2} cols also fits, autoFit not maximal`);
    }
  }
  assert.deepEqual(problems, []);
});

ftest('the real pipeline end to end: converter Grid -> every target, clean payloads', () => {
  const c = conv(portrait());
  const problems = [];
  for (const t of BRAILLE_TARGETS) for (const invert of [false, true]) {
    const { cols, rows } = T.autoFit(t, 'braille', {});
    const g = c.run({}, { mode: 'braille', cols, rows, tone: { invert } });
    const res = T.formatFor(t, g);
    const v = violations(res.text, { braille: true, rows });
    if (v.length) problems.push(`${t}: ${v.join('; ')}`);
    if (!res.fits) problems.push(`${t}: autoFit grid does not fit (${res.count}/${res.limit})`);
  }
  const ga = c.run({}, { mode: 'ascii', cols: 32, rows: 15 });
  const v = violations(T.formatFor('tg', ga).text, { fence: true, rows: 15 });
  if (v.length) problems.push('tg ascii: ' + v.join('; '));
  assert.deepEqual(problems, []);
});

// ---------- report ----------
console.log(out.join('\n'));
console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
if (fmtMissing) console.log('formatters not testable: ' + fmtMissing);
process.exitCode = fail ? 1 : 0;

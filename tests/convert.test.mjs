// Converter tests (node, plain assert): node tests/convert.test.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createConverter, gridLines, DITHERS, smallGridBoost } from '../js/convert.js';
import { encodeBraille, brailleDots, ditherDots } from '../js/dither.js';
import { QUAD_CP, BLOCK_SET, blocksQuad, labGrid } from '../js/blocks.js';
import { sampleFromRGBA, decodeSource, toneGrid, TONE_DEFAULTS, LOOKS } from '../js/tone.js';
// Timing budgets are for this machine; shared CI runners (CI=true) are slower, so they get slack
// there: the tests still catch a real slowdown without failing on a busy runner.
const PERF = process.env.CI ? 4 : 1;

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push('ok   ' + name); } catch (e) { fail++; results.push('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
}

// Synthetic portrait (ImageData-like): grey backdrop, dark hair, skin oval, eyes, mouth.
function portrait(w = 1200, h = 1600) {
  const data = new Uint8ClampedArray(w * h * 4);
  const ell = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p += 4) {
      const u = x / w, v = y / h;
      let c = [150, 160, 175];
      if (ell(u, v, 0.5, 0.4, 0.3, 0.27)) c = [40, 30, 25];
      if (ell(u, v, 0.5, 0.43, 0.21, 0.21)) c = [222, 180, 150];
      if (ell(u, v, 0.42, 0.4, 0.035, 0.018) || ell(u, v, 0.58, 0.4, 0.035, 0.018)) c = [30, 20, 20];
      if (ell(u, v, 0.5, 0.55, 0.06, 0.015)) c = [160, 60, 60];
      if (ell(u, v, 0.5, 1.0, 0.4, 0.15)) c = [40, 45, 60];
      data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function halves(w = 400, h = 400) {   // left half black, right half white
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p += 4) {
    const c = x < w / 2 ? 0 : 255;
    data[p] = data[p + 1] = data[p + 2] = c; data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

const CROP = { x: 0.5, y: 0.45, zoom: 1.2, rotation: 0 };
const PHOTO = portrait();

test('Braille bit order: each of the 8 dots maps to its code point', () => {
  // [column, row] -> expected code point, from the Unicode dot numbering (dots 1-8)
  const expect = [
    [0, 0, 0x2801], [0, 1, 0x2802], [0, 2, 0x2804], [1, 0, 0x2808],
    [1, 1, 0x2810], [1, 2, 0x2820], [0, 3, 0x2840], [1, 3, 0x2880],
  ];
  for (const [cx, cy, cp] of expect) {
    const dots = new Uint8Array(8);
    dots[cy * 2 + cx] = 1;
    const g = encodeBraille(dots, 2, 4);
    assert.equal(g.cp.length, 1);
    assert.equal(g.cp[0], cp, `dot at col ${cx} row ${cy}: got U+${g.cp[0].toString(16)}`);
  }
  assert.equal(encodeBraille(new Uint8Array(8).fill(1), 2, 4).cp[0], 0x28FF);
  assert.equal(encodeBraille(new Uint8Array(8), 2, 4).cp[0], 0x2800);
});

test('Braille encode/decode round trip for all 256 patterns, multi-cell layout', () => {
  const W = 2 * 256, H = 4;
  const dots = new Uint8Array(W * H);
  for (let c = 0; c < 256; c++) {
    const d = brailleDots(0x2800 + c);
    for (let r = 0; r < 4; r++) for (let k = 0; k < 2; k++) dots[r * W + c * 2 + k] = d[r][k];
  }
  const g = encodeBraille(dots, W, H);
  for (let c = 0; c < 256; c++) assert.equal(g.cp[c], 0x2800 + c);
  // second row of cells lands in the second row of the grid
  const d2 = new Uint8Array(4 * 8); d2[4 * 2 + 1] = 1;   // dot at x=1, y=4 -> cell (0,1), dot 4
  const g2 = encodeBraille(d2, 2, 8);
  assert.deepEqual([...g2.cp], [0x2800, 0x2808]);
});

test('every dither gives only U+2800..U+28FF, never U+0020, right size', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  for (const d of DITHERS) {
    for (const cols of [16, 28, 40, 60]) {
      const rows = Math.round(cols * 0.55);
      const g = conv.run(CROP, { mode: 'braille', cols, rows, dither: d });
      assert.equal(g.cp.length, cols * rows);
      assert.equal(g.cols, cols); assert.equal(g.rows, rows);
      for (const cp of g.cp) assert.ok(cp >= 0x2800 && cp <= 0x28FF, `${d}: U+${cp.toString(16)}`);
      const lines = gridLines(g);
      assert.equal(lines.length, rows);
      for (const l of lines) { assert.ok(!l.includes(' ')); assert.equal([...l].length, cols); }
      assert.ok(g.ink > 0.1 && g.ink < 0.7, `${d} ${cols}: ink ${g.ink}`);
    }
  }
});

test('deterministic: two fresh converters give identical grids', () => {
  for (const d of DITHERS) {
    const a = createConverter(); a.setSource(PHOTO);
    const b = createConverter(); b.setSource(PHOTO);
    const opts = { mode: 'braille', cols: 40, rows: 22, dither: d, tone: { edges: 0.5 } };
    assert.deepEqual([...a.run(CROP, opts).cp], [...b.run(CROP, opts).cp]);
  }
});

test('invert puts the dots on the light half', () => {
  const conv = createConverter();
  conv.setSource(halves());
  const count = (g, left) => {
    let n = 0;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      if ((c < g.cols / 2) !== left) continue;
      const bits = g.cp[r * g.cols + c] - 0x2800;
      for (let b = bits; b; b &= b - 1) n++;
    }
    return n;
  };
  const opts = { mode: 'braille', cols: 20, rows: 11, tone: { auto: false, detail: 0 } };
  const g0 = conv.run({}, opts);
  const g1 = conv.run({}, { ...opts, tone: { auto: false, detail: 0, invert: true } });
  assert.ok(count(g0, true) > 10 * count(g0, false), 'normal: dots on the dark (left) half');
  assert.ok(count(g1, false) > 10 * count(g1, true), 'inverted: dots on the light (right) half');
});

test('transparent pixels stay paper when inverted (logo background, past the photo edge)', () => {
  const w = 100, h = 100;
  const data = new Uint8ClampedArray(w * h * 4);   // transparent, with an opaque white square in the middle
  for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) data.set([255, 255, 255, 255], (y * w + x) * 4);
  const conv = createConverter();
  conv.setSource({ width: w, height: h, data });
  const g = conv.run({}, { mode: 'braille', cols: 20, rows: 10, dither: 'threshold', tone: { invert: true, auto: false, detail: 0 } });
  const dotted = i => g.cp[i] !== 0x2800;
  assert.ok(!dotted(0) && !dotted(19) && !dotted(199), 'transparent corners stay blank');
  assert.ok(dotted(5 * 20 + 10), 'the opaque white square becomes dots');
  // not inverted, white on transparent is paper on paper: nothing at all
  const plain = conv.run({ zoom: 0.5 }, { mode: 'braille', cols: 20, rows: 10 });
  assert.ok(plain.cp.every(c => c === 0x2800));
});

test('blocks give only the allowed set; colour has fg/bg, mono has none', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  for (const blocks of ['quad', 'half']) {
    for (const color of [true, false]) {
      const g = conv.run(CROP, { mode: 'blocks', cols: 40, rows: 20, blocks, color });
      assert.equal(g.cp.length, 800);
      for (const cp of g.cp) assert.ok(BLOCK_SET.has(cp), `U+${cp.toString(16)}`);
      if (color) { assert.ok(g.fg && g.bg); assert.equal(g.fg.length, 800); }
      else { assert.equal(g.fg, null); assert.equal(g.bg, null); }
      if (blocks === 'half' && !color) for (const cp of g.cp) assert.ok([0x20, 0x2580, 0x2584, 0x2588].includes(cp));
    }
  }
});

test('quadrant fit: one dark corner gives the matching quadrant with fg dark', () => {
  // 2x2 sub-cells per mask: dark where the mask bit is set
  for (let m = 1; m < 15; m++) {
    const rgb = new Uint8ClampedArray(4 * 3);
    const SUB = [0, 1, 2, 3];   // UL, UR, LL, LR -> row-major index in a 2x2 grid
    for (let k = 0; k < 4; k++) {
      const v = (m >> k) & 1 ? 20 : 235;
      rgb[SUB[k] * 3] = rgb[SUB[k] * 3 + 1] = rgb[SUB[k] * 3 + 2] = v;
    }
    const g = blocksQuad(labGrid(rgb, null, 4), 2, 2);
    assert.equal(g.cp[0], QUAD_CP[m], `mask ${m}: got U+${g.cp[0].toString(16)}`);
    assert.ok((g.fg[0] & 0xff) < 60 && (g.bg[0] & 0xff) > 200);
  }
});

test('memoisation: a tone change never resamples, a dither change never re-tones', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  const o = { mode: 'braille', cols: 40, rows: 22 };
  conv.run(CROP, o);
  assert.deepEqual({ ...conv.stats }, { samples: 1, tones: 1, encodes: 1 });
  conv.run(CROP, { ...o, tone: { contrast: 0.3 } });
  assert.equal(conv.stats.samples, 1, 'tone change resampled');
  assert.equal(conv.stats.tones, 2);
  conv.run(CROP, { ...o, tone: { contrast: 0.3 }, dither: 'bayer' });
  assert.equal(conv.stats.tones, 2, 'dither change re-toned');
  conv.run(CROP, { ...o, tone: { contrast: 0.3 }, dither: 'threshold' });
  conv.run({ ...CROP }, o);   // back to the first tone: cached
  assert.equal(conv.stats.samples, 1);
  assert.equal(conv.stats.tones, 2);
  conv.run({ ...CROP, x: 0.51 }, o);
  assert.equal(conv.stats.samples, 2, 'crop change must resample');
  // mono blocks: dither change does not re-tone either
  conv.run(CROP, { mode: 'blocks', cols: 40, rows: 20, dither: 'atkinson' });
  const t = conv.stats.tones;
  conv.run(CROP, { mode: 'blocks', cols: 40, rows: 20, dither: 'bayer' });
  assert.equal(conv.stats.tones, t);
  conv.setSource(PHOTO);
  conv.run(CROP, o);
  assert.equal(conv.stats.samples, 4, 'setSource clears the caches');
});

test('sampler: transparent pixels are white paper, rotation turns the image', () => {
  const w = 64, h = 64;
  const data = new Uint8ClampedArray(w * h * 4);   // all transparent black
  const s = sampleFromRGBA(data, w, h, 8, 8, { crop: {} });
  for (const v of s.L) assert.ok(v > 0.999);
  const hv = halves(64, 64);
  const s0 = sampleFromRGBA(hv.data, 64, 64, 8, 8, { crop: {} });
  assert.ok(s0.L[0] < 0.05 && s0.L[7] > 0.95, 'left dark, right light');
  const s90 = sampleFromRGBA(hv.data, 64, 64, 8, 8, { crop: { rotation: 90 } });
  // rotated 90 deg clockwise: the dark left half ends up on top
  assert.ok(s90.L[0] < 0.05 && s90.L[7] < 0.05 && s90.L[63] > 0.95, 'dark half on top after 90 deg');
  const sc = sampleFromRGBA(PHOTO.data, PHOTO.width, PHOTO.height, 30, 40, { crop: CROP, color: true });
  assert.equal(sc.rgb.length, 30 * 40 * 3);
});

test('decode once: long side capped at 1024 by exact area averaging; samples are area means', () => {
  // 2048 x 1024 fine checkerboard of 0 / 255 -> every decoded pixel averages one 2 x 2 block
  const w = 2048, h = 1024, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p += 4) {
    data[p] = data[p + 1] = data[p + 2] = (x + y) & 1 ? 255 : 0; data[p + 3] = 255;
  }
  const dec = decodeSource({ width: w, height: h, data });
  assert.deepEqual([dec.width, dec.height], [1024, 512]);
  assert.ok(dec.opaque);
  for (let i = 0; i < dec.data.length; i += 4 * 997) assert.ok(Math.abs(dec.data[i] - 127.5) <= 0.5 && dec.data[i + 3] === 255, 'pixel ' + dec.data[i]);
  // whole-image sample of a two-level image = its exact mean; a 1 x 1 sample of the halves is 0.5
  const hv = halves(64, 64);
  const one = sampleFromRGBA(hv.data, 64, 64, 1, 1);
  assert.ok(Math.abs(one.L[0] - 0.5) < 1e-3, 'mean ' + one.L[0]);
  // enlarging (8 source px -> 64 samples) interpolates linearly across the black / white edge
  const up = sampleFromRGBA(halves(8, 8).data, 8, 8, 64, 1, { crop: { zoom: 1 } });
  let steps = 0;
  for (let x = 1; x < 64; x++) { assert.ok(up.L[x] >= up.L[x - 1] - 1e-6, 'monotone'); if (up.L[x] > up.L[x - 1] + 1e-6) steps++; }
  assert.ok(steps >= 6, 'smooth ramp, not a hard step: ' + steps);
});

test('tone: auto hits the ink target, brightness works with auto, gamma > 1 lightens (every look)', () => {
  const img = sampleFromRGBA(PHOTO.data, PHOTO.width, PHOTO.height, 80, 88, { crop: CROP });
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  // soft solves the midtones for the target exactly; the others place regions first and only trim
  const soft = toneGrid(img, { look: 'soft' }, { target: 0.4 });
  assert.ok(Math.abs(soft.stats.coverage - 0.4) < 0.08, 'soft coverage ' + soft.stats.coverage);
  for (const { id } of LOOKS) {
    const base = toneGrid(img, { look: id }, { target: 0.4 });
    assert.ok(base.stats.coverage > 0.15 && base.stats.coverage < 0.7, id + ' coverage ' + base.stats.coverage);
    const bright = toneGrid(img, { look: id, brightness: 0.6 }, { target: 0.4 });
    assert.ok(mean(bright) > mean(base) + 0.02, id + ': brightness lightens under auto');
    const g = toneGrid(img, { look: id, gamma: 2 }, { target: 0.4 });
    assert.ok(mean(g) > mean(base) + 0.01, id + ': gamma 2 lightens');
  }
  const inv = toneGrid(img, { ...TONE_DEFAULTS, look: 'soft', invert: true }, { target: 0.4 });
  // a mostly light photo cannot reach 0.4 dots inverted without crushing it: the solve is bounded
  assert.ok(inv.stats.coverage > 0.3 && inv.stats.coverage < 0.62, 'inverted coverage ' + inv.stats.coverage);
  assert.equal(smallGridBoost(16), 1); assert.equal(smallGridBoost(40), 0);
});

test('edges OR a thinned ridge into the dots', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  const o = { mode: 'braille', cols: 40, rows: 22 };
  const a = conv.run(CROP, o), b = conv.run(CROP, { ...o, tone: { edges: 1 } });
  assert.ok(b.ink > a.ink, `edges add dots: ${a.ink.toFixed(3)} -> ${b.ink.toFixed(3)}`);
});

test('looks: TONE_DEFAULTS.look is photo; LOOKS lists 5 { id, name }; unknown look falls back', () => {
  assert.equal(TONE_DEFAULTS.look, 'photo');
  assert.deepEqual(LOOKS.map(l => l.id), ['photo', 'texture', 'sketch', 'soft', 'poster']);
  for (const l of LOOKS) assert.ok(typeof l.name === 'string' && l.name.length > 0);
  const img = sampleFromRGBA(PHOTO.data, PHOTO.width, PHOTO.height, 56, 60, { crop: CROP });
  assert.deepEqual([...toneGrid(img, { look: 'nope' })], [...toneGrid(img, { look: 'photo' })]);
  assert.equal(toneGrid(img, { look: 'nope' }).stats.look, 'photo');
});

test('looks: every look deterministic, finite, in [0, 1], with .edge and .stats (both themes, 3 sizes)', () => {
  for (const [W, H] of [[2, 4], [56, 60], [120, 88]]) {
    const img = sampleFromRGBA(PHOTO.data, PHOTO.width, PHOTO.height, W, H, { crop: CROP });
    for (const { id } of LOOKS) for (const invert of [false, true]) {
      const tone = { look: id, invert, edges: 0.3 };
      const a = toneGrid(img, tone, { target: 0.4, boost: 0.5 }), b = toneGrid(img, tone, { target: 0.4, boost: 0.5 });
      assert.deepEqual([...a], [...b], id + ' ' + W + 'x' + H + ' not deterministic');
      for (let i = 0; i < a.length; i++) assert.ok(a[i] >= 0 && a[i] <= 1, id + ' ' + W + 'x' + H + ' L[' + i + '] = ' + a[i]);
      assert.ok(a.edge && a.edge.mag.length === W * H, id + ' edge');
      for (const k of ['lo', 'hi', 'gamma', 'coverage', 'std']) assert.ok(Number.isFinite(a.stats[k]), id + ' stats.' + k);
    }
  }
});

test('looks: invert puts the dots on the light half in every look (auto on)', () => {
  const conv = createConverter();
  conv.setSource(halves());
  const count = (g, left) => {
    let n = 0;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      if ((c < g.cols / 2) !== left) continue;
      for (let b = g.cp[r * g.cols + c] - 0x2800; b; b &= b - 1) n++;
    }
    return n;
  };
  for (const { id } of LOOKS) {
    const g0 = conv.run({}, { mode: 'braille', cols: 20, rows: 11, tone: { look: id } });
    const g1 = conv.run({}, { mode: 'braille', cols: 20, rows: 11, tone: { look: id, invert: true } });
    assert.ok(count(g0, true) > 5 * count(g0, false), id + ': normal: dots on the dark (left) half');
    assert.ok(count(g1, false) > 5 * count(g1, true), id + ': inverted: dots on the light (right) half');
  }
});

test('looks: brightness moves the ink in both themes, every look (+ = lighter photo)', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  const o = { mode: 'braille', cols: 40, rows: 22 };
  for (const { id } of LOOKS) for (const invert of [false, true]) {
    const [dk, mid, lt] = [-0.6, 0, 0.6].map(b => conv.run(CROP, { ...o, tone: { look: id, invert, brightness: b } }).ink);
    // light theme: lighter photo = fewer dots; dark theme: lighter photo = more lit dots
    const ok = invert ? lt >= mid && mid >= dk && lt - dk > 0.05 : lt <= mid && mid <= dk && dk - lt > 0.05;
    assert.ok(ok, id + (invert ? ' dark' : ' light') + ': ink at -0.6 / 0 / +0.6 = ' + [dk, mid, lt].map(v => v.toFixed(3)).join(' / '));
  }
});

test('looks: the tone cache is keyed on the look; colour blocks stay soft', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  const o = { mode: 'braille', cols: 30, rows: 16 };
  const a = conv.run(CROP, { ...o, tone: { look: 'photo' } });
  const n = conv.stats.tones;
  const b = conv.run(CROP, { ...o, tone: { look: 'poster' } });
  assert.equal(conv.stats.tones, n + 1, 'a look change re-tones');
  assert.notDeepEqual([...a.cp], [...b.cp], 'photo and poster differ');
  assert.deepEqual([...conv.run(CROP, { ...o, tone: { look: 'photo' } }).cp], [...a.cp], 'back to photo from the cache');
  const s = conv.stats.samples;
  conv.run(CROP, { ...o, tone: { look: 'sketch' } });
  assert.equal(conv.stats.samples, s, 'a look change never resamples');
  const c1 = conv.run(CROP, { mode: 'blocks', cols: 30, rows: 16, color: true, tone: { look: 'photo' } });
  const c2 = conv.run(CROP, { mode: 'blocks', cols: 30, rows: 16, color: true, tone: { look: 'soft' } });
  assert.deepEqual([...c1.fg], [...c2.fg]);
});

const lookMs = {};
test('looks: every look under 5 ms for a 120 x 88 grid (node, median)', () => {
  const img = sampleFromRGBA(PHOTO.data, PHOTO.width, PHOTO.height, 120, 88, { crop: CROP });
  for (const { id } of LOOKS) {
    const xs = [];
    for (let k = 0; k < 15; k++) {
      const t0 = performance.now();
      toneGrid(img, { look: id, brightness: (k % 5) / 10 }, { target: 0.4, boost: 0 });
      if (k >= 3) xs.push(performance.now() - t0);
    }
    xs.sort((a, b) => a - b);
    lookMs[id] = xs[xs.length >> 1];
  }
  const slow = Object.entries(lookMs).filter(([, v]) => v >= 5 * PERF);
  assert.deepEqual(slow, []);
});

const timing = {};
test('timing: 60 x 40 Braille from a fresh crop < 30 ms, tone change < 10 ms', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  const o = { mode: 'braille', cols: 60, rows: 40 };
  conv.run({ ...CROP, x: 0.3 }, o);   // warm up the JIT
  conv.run({ ...CROP, x: 0.3 }, { ...o, tone: { contrast: 0.9 } });
  const fresh = [], toneT = [], dith = [];
  for (let k = 0; k < 9; k++) {
    const crop = { ...CROP, x: 0.45 + k * 0.01 };
    let t0 = performance.now(); conv.run(crop, o); fresh.push(performance.now() - t0);
    t0 = performance.now(); conv.run(crop, { ...o, tone: { contrast: 0.1 * k + 0.05 } }); toneT.push(performance.now() - t0);
    t0 = performance.now(); conv.run(crop, { ...o, tone: { contrast: 0.1 * k + 0.05 }, dither: 'floyd' }); dith.push(performance.now() - t0);
  }
  const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  timing.fresh = med(fresh); timing.tone = med(toneT); timing.dither = med(dith);
  timing.freshMax = Math.max(...fresh); timing.toneMax = Math.max(...toneT);
  assert.ok(timing.fresh < 30 * PERF, 'fresh ' + timing.fresh);
  assert.ok(timing.tone < 10 * PERF, 'tone ' + timing.tone);
});

test('ASCII wiring (when ascii.js is present)', () => {
  const conv = createConverter();
  conv.setSource(PHOTO);
  if (!conv.asciiReady) { results.push('     (ascii.js not loaded: skipped)'); return; }
  for (const method of ['shape', 'ramp']) {
    let g;
    try { g = conv.run(CROP, { mode: 'ascii', cols: 40, rows: 18, ascii: method }); } catch (e) {
      if (/shape-vectors/.test(e.message)) { results.push('     (ascii ' + method + ': ' + e.message + ' - skipped)'); continue; }
      throw e;
    }
    assert.equal(g.cp.length, 40 * 18);
    for (const cp of g.cp) assert.ok(cp >= 0x20 && cp <= 0x7E && cp !== 0x60, `U+${cp.toString(16)}`);
  }
});

console.log(results.join('\n'));
console.log('timing (node, median ms):', JSON.stringify(Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, +v.toFixed(2)]))));
console.log('looks 120 x 88 (node, median ms):', JSON.stringify(Object.fromEntries(Object.entries(lookMs).map(([k, v]) => [k, +v.toFixed(2)]))));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

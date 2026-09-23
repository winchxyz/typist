// node --test tests/ascii.test.mjs   (or: node tests/ascii.test.mjs)
// Classic ASCII: charset rules, determinism, clean paper, synthetic shapes (lines, diagonals, a
// circle) and the 60 x 40 time budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiCells, ASCII_CHARSET, RAMP, TONE_RAMP, ASCII_SUB, CELL_ASPECT, SHAPES_CURRENT } from '../js/ascii.js';
import { GLYPHS, COVERAGE } from '../js/shape-vectors.js';
// Timing budgets are for this machine; shared CI runners (CI=true) are slower, so they get slack
// there: the tests still catch a real slowdown without failing on a busy runner.
const PERF = process.env.CI ? 4 : 1;

const [SX, SY] = ASCII_SUB;
const HT = 1 / CELL_ASPECT;   // cell height in cell widths

// Lightness grid for cols x rows cells from an ink test in physical cell units (x: 0..cols,
// y: 0..rows * HT), 3 x 3 supersampled per sample pixel.
function synth(cols, rows, inkAt) {
  const W = cols * SX, H = rows * SY, L = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let ink = 0;
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) ink += inkAt((px + (i + 0.5) / 3) / SX, (py + (j + 0.5) / 3) / SY * HT) ? 1 : 0;
      }
      L[py * W + px] = 1 - ink / 9;
    }
  }
  return { L, W, H };
}
const run = (cols, rows, inkAt, opts) => {
  const { L, W, H } = synth(cols, rows, inkAt);
  return asciiCells(L, W, H, cols, rows, opts);
};
const chars = cp => Array.from(cp, c => String.fromCodePoint(c));
const nonBlank = list => list.filter(ch => ch !== ' ');
const mode = list => {
  const n = new Map();
  for (const ch of list) n.set(ch, (n.get(ch) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
};
// Distance from (x, y) to a segment, physical units.
const segDist = (x, y, x0, y0, x1, y1) => {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
};
const STROKE = 0.3;   // line width in cell widths, about a glyph stroke drawn at 1.7x

test('charset: 94 printable glyphs, no backtick, data matches the geometry', () => {
  assert.equal(ASCII_CHARSET.length, 94);
  assert.ok(!ASCII_CHARSET.includes('`'));
  for (const ch of ASCII_CHARSET) assert.ok(ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e);
  assert.equal(GLYPHS, ASCII_CHARSET);
  assert.ok(SHAPES_CURRENT, 'shape-vectors.js was generated with other circle geometry: rerun dev/shapes.html');
  assert.ok(!RAMP.includes('`'));
  for (const ch of TONE_RAMP) assert.ok(ASCII_CHARSET.includes(ch), TONE_RAMP);
  assert.equal(RAMP[RAMP.length - 1], ' ');
  const cov = Array.from(RAMP, ch => COVERAGE[GLYPHS.indexOf(ch)]);
  for (let i = 1; i < cov.length; i++) assert.ok(cov[i] < cov[i - 1], `ramp coverage not decreasing at ${i}: ${RAMP}`);
});

test('only charset glyphs are emitted (noise, both methods, hostile ramp)', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const cols = 40, rows = 20, W = cols * SX, H = rows * SY;
  const L = Float32Array.from({ length: W * H }, rnd);
  const set = new Set(ASCII_CHARSET);
  for (const opts of [{ method: 'shape' }, { method: 'shape', contrast: 0 }, { method: 'shape', contrast: 2 },
    { method: 'ramp' }, { method: 'ramp', ramp: '@`#` .' }]) {
    const cp = asciiCells(L, W, H, cols, rows, opts);
    assert.equal(cp.length, cols * rows);
    for (const ch of chars(cp)) {
      assert.ok(set.has(ch), `${JSON.stringify(opts)} emitted ${JSON.stringify(ch)}`);
      assert.notEqual(ch, '`');
    }
  }
  // Odd input sizes are resampled, not rejected.
  const cp = asciiCells(Float32Array.from({ length: 97 * 61 }, rnd), 97, 61, 20, 9, {});
  assert.equal(cp.length, 180);
});

test('deterministic: same grid, same text; white is all spaces, black is dense', () => {
  const inkAt = (x, y) => Math.hypot(x - 10, (y - 10 * HT / 2)) < 6;
  const a = run(20, 10, inkAt), b = run(20, 10, inkAt);
  assert.deepEqual(a, b);
  assert.ok(chars(run(10, 5, () => false)).every(ch => ch === ' '));
  const dense = chars(run(10, 5, () => true));
  const top = dense[0];
  assert.ok(COVERAGE[GLYPHS.indexOf(top)] > 0.2, `black became ${top}`);
});

// Lightness from a function of physical position (x: 0..cols, y: 0..rows * HT), 1 = paper.
function synthL(cols, rows, lAt) {
  const W = cols * SX, H = rows * SY, L = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) L[py * W + px] = lAt((px + 0.5) / SX, (py + 0.5) / SY * HT);
  }
  return { L, W, H };
}

test('paper stays blank: light grey backgrounds, noisy near-white, a grey patch on white', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const cols = 30, rows = 12;
  // a dark disc on a light grey background (the grey is this image's paper)
  for (const bg of [0.97, 0.9, 0.82]) {
    const { L, W, H } = synthL(cols, rows, (x, y) => (Math.hypot(x - 15, y - rows * HT / 2) < 5 ? 0.1 : bg + (rnd() - 0.5) * 0.06));
    const cp = chars(asciiCells(L, W, H, cols, rows));
    const border = cp.filter((ch, i) => { const r = Math.floor(i / cols), c = i % cols; return r < 2 || r >= rows - 2 || c < 4 || c >= cols - 4; });
    assert.ok(border.every(ch => ch === ' '), `bg ${bg}: background gave ${JSON.stringify(mode(border))}`);
    assert.ok(cp.some(ch => ch !== ' '), `bg ${bg}: the disc vanished`);
  }
  // a very light grey patch (L 0.92) next to black on white: the patch is paper, the black is not
  const { L, W, H } = synthL(cols, rows, x => (x < 10 ? 0.02 : x < 20 ? 0.92 : 1));
  const cp = chars(asciiCells(L, W, H, cols, rows));
  const patch = [], black = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c >= 11 && c < 19) patch.push(cp[r * cols + c]);
      if (c < 9) black.push(cp[r * cols + c]);
    }
  }
  assert.ok(patch.every(ch => ch === ' '), `light patch gave ${JSON.stringify(mode(patch))}`);
  assert.ok(black.every(ch => COVERAGE[GLYPHS.indexOf(ch)] > 0.2), `black gave ${JSON.stringify(mode(black))}`);
});

test('vertical lines read as |, thin or thick, centred or off-centre', () => {
  const cols = 9, rows = 8;
  for (const w of [0.12, STROKE, 0.45]) {
    const seen = [];
    for (const x0 of [4.5, 4.35, 4.65]) {
      const cp = chars(run(cols, rows, x => Math.abs(x - x0) < w / 2));
      for (let r = 1; r < rows - 1; r++) seen.push(cp[r * cols + 4]);
    }
    const ok = seen.filter(ch => ch === '|').length;
    assert.ok(ok >= seen.length * 0.8, `vertical line ${w} wide gave ${JSON.stringify(mode(seen))}`);
  }
});

test('horizontal lines read as - mid-cell and _ at the cell bottom, thin or thick', () => {
  const cols = 10, rows = 5;
  for (const w of [0.12, STROKE]) {
    const mid = chars(run(cols, rows, (x, y) => Math.abs(y - 2.5 * HT) < w / 2)).slice(2 * cols + 1, 3 * cols - 1);
    assert.ok(mid.filter(ch => ch === '-').length >= mid.length * 0.8, `mid line ${w} gave ${JSON.stringify(mode(mid))}`);
    const low = chars(run(cols, rows, (x, y) => Math.abs(y - 2.85 * HT) < w / 2)).slice(2 * cols + 1, 3 * cols - 1);
    assert.ok(low.filter(ch => ch === '_').length >= low.length * 0.8, `low line ${w} gave ${JSON.stringify(mode(low))}`);
  }
});

test('diagonals at the glyph slope read as / and \\', () => {
  const cols = 12, rows = 10;
  // One cell across per cell down, the slope of '/' in a monospace cell.
  for (const w of [0.15, STROKE]) {
    const up = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, rows * HT - 0.5, 11, 0.5) < w / 2)));
    const down = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, 0.5, 11, rows * HT - 0.5) < w / 2)));
    assert.ok(up.filter(ch => ch === '/').length >= up.length * 0.6, `rising ${w} gave ${JSON.stringify(mode(up))}`);
    assert.ok(down.filter(ch => ch === '\\').length >= down.length * 0.6, `falling ${w} gave ${JSON.stringify(mode(down))}`);
  }
});

test('45-degree diagonals lean the right way and use stroke glyphs', () => {
  const cols = 24, rows = 10, len = rows * HT;
  const up = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, len - 0.5, 1 + len - 1, 0.5) < STROKE / 2)));
  const down = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, 0.5, 1 + len - 1, len - 0.5) < STROKE / 2)));
  // a 45-degree line is flatter than '/', so ASCII artists draw it with '/' plus _ , . ' - steps
  // (light marks , . ' " ; : are the steps between strokes; a few stray glyphs remain: 70 %)
  const rising = s => s.filter(ch => '/,.\'_-";:'.includes(ch)).length;
  const falling = s => s.filter(ch => '\\\'.,-_";:'.includes(ch)).length;
  assert.ok(up.includes('/') && rising(up) >= up.length * 0.7, `45 up gave ${JSON.stringify(mode(up))}`);
  assert.ok(down.includes('\\') && falling(down) >= down.length * 0.7, `45 down gave ${JSON.stringify(mode(down))}`);
  assert.ok(!up.includes('\\'), `45 up contains \\: ${JSON.stringify(mode(up))}`);
  assert.ok(!down.includes('/'), `45 down contains /: ${JSON.stringify(mode(down))}`);
});

test('circle outline: ( | ) on its sides, / \\ on its shoulders, _ - on top and bottom', () => {
  const cols = 30, rows = 14, cx = 15, cy = rows * HT / 2, R = 12;
  const cp = chars(run(cols, rows, (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - R) < STROKE / 2));
  const at = (r, c) => cp[r * cols + c];
  // outermost stroke glyph of a row (light marks , . ; : ' are skipped: where the outline runs
  // exactly on a cell boundary each cell sees half of it, and one of them may draw only a mark)
  const firstFrom = (r, dir) => {
    for (let c = dir > 0 ? 0 : cols - 1; c >= 0 && c < cols; c += dir) if (!' ,.;:\''.includes(at(r, c))) return at(r, c);
    return null;
  };
  // rows around the equator: parentheses, bars or slashes on both sides
  const eq = [5, 6, 7, 8];
  const left = eq.map(r => firstFrom(r, 1)), right = eq.map(r => firstFrom(r, -1));
  const lefty = left.filter(ch => ch && '(|[{/\\'.includes(ch)).length;
  const righty = right.filter(ch => ch && ')|]}/\\'.includes(ch)).length;
  assert.ok(lefty >= 3 && righty >= 3, `equator left ${JSON.stringify(left)} right ${JSON.stringify(right)}`);
  // upper shoulders lean inwards (/ on the left, \ on the right), lower ones outwards
  const band = (r0, r1, c0, c1) => {
    const o = [];
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) if (at(r, c) !== ' ') o.push(at(r, c));
    return o;
  };
  const ul = band(1, 5, 0, 12), ur = band(1, 5, 18, 30), ll = band(9, 13, 0, 12), lr = band(9, 13, 18, 30);
  assert.ok(ul.includes('/') && !ul.includes('\\'), `upper left ${JSON.stringify(mode(ul))}`);
  assert.ok(ur.includes('\\') && !ur.includes('/'), `upper right ${JSON.stringify(mode(ur))}`);
  assert.ok(ll.includes('\\') && !ll.includes('/'), `lower left ${JSON.stringify(mode(ll))}`);
  assert.ok(lr.includes('/') && !lr.includes('\\'), `lower right ${JSON.stringify(mode(lr))}`);
  // top and bottom: horizontal strokes
  const top = band(0, 2, 10, 20), bottom = band(12, 14, 10, 20);
  assert.ok(top.length >= 6 && top.filter(ch => '_-~.,'.includes(ch)).length >= top.length * 0.8, `top ${JSON.stringify(mode(top))}`);
  assert.ok(bottom.length >= 6 && bottom.filter(ch => '_-~\'"^'.includes(ch)).length >= bottom.length * 0.8, `bottom ${JSON.stringify(mode(bottom))}`);
  // every glyph on the outline is a stroke or a light mark, never a letter or a dense glyph
  // ('=' is two horizontal bars: a shallow stretch of the arc crossing two sub-rows)
  const bad = cp.filter(ch => ch !== ' ' && !'|/\\()[]{}<>_=-~.,:;\'"^!'.includes(ch));
  assert.ok(bad.length <= 2, `outline used ${JSON.stringify(mode(bad))}`);
});

test('60 x 40 cells: shape method under 10 ms', () => {
  const cols = 60, rows = 40;
  const { L, W, H } = synth(cols, rows, (x, y) => (Math.sin(x * 0.7) * Math.cos(y * 0.23) > 0.2) || Math.hypot(x - 30, y - 40) < 20);
  for (let i = 0; i < 10; i++) asciiCells(L, W, H, cols, rows, {});
  const t = [];
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now();
    asciiCells(L, W, H, cols, rows, {});
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  const med = t[t.length >> 1];
  console.log(`# asciiCells 60x40 shape: median ${med.toFixed(2)} ms, min ${t[0].toFixed(2)}, max ${t[t.length - 1].toFixed(2)}`);
  assert.ok(med < 10 * PERF, `median ${med.toFixed(2)} ms`);
});

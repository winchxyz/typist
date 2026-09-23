// node --test tests/ascii.test.mjs   (or: node tests/ascii.test.mjs)
// Classic ASCII: charset rules, determinism, synthetic shapes and the 60 x 40 time budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiCells, ASCII_CHARSET, RAMP, ASCII_SUB, CELL_ASPECT, SHAPES_CURRENT } from '../js/ascii.js';
import { GLYPHS, COVERAGE } from '../js/shape-vectors.js';

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

test('vertical line reads as | or similar', () => {
  const cols = 9, rows = 8;
  const seen = [];
  for (const x0 of [4.5, 4.3, 4.7]) {
    const cp = chars(run(cols, rows, x => Math.abs(x - x0) < STROKE / 2));
    for (let r = 1; r < rows - 1; r++) seen.push(cp[r * cols + 4]);
  }
  const ok = seen.filter(ch => '|!Il1[]()i{}'.includes(ch)).length;
  assert.ok(ok >= seen.length * 0.8, `vertical line gave ${JSON.stringify(mode(seen))}`);
});

test('horizontal line reads as - mid-cell and _ at the cell bottom', () => {
  const cols = 10, rows = 5;
  const mid = chars(run(cols, rows, (x, y) => Math.abs(y - 2.5 * HT) < STROKE / 2)).slice(2 * cols + 1, 3 * cols - 1);
  assert.ok(mid.filter(ch => '-~='.includes(ch)).length >= mid.length * 0.8, `mid line gave ${JSON.stringify(mode(mid))}`);
  const low = chars(run(cols, rows, (x, y) => Math.abs(y - 2.85 * HT) < STROKE / 2)).slice(2 * cols + 1, 3 * cols - 1);
  assert.ok(low.filter(ch => '_'.includes(ch)).length >= low.length * 0.8, `low line gave ${JSON.stringify(mode(low))}`);
});

test('diagonals read as / and \\ (glyph slope: one column per row)', () => {
  const cols = 12, rows = 10;
  // One cell across per cell down, the slope of '/' in a monospace cell.
  const up = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, rows * HT - 0.5, 11, 0.5) < STROKE / 2)));
  const down = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, 0.5, 11, rows * HT - 0.5) < STROKE / 2)));
  assert.equal(mode(up)[0][0], '/', `rising diagonal gave ${JSON.stringify(mode(up))}`);
  assert.equal(mode(down)[0][0], '\\', `falling diagonal gave ${JSON.stringify(mode(down))}`);
});

test('45-degree diagonals lean the right way', () => {
  const cols = 24, rows = 10, len = rows * HT;
  const up = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, len - 0.5, 1 + len - 1, 0.5) < STROKE / 2)));
  const down = nonBlank(chars(run(cols, rows, (x, y) => segDist(x, y, 1, 0.5, 1 + len - 1, len - 0.5) < STROKE / 2)));
  const rising = s => s.filter(ch => '/,.\'_-'.includes(ch)).length;
  const falling = s => s.filter(ch => '\\\'`.-_'.includes(ch)).length;
  assert.ok(up.includes('/') || rising(up) >= up.length * 0.6, `45 up gave ${JSON.stringify(mode(up))}`);
  assert.ok(down.includes('\\') || falling(down) >= down.length * 0.6, `45 down gave ${JSON.stringify(mode(down))}`);
  assert.ok(!up.includes('\\'), `45 up contains \\: ${JSON.stringify(mode(up))}`);
  assert.ok(!down.includes('/'), `45 down contains /: ${JSON.stringify(mode(down))}`);
});

test('circle outline: parentheses-like glyphs on its left and right', () => {
  const cols = 30, rows = 14, cx = 15, cy = rows * HT / 2, R = 12;
  const cp = chars(run(cols, rows, (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - R) < STROKE / 2));
  const mid = [5, 6, 7, 8];   // rows near the equator
  const left = mid.map(r => cp.slice(r * cols, r * cols + 6).find(ch => ch !== ' '));
  const right = mid.map(r => cp.slice(r * cols + 24, (r + 1) * cols).reverse().find(ch => ch !== ' '));
  const lefty = left.filter(ch => ch && '(|[{<!:'.includes(ch)).length;
  const righty = right.filter(ch => ch && ')|]}>!:'.includes(ch)).length;
  assert.ok(lefty >= 3 && righty >= 3, `left ${JSON.stringify(left)} right ${JSON.stringify(right)}`);
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
  assert.ok(med < 10, `median ${med.toFixed(2)} ms`);
});

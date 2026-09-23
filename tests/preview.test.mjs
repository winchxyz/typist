// Preview layout maths (node, plain assert): node tests/preview.test.mjs
// Cell sizes from FIT, the text column vs maxCols, wrapping like a text engine, Windows shear.
import assert from 'node:assert/strict';
import { FIT, PHONES, maxCols, formatFor } from '../js/targets.js';
import {
  cellMetrics, textWidth, cellWidths, wrapRow, layoutArt, shearOffsets, payloadRows, ariaLabel,
  WIN_BLANK_RATIO, IG_MORE_ROWS,
} from '../js/preview.js';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push('ok   ' + name); } catch (e) {
    fail++; results.push('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n     '));
  }
}
const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b}`);
const B = 0x2800, FULL = 0x28ff;
const row = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const grid = (mode, cols, rows, f) => {
  const cp = new Uint32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) cp[y * cols + x] = f(x, y);
  return { mode, cols, rows, cp, fg: null, bg: null, ink: 0.5 };
};
const CASES = [['ig', 'braille'], ['x', 'braille'], ['xlong', 'braille'], ['tg', 'braille'], ['tg', 'ascii'],
  ['tgc', 'braille'], ['tgc', 'ascii']];

// ---------------------------------------------------------------- cell sizes
test('cell size = FIT fontPx x cellEm by fontPx x lineEm, every target and mode', () => {
  for (const [t, mode] of CASES) {
    const f = FIT[t][mode], m = cellMetrics(t, mode, 'ios');
    near(m.cellW, f.fontPx * f.cellEm); near(m.cellH, f.fontPx * f.lineEm);
    assert.equal(m.blankW, m.cellW, `${t}/${mode} blank width on iOS`);
    assert.equal(m.shear, false);
  }
  const ig = cellMetrics('ig', 'braille');
  near(ig.cellW, 11.25); near(ig.cellH, 19.5);
});

test('Windows: Braille blanks are 0.651/0.753 of a dot cell; ASCII never shears', () => {
  const m = cellMetrics('tg', 'braille', 'windows');
  assert.equal(m.shear, true);
  near(m.blankW / m.cellW, 0.651 / 0.753, 1e-12);
  near(WIN_BLANK_RATIO, 0.8645418326693227, 1e-12);
  const a = cellMetrics('tg', 'ascii', 'windows');
  assert.equal(a.shear, false); assert.equal(a.blankW, a.cellW);
  assert.equal(cellMetrics('ig', 'braille', 'android').shear, false);
});

test('cellWidths: only U+2800 narrows on Windows (U+2840 blank-dot keeps full width)', () => {
  const m = cellMetrics('ig', 'braille', 'windows');
  const w = cellWidths([B, 0x2840, FULL, B], m);
  near(w[0], m.blankW); near(w[1], m.cellW); near(w[2], m.cellW); near(w[3], m.blankW);
});

// ---------------------------------------------------------------- text column vs maxCols
test('text column holds exactly maxCols cells at 360 / 390 / 430; one more wraps', () => {
  for (const [t, mode] of CASES) for (const phone of PHONES) {
    const m = cellMetrics(t, mode), W = textWidth(t, mode, phone), mc = maxCols(t, mode, { phone });
    const fill = mode === 'ascii' ? 0x40 : FULL;
    assert.equal(wrapRow(row(mc, () => fill), cellWidths(row(mc, () => fill), m), W).length, 1, `${t}/${mode}@${phone} ${mc} fit`);
    assert.equal(wrapRow(row(mc + 1, () => fill), cellWidths(row(mc + 1, () => fill), m), W).length, 2, `${t}/${mode}@${phone} ${mc + 1} wraps`);
  }
});

test('preview wraps iff formatFor says the grid is too wide (iOS / Android)', () => {
  for (const [t, mode] of CASES) for (const phone of PHONES) {
    const mc = maxCols(t, mode, { phone });
    for (const cols of [mc - 3, mc, mc + 1, mc + 7]) {
      const g = grid(mode, cols, 3, () => (mode === 'ascii' ? 0x23 : FULL));
      const p = formatFor(t, g, { phone });
      const { rows } = payloadRows(p, g);
      const lay = layoutArt(rows, mode, cellMetrics(t, mode, 'ios'), textWidth(t, mode, phone));
      assert.equal(lay.wrappedRows.length > 0, p.wraps, `${t}/${mode}@${phone} cols ${cols}`);
    }
  }
});

test('plain (file) never wraps', () => {
  assert.equal(textWidth('plain', 'braille'), Infinity);
  const lay = layoutArt([row(300, () => FULL)], 'braille', cellMetrics('plain', 'braille'), Infinity);
  assert.equal(lay.lines.length, 1);
});

// ---------------------------------------------------------------- wrapping like text
test('Braille: the overflowing part continues on the next line, greedily', () => {
  const m = { cellW: 10, cellH: 20, blankW: 10, shear: false };
  const cells = row(25, i => (i % 3 ? FULL : B));
  const parts = wrapRow(cells, cellWidths(cells, m), 100);
  assert.deepEqual(parts.map(p => [p.start, p.end]), [[0, 10], [10, 20], [20, 25]]);
  assert.deepEqual([...parts[1].xs], row(10, i => i * 10));   // continuation starts at x = 0
  near(parts[2].width, 50);
});

test('Braille: blank cells are glyphs, not spaces (trailing U+2800 still wraps)', () => {
  const m = { cellW: 10, cellH: 20, blankW: 10, shear: false };
  const cells = [...row(8, () => FULL), ...row(4, () => B)];
  assert.equal(wrapRow(cells, cellWidths(cells, m), 100).length, 2);
});

test('ASCII: breaks after spaces, spaces hang, long words break mid-word', () => {
  const m = { cellW: 10, cellH: 20, blankW: 10, shear: false };
  const s = str => Array.from(str, c => c.codePointAt(0));
  // "aaaa bbbbbb" in 8 cells: break before "bbbbbb", the space hangs on line 1
  let parts = wrapRow(s('aaaa bbbbbb'), cellWidths(s('aaaa bbbbbb'), m), 80, true);
  assert.deepEqual(parts.map(p => [p.start, p.end]), [[0, 5], [5, 11]]);
  near(parts[0].width, 40);   // hanging space not counted
  // trailing spaces past the edge hang: no extra line
  parts = wrapRow(s('abcdefgh    '), cellWidths(s('abcdefgh    '), m), 80, true);
  assert.equal(parts.length, 1);
  // one word wider than the line breaks at the overflow
  parts = wrapRow(s('abcdefghijkl'), cellWidths(s('abcdefghijkl'), m), 80, true);
  assert.deepEqual(parts.map(p => [p.start, p.end]), [[0, 8], [8, 12]]);
  // several spaces: break after the whole run
  parts = wrapRow(s('ab   cdefgh'), cellWidths(s('ab   cdefgh'), m), 80, true);
  assert.deepEqual(parts.map(p => [p.start, p.end]), [[0, 5], [5, 11]]);
});

test('layoutArt: rowLine / rowSpan / wrappedRows / height', () => {
  const m = { cellW: 10, cellH: 20, blankW: 10, shear: false };
  const rows = [row(5, () => FULL), row(25, () => FULL), row(10, () => FULL), row(11, () => FULL)];
  const lay = layoutArt(rows, 'braille', m, 100);
  assert.deepEqual(lay.rowLine, [0, 1, 4, 5]);
  assert.deepEqual(lay.rowSpan, [1, 3, 1, 2]);
  assert.deepEqual(lay.wrappedRows, [1, 3]);
  assert.equal(lay.lines.length, 7);
  near(lay.height, 140); near(lay.width, 100);
  assert.ok(lay.lines.every(l => l.width <= 100 + 1e-9));
});

test('a single cell wider than the line still takes one line (no infinite loop)', () => {
  const m = { cellW: 50, cellH: 20, blankW: 50, shear: false };
  const parts = wrapRow(row(3, () => FULL), cellWidths(row(3, () => FULL), m), 20);
  assert.equal(parts.length, 3);
});

// ---------------------------------------------------------------- Windows shear
test('shear offset = -(leading blanks) x (dot - blank width); 0 on phones and for dotless rows', () => {
  const w = cellMetrics('ig', 'braille', 'windows'), p = cellMetrics('ig', 'braille', 'ios');
  const rows = [[FULL, B], [B, B, B, FULL], [B, B, B, B], row(20, i => (i < 7 ? B : FULL))];
  const off = shearOffsets(rows, w);
  const d = w.cellW - w.blankW;
  near(off[0], 0); near(off[1], -3 * d); near(off[2], 0); near(off[3], -7 * d);
  near(d, 11.25 * (1 - 0.651 / 0.753), 1e-12);   // 1.524 px per blank at 15 px
  assert.deepEqual(shearOffsets(rows, p), [0, 0, 0, 0]);
});

test('Windows layout: x positions follow the narrower blanks; a blank-heavy row fits where a phone wraps', () => {
  const w = cellMetrics('ig', 'braille', 'windows'), p = cellMetrics('ig', 'braille', 'ios');
  const cells = [B, B, FULL, B, FULL];
  const [line] = wrapRow(cells, cellWidths(cells, w), 1000);
  near(line.xs[2], 2 * w.blankW); near(line.xs[4], 3 * w.blankW + w.cellW);
  // 27 cells at 390: 27 > maxCols 26 on a phone, but 20 of them blank -> fits on Windows
  const W = textWidth('ig', 'braille', 390), mc = maxCols('ig', 'braille', { phone: 390 });
  const r = row(mc + 1, i => (i < 20 ? B : FULL));
  assert.equal(wrapRow(r, cellWidths(r, p), W).length, 2);
  assert.equal(wrapRow(r, cellWidths(r, w), W).length, 1);
});

// ---------------------------------------------------------------- payload and labels
test('payloadRows: fence stripped for Telegram ASCII, blank-dot cells kept as pasted', () => {
  const g = grid('ascii', 4, 2, (x, y) => (x === y ? 0x23 : 0x20));
  const p = formatFor('tg', g);
  const { mode, rows } = payloadRows(p, g);
  assert.equal(mode, 'ascii');
  assert.deepEqual(rows.map(r => String.fromCodePoint(...r)), ['#   ', ' #  ']);
  const b = grid('braille', 3, 1, x => (x === 1 ? FULL : B));
  const pd = formatFor('ig', b, { blank: 'dot' });
  assert.deepEqual(payloadRows(pd, b).rows[0], [0x2840, FULL, 0x2840]);
  assert.deepEqual(payloadRows(null, b).rows[0], [B, FULL, B]);
});

test('aria-label says size and place, never the characters', () => {
  assert.equal(ariaLabel('ig', 26, 15), 'Text art of your photo, 26 by 15 characters, for an Instagram comment');
  assert.equal(ariaLabel('tgc', 27, 16, { caption: true }), 'Text art of your photo, 27 by 16 characters, for a Telegram photo caption');
  assert.match(ariaLabel('x', 30, 17, { wrapped: 17, phone: 360 }), /17 rows wrap on a 360 px screen$/);
  assert.equal(IG_MORE_ROWS, 12);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Classic ASCII: a density ramp and the shape-vector matcher after Alex Harri, "ASCII characters
// are not pixels" (alexharri.com/blog/ascii-rendering).
//
// Shape method, per cell:
//   1. six sampling circles in a staggered 2 x 3 layout measure mean ink (1 - L) -> a 6D vector;
//   2. directional contrast: each circle is pushed down when the neighbouring cells' nearest circles
//      (the "external" circles) hold more ink, which sharpens edges between cells;
//   3. global contrast: v = (v / max)^e * max over the vector, which exaggerates its shape;
//   4. nearest glyph (Euclidean) among the committed glyph vectors in shape-vectors.js.
// Glyph vectors are committed data (dev/shapes.html renders them from one font), and every step
// here is plain arithmetic, so the same lightness grid gives the same text in every engine.
// Namespace import: an older or placeholder data file may lack some exports (SHAPES_CURRENT says so).
import * as SV from './shape-vectors.js';
const { GLYPHS = '', VECTORS = [], COVERAGE = [], RAMP: MEASURED_RAMP = '@%#*+=-:. ', GEOMETRY_KEY: DATA_KEY = '' } = SV;
const DATA_SHIFTS = SV.SHIFTS || [0];

/** The 94 printable ASCII glyphs 0x20..0x7E minus the backtick (Telegram fences). */
export const ASCII_CHARSET = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7e; c++) if (c !== 0x60) s += String.fromCharCode(c);
  return s;
})();

/** Default density ramp, dark -> light, chosen from measured glyph coverage (shape-vectors.js). */
export const RAMP = MEASURED_RAMP;

/** Rendered cell width / height in a monospace code block (SPEC: ~0.6 em advance, ~1.3 em line). */
export const CELL_ASPECT = 0.46;

/** Lightness samples per cell [x, y]; 8 / 17 = 0.47, so sample pixels are close to square. */
export const ASCII_SUB = [8, 17];

// Circle geometry in cell-width units: x runs 0..1 across the cell, y runs 0..HT down it, so the
// circles stay round on the rendered (tall) cell. Left circles sit lower and right ones higher
// (Harri's stagger), which closes the gaps a plain 2 x 3 grid leaves for diagonals.
const HT = 1 / CELL_ASPECT;
const COL_X = [0.27, 0.73];
const STAGGER = 0.1;
export const CIRCLE_R = 0.34;
/** Internal circle centres [x, y], order TL, TR, ML, MR, BL, BR (Harri's indices 0..5). */
export const CIRCLES = [0, 1, 2].flatMap(row => {
  const y = HT * (2 * row + 1) / 6;
  return [[COL_X[0], y + STAGGER], [COL_X[1], y - STAGGER]];
});
/** Sideways glyph offsets (cell widths) measured as extra candidates of the same glyph. */
export const SHIFTS = [0, -0.25, 0.25];
// Shifted candidates pay a small distance penalty so a centred glyph wins near-ties.
const SHIFT_PENALTY = 0.01;
export const GEOMETRY_KEY = `a${CELL_ASPECT}-x${COL_X.join(',')}-s${STAGGER}-r${CIRCLE_R}-d${SHIFTS.join(',')}`;

// External circles are the neighbouring cells' nearest internal circles: [dx, dy, circle].
//   0 1      above: the upper cell's BL, BR
// 2 . . 3    left cell's TR / MR / BR, right cell's TL / ML / BL
// 4 . . 5
// 6 . . 7
//   8 9      below: the lower cell's TL, TR
const EXTERNAL = [
  [0, -1, 4], [0, -1, 5],
  [-1, 0, 1], [1, 0, 0],
  [-1, 0, 3], [1, 0, 2],
  [-1, 0, 5], [1, 0, 4],
  [0, 1, 0], [0, 1, 1],
];
// Which external circles bear on each internal circle (Harri's AFFECTING_EXTERNAL_INDICES).
const AFFECTING = [[0, 1, 2, 4], [0, 1, 3, 5], [2, 4, 6], [3, 5, 7], [4, 6, 8, 9], [5, 7, 8, 9]];

// Default exponents at contrast = 1; `contrast` scales (e - 1), so 0 switches enhancement off.
const GLOBAL_EXP = 2;
const DIRECTIONAL_EXP = 3;

/**
 * Pixel weights of each internal circle over a w x h cell raster (area coverage by k x k
 * supersampling; weights sum to 1 per circle). Shared by the matcher and the glyph generator so
 * image cells and glyphs are measured with exactly the same circles.
 * Returns [{ px: Int32Array (y * w + x), wt: Float64Array }] x 6.
 */
export function circleWeights(w, h, k = w * h > 4096 ? 1 : 6) {
  return CIRCLES.map(([cx, cy]) => {
    const px = [], wt = [];
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let j = 0; j < k; j++) {
          const sy = (y + (j + 0.5) / k) / h * HT - cy;
          for (let i = 0; i < k; i++) {
            const sx = (x + (i + 0.5) / k) / w - cx;
            if (sx * sx + sy * sy <= CIRCLE_R * CIRCLE_R) hit++;
          }
        }
        if (hit) { px.push(y * w + x); wt.push(hit); sum += hit; }
      }
    }
    return { px: Int32Array.from(px), wt: Float64Array.from(wt, v => v / sum) };
  });
}

/** Area-average resample of a lightness grid (box filter; also fine for mild upsampling). */
export function resampleL(L, W, H, W2, H2) {
  const axis = (n, n2) => {
    const idx = [], wts = [];
    const s = n / n2;
    for (let o = 0; o < n2; o++) {
      const a = o * s, b = Math.min(n, (o + 1) * s);
      const ii = [], ww = [];
      if (b - a < 1e-9) { ii.push(Math.min(n - 1, Math.floor(a))); ww.push(1); }
      for (let i = Math.floor(a); i < b && i < n; i++) {
        const w = Math.min(b, i + 1) - Math.max(a, i);
        if (w > 1e-9) { ii.push(i); ww.push(w / (b - a)); }
      }
      idx.push(ii); wts.push(ww);
    }
    return { idx, wts };
  };
  const ax = axis(W, W2), ay = axis(H, H2);
  const tmp = new Float64Array(W2 * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W2; x++) {
      const ii = ax.idx[x], ww = ax.wts[x];
      let s = 0;
      for (let t = 0; t < ii.length; t++) s += L[y * W + ii[t]] * ww[t];
      tmp[y * W2 + x] = s;
    }
  }
  const out = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) {
    const ii = ay.idx[y], ww = ay.wts[y];
    for (let x = 0; x < W2; x++) {
      let s = 0;
      for (let t = 0; t < ii.length; t++) s += tmp[ii[t] * W2 + x] * ww[t];
      out[y * W2 + x] = s;
    }
  }
  return out;
}

// Math.pow is not guaranteed to round identically across engines; a float32-rounded table with
// linear interpolation is (and is faster than pow per component).
const LUT_N = 1024;
const lutCache = new Map();
function powTable(e) {
  let t = lutCache.get(e);
  if (!t) {
    t = new Float64Array(LUT_N + 2);
    for (let i = 0; i <= LUT_N; i++) t[i] = Math.fround(Math.pow(i / LUT_N, e));
    t[LUT_N + 1] = t[LUT_N];
    if (lutCache.size > 16) lutCache.clear();
    lutCache.set(e, t);
  }
  return t;
}
function powLerp(t, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const f = x * LUT_N, i = f | 0;
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}

const GV = Float64Array.from(VECTORS);
const NS = (DATA_SHIFTS && DATA_SHIFTS.length) || 1;
const NC = GV.length / 6;                     // candidates = glyphs x shifts
const CAND_CP = Uint32Array.from({ length: NC }, (_, i) => GLYPHS.codePointAt(Math.floor(i / NS)));
const CAND_PEN = Float64Array.from({ length: NC }, (_, i) => (i % NS && DATA_SHIFTS[i % NS] ? SHIFT_PENALTY : 0));
const weightCache = new Map();

/**
 * Lightness grid -> one code point per cell (row-major).
 * L: Float32Array W x H, 1 = paper. Ideally W = cols * ASCII_SUB[0], H = rows * ASCII_SUB[1];
 * other sizes are area-resampled first.
 * opts: method 'shape' | 'ramp'; ramp: dark -> light string; contrast: enhancement strength
 * (0 = off, 1 = default, 2 = strong).
 */
export function asciiCells(L, W, H, cols, rows, { method = 'shape', ramp = RAMP, contrast = 1 } = {}) {
  const [SX, SY] = ASCII_SUB;
  if (W !== cols * SX || H !== rows * SY) {
    L = resampleL(L, W, H, cols * SX, rows * SY);
    W = cols * SX; H = rows * SY;
  }
  const out = new Uint32Array(cols * rows);
  if (method === 'ramp') return rampCells(L, W, cols, rows, ramp, out);
  if (!GV.length) throw new Error('shape-vectors.js is empty: run dev/shapes.html');

  // 1. internal circle vectors (mean ink)
  let circ = weightCache.get(W);
  if (!circ) {
    circ = circleWeights(SX, SY).map(({ px, wt }) => ({ off: Int32Array.from(px, p => Math.floor(p / SX) * W + (p % SX)), wt }));
    weightCache.set(W, circ);
  }
  const n = cols * rows;
  const raw = new Float64Array(n * 6);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const base = r * SY * W + c * SX, o = (r * cols + c) * 6;
      for (let k = 0; k < 6; k++) {
        const { off, wt } = circ[k];
        let s = 0;
        for (let t = 0; t < off.length; t++) s += wt[t] * L[base + off[t]];
        const ink = 1 - s;
        raw[o + k] = ink < 0 ? 0 : ink > 1 ? 1 : ink;
      }
    }
  }

  // 2. directional contrast from the neighbours' circles (outside the grid counts as paper),
  // 3. global contrast, 4. nearest glyph.
  const eD = 1 + (DIRECTIONAL_EXP - 1) * contrast, eG = 1 + (GLOBAL_EXP - 1) * contrast;
  const tD = powTable(eD), tG = powTable(eG);
  const ext = new Float64Array(10), v = new Float64Array(6);
  let prev = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const o = (r * cols + c) * 6;
      for (let e = 0; e < 10; e++) {
        const [dx, dy, k] = EXTERNAL[e];
        const cc = c + dx, rr = r + dy;
        ext[e] = cc < 0 || rr < 0 || cc >= cols || rr >= rows ? 0 : raw[(rr * cols + cc) * 6 + k];
      }
      let vmax = 0;
      for (let k = 0; k < 6; k++) {
        let x = raw[o + k], m = x;
        const aff = AFFECTING[k];
        for (let t = 0; t < aff.length; t++) if (ext[aff[t]] > m) m = ext[aff[t]];
        x = m > 0 ? powLerp(tD, x / m) * m : 0;
        v[k] = x;
        if (x > vmax) vmax = x;
      }
      if (vmax > 0) for (let k = 0; k < 6; k++) v[k] = powLerp(tG, v[k] / vmax) * vmax;
      prev = nearest(v, prev);
      out[r * cols + c] = CAND_CP[prev];
    }
  }
  return out;
}

// Brute force with partial-distance early exit, seeded with the previous cell's glyph (neighbours
// usually match, so the bound is tight from the start). Ties keep the seed, then the lower index.
function nearest(v, seed) {
  let best = seed, bd = dist(v, seed, Infinity);
  for (let g = 0; g < NC; g++) {
    if (g === seed) continue;
    const d = dist(v, g, bd);
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}
function dist(v, g, bound) {
  const o = g * 6;
  let d = CAND_PEN[g];
  for (let k = 0; k < 6; k++) {
    const t = v[k] - GV[o + k];
    d += t * t;
    if (d >= bound) return d;
  }
  return d;
}

function rampCells(L, W, cols, rows, ramp, out) {
  const [SX, SY] = ASCII_SUB;
  // only charset glyphs: a ramp of backticks alone left nothing and emitted NUL; control or
  // non-ASCII characters would break the Telegram fence
  let chars = Array.from(ramp || RAMP).filter(ch => ASCII_CHARSET.includes(ch));
  if (!chars.length) chars = Array.from(RAMP);
  const cps = Uint32Array.from(chars, ch => ch.codePointAt(0));
  const nr = cps.length, inv = 1 / (SX * SY);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const base = r * SY * W + c * SX;
      let s = 0;
      for (let y = 0; y < SY; y++) for (let x = 0; x < SX; x++) s += L[base + y * W + x];
      const i = Math.floor(s * inv * nr);
      // NaN lightness (no index) reads as paper rather than code point 0
      out[r * cols + c] = cps[i >= 0 ? (i < nr ? i : nr - 1) : i < 0 ? 0 : nr - 1];
    }
  }
  return out;
}

/** Mean ink coverage of an ASCII grid's glyphs (relative to the densest glyph), for the UI. */
export function asciiInk(cp) {
  if (!COVERAGE.length) return 0;
  const cmax = Math.max(...COVERAGE);
  let s = 0;
  for (let i = 0; i < cp.length; i++) {
    const g = GLYPHS.indexOf(String.fromCodePoint(cp[i]));
    if (g >= 0) s += COVERAGE[g] / cmax;
  }
  return cp.length ? s / cp.length : 0;
}

/** True when the committed glyph vectors were generated with this file's circle geometry. */
export const SHAPES_CURRENT = DATA_KEY === GEOMETRY_KEY;

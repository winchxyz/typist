// Classic ASCII: a density ramp and a shape matcher after Alex Harri, "ASCII characters are not
// pixels" (alexharri.com/blog/ascii-rendering), adapted so that edges read as | / \ _ - ( ) and
// paper stays blank.
//
// Shape method, per cell:
//   1. levels: ink = 1 - L is rescaled between the image's own paper and dark levels (histogram
//      percentiles), so "near paper" means near this image's white, whatever its exposure;
//   2. fifteen sampling circles on a 3 x 5 lattice measure mean ink. Harri's six staggered circles
//      cannot tell a centred '|' from flat grey (both fill every circle equally) and put '_' and
//      'L' close together; a middle column and a bottom row can;
//   3. paper gate: a cell whose ink is near paper and has no structure (no edge or line crossing
//      it) is a space, so backgrounds stay clean;
//   4. directional contrast: each boundary circle is pushed down when the neighbouring cells'
//      adjacent circles hold more ink (Harri's external circles, on the lattice), and global
//      contrast v = (v / max)^e * max exaggerates the cell's shape;
//   5. nearest glyph by a distance that weighs the *direction* of the ink vector (cosine) more
//      than its amount, the more so the more structure the cell has: a thin faint line and a thick
//      dark one both pick '|', while flat tone is matched on density. Only glyphs that read as a
//      shape or a tone take part; busy letters and digits are left out.
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
// circles stay round on the rendered (tall) cell. A plain lattice: 3 columns x 5 rows, radius a
// little over half the pitch so neighbouring circles overlap and no stroke falls in a gap.
const HT = 1 / CELL_ASPECT;
export const GRID = [3, 5];
const [GX, GY] = GRID;
export const DIMS = GX * GY;
export const CIRCLE_R = 0.28;
/** Circle centres [x, y], row-major (row 0 = top). */
export const CIRCLES = Array.from({ length: DIMS }, (_, k) => [((k % GX) + 0.5) / GX, HT * (Math.floor(k / GX) + 0.5) / GY]);
/** Sideways glyph offsets (cell widths) measured as extra candidates of the same glyph. */
export const SHIFTS = [0, -0.15, 0.15, -0.3, 0.3];
export const GEOMETRY_KEY = `g${GX}x${GY}-a${CELL_ASPECT}-r${CIRCLE_R}-d${SHIFTS.join(',')}`;

// Default exponents at contrast = 1; `contrast` scales (e - 1), so 0 switches enhancement off.
const GLOBAL_EXP = 2;
const DIRECTIONAL_EXP = 3;

// Levels: paper and dark are these percentiles of the lightness histogram.
const PAPER_PCT = 0.97, DARK_PCT = 0.02, PAPER_MIN = 0.65;
// Paper gate (normalised ink, 0 = this image's paper, 1 = its darkest): a cell is blank when its
// mean ink is under GATE_TONE and its circles differ by less than GATE_STRUCT (no edge, no line).
const GATE_TONE = 0.16, GATE_STRUCT = 0.3;
// Distance = PEN + WT * tone error^2 + (WD0 + WD1 * structure) * direction error^2, where
// structure = circle ink range / STRUCT_FULL (clamped to 1), tone error in units of the densest
// glyph, direction error = squared distance of the unit vectors (2 - 2 cos).
// The tone weight eases off as structure grows (TONE_EASE): a thin line is light in tone but
// must still draw as a stroke.
const WT = 3, TONE_EASE = 0.75, WD0 = 0.25, WD1 = 2.2, STRUCT_FULL = 0.4;
// Tone and structure are decided separately (the way hand-made ASCII art is drawn): every cell
// starts from the tone ramp, and only a cell whose ink is a clear stroke (enough contrast inside
// the cell AND a stroke glyph that fits its shape) is drawn with that stroke. Before this, dense
// letters (M W d b p q) competed on shape in every non-flat cell and drew letter soup in
// gradients, hair and fabric; a poorly fitting stroke is now tone instead.
// Flat cells (circle ink range under FLAT_RANGE) never try a stroke.
const FLAT_RANGE = 0.3;
// A stroke must fit the cell's (contrast-enhanced) ink direction with at least this cosine, and
// may be at most TONE_GAP lighter than the cell (a dark cell with a little texture stays dark).
const COS_MIN = 0.6, TONE_GAP = 0.42;
// Local contrast before matching: an unsharp mask on the circle lattice (radius about one cell
// width) makes eyes, glasses, nostrils and mouth darker than the skin around them and the skin
// next to them lighter, so small facial features survive at 32 columns. LC is its strength.
const LC = 0.9, LC_RX = 3, LC_RY = 2;
// Ramp tone curve: ink^RAMP_GAMMA. Above 1 it keeps mid-grey skin light (few glyphs) while dark
// areas stay dark, so a face reads as features on a clean ground instead of midtone texture.
const RAMP_GAMMA = 1.6;
/**
 * Tone ramp, light -> dark: ten glyphs at nearly even measured coverage (0, .07, .15, .27, .34,
 * .47, .58, .71, .81, 1.0 of '@'), so a gradient steps evenly ('&' fit the gap but read as noise
 * sprinkled through dark fabric). Bourke's ' .:-=+*#%@'
 * jumps from '*' (.27) to '#' (.71) and has '-' lighter than ':'.
 */
export const TONE_RAMP = ' .:*+xo#%@';

// Glyphs the matcher may use as strokes and their penalty (added to the distance). Tier 0: strokes
// and marks; tier 1: a peak and a blob; tier 2: brackets and a few letters that read as corners
// and eyes. Dense glyphs come only from the tone ramp.
const TIERS = [
  [" .,:;'\"-_=+|/\\()!", 0],
  ['^*', 0.03],   // right sometimes, but they win small corners too easily
  ['[]oLTY<>', 0.05],
];
// Shifted candidates pay SHIFT_PENALTY per 0.15 cell of offset, so a centred glyph wins near-ties;
// only glyphs whose position is their meaning (strokes and marks) are tried shifted.
const SHIFT_PENALTY = 0.01;
const SHIFTABLE = new Set(Array.from("|/\\()!.,:;'\""));
// Direction weights per lattice row: no glyph reaches the top fifth of the line box (above cap
// height) and few reach the bottom one, so ink there (a line running on through the cell) should
// not pull the match towards brackets and braces, the only glyphs that span it.
const ROW_W = [0.3, 1, 1, 1, 0.7];
const DIM_W = Float64Array.from({ length: DIMS }, (_, k) => ROW_W[Math.floor(k / GX)]);

/**
 * Pixel weights of each circle over a w x h cell raster (area coverage by k x k supersampling;
 * weights sum to 1 per circle). Shared by the matcher and the glyph generator so image cells and
 * glyphs are measured with exactly the same circles.
 * Returns [{ px: Int32Array (y * w + x), wt: Float64Array }] x DIMS.
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

// Candidate tables: one candidate per (allowed glyph, shift). U = unit direction, T = tone (mean
// circle ink), PEN = tier + shift penalty. TSCALE = densest allowed glyph's tone, so black maps to it.
const NS = (DATA_SHIFTS && DATA_SHIFTS.length) || 1;
const DATA_OK = VECTORS.length > 0 && VECTORS.length === GLYPHS.length * NS * DIMS;
const PEN_OF = new Map();
for (const [set, pen] of TIERS) for (const ch of set) PEN_OF.set(ch, pen);
const cand = [];
if (DATA_OK) {
  for (let gi = 0; gi < GLYPHS.length; gi++) {
    const ch = GLYPHS[gi];
    if (!PEN_OF.has(ch)) continue;
    for (let s = 0; s < NS; s++) {
      if (s && !SHIFTABLE.has(ch)) continue;
      const o = (gi * NS + s) * DIMS;
      const v = VECTORS.slice(o, o + DIMS);
      let n2 = 0, sum = 0;
      v.forEach((x, k) => { const y = x * DIM_W[k]; n2 += y * y; sum += x; });
      const nrm = Math.sqrt(n2);
      cand.push({
        cp: ch.codePointAt(0), shift: s,
        u: v.map((x, k) => (nrm > 0 ? x * DIM_W[k] / nrm : 0)), t: sum / DIMS,
        pen: PEN_OF.get(ch) + SHIFT_PENALTY * Math.round(Math.abs(DATA_SHIFTS[s] || 0) / 0.15),
      });
    }
  }
}
const NC = cand.length;
const CU = new Float64Array(NC * DIMS), CT = new Float64Array(NC), CPEN = new Float64Array(NC);
const CAND_CP = new Uint32Array(NC);
cand.forEach((c, i) => { CU.set(c.u, i * DIMS); CT[i] = c.t; CPEN[i] = c.pen; CAND_CP[i] = c.cp; });
const SPACE_CAND = cand.findIndex(c => c.cp === 0x20);
// Tone of an unshifted glyph (mean circle ink) straight from the data, for ramp glyphs that are not
// stroke candidates.
const glyphTone = ch => {
  const gi = GLYPHS.indexOf(ch);
  if (!DATA_OK || gi < 0) return 0;
  let s = 0;
  for (let k = 0; k < DIMS; k++) s += VECTORS[gi * NS * DIMS + k];
  return s / DIMS;
};
// Tone curve: normalised ink -> target glyph tone, interpolated through the ramp glyphs' measured
// tone (made monotone), so a stroke cell gets the same density as the ramp would give it.
const RAMP_CP = Uint32Array.from(TONE_RAMP, ch => ch.codePointAt(0));
const RAMP_T = (() => {
  const t = Array.from(TONE_RAMP, glyphTone);
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) t[i] = t[i - 1];
  return Float64Array.from(t);
})();
// Black maps to the densest ramp glyph.
const TSCALE = RAMP_T[RAMP_T.length - 1] || 1;
function toneTarget(ink) {
  const f = ink * (RAMP_T.length - 1), i = Math.min(RAMP_T.length - 2, f | 0);
  return RAMP_T[i] + (RAMP_T[i + 1] - RAMP_T[i]) * (f - i);
}
// Ramp glyph for a normalised ink level: the one whose measured coverage (relative to the densest)
// is nearest, as a 256-step table.
const RAMP_LUT = (() => {
  const cmax = COVERAGE.length ? Math.max(...COVERAGE) : 1;
  const cov = Array.from(TONE_RAMP, (ch, i) => (COVERAGE.length ? COVERAGE[GLYPHS.indexOf(ch)] / cmax : i / (TONE_RAMP.length - 1)));
  const lut = new Uint32Array(257);
  for (let i = 0; i <= 256; i++) {
    const t = i / 256;
    let b = 0;
    for (let j = 1; j < cov.length; j++) if (Math.abs(cov[j] - t) < Math.abs(cov[b] - t)) b = j;
    lut[i] = RAMP_CP[b];
  }
  return lut;
})();
const rampGlyph = t => RAMP_LUT[t <= 0 ? 0 : t >= 1 ? 256 : (t * 256 + 0.5) | 0];

// For each circle, the lattice offsets [dx, dy] of the neighbouring circles that lie in another
// cell (Harri's external circles): boundary circles have 3 or 5, inner ones none.
const EXT = CIRCLES.map((_, k) => {
  const i = k % GX, j = Math.floor(k / GX), list = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ii = i + dx, jj = j + dy;
      if ((dx || dy) && (ii < 0 || ii >= GX || jj < 0 || jj >= GY)) list.push([dx, dy]);
    }
  }
  return list;
});
const weightCache = new Map();

/** Paper and dark lightness of a grid: histogram percentiles (256 bins, O(n), deterministic). */
export function levelsOf(L) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < L.length; i++) {
    const v = L[i];
    if (!(v === v)) continue;   // NaN
    hist[v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0]++;
    n++;
  }
  if (!n) return { paper: 1, dark: 0 };
  const at = p => {
    const target = p * n;
    let acc = 0;
    for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= target) return b / 255; }
    return 1;
  };
  return { paper: at(PAPER_PCT), dark: at(DARK_PCT) };
}

/**
 * Lightness grid -> one code point per cell (row-major).
 * L: Float32Array W x H, 1 = paper. Ideally W = cols * ASCII_SUB[0], H = rows * ASCII_SUB[1];
 * other sizes are area-resampled first.
 * opts: method 'shape' | 'ramp'; ramp: dark -> light string; contrast: enhancement strength
 * (0 = off, 1 = default, 2 = strong).
 */
export function asciiCells(L, W, H, cols, rows, { method = 'shape', ramp = RAMP, contrast = 1, tune = null } = {}) {
  const [SX, SY] = ASCII_SUB;
  if (W !== cols * SX || H !== rows * SY) {
    L = resampleL(L, W, H, cols * SX, rows * SY);
    W = cols * SX; H = rows * SY;
  }
  const out = new Uint32Array(cols * rows);
  if (method === 'ramp') return rampCells(L, W, cols, rows, ramp, out);
  if (!NC) throw new Error('shape-vectors.js does not match js/ascii.js: run dev/shapes.html');

  // 1. levels relative to this image: ink 0 at its paper, 1 at its dark end
  // (paper is never darker than PAPER_MIN: an all-black or all-grey grid is tone, not paper)
  const lv = levelsOf(L);
  const paper = lv.paper > PAPER_MIN ? lv.paper : PAPER_MIN;
  const inkLo = 1 - paper, span = Math.max(0.25, paper - lv.dark);

  // 2. circle means on the global lattice (GX*cols x GY*rows), normalised ink
  let circ = weightCache.get(W);
  if (!circ) {
    circ = circleWeights(SX, SY).map(({ px, wt }) => ({ off: Int32Array.from(px, p => Math.floor(p / SX) * W + (p % SX)), wt }));
    weightCache.set(W, circ);
  }
  const LW = cols * GX, LH = rows * GY;
  const lat = new Float64Array(LW * LH);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const base = r * SY * W + c * SX;
      for (let k = 0; k < DIMS; k++) {
        const { off, wt } = circ[k];
        let s = 0;
        for (let t = 0; t < off.length; t++) s += wt[t] * L[base + off[t]];
        const ink = (1 - s - inkLo) / span;
        lat[(r * GY + Math.floor(k / GX)) * LW + c * GX + (k % GX)] = ink > 0 ? (ink < 1 ? ink : 1) : 0;   // NaN -> 0
      }
    }
  }

  // 2b. local contrast: lat += LC * (lat - blur(lat)), clamped (unsharp mask on the lattice)
  const P = { LC, COS_MIN, TONE_GAP, FLAT_RANGE, RAMP_GAMMA, ...tune };
  const tR = powTable(P.RAMP_GAMMA);
  if (P.LC > 0) {
    const m = boxBlur2(lat, LW, LH, LC_RX, LC_RY);
    for (let i = 0; i < lat.length; i++) {
      const x = lat[i] + P.LC * (lat[i] - m[i]);
      lat[i] = x > 0 ? (x < 1 ? x : 1) : 0;
    }
  }

  // 3. gate, 4. directional + global contrast, 5. tone ramp or nearest stroke
  const eD = 1 + (DIRECTIONAL_EXP - 1) * contrast, eG = 1 + (GLOBAL_EXP - 1) * contrast;
  const tD = powTable(eD), tG = powTable(eG);
  const raw = new Float64Array(DIMS), v = new Float64Array(DIMS), u = new Float64Array(DIMS);
  const invT = 1 / TSCALE;
  let prev = SPACE_CAND >= 0 ? SPACE_CAND : 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gx0 = c * GX, gy0 = r * GY;
      let sum = 0, lo = 1, hi = 0;
      for (let k = 0; k < DIMS; k++) {
        const x = lat[(gy0 + Math.floor(k / GX)) * LW + gx0 + (k % GX)];
        raw[k] = x; sum += x;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      const tone = sum / DIMS, range = hi - lo;
      if (!(hi > 0)) { out[r * cols + c] = 0x20; continue; }

      let vmax = 0, vmin = 1, vsum = 0;
      for (let k = 0; k < DIMS; k++) {
        let x = raw[k], m = x;
        const ext = EXT[k];
        for (let e = 0; e < ext.length; e++) {
          const gx = gx0 + (k % GX) + ext[e][0], gy = gy0 + Math.floor(k / GX) + ext[e][1];
          if (gx >= 0 && gy >= 0 && gx < LW && gy < LH) {
            const y = lat[gy * LW + gx];
            if (y > m) m = y;
          }
        }
        x = m > 0 ? powLerp(tD, x / m) * m : 0;
        v[k] = x; vsum += x;
        if (x > vmax) vmax = x;
        if (x < vmin) vmin = x;
      }
      // gate after directional contrast: ink that belongs to a darker neighbour (the edge of a
      // stroke that runs through the next cell) does not keep this cell from being paper
      if (vsum / DIMS < GATE_TONE && vmax - vmin < GATE_STRUCT) { out[r * cols + c] = 0x20; continue; }
      const ramp = rampGlyph(powLerp(tR, tone));
      if (range < P.FLAT_RANGE) { out[r * cols + c] = ramp; continue; }
      let n2 = 0;
      if (vmax > 0) {
        for (let k = 0; k < DIMS; k++) { const x = powLerp(tG, v[k] / vmax) * vmax * DIM_W[k]; v[k] = x; n2 += x * x; }
      }
      if (!(n2 > 0)) { out[r * cols + c] = ramp; continue; }
      const inv = 1 / Math.sqrt(n2);
      for (let k = 0; k < DIMS; k++) u[k] = v[k] * inv;
      const st = range >= STRUCT_FULL ? 1 : range / STRUCT_FULL;
      const g = nearest(u, toneTarget(tone), WD0 + WD1 * st, WT * (1 - TONE_EASE * st) * invT * invT, prev);
      // the stroke must really fit, and must not punch a light hole into a dark cell
      let a = 0;
      for (let k = 0, o = g * DIMS; k < DIMS; k++) a += u[k] * CU[o + k];
      if (a < P.COS_MIN || tone - CT[g] * invT > P.TONE_GAP) { out[r * cols + c] = ramp; continue; }
      prev = g;
      out[r * cols + c] = CAND_CP[g];
    }
  }
  return out;
}

// Separable box blur (two passes, edges clamped) of a W x H grid; returns a new array.
function boxBlur2(src, W, H, rx, ry) {
  const a = Float64Array.from(src), b = new Float64Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      const o = y * W;
      let s = 0;
      for (let i = -rx; i <= rx; i++) s += a[o + (i < 0 ? 0 : i >= W ? W - 1 : i)];
      for (let x = 0; x < W; x++) {
        b[o + x] = s / (2 * rx + 1);
        const add = x + rx + 1, sub = x - rx;
        s += a[o + (add >= W ? W - 1 : add)] - a[o + (sub < 0 ? 0 : sub)];
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let i = -ry; i <= ry; i++) s += b[(i < 0 ? 0 : i >= H ? H - 1 : i) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = s / (2 * ry + 1);
        const add = y + ry + 1, sub = y - ry;
        s += b[(add >= H ? H - 1 : add) * W + x] - b[(sub < 0 ? 0 : sub) * W + x];
      }
    }
  }
  return a;
}

// Brute force with partial-distance early exit, seeded with the previous cell's glyph (neighbours
// usually match, so the bound is tight from the start). Ties keep the seed, then the lower index.
function nearest(u, t, wd, wt, seed) {
  let best = seed, bd = dist(u, t, wd, wt, seed, Infinity);
  for (let g = 0; g < NC; g++) {
    if (g === seed) continue;
    const d = dist(u, t, wd, wt, g, bd);
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}
function dist(u, t, wd, wt, g, bound) {
  const te = t - CT[g];
  let d = CPEN[g] + wt * te * te;
  if (d >= bound) return d;
  const o = g * DIMS;
  let a = 0;
  for (let k = 0; k < DIMS; k++) {
    const e = u[k] - CU[o + k];
    a += e * e;
    if (d + wd * a >= bound) return d + wd * a;
  }
  return d + wd * a;
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
export const SHAPES_CURRENT = DATA_KEY === GEOMETRY_KEY && DATA_OK;

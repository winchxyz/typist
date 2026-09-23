// Variant "local": local-contrast tone for tiny dot grids.
//
// The global pipeline (percentile levels + one gamma for a global ink target) keeps silhouettes but
// flattens whatever sits inside a large light or dark area: a white bust dithers to a blank face, a
// dark tabby coat to solid dots. Here the tone curve is local instead:
//
//   1. centre-weighted percentile levels (as js/tone.js)
//   2. CLAHE: per-tile histogram equalisation on a coarse grid of tiles (about 4 across the crop,
//      so a face gets roughly one tile of its own), contrast-limited so flat areas map close to
//      identity (clean backgrounds) while low-contrast textured areas (a face, a coat) are
//      stretched. LUTs are piecewise linear inside each bin and blended bilinearly between tile
//      centres, so the result stays continuous (no posterised bands, no tile seams).
//   3. blended with the levelled image by `amount`, so the global light/dark structure survives
//   4. a small unsharp mask (a dot or two) for eyes and mouths at 16-28 columns
//   0. an activity mask (blurred fine detail, relative to its p90) gates steps 2-4 and 6, so flat
//      backdrops and skies are left alone and only textured areas get the local stretch
//   5. midtones (bounded 0.5..2) for the ink target on a subject-weighted histogram: centre x local
//      activity, so a big flat backdrop does not eat the ink budget (or decide the exposure)
//   6. flat-area cleanup: near-white / near-black flat tones ease to paper / solid ink (no speckle)
//
// Contract = toneGrid in js/tone.js: pure, deterministic, no DOM; returns Float32Array L with
// .edge (edgeMap of the toned image) and .stats.

import { TONE_DEFAULTS, boxBlur, boxRadiusForSigma, edgeMap, levels, solveGamma } from '../js/tone.js';

export const LOCAL_DEFAULTS = Object.freeze({
  tiles: 4,        // CLAHE tiles across the longer side of the crop (content scale, not dots)
  clip: 2.0,       // clip limit, in multiples of the mean bin count
  bins: 64,
  amount: 0.65,    // CLAHE blend (0 = levels only)
  sharpen: 0.5,    // unsharp mask gain at ~1.2 dots
  salient: 0.6,    // 0..1 how much local activity (vs flatness) weights the ink target
  actScale: 0.05,  // activity blur sigma, fraction of the grid's longer side
  refMin: 0.025,   // activity floor for the p90 reference (a low-contrast photo's noise is not texture)
  gate0: 0.2,      // activity / p90 below this = flat (CLAHE at `floor` strength)
  gate1: 0.6,      // above this = textured (full CLAHE)
  floor: 0.3,      // CLAHE strength on flat areas
  gmin: 0.5,       // bounds of the ink-target midtone exponent
  gmax: 2,
  clean: 0.9,      // flat-area cleanup strength (0 = off)
  cleanAt: 0.66,   // tones above this (below 1 - this) ease to paper (ink) where flat
  target: null,    // override the ink target (null = the caller's)
});

/** Weighted percentile of non-negative values (256 bins over [0, max]). */
function weightedPct(values, wts, p) {
  let mx = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > mx) mx = values[i];
  if (mx <= 0) return 0;
  const hist = new Float64Array(256);
  let total = 0;
  const s = 255 / mx;
  for (let i = 0; i < values.length; i++) { hist[(values[i] * s) | 0] += wts[i]; total += wts[i]; }
  let acc = 0;
  for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= total * p) return (k + 0.5) / s; }
  return mx;
}

const TONE_RANGE = [['brightness', -1, 1], ['contrast', -1, 1], ['gamma', 0.3, 3], ['detail', 0, 1], ['edges', 0, 1]];
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

const weightMaps = new Map();
function centreWeights(W, H) {
  const key = W + 'x' + H;
  let w = weightMaps.get(key);
  if (w) return w;
  w = new Float32Array(W * H);
  for (let i = 0, y = 0; y < H; y++) {
    const dy = (y + 0.5) / H * 2 - 1;
    for (let x = 0; x < W; x++, i++) {
      const dx = (x + 0.5) / W * 2 - 1;
      w[i] = 0.25 + Math.exp(-(dx * dx + dy * dy) * 1.5);
    }
  }
  if (weightMaps.size > 16) weightMaps.clear();
  weightMaps.set(key, w);
  return w;
}

function histogram(values, wts) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    hist[v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0] += wts[i];
    total += wts[i];
  }
  return { hist, total };
}

function percentile({ hist, total }, p) {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; }
  return 1;
}

/**
 * Contrast-limited adaptive histogram equalisation of `src` (values 0..1) into `dst`.
 * tx x ty tiles; `clip` in multiples of the mean bin count. Each tile's mapping is its clipped CDF,
 * evaluated piecewise-linearly inside a bin (uniform-within-bin assumption), and every sample
 * blends the four nearest tile mappings bilinearly.
 */
export function clahe(src, dst, W, H, tx, ty, clip, bins) {
  const luts = new Float32Array(tx * ty * (bins + 1));
  const hist = new Float32Array(bins);
  for (let j = 0; j < ty; j++) {
    const y0 = Math.floor(j * H / ty), y1 = Math.floor((j + 1) * H / ty);
    for (let i = 0; i < tx; i++) {
      const x0 = Math.floor(i * W / tx), x1 = Math.floor((i + 1) * W / tx);
      hist.fill(0);
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, p = y * W + x0; x < x1; x++, p++) {
          const v = src[p];
          const b = v <= 0 ? 0 : v >= 1 ? bins - 1 : Math.min(bins - 1, (v * bins) | 0);
          hist[b]++; n++;
        }
      }
      const o = (j * tx + i) * (bins + 1);
      if (!n) { for (let k = 0; k <= bins; k++) luts[o + k] = k / bins; continue; }
      const limit = Math.max(1, clip * n / bins);
      let excess = 0;
      for (let k = 0; k < bins; k++) if (hist[k] > limit) { excess += hist[k] - limit; hist[k] = limit; }
      const add = excess / bins, inv = 1 / n;
      let acc = 0;
      luts[o] = 0;
      for (let k = 0; k < bins; k++) { acc += hist[k] + add; luts[o + k + 1] = acc * inv; }
    }
  }
  // tile-centre coordinates: outside the outermost centres a sample uses the edge tile alone
  const cell = (g, n) => {
    if (g <= 0 || n === 1) return [0, 0, 0];
    if (g >= n - 1) return [n - 1, n - 1, 0];
    const a = Math.floor(g);
    return [a, a + 1, g - a];
  };
  const b1 = bins + 1;
  const cx = [];
  for (let x = 0; x < W; x++) cx.push(cell((x + 0.5) * tx / W - 0.5, tx));
  for (let y = 0, p = 0; y < H; y++) {
    const [j0, j1, fy] = cell((y + 0.5) * ty / H - 0.5, ty);
    for (let x = 0; x < W; x++, p++) {
      const [i0, i1, fx] = cx[x];
      const v = src[p];
      const pos = (v <= 0 ? 0 : v >= 1 ? 1 : v) * bins;
      let k = pos | 0; if (k > bins - 1) k = bins - 1;
      const f = pos - k;
      let o = (j0 * tx + i0) * b1 + k;
      const a00 = luts[o] + (luts[o + 1] - luts[o]) * f;
      o = (j0 * tx + i1) * b1 + k;
      const a01 = luts[o] + (luts[o + 1] - luts[o]) * f;
      o = (j1 * tx + i0) * b1 + k;
      const a10 = luts[o] + (luts[o + 1] - luts[o]) * f;
      o = (j1 * tx + i1) * b1 + k;
      const a11 = luts[o] + (luts[o + 1] - luts[o]) * f;
      dst[p] = (a00 * (1 - fx) + a01 * fx) * (1 - fy) + (a10 * (1 - fx) + a11 * fx) * fy;
    }
  }
  return dst;
}

function applyPow(out, g) {
  if (Math.abs(g - 1) < 1e-4) return;
  const n = 1024;
  const lut = new Float32Array(n + 2);
  for (let i = 0; i <= n; i++) lut[i] = Math.pow(i / n, g);
  lut[n + 1] = 1;
  for (let i = 0; i < out.length; i++) {
    const x = clamp01(out[i]) * n;
    const k = x | 0;
    out[i] = lut[k] + (lut[k + 1] - lut[k]) * (x - k);
  }
}

/**
 * Same contract as toneGrid(img, tone, { target, boost, stretch }).
 * extra.params overrides LOCAL_DEFAULTS (lab iteration).
 */
export function toneVariant(img, tone, { target = 0.4, boost = 0, stretch = 1, params = null } = {}) {
  const t = { ...TONE_DEFAULTS, ...tone };
  for (const [k, a, b] of TONE_RANGE) {
    const v = +t[k];
    t[k] = Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : TONE_DEFAULTS[k];
  }
  const P = { ...LOCAL_DEFAULTS, ...params };
  if (P.target != null) target = P.target;
  const { W, H, L } = img;
  const N = W * H;
  const cw = centreWeights(W, H);
  const out = new Float32Array(N);

  // 1. levels
  let [lo, hi] = t.auto ? levels(histogram(L, cw)) : [0, 1];
  lo *= stretch; hi = 1 - (1 - hi) * stretch;
  const span = Math.max(1e-3, hi - lo);
  for (let i = 0; i < N; i++) out[i] = clamp01((L[i] - lo) / span);

  const long = Math.max(W, H);
  const rFine = boxRadiusForSigma(Math.max(1, 0.02 * long));

  // Activity = blurred |fine detail| of the levelled image: high on a face, a coat, a tower, near
  // zero on a backdrop or a sky. It gates CLAHE and the unsharp mask (flat areas keep their tone,
  // so faint gradients do not turn into speckle) and weights the ink target (the subject decides
  // the exposure, not the backdrop). Normalised by its own 90th percentile, so it is relative.
  const blur0 = Float32Array.from(out);
  boxBlur(blur0, W, H, rFine);
  const mask = new Float32Array(N);
  for (let i = 0; i < N; i++) mask[i] = Math.abs(out[i] - blur0[i]);
  boxBlur(mask, W, H, boxRadiusForSigma(Math.max(1.5, P.actScale * long)));
  const ref = Math.max(P.refMin, weightedPct(mask, cw, 0.9));
  const g0 = P.gate0, gs = 1 / Math.max(1e-3, P.gate1 - P.gate0);
  for (let i = 0; i < N; i++) {
    const u = clamp01((mask[i] / ref - g0) * gs);
    mask[i] = u * u * (3 - 2 * u);
  }

  // 2-3. CLAHE, blended. `detail` scales it (0.35 default = 1x), small grids get a little more.
  const dScale = t.detail / TONE_DEFAULTS.detail;
  const amount = Math.min(1, P.amount * Math.min(1.4, dScale) * (1 + 0.15 * boost));
  if (amount > 0 && W >= 4 && H >= 4) {
    const tx = Math.max(1, Math.round(P.tiles * W / long));
    const ty = Math.max(1, Math.round(P.tiles * H / long));
    const eq = clahe(out, new Float32Array(N), W, H, tx, ty, P.clip, P.bins);
    const fl = P.floor;
    for (let i = 0; i < N; i++) out[i] += (eq[i] - out[i]) * amount * (fl + (1 - fl) * mask[i]);
  }

  // 4. unsharp at ~1.2 dots: the features a Braille cell can still hold
  const sharpen = P.sharpen * Math.min(1.5, dScale) * (1 + 0.6 * boost);
  if (sharpen > 0) {
    const base = Float32Array.from(out);
    boxBlur(base, W, H, rFine);
    const lim = 0.25;
    for (let i = 0; i < N; i++) {
      let d = sharpen * (0.3 + 0.7 * mask[i]) * (out[i] - base[i]);
      d = d < -lim ? -lim : d > lim ? lim : d;
      out[i] = clamp01(out[i] + d);
    }
  }

  // contrast / brightness (manual, as toneGrid); histograms from here on are subject-weighted
  const wts = new Float32Array(N);
  for (let i = 0; i < N; i++) wts[i] = cw[i] * (1 - P.salient + P.salient * mask[i]);
  let h = histogram(out, wts);
  const contrast = t.contrast;
  const c = contrast >= 0 ? 1 + 2 * contrast : 1 + contrast;
  const autoTarget = t.auto && target != null;
  const b = autoTarget ? 0 : t.brightness * 0.4;
  if (c !== 1 || b !== 0) {
    const mid = t.auto ? percentile(h, 0.5) : 0.5;
    for (let i = 0; i < N; i++) out[i] = clamp01((out[i] - mid) * c + mid + b);
    h = histogram(out, wts);
  }

  // 5. midtones for the ink target, measured on the subject
  let g = 1;
  if (autoTarget) {
    const tgt = Math.max(0.08, Math.min(0.8, target - 0.25 * t.brightness));
    // bounded tighter than toneGrid (0.25..4): CLAHE already spreads the tones, and a steep
    // global power (0.25 on a dark photo) flattens every highlight, which is where faces live
    g = Math.max(P.gmin, Math.min(P.gmax, solveGamma(h, tgt, t.invert)));
  }
  g /= Math.max(0.1, t.gamma);
  applyPow(out, g);

  // 6. flat-area cleanup: a flat near-white (near-black) area dithers to a sparse sprinkle of lone
  // dots (holes) that reads as noise, not as tone. Only where activity is low, ease those tones
  // the rest of the way to paper (solid ink); textured areas keep every grey.
  if (P.clean > 0) {
    const c0 = P.cleanAt, cs = 1 / Math.max(1e-3, 1 - c0 - 0.04);
    for (let i = 0; i < N; i++) {
      const k = P.clean * (1 - mask[i]);
      if (k <= 0) continue;
      const v = out[i];
      if (v > c0) {
        const u = clamp01((v - c0) * cs);
        out[i] = v + (1 - v) * k * u * u * (3 - 2 * u);
      } else if (v < 1 - c0) {
        const u = clamp01((1 - c0 - v) * cs);
        out[i] = v - v * k * u * u * (3 - 2 * u);
      }
    }
  }

  if (t.invert) {
    const A = img.A;
    if (A) for (let i = 0; i < N; i++) out[i] = A[i] * out[i];
    for (let i = 0; i < N; i++) out[i] = 1 - out[i];
  }

  const edge = edgeMap(out, W, H);
  if (t.edges > 0) {
    for (let i = 0; i < N; i++) {
      const m = edge.mag[i] * (edge.thin[i] ? 1 : 0.35);
      out[i] = clamp01(out[i] - t.edges * m);
    }
  }

  let mean = 0, wsum = 0;
  for (let i = 0; i < N; i++) { mean += out[i] * cw[i]; wsum += cw[i]; }
  mean /= wsum || 1;
  let v = 0;
  for (let i = 0; i < N; i++) v += cw[i] * (out[i] - mean) ** 2;
  const std = Math.sqrt(v / (wsum || 1));
  out.edge = edge;
  out.stats = { lo, hi, gamma: g, coverage: 1 - mean, std, flat: std < 0.03, amount };
  return out;
}

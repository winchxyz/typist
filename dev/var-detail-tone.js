// Variant "detail": detail-preserving local tone mapping for dot art (HDR-photography style).
//
//   I      = levels(L)                         subject-weighted percentiles
//   base   = guidedFilter(I, r, eps)           edge-preserving: lighting + big shapes
//   detail = I - base                          eyes, brows, mouth, stripes, texture
//   out    = T(base) + G(detail)               T: inverse-S that flattens the subject's mid tones
//                                              but keeps 0 and 1; G: gain with a tanh soft clip
//   midtones solved for the ink target on the SUBJECT (centre x detail-energy saliency), then
//   flat low-saliency regions are pulled to paper or solid (clean backgrounds).
//
// A 1-bit dot display draws extremes cleanly and mid tones as dither texture. Large-scale shading
// spends the dot budget without adding recognition, so its contrast is compressed where the subject
// sits, while the small-scale layer (the features) is amplified. Pure, deterministic, no DOM.
import { boxBlur, edgeMap, levels, solveGamma, TONE_DEFAULTS } from '../js/tone.js';

export const DETAIL_PARAMS = Object.freeze({
  baseScale: 0.08,   // guided-filter radius / max(W, H)
  eps: 0.06,         // guided-filter range term (sigma_r^2): steps above ~sqrt(eps) stay in the base
  compress: 1,       // slope of the inverse-S at the subject's mid tone (1 = off)
  expand: 0.7,       // pull of the base toward two region levels, split at the subject's mid tone
  lvLo: 0.1,         // level a dark region's base is pulled to
  lvHi: 0.95,        // level a light region's base is pulled to
  pivotK: 10,        // steepness of the split
  gain: 2.6,         // detail gain at 36+ columns
  gainSmall: 1.2,    // extra detail gain at 16 columns (times boost)
  limit: 0.5,        // soft clip of the boosted detail (tanh), so no halos
  bgDetail: 0.3,     // detail gain factor where saliency is 0
  bgClean: 0.7,      // pull of flat low-saliency regions toward paper / solid
  targetScale: 1,    // ink target on the subject = target * targetScale
  snap: 0.06,        // end snap: out < snap -> 0, out > 1 - snap -> 1
  centre: 2.0,       // centre prior falloff
  gMin: 0.8,         // bounds of the midtone exponent solved for the ink target
  gMax: 1.25,
  pivot: 'otsu',     // 'otsu' | 'median': where the base splits into dark / light regions
  adapt: 1,          // detail-adaptive base: squeeze toward m where local detail is strong
  sigC: 0.04,        // local detail amplitude at which the squeeze is half on
  midCompress: 0.3,  // base slope inside detailed regions
  sigN: 0.05,        // floor of the detail normaliser (flat noise is not amplified)
});

const TONE_RANGE = [['brightness', -1, 1], ['contrast', -1, 1], ['gamma', 0.3, 3], ['detail', 0, 1], ['edges', 0, 1]];
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function hist(values, wts) {
  const h = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    h[v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0] += wts[i];
    total += wts[i];
  }
  return { hist: h, total };
}
function pct({ hist: h, total }, p) {
  const t = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= t) return i / 255; }
  return 1;
}

/** Weighted Otsu threshold of a 256-bin histogram (maximises between-class variance). */
function otsu({ hist: h, total }) {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * h[i];
  let wB = 0, sumB = 0, best = -1, th = 127;
  for (let i = 0; i < 256; i++) {
    wB += h[i];
    if (wB <= 0) continue;
    const wF = total - wB;
    if (wF <= 0) break;
    sumB += i * h[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = i; }
  }
  return (th + 0.5) / 255;
}

/** Self-guided filter (He et al.): O(N) box means, preserves steps stronger than sqrt(eps). */
export function guidedFilter(I, W, H, r, eps) {
  const N = W * H;
  const mI = Float32Array.from(I);
  const II = new Float32Array(N);
  for (let i = 0; i < N; i++) II[i] = I[i] * I[i];
  boxBlur(mI, W, H, r, 1);
  boxBlur(II, W, H, r, 1);
  const a = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = Math.max(0, II[i] - mI[i] * mI[i]);
    a[i] = v / (v + eps);
    b[i] = mI[i] - a[i] * mI[i];
  }
  boxBlur(a, W, H, r, 1);
  boxBlur(b, W, H, r, 1);
  const q = new Float32Array(N);
  for (let i = 0; i < N; i++) q[i] = a[i] * I[i] + b[i];
  return q;
}

const centreCache = new Map();
function centrePrior(W, H, k) {
  const key = W + 'x' + H + 'x' + k;
  let c = centreCache.get(key);
  if (c) return c;
  c = new Float32Array(W * H);
  for (let y = 0, i = 0; y < H; y++) {
    const dy = (y + 0.5) / H * 2 - 1;
    for (let x = 0; x < W; x++, i++) {
      const dx = (x + 0.5) / W * 2 - 1;
      c[i] = Math.exp(-(dx * dx + dy * dy) * k);
    }
  }
  if (centreCache.size > 16) centreCache.clear();
  centreCache.set(key, c);
  return c;
}

/**
 * Same contract as toneGrid(img, tone, { target, boost }): returns the final lightness with .edge and
 * .stats. extra.params overrides DETAIL_PARAMS (lab iteration); extra.debug attaches the layers.
 */
export function toneVariant(img, tone, { target = 0.4, boost = 0, params = null, debug = false } = {}) {
  const P = { ...DETAIL_PARAMS, ...params };
  const t = { ...TONE_DEFAULTS, ...tone };
  for (const [k, a, b] of TONE_RANGE) {
    const v = +t[k];
    t[k] = Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : TONE_DEFAULTS[k];
  }
  const { W, H, L, A } = img;
  const N = W * H;
  const cp = centrePrior(W, H, P.centre);
  const wC = new Float32Array(N);
  for (let i = 0; i < N; i++) wC[i] = 0.2 + cp[i];

  // levels, then (dark mode) flip first so everything below means "ink = what the dots draw";
  // transparent parts stay paper in both themes
  let [lo, hi] = t.auto ? levels(hist(L, wC)) : [0, 1];
  const span = Math.max(1e-3, hi - lo);
  const I = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = clamp01((L[i] - lo) / span);
    I[i] = t.invert ? 1 - (A ? A[i] : 1) * v : v;
  }

  // base / detail split at a scale tied to the grid: ~7% of the long side (4 dots at 28 columns)
  const r = Math.max(1, Math.round(P.baseScale * Math.max(W, H)));
  const B = guidedFilter(I, W, H, r, P.eps);
  const D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = I[i] - B[i];

  // saliency: centre prior x local energy (detail magnitude + base gradient), so a busy centre
  // counts and a flat rim does not
  const E = new Float32Array(N);
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const gx = B[y * W + Math.min(W - 1, x + 1)] - B[y * W + Math.max(0, x - 1)];
      const gy = B[Math.min(H - 1, y + 1) * W + x] - B[Math.max(0, y - 1) * W + x];
      E[i] = Math.abs(D[i]) + 0.5 * Math.sqrt(gx * gx + gy * gy);
    }
  }
  boxBlur(E, W, H, r, 2);
  const e90 = Math.max(1e-3, pct(hist(E, cp), 0.9) );
  const S = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const en = Math.min(1, E[i] / e90);
    S[i] = clamp01(1.25 * Math.pow(cp[i], 0.8) * (0.35 + 0.65 * en));
  }
  const wS = new Float32Array(N);
  for (let i = 0; i < N; i++) wS[i] = 0.08 + S[i];

  // T: inverse-S around the subject's mid tone m. Slope `compress` at m, T(0) = 0, T(1) = 1, monotone.
  // m splits the subject's base into its dark and light regions (weighted Otsu): the light stripes
  // of a lighthouse against a bright sky still count as light, which a median split does not give
  const m = Math.min(0.85, Math.max(0.15, P.pivot === 'median' ? pct(hist(B, wS), 0.5) : otsu(hist(B, wS))));
  const cb = P.compress;
  const detailScale = t.detail / 0.35;   // the detail slider scales the gain (0 = base only)
  const gain = (P.gain + P.gainSmall * boost) * detailScale;
  const lim = P.limit;
  // local detail amplitude: where features live the base is squeezed toward mid grey so the boosted
  // detail swings to both paper and solid; flat regions keep the expanded (clean) base instead
  let sig = null;
  if (P.adapt > 0) {
    sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = D[i] * D[i];
    boxBlur(sig, W, H, r, 1);
    for (let i = 0; i < N; i++) sig[i] = Math.sqrt(sig[i]);
  }
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const b = B[i];
    const R = b < m ? m : 1 - m;
    const u = (b - m) / R;
    let tb = m + u * R * (cb + (1 - cb) * u * u);
    if (P.expand > 0) {
      const sg = P.lvLo + (P.lvHi - P.lvLo) / (1 + Math.exp(-(b - m) * P.pivotK));
      tb += P.expand * (sg - tb);
    }
    const s = S[i];
    let d;
    if (sig) {
      const w = P.adapt * sig[i] / (sig[i] + P.sigC) * (P.bgDetail + (1 - P.bgDetail) * s);
      tb += w * (m + P.midCompress * (b - m) - tb);
      // contrast-normalised detail (local contrast normalisation): weak texture in shadow gets
      // the same swing as strong texture in light
      const dn = D[i] / (sig[i] + P.sigN);
      d = lim * Math.tanh(gain * 0.35 * dn * (P.bgDetail + (1 - P.bgDetail) * s));
    } else {
      const g = gain * (P.bgDetail + (1 - P.bgDetail) * s);
      d = g > 0 ? lim * Math.tanh(g * D[i] / lim) : 0;
    }
    out[i] = clamp01(tb + d);
  }

  // manual contrast around the subject median
  let h = hist(out, wS);
  if (t.contrast !== 0) {
    const c = t.contrast >= 0 ? 1 + 2 * t.contrast : 1 + t.contrast;
    const mid = pct(h, 0.5);
    for (let i = 0; i < N; i++) out[i] = clamp01((out[i] - mid) * c + mid);
    h = hist(out, wS);
  }

  // midtones solved for the ink target on the subject
  let g = 1;
  if (t.auto && target != null) {
    const tgt = Math.max(0.08, Math.min(0.8, target * P.targetScale - 0.25 * t.brightness));
    // bounded: the base curve already placed the regions; the target only trims the midtones
    g = Math.max(P.gMin, Math.min(P.gMax, solveGamma(h, tgt, false)));
  } else if (!t.auto) {
    const bb = t.brightness * 0.4;
    for (let i = 0; i < N; i++) out[i] = clamp01(out[i] + bb);
  }
  g /= Math.max(0.1, t.gamma);
  if (Math.abs(g - 1) > 1e-4) for (let i = 0; i < N; i++) out[i] = Math.pow(out[i], g);

  // clean backgrounds: flat, low-saliency regions snap toward paper or solid
  const pre = debug ? Float32Array.from(out) : null;
  if (P.bgClean > 0) {
    for (let i = 0; i < N; i++) {
      const s = S[i];
      const amt = P.bgClean * (1 - s) * (1 - s) * (1 - Math.min(1, E[i] / e90));
      if (amt <= 0) continue;
      const o = out[i];
      const sig = 1 / (1 + Math.exp(-(o - 0.5) * 14));
      out[i] = o + amt * (sig - o);
    }
  }
  const sn = P.snap;
  if (sn > 0) for (let i = 0; i < N; i++) out[i] = clamp01((out[i] - sn) / (1 - 2 * sn));

  const edge = edgeMap(out, W, H);
  if (t.edges > 0) {
    for (let i = 0; i < N; i++) out[i] = clamp01(out[i] - t.edges * edge.mag[i] * (edge.thin[i] ? 1 : 0.35));
  }

  // stats in the output polarity (like toneGrid: after invert)
  let mean = 0, wsum = 0;
  for (let i = 0; i < N; i++) { mean += out[i] * wC[i]; wsum += wC[i]; }
  mean /= wsum || 1;
  let v = 0;
  for (let i = 0; i < N; i++) v += wC[i] * (out[i] - mean) ** 2;
  const std = Math.sqrt(v / (wsum || 1));
  out.edge = edge;
  out.stats = { lo, hi, gamma: g, coverage: 1 - mean, std, flat: std < 0.03, r, m };
  if (debug) out.debug = { I, B, D, S, pre };
  return out;
}

// Interleaved gradient noise (Jimenez 2014): a deterministic, blue-ish per-pixel offset. Used as a
// small threshold modulation it breaks Atkinson's worms without Math.random.
const ign = (x, y) => {
  const f = 0.06711056 * x + 0.00583715 * y;
  const g = 52.9829189 * (f - Math.floor(f));
  return g - Math.floor(g);
};

const ATKINSON = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];

/**
 * Edge-aware Atkinson: serpentine, diffused error scaled by (1 - edge strength) so a feature's error
 * does not spray into the skin next to it, threshold modulated by IGN (blue-noise-like order).
 * Then the same lone-dot / lone-hole cleanup as js/dither.js.
 */
export function ditherVariant(L, W, H, { edge = null, edgeK = 1.5, jitter = 0.16, cleanup = true, edges = 0 } = {}) {
  const N = W * H;
  const dots = new Uint8Array(N);
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) buf[i] = 1 - L[i];
  const mag = edge ? edge.mag : null;
  for (let y = 0; y < H; y++) {
    const rtl = y & 1;
    for (let n = 0; n < W; n++) {
      const x = rtl ? W - 1 - n : n;
      const i = y * W + x;
      let v = buf[i];
      v = v < -0.5 ? -0.5 : v > 1.5 ? 1.5 : v;
      const th = 0.5 + jitter * (ign(x, y) - 0.5);
      const q = v >= th ? 1 : 0;
      dots[i] = q;
      let err = (v - q) / 8;
      if (mag) err *= Math.max(0, 1 - edgeK * mag[i]);
      if (err === 0) continue;
      for (let k = 0; k < 6; k++) {
        const xx = x + (rtl ? -ATKINSON[k][0] : ATKINSON[k][0]);
        const yy = y + ATKINSON[k][1];
        if (xx < 0 || xx >= W || yy >= H) continue;
        buf[yy * W + xx] += err;
      }
    }
  }
  if (cleanup) {
    const src = Uint8Array.from(dots);
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        const v = 1 - L[i];
        const on = src[i];
        if (on ? v > 0.3 : v < 0.7) continue;
        let s = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx | dy) === 0 || xx < 0 || xx >= W) continue;
            s += src[yy * W + xx]; cnt++;
          }
        }
        if (on && s === 0) dots[i] = 0;
        else if (!on && s === cnt) dots[i] = 1;
      }
    }
  }
  if (edges > 0 && edge) {
    const thr = 0.55 - 0.45 * Math.min(1, edges);
    for (let i = 0; i < N; i++) if (edge.thin[i] && edge.mag[i] > thr) dots[i] = 1;
  }
  return dots;
}

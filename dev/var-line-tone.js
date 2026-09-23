// Variant "line": LINE + TONE, the way an illustrator draws a face at 56 x 60 dots.
//
// Tone alone cannot carry a face at Braille sizes: eyes, brows, nose and mouth are 1-3 dots and
// dither into the skin. So the picture is two layers:
//   line  XDoG (eXtended Difference of Gaussians, Winnemoeller, Kyprianidis & Olsen 2012) on the
//         dot grid: S = (1 + p) G_s - p G_ks, soft threshold 1 + tanh(phi (S - eps)) below eps.
//         The strong response is kept with hysteresis (Canny-style: strong seeds grow through weak
//         pixels) and short fragments are dropped, so smooth gradients and fine texture give no
//         speckle while eyes, brows, mouth, whiskers and stripes come out as clean ink lines.
//   tone  toneGrid with a lower ink target, so lines dominate and the shading only supports them.
// The two are combined as min(tone, line): a line pixel is L = 0, which every dither keeps as a dot
// (it cannot be diffused away), so no dither bypass is needed.
//
// Pure and deterministic, no DOM. Same contract as toneGrid:
//   toneVariant(img {W, H, L, A?}, tone, extra {target, boost, stretch}) -> Float32Array L
//   with .edge (edgeMap of the result, for the error-diffusion edge damping) and .stats.

import { toneGrid, edgeMap, TONE_DEFAULTS } from '../js/tone.js';

export const LINE_DEFAULTS = Object.freeze({
  sigma: 0.7,       // inner Gaussian in dots (outer = k * sigma)
  sigmaGrow: 0.004, // + this x max(W, H): big grids draw slightly broader, calmer strokes
  k: 1.6,
  p: 30,            // XDoG sharpening
  eps: -0.06,       // threshold on S; below 0 so flat blacks are left to the tone layer
  phi: 20,          // steepness of the soft threshold
  strong: 0.8,      // hysteresis: seed ink level
  weak: 0.3,        //             grow-through ink level
  minLen: 4,        // fragments shorter than this are dropped (unless very strong)
  keepDot: 0.9,     // a lone fragment this strong survives (a pupil at 16 x 9)
  toneTarget: 0.25, // ink target of the tone layer (the normal pipeline uses 0.4)
  toneDetail: 0.2,  // unsharp mask of the tone layer (lines already carry the detail)
  lineInk: 1.6,     // gain from XDoG ink to line darkness
  halo: 0.35,       // lighten the tone beside a line by this much, so the line reads on shading
  invTarget: 0.4,   // dark mode: lit-dot target (lines are carved out of the lit tone)
});

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// Separable Gaussian with clamped borders (box blurs cannot do sigma < 1 dot).
function gauss(src, W, H, sigma, tmp, dst) {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const ker = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { ker[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += ker[i + r]; }
  for (let i = 0; i < ker.length; i++) ker[i] /= s;
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        a += ker[i + r] * src[o + (xx < 0 ? 0 : xx >= W ? W - 1 : xx)];
      }
      tmp[o + x] = a;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        a += ker[i + r] * tmp[(yy < 0 ? 0 : yy >= H ? H - 1 : yy) * W + x];
      }
      dst[y * W + x] = a;
    }
  }
  return dst;
}

/**
 * The line layer alone: Float32Array of ink 0..1 per dot (0 = no line).
 * base: lightness to draw from (levels + midtones already solved).
 */
export function xdogLines(base, W, H, o = LINE_DEFAULTS) {
  const N = W * H;
  const sigma = o.sigma + o.sigmaGrow * Math.max(W, H);
  const tmp = new Float32Array(N);
  const g1 = gauss(base, W, H, sigma, tmp, new Float32Array(N));
  const g2 = gauss(base, W, H, sigma * o.k, tmp, new Float32Array(N));
  const ink = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const S = (1 + o.p) * g1[i] - o.p * g2[i];
    if (S < o.eps) ink[i] = -Math.tanh(o.phi * (S - o.eps));
  }
  // hysteresis: strong pixels seed, weak ones join only when connected to a seed (8-neighbours)
  const keep = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  for (let i = 0; i < N; i++) if (ink[i] >= o.strong) { keep[i] = 1; stack[sp++] = i; }
  while (sp) {
    const i = stack[--sp], x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const j = yy * W + xx;
        if (!keep[j] && ink[j] >= o.weak) { keep[j] = 1; stack[sp++] = j; }
      }
    }
  }
  // drop short fragments: a speck of texture is not a line
  const label = new Int32Array(N).fill(-1);
  const members = new Int32Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (!keep[s0] || label[s0] >= 0) continue;
    let n = 0, peak = 0;
    sp = 0; stack[sp++] = s0; label[s0] = s0;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i / W) | 0;
      members[n++] = i;
      if (ink[i] > peak) peak = ink[i];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (keep[j] && label[j] < 0) { label[j] = s0; stack[sp++] = j; }
        }
      }
    }
    if (n < o.minLen && peak < o.keepDot) for (let m = 0; m < n; m++) keep[members[m]] = 0;
  }
  for (let i = 0; i < N; i++) if (!keep[i]) ink[i] = 0;
  return ink;
}

// A crop that runs past the photo's edge has a pale fringe; the DoG would draw a ruler line along
// it. Clear lines within 2 dots of any side whose outer row / column is not opaque.
function clearPaddedSides(ink, A, W, H) {
  if (!A) return;
  const side = (n, at) => { let s = 0; for (let k = 0; k < n; k++) s += A[at(k)]; return s / n < 0.98; };
  const top = side(W, k => k), bottom = side(W, k => (H - 1) * W + k);
  const left = side(H, k => k * W), right = side(H, k => k * W + W - 1);
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      if ((top && y < 2) || (bottom && y >= H - 2) || (left && x < 2) || (right && x >= W - 2)) ink[i] = 0;
    }
  }
}

// Illustrators leave a sliver of paper beside an ink line on shading, or the line drowns in it:
// the 8-neighbours of a line that are not line themselves move towards paper (towards dark in
// dark mode, where a line is a gap in lit dots).
function haloTone(toneL, ink, W, H, amt) {
  const N = W * H;
  const near = new Uint8Array(N);
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      if (ink[i] < 0.5) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) near[yy * W + xx] = 1;
        }
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (!near[i] || ink[i] >= 0.5) continue;
    toneL[i] = amt > 0 ? toneL[i] + (1 - toneL[i]) * amt : toneL[i] * (1 + amt);
  }
}

/** Same contract as toneGrid (see SPEC.md), plus `line` overrides for the lab. */
export function toneVariant(img, tone, { target = 0.4, boost = 0, stretch = 1, line = null } = {}) {
  const t = { ...TONE_DEFAULTS, ...tone };
  const o = { ...LINE_DEFAULTS, ...line };
  const { W, H } = img;
  const N = W * H;

  // what the lines are drawn from: levels + midtones for a mid ink level, no sharpening (the DoG
  // is the sharpening), never inverted (lines always follow the dark features)
  const base = toneGrid(img, { ...t, invert: false, detail: 0, edges: 0 }, { target: 0.45, boost: 0, stretch });
  const ink = xdogLines(base, W, H, o);
  clearPaddedSides(ink, img.A, W, H);

  // the tone layer: lighter than the normal pipeline so the lines dominate; the user's brightness
  // still moves it (toneGrid shifts the target), and the target scales with the normal one
  const tTarget = Math.max(0.05, (t.invert ? o.invTarget : o.toneTarget) * (target == null ? 1 : target / 0.4));
  const toneL = toneGrid(img, { ...t, detail: Math.min(t.detail, o.toneDetail), edges: 0 }, { target: tTarget, boost, stretch });

  const out = new Float32Array(N);
  if (o.halo > 0) haloTone(toneL, ink, W, H, t.invert ? -o.halo : o.halo);
  if (!t.invert) {
    for (let i = 0; i < N; i++) out[i] = Math.min(toneL[i], 1 - clamp01(ink[i] * o.lineInk));
  } else {
    // dark mode: dots are the light parts, so a line (a dark feature) is carved out of the lit tone
    for (let i = 0; i < N; i++) out[i] = Math.max(toneL[i], clamp01(ink[i] * o.lineInk));
  }

  const edge = edgeMap(out, W, H);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += out[i];
  mean /= N || 1;
  let lines = 0;
  for (let i = 0; i < N; i++) if (ink[i] > 0) lines++;
  out.edge = edge;
  out.lines = ink;
  out.stats = { ...toneL.stats, coverage: 1 - mean, lineFrac: lines / (N || 1) };
  return out;
}

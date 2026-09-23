// Tone pipeline (adapted from Spiralist): photo -> W x H lightness grid -> toned lightness.
//
//   sampleImage(source, crop, W, H)   DOM: canvas resample of the square crop, over white
//   sampleFromRGBA(rgba, w, h, W, H)  pure twin of the same resample (node tests, ImageData sources)
//   toneGrid(img, tone)               pure: levels, detail, contrast, brightness, gamma, invert, edges
//
// Polarity: L in [0, 1], 1 = white paper, 0 = black. Ink = 1 - L. `invert` flips L at the end, so
// every later stage (dots, glyphs, blocks) keeps meaning "ink where L is low".

export const TONE_DEFAULTS = Object.freeze({
  auto: true,        // percentile levels + midtones solved for a target ink coverage
  brightness: 0,     // -1..1  auto: shifts the ink target; manual: shifts midtones
  contrast: 0,       // -1..1  around the median
  gamma: 1,          // 0.3..3 on top of auto; > 1 = lighter midtones (L^(1/gamma))
  detail: 0.35,      // 0..1   unsharp mask at a scale of ~2% of the grid
  edges: 0,          // 0..1   Sobel edge emphasis (thinned), also OR-ed into Braille dots
  invert: false,     // dark mode: dots stand for the light parts
});

const TONE_RANGE = [['brightness', -1, 1], ['contrast', -1, 1], ['gamma', 0.3, 3], ['detail', 0, 1], ['edges', 0, 1]];

export const CROP_DEFAULTS = Object.freeze({
  x: 0.5,        // crop centre in normalised image coords
  y: 0.5,
  zoom: 1,       // 1 = the square's side equals the photo's short side
  rotation: 0,   // degrees, clockwise
});

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Side of the square crop in source pixels. */
export function cropSide(width, height, crop) {
  return Math.min(width, height) / Math.max(0.05, (crop && crop.zoom) || 1);
}

// Supersampling per axis: enough to average the source footprint of one sample, capped so the
// work stays small (the canvas already filters large reductions).
function superFactor(side, W, H) {
  const s = Math.ceil(side / Math.max(1, Math.min(W, H)));
  return Math.max(1, Math.min(4, s));
}

let scratch = null;   // reused canvas: allocation dominates small resamples otherwise
function scratchCtx(w, h) {
  if (!scratch) {
    scratch = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  return scratch.getContext('2d', { willReadFrequently: true });
}

/**
 * Resample the square crop of `source` to a W x H grid. Sample cells are generally not square in
 * the photo (the grid's cell aspect differs), which is what keeps physical proportions on the target.
 * source: ImageBitmap / canvas / img, or an ImageData-like { width, height, data } (pure path).
 */
export function sampleImage(source, crop, W, H, { color = false } = {}) {
  crop = { ...CROP_DEFAULTS, ...crop };
  const w = source.width, h = source.height;
  if (source.data && !(typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement)) {
    return sampleFromRGBA(source.data, w, h, W, H, { color, crop });
  }
  const side = cropSide(w, h, crop);
  const S = superFactor(side, W, H);
  const cw = W * S, ch = H * S;
  const ctx = scratchCtx(cw, ch);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // rotate in isotropic photo pixels first, then squash the square onto the W x H grid
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(cw / side, ch / side);
  ctx.rotate((crop.rotation || 0) * Math.PI / 180);
  ctx.translate(-crop.x * w, -crop.y * h);
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, cw, ch).data;
  return boxDown(data, cw, ch, S, W, H, color);
}

/** Average S x S blocks of straight RGBA, composited over white. */
function boxDown(data, cw, ch, S, W, H, color) {
  const N = W * H;
  const L = new Float32Array(N);
  const rgb = color ? new Uint8ClampedArray(N * 3) : null;
  const A = new Float32Array(N);
  const inv = 1 / (S * S);
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      let ra = 0, ga = 0, ba = 0, aa = 0;
      for (let sy = 0; sy < S; sy++) {
        let p = ((y * S + sy) * cw + x * S) * 4;
        for (let sx = 0; sx < S; sx++, p += 4) {
          const a = data[p + 3];
          ra += data[p] * a; ga += data[p + 1] * a; ba += data[p + 2] * a; aa += a;
        }
      }
      writePixel(L, rgb, A, i, ra * inv / 255, ga * inv / 255, ba * inv / 255, aa * inv / 255);
    }
  }
  return { W, H, L, rgb, A: opaque(A) };
}

// Alpha is only kept when some sample is not opaque (a photo has none; a logo PNG or a crop past
// the photo's edge does).
function opaque(A) {
  for (let i = 0; i < A.length; i++) if (A[i] < 0.998) return A;
  return null;
}

// Premultiplied sums -> composite over white -> luma (Rec. 709 weights on the encoded values).
function writePixel(L, rgb, A, i, rp, gp, bp, a) {
  A[i] = a;
  const w = 255 * (1 - a);
  const r = rp + w, g = gp + w, b = bp + w;
  L[i] = clamp01((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
  if (rgb) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; }
}

/**
 * Pure resample of straight RGBA bytes to W x H, composited over white. With `crop` it takes the
 * square crop (rotation included) like sampleImage; without, the whole image. Each sample averages
 * S x S bilinear taps; taps outside the photo read as white paper.
 */
export function sampleFromRGBA(rgba, srcW, srcH, W, H, { color = false, crop = null } = {}) {
  let cx, cy, sideX, sideY, rot = 0;
  if (crop) {
    const c = { ...CROP_DEFAULTS, ...crop };
    cx = c.x * srcW; cy = c.y * srcH;
    sideX = sideY = cropSide(srcW, srcH, c);
    rot = (c.rotation || 0) * Math.PI / 180;
  } else {
    cx = srcW / 2; cy = srcH / 2; sideX = srcW; sideY = srcH;
  }
  const S = superFactor(Math.max(sideX, sideY), W, H);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const N = W * H;
  const L = new Float32Array(N);
  const rgb = color ? new Uint8ClampedArray(N * 3) : null;
  const A = new Float32Array(N);
  const inv = 1 / (S * S);
  const tap = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      let ra = 0, ga = 0, ba = 0, aa = 0;
      for (let sy = 0; sy < S; sy++) {
        const v = ((y + (sy + 0.5) / S) / H - 0.5) * sideY;
        for (let sx = 0; sx < S; sx++) {
          const u = ((x + (sx + 0.5) / S) / W - 0.5) * sideX;
          // inverse of the canvas transform: undo the clockwise rotation
          const px = cx + u * cos + v * sin;
          const py = cy - u * sin + v * cos;
          bilinear(rgba, srcW, srcH, px - 0.5, py - 0.5, tap);
          ra += tap[0]; ga += tap[1]; ba += tap[2]; aa += tap[3];
        }
      }
      // taps are already premultiplied 0..255 with alpha 0..1
      writePixel(L, rgb, A, i, ra * inv, ga * inv, ba * inv, aa * inv);
    }
  }
  return { W, H, L, rgb, A: opaque(A) };
}

// Bilinear tap returning premultiplied rgb (0..255 * alpha) and alpha (0..1). Taps outside the
// photo's rectangle are transparent; inside it, neighbours clamp to the edge pixel (as canvas
// drawImage does), else the outer half-pixel ring blends with nothing and every crop that spans the
// photo gets a pale fringe that auto levels then stretch into a white frame.
function bilinear(d, w, h, x, y, out) {
  out[0] = out[1] = out[2] = out[3] = 0;
  if (!(x >= -0.5 && y >= -0.5 && x <= w - 0.5 && y <= h - 0.5)) return;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  for (let k = 0; k < 4; k++) {
    let xx = x0 + (k & 1), yy = y0 + (k >> 1);
    xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
    yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
    const wt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
    const p = (yy * w + xx) * 4;
    const a = d[p + 3] / 255 * wt;
    out[0] += d[p] * a; out[1] += d[p + 1] * a; out[2] += d[p + 2] * a; out[3] += a;
  }
}

/**
 * Separable box blur, `passes` times (3 passes ~ Gaussian with sigma^2 = r(r+1)). In place.
 * Borders repeat the edge sample so they neither darken nor lighten.
 */
export function boxBlur(data, W, H, radius, passes = 3) {
  const r = Math.max(0, Math.round(radius));
  if (r < 1) return data;
  const tmp = new Float32Array(data.length);
  for (let p = 0; p < passes; p++) {
    blurRows(data, tmp, W, H, r);
    blurCols(tmp, data, W, H, r);
  }
  return data;
}

function blurRows(src, dst, W, H, r) {
  const inv = 1 / (2 * r + 1), last = W - 1;
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let acc = src[o] * (r + 1);
    for (let i = 1; i <= r; i++) acc += src[o + Math.min(i, last)];
    for (let x = 0; x < W; x++) {
      dst[o + x] = acc * inv;
      acc += src[o + Math.min(x + r + 1, last)] - src[o + Math.max(x - r, 0)];
    }
  }
}

function blurCols(src, dst, W, H, r) {
  const inv = 1 / (2 * r + 1), last = H - 1;
  const acc = new Float64Array(W);
  for (let k = 0; k < W; k++) {
    let a = src[k] * (r + 1);
    for (let i = 1; i <= r; i++) a += src[Math.min(i, last) * W + k];
    acc[k] = a;
  }
  for (let y = 0; y < H; y++) {
    const out = y * W, add = Math.min(y + r + 1, last) * W, sub = Math.max(y - r, 0) * W;
    for (let k = 0; k < W; k++) {
      dst[out + k] = acc[k] * inv;
      acc[k] += src[add + k] - src[sub + k];
    }
  }
}

/** sigma (px) -> box radius for 3 passes. */
export function boxRadiusForSigma(sigma) {
  return Math.max(0, Math.round((-1 + Math.sqrt(1 + 4 * sigma * sigma)) / 2));
}

// Subject bias: the middle of the crop counts more than the rim when measuring levels and ink,
// so a big plain background does not decide the exposure of the face.
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

/** Percentile levels [lo, hi]; a nearly flat photo is left alone (stretching would amplify noise). */
export function levels(h, lowPct = 0.005, highPct = 0.995) {
  if (h.total < 1e-6) return [0, 1];
  const lo = percentile(h, lowPct), hi = percentile(h, highPct);
  if (hi - lo < 12 / 255) return [0, 1];
  return [lo, hi];
}

/** Mean ink coverage (weighted) for exponent g; `flip` = ink is where L is high (invert). */
function meanInk(h, g, flip) {
  let s = 0;
  for (let i = 0; i < 256; i++) {
    if (!h.hist[i]) continue;
    const v = Math.pow(i / 255, g);
    s += h.hist[i] * (flip ? v : 1 - v);
  }
  return s / (h.total || 1);
}

/** Midtone exponent that makes the mean ink coverage hit `target` (bisection in log space). */
export function solveGamma(h, target, flip = false) {
  if (h.total < 1e-6) return 1;
  let lo = Math.log(0.25), hi = Math.log(4);   // bounded: never crush a photo to a silhouette
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    const ink = meanInk(h, Math.exp(mid), flip);
    if ((ink < target) !== flip) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
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
 * Sobel gradient of L: `mag` normalised so a full black/white step reads 1, and `thin`, the
 * non-maximum-suppressed ridge (one sample wide), so emphasised edges are lines, not bands.
 */
export function edgeMap(L, W, H) {
  const N = W * H;
  const mag = new Float32Array(N);
  const dir = new Uint8Array(N);
  const at = (x, y) => L[(y < 0 ? 0 : y >= H ? H - 1 : y) * W + (x < 0 ? 0 : x >= W ? W - 1 : x)];
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
      const d = at(x - 1, y), f = at(x + 1, y);
      const g = at(x - 1, y + 1), hh = at(x, y + 1), k = at(x + 1, y + 1);
      const gx = (c + 2 * f + k) - (a + 2 * d + g);
      const gy = (g + 2 * hh + k) - (a + 2 * b + c);
      mag[i] = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 4);
      // quantise the gradient direction: 0 = horizontal, 1 = diag /, 2 = vertical, 3 = diag \
      const ang = Math.atan2(gy, gx);
      dir[i] = ((Math.round(ang / (Math.PI / 4)) % 4) + 4) % 4;
    }
  }
  const thin = new Uint8Array(N);
  const OFF = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const m = mag[i];
      if (m < 0.08) continue;
      const [ox, oy] = OFF[dir[i]];
      const x1 = x + ox, y1 = y + oy, x2 = x - ox, y2 = y - oy;
      const m1 = x1 >= 0 && y1 >= 0 && x1 < W && y1 < H ? mag[y1 * W + x1] : 0;
      const m2 = x2 >= 0 && y2 >= 0 && x2 < W && y2 < H ? mag[y2 * W + x2] : 0;
      if (m >= m1 && m > m2) thin[i] = 1;
    }
  }
  return { mag, thin };
}

/**
 * Apply the tone controls to a sampled grid { W, H, L }. Pure and deterministic.
 * extra.target: ink coverage the auto midtones aim for (null = levels only, e.g. colour blocks).
 * extra.boost 0..1: small-grid help (more detail and contrast), set by the converter.
 * extra.stretch 0..1: strength of the auto levels (colour blocks keep the photo's own exposure more).
 * Returns the final lightness (after invert and edge emphasis) with two extra properties:
 *   .edge  = edgeMap of the toned image (before edge emphasis), for the dithers
 *   .stats = { lo, hi, gamma, coverage, std, flat }
 */
export function toneGrid(img, tone, { target = 0.4, boost = 0, stretch = 1 } = {}) {
  const t = { ...TONE_DEFAULTS, ...tone };
  // A slider read as NaN or a string must not blank the picture (NaN gamma made every L NaN), and
  // contrast below -1 would flip it: non-numbers fall back to the default, numbers clamp to range.
  for (const [k, a, b] of TONE_RANGE) {
    const v = +t[k];
    t[k] = Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : TONE_DEFAULTS[k];
  }
  const { W, H, L } = img;
  const N = W * H;
  const wts = centreWeights(W, H);
  const out = new Float32Array(N);

  let [lo, hi] = t.auto ? levels(histogram(L, wts)) : [0, 1];
  lo *= stretch; hi = 1 - (1 - hi) * stretch;
  const span = Math.max(1e-3, hi - lo);
  for (let i = 0; i < N; i++) out[i] = clamp01((L[i] - lo) / span);

  // Local contrast: an unsharp mask a couple of dots wide separates eyes, brows and mouth from
  // skin that would otherwise dither to the same grey. Clamped so it never paints halos.
  const detail = Math.min(1.5, t.detail + 0.45 * boost);
  if (detail > 0) {
    const base = Float32Array.from(out);
    boxBlur(base, W, H, boxRadiusForSigma(Math.max(1, 0.025 * Math.max(W, H))));
    const k = detail * 1.8;
    const lim = 0.12 + 0.1 * detail;
    for (let i = 0; i < N; i++) {
      let d = k * (out[i] - base[i]);
      d = d < -lim ? -lim : d > lim ? lim : d;
      out[i] = clamp01(out[i] + d);
    }
  }

  let h = histogram(out, wts);
  const contrast = t.contrast + 0.3 * boost;
  const c = contrast >= 0 ? 1 + 2 * contrast : 1 + contrast;
  const autoTarget = t.auto && target != null;
  const b = autoTarget ? 0 : t.brightness * 0.4;
  if (c !== 1 || b !== 0) {
    const mid = t.auto ? percentile(h, 0.5) : 0.5;
    for (let i = 0; i < N; i++) out[i] = clamp01((out[i] - mid) * c + mid + b);
    h = histogram(out, wts);
  }

  // Midtones: solve for the ink target (brightness moves the target), then the manual gamma on top.
  let g = 1;
  if (autoTarget) {
    const tgt = Math.max(0.08, Math.min(0.8, target - 0.25 * t.brightness));
    g = solveGamma(h, tgt, t.invert);
  }
  g /= Math.max(0.1, t.gamma);
  applyPow(out, g);

  if (t.invert) {
    const A = img.A;
    // transparent parts (a logo's background, past the photo's edge) are paper in both themes
    if (A) for (let i = 0; i < N; i++) out[i] = A[i] * out[i];
    for (let i = 0; i < N; i++) out[i] = 1 - out[i];
  }

  const edge = edgeMap(out, W, H);
  if (t.edges > 0) {
    const amt = t.edges;
    for (let i = 0; i < N; i++) {
      const m = edge.mag[i] * (edge.thin[i] ? 1 : 0.35);
      out[i] = clamp01(out[i] - amt * m);
    }
  }

  let mean = 0, wsum = 0;
  for (let i = 0; i < N; i++) { mean += out[i] * wts[i]; wsum += wts[i]; }
  mean /= wsum || 1;
  let v = 0;
  for (let i = 0; i < N; i++) v += wts[i] * (out[i] - mean) ** 2;
  const std = Math.sqrt(v / (wsum || 1));
  out.edge = edge;
  out.stats = { lo, hi, gamma: g, coverage: 1 - mean, std, flat: std < 0.03 };
  return out;
}

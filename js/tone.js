// Tone pipeline (adapted from Spiralist): photo -> W x H lightness grid -> toned lightness.
//
//   decodeSource(source)              once per photo: straight RGBA, long side <= DECODE_MAX
//   sampleImage(source, crop, W, H)   pure JS resample of the square crop, over white (any engine)
//   sampleFromRGBA(rgba, w, h, W, H)  the same resample of raw bytes at their own size (node tests)
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

// ---------------------------------------------------------------------------------- sampling
// The photo is decoded ONCE (decodeSource) into straight RGBA at most DECODE_MAX px on its long
// side, drawn at native size so no engine resamples it. Every crop, rotation and resample after
// that is plain JS over summed-area tables: O(1) per sample whatever the zoom, and the same numbers
// in every engine. (Resampling each crop through a canvas cost up to a 1440 x 1428 readback, slowed
// every later canvas in Chromium and WebKit, and differed between engines by enough for the
// dithers to flip a third of the cells.)

/** Long side of the decoded working buffer (px). */
export const DECODE_MAX = 1024;
// Above this many pixels the canvas shrinks the photo first (the app's intake caps at 2048 px, so
// only huge direct sources hit this; their result then depends on the engine's resampler).
const READ_MAX_PX = 4096 * 4096;

/** A decoded photo: straight RGBA bytes plus lazily built summed-area tables. */
export class DecodedImage {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data;
    let opaque = true;
    for (let p = 3; p < data.length; p += 4) if (data[p] !== 255) { opaque = false; break; }
    this.opaque = opaque;
    this.sat = null;      // { Y, A } premultiplied luma (+ alpha when not opaque)
    this.satRGB = null;   // [R, G, B] premultiplied, only for colour blocks
  }
}

const isPixels = s => !!(s && s.data && typeof s.getContext !== 'function' && s.width > 0 && s.height > 0);

/**
 * Decode any source once: DecodedImage (returned as is), ImageData-like { width, height, data },
 * or a drawable (ImageBitmap, canvas, img). Larger than maxSide: area-averaged down in JS.
 */
export function decodeSource(source, maxSide = DECODE_MAX) {
  if (source instanceof DecodedImage) return source;
  if (isPixels(source)) return fromRGBA(source.data, source.width, source.height, maxSide);
  // An ImageBitmap or img cannot change, so its decode (and summed-area tables) is shared by every
  // converter and lab call given the same object; a canvas can be redrawn, so it is read each time.
  const keep = typeof source.getContext !== 'function' && maxSide === DECODE_MAX;
  const hit = keep && decodeCache.get(source);
  if (hit) return hit;
  const dec = readDrawable(source, maxSide);
  if (keep) decodeCache.set(source, dec);
  return dec;
}
const decodeCache = new WeakMap();

function readDrawable(source, maxSide) {
  const w = source.naturalWidth || source.videoWidth || source.width;
  const h = source.naturalHeight || source.videoHeight || source.height;
  if (!(w > 0 && h > 0)) throw new Error('decodeSource: empty image');
  let dw = w, dh = h;
  if (w * h > READ_MAX_PX) {
    const k = Math.sqrt(READ_MAX_PX / (w * h));
    dw = Math.max(1, Math.floor(w * k)); dh = Math.max(1, Math.floor(h * k));
  }
  const cv = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(dw, dh)
    : Object.assign(document.createElement('canvas'), { width: dw, height: dh });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, dw, dh);
  const data = ctx.getImageData(0, 0, dw, dh).data;
  cv.width = cv.height = 1;   // Safari keeps canvas memory until GC otherwise
  return fromRGBA(data, dw, dh, maxSide);
}

function fromRGBA(data, w, h, maxSide) {
  const s = maxSide / Math.max(w, h);
  if (s >= 1) return new DecodedImage(w, h, data);
  const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  return new DecodedImage(tw, th, areaDown(data, w, h, tw, th));
}

// Fractional box spans of n source cells onto n2 (<= n) output cells, flattened.
function spans(n, n2) {
  const s = n / n2, start = new Int32Array(n2 + 1), idx = [], wt = [];
  for (let o = 0; o < n2; o++) {
    start[o] = idx.length;
    const a = o * s, b = Math.min(n, (o + 1) * s);
    for (let i = Math.floor(a); i < b && i < n; i++) {
      const w = Math.min(b, i + 1) - Math.max(a, i);
      if (w > 1e-12) { idx.push(i); wt.push(w); }
    }
  }
  start[n2] = idx.length;
  return { start, idx: Int32Array.from(idx), wt: Float64Array.from(wt) };
}

/** Area-average downscale of straight RGBA (alpha-weighted colour), one source row at a time. */
function areaDown(d, w, h, tw, th) {
  const out = new Uint8ClampedArray(tw * th * 4);
  const X = spans(w, tw), sy = h / th, inv = 1 / ((w / tw) * sy);
  const row = new Float64Array(tw * 4), acc = new Float64Array(tw * 4);
  const flush = oy => {
    for (let x = 0, q = oy * tw * 4; x < tw; x++, q += 4) {
      const k = x * 4, a = acc[k + 3];
      if (a > 0) { out[q] = acc[k] / a; out[q + 1] = acc[k + 1] / a; out[q + 2] = acc[k + 2] / a; }
      out[q + 3] = a * inv;
    }
    acc.fill(0);
  };
  let oy = 0, end = sy;
  for (let y = 0; y < h && oy < th; y++) {
    const base = y * w * 4;
    for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = X.start[x]; t < X.start[x + 1]; t++) {
        const p = base + X.idx[t] * 4, wa = X.wt[t] * d[p + 3];
        r += d[p] * wa; g += d[p + 1] * wa; b += d[p + 2] * wa; a += wa;
      }
      row[x * 4] = r; row[x * 4 + 1] = g; row[x * 4 + 2] = b; row[x * 4 + 3] = a;
    }
    // source row [y, y + 1) splits between output row oy and, past `end`, row oy + 1
    const last = y === h - 1;
    const wIn = last ? 1 : Math.min(y + 1, end) - y;
    for (let k = 0; k < acc.length; k++) acc[k] += row[k] * wIn;
    if (last || y + 1 >= end - 1e-9) {
      flush(oy++);
      end = (oy + 1) * sy;
      const spill = y + 1 - (end - sy);
      if (!last && spill > 1e-9 && oy < th) for (let k = 0; k < acc.length; k++) acc[k] += row[k] * spill;
    }
  }
  while (oy < th) flush(oy++);
  return out;
}

// Summed-area tables hold integers (value x 16), so sums are exact and engine-independent;
// Uint32 fits up to 1024 x 1024 px of white, larger buffers fall back to Float64.
const SAT_SCALE = 16;
function satArray(n) { return (n + 1) * 4080 < 4294967295 ? Uint32Array : Float64Array; }

function buildSat(dec) {
  const { width: w, height: h, data: d } = dec, W1 = w + 1;
  const T = satArray(w * h);
  const Y = new T(W1 * (h + 1)), A = dec.opaque ? null : new T(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let ry = 0, ra = 0;
    const o = (y + 1) * W1, u = y * W1;
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) {
      const a = d[p + 3];
      // premultiplied Rec. 709 luma of the encoded values, x 16, rounded: exact integer sums
      ry += Math.round((0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) * a * (SAT_SCALE / 255));
      Y[o + x + 1] = Y[u + x + 1] + ry;
      if (A) { ra += a * SAT_SCALE; A[o + x + 1] = A[u + x + 1] + ra; }
    }
  }
  return (dec.sat = { Y, A });
}

function buildSatRGB(dec) {
  const { width: w, height: h, data: d } = dec, W1 = w + 1;
  const T = satArray(w * h);
  const S = [new T(W1 * (h + 1)), new T(W1 * (h + 1)), new T(W1 * (h + 1))];
  const run = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    run[0] = run[1] = run[2] = 0;
    const o = (y + 1) * W1, u = y * W1;
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) {
      const k = d[p + 3] * (SAT_SCALE / 255);
      for (let c = 0; c < 3; c++) {
        run[c] += Math.round(d[p + c] * k);
        S[c][o + x + 1] = S[c][u + x + 1] + run[c];
      }
    }
  }
  return (dec.satRGB = S);
}

// Sum over the box [x0, x1) x [y0, y1) (source px, 0 <= x0 <= x1 <= w) of the piecewise-constant
// image: bilinear reads of the table at fractional corners are the exact integral.
function boxSum(S, W1, w, h, x0, y0, x1, y1) {
  return satAt(S, W1, w, h, x1, y1) - satAt(S, W1, w, h, x0, y1) - satAt(S, W1, w, h, x1, y0) + satAt(S, W1, w, h, x0, y0);
}
function satAt(S, W1, w, h, x, y) {
  let i = x | 0, j = y | 0;
  if (i >= w) i = w - 1;
  if (j >= h) j = h - 1;
  const fx = x - i, fy = y - j, p = j * W1 + i;
  const top = S[p] + (S[p + 1] - S[p]) * fx;
  const bot = S[p + W1] + (S[p + W1 + 1] - S[p + W1]) * fx;
  return top + (bot - top) * fy;
}

// cos / sin that every engine agrees on: exact at quarter turns, float32-rounded otherwise
// (Math.cos may differ in the last bit between engines).
function turn(deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d % 90 === 0) return [[1, 0], [0, 1], [-1, 0], [0, -1]][d / 90];
  const r = d * Math.PI / 180;
  return [Math.fround(Math.cos(r)), Math.fround(Math.sin(r))];
}

/**
 * Resample the square crop (or, without a crop, the whole image) of a decoded photo to W x H.
 * Each sample averages its footprint in the photo (area average when shrinking; at least one
 * source pixel wide, which is bilinear interpolation when enlarging). The footprint of a rotated
 * crop is taken as the axis-aligned box of the same extent, exact at quarter turns. The part of a
 * footprint outside the photo is transparent paper. Transparent pixels composite over white, and
 * alpha is kept (A, null when every sample is opaque) for the blank-stays-blank rule.
 */
export function sampleDecoded(dec, crop, W, H, { color = false } = {}) {
  const w = dec.width, h = dec.height, W1 = w + 1;
  let cx, cy, sideX, sideY, cos = 1, sin = 0;
  if (crop) {
    const c = { ...CROP_DEFAULTS, ...crop };
    cx = c.x * w; cy = c.y * h;
    sideX = sideY = cropSide(w, h, c);
    [cos, sin] = turn(+c.rotation || 0);
  } else {
    cx = w / 2; cy = h / 2; sideX = w; sideY = h;
  }
  const { Y, A: SA } = dec.sat || buildSat(dec);
  const RGB = color ? dec.satRGB || buildSatRGB(dec) : null;
  const du = sideX / W, dv = sideY / H;
  const hx = Math.sqrt((du * cos) ** 2 + (dv * sin) ** 2) / 2;
  const hy = Math.sqrt((du * sin) ** 2 + (dv * cos) ** 2) / 2;
  const fx = Math.max(hx, 0.5), fy = Math.max(hy, 0.5);
  const N = W * H;
  const L = new Float32Array(N);
  const rgb = color ? new Uint8ClampedArray(N * 3) : null;
  const Aout = new Float32Array(N);
  const inv255 = 1 / 255;
  for (let y = 0, i = 0; y < H; y++) {
    const v = ((y + 0.5) / H - 0.5) * sideY;
    for (let x = 0; x < W; x++, i++) {
      const u = ((x + 0.5) / W - 0.5) * sideX;
      // inverse of a clockwise rotation of the photo about the crop centre
      const px = cx + u * cos + v * sin;
      const py = cy - u * sin + v * cos;
      // share of the sample's own footprint that lies on the photo
      const covX = px - hx >= 0 && px + hx <= w ? 1 : (Math.min(px + hx, w) - Math.max(px - hx, 0)) / (2 * hx);
      const covY = py - hy >= 0 && py + hy <= h ? 1 : (Math.min(py + hy, h) - Math.max(py - hy, 0)) / (2 * hy);
      const x0 = px - fx > 0 ? px - fx : 0, x1 = px + fx < w ? px + fx : w;
      const y0 = py - fy > 0 ? py - fy : 0, y1 = py + fy < h ? py + fy : h;
      const area = (x1 - x0) * (y1 - y0);
      if (!(covX > 0 && covY > 0 && area > 0)) {   // off the photo (or NaN): paper
        L[i] = 1;
        if (rgb) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 255;
        continue;
      }
      const cov = covX * covY, k = cov / (area * SAT_SCALE);
      const a = SA ? boxSum(SA, W1, w, h, x0, y0, x1, y1) * k * inv255 : cov;
      const white = 255 * (1 - a);
      Aout[i] = a;
      L[i] = clamp01((boxSum(Y, W1, w, h, x0, y0, x1, y1) * k + white) * inv255);
      if (rgb) {
        rgb[i * 3] = boxSum(RGB[0], W1, w, h, x0, y0, x1, y1) * k + white;
        rgb[i * 3 + 1] = boxSum(RGB[1], W1, w, h, x0, y0, x1, y1) * k + white;
        rgb[i * 3 + 2] = boxSum(RGB[2], W1, w, h, x0, y0, x1, y1) * k + white;
      }
    }
  }
  return { W, H, L, rgb, A: opaque(Aout) };
}

// Alpha is only kept when some sample is not opaque (a photo has none; a logo PNG or a crop past
// the photo's edge does).
function opaque(A) {
  for (let i = 0; i < A.length; i++) if (A[i] < 0.998) return A;
  return null;
}

/**
 * Resample the square crop of `source` to a W x H grid (see sampleDecoded). Sample cells are
 * generally not square in the photo (the grid's cell aspect differs), which keeps physical
 * proportions on the target. source: DecodedImage, ImageData-like, or ImageBitmap / canvas / img.
 */
export function sampleImage(source, crop, W, H, { color = false } = {}) {
  return sampleDecoded(decodeSource(source), crop || {}, W, H, { color });
}

/**
 * Pure resample of straight RGBA bytes at their own resolution (no decode cap), same method as
 * sampleImage. With `crop` it takes the square crop (rotation included); without, the whole image.
 */
export function sampleFromRGBA(rgba, srcW, srcH, W, H, { color = false, crop = null } = {}) {
  return sampleDecoded(new DecodedImage(srcW, srcH, rgba), crop, W, H, { color });
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

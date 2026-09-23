// Tone pipeline (adapted from Spiralist): photo -> W x H lightness grid -> toned lightness.
//
//   decodeSource(source)              once per photo: straight RGBA, long side <= DECODE_MAX
//   sampleImage(source, crop, W, H)   pure JS resample of the square crop, over white (any engine)
//   sampleFromRGBA(rgba, w, h, W, H)  the same resample of raw bytes at their own size (node tests)
//   toneGrid(img, tone)               pure: levels, detail, contrast, brightness, gamma, invert, edges,
//                                     in one of five LOOKS (tone.look): photo, texture, sketch, soft, poster
//
// Polarity: L in [0, 1], 1 = white paper, 0 = black. Ink = 1 - L. `invert` flips L at the end, so
// every later stage (dots, glyphs, blocks) keeps meaning "ink where L is low".

export const LOOKS = Object.freeze([
  Object.freeze({ id: 'photo', name: 'Photo' }),     // local tone mapping: features pushed to the extremes
  Object.freeze({ id: 'texture', name: 'Texture' }), // CLAHE: fur, hair, fabric, water
  Object.freeze({ id: 'sketch', name: 'Sketch' }),   // XDoG ink lines over a light tone
  Object.freeze({ id: 'soft', name: 'Soft' }),       // plain levels + midtones (the original curve)
  Object.freeze({ id: 'poster', name: 'Poster' }),   // two levels, clean shapes: logos, silhouettes
]);
const LOOK_IDS = new Set(LOOKS.map(l => l.id));

export const TONE_DEFAULTS = Object.freeze({
  look: 'photo',     // one of LOOKS
  auto: true,        // percentile levels + midtones solved for a target ink coverage
  brightness: 0,     // -1..1  a lighter / darker photo (power outside the auto solve)
  contrast: 0,       // -1..1  around the median
  gamma: 1,          // 0.3..3 on top of auto; > 1 = lighter midtones (L^(1/gamma))
  detail: 0.35,      // 0..1   local contrast (each look's own detail layer, 0.35 = 1x)
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
  const tmp = blurScratch(data.length);
  for (let p = 0; p < passes; p++) {
    blurRows(data, tmp, W, H, r);
    blurCols(tmp, data, W, H, r);
  }
  return data;
}

// The blur's intermediate buffer is internal (never escapes), so one per size is reused: the photo
// look blurs ~8 times per tone change and fresh arrays cost GC time on phones.
let blurTmp = null;
function blurScratch(n) {
  if (!blurTmp || blurTmp.length !== n) blurTmp = new Float32Array(n);
  return blurTmp;
}

// tanh and the logistic curve as rational functions: several times faster than Math.tanh / exp
// per sample, and plain arithmetic, so every engine gives the same bits.
function tanhA(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}
const sigmoidA = z => 0.5 + 0.5 * tanhA(0.5 * z);

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
// so a big plain background does not decide the exposure of the face. Cached per size and falloff.
const weightMaps = new Map();
function radialMap(W, H, k, base, pow = 1) {
  const key = W + 'x' + H + ',' + k + ',' + base + ',' + pow;
  let w = weightMaps.get(key);
  if (w) return w;
  w = new Float32Array(W * H);
  for (let i = 0, y = 0; y < H; y++) {
    const dy = (y + 0.5) / H * 2 - 1;
    for (let x = 0; x < W; x++, i++) {
      const dx = (x + 0.5) / W * 2 - 1;
      w[i] = base + Math.exp(-(dx * dx + dy * dy) * k * pow);
    }
  }
  if (weightMaps.size > 48) weightMaps.clear();
  weightMaps.set(key, w);
  return w;
}
const centreWeights = (W, H) => radialMap(W, H, 1.5, 0.25);

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

/** Weighted Otsu threshold of a 256-bin histogram (maximises the between-class variance). */
function otsu({ hist, total }) {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = -1, th = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB <= 0) continue;
    const wF = total - wB;
    if (wF <= 1e-9) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = i; }
  }
  return (th + 0.5) / 255;
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
export function solveGamma(h, target, flip = false, gMin = 0.25, gMax = 4) {
  if (h.total < 1e-6) return 1;
  let lo = Math.log(gMin), hi = Math.log(gMax);   // bounded: never crush a photo to a silhouette
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    const ink = meanInk(h, Math.exp(mid), flip);
    if ((ink < target) !== flip) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

/** out = out^g through a 1024-entry LUT (Math.pow per sample is the slowest part on phones). */
function applyPow(out, g) {
  if (!(Math.abs(g - 1) >= 1e-4)) return;
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

/** Same as applyPow on the ink side: out = 1 - (1 - out)^g. */
function applyPowInk(out, g) {
  if (!(Math.abs(g - 1) >= 1e-4)) return;
  for (let i = 0; i < out.length; i++) out[i] = 1 - out[i];
  applyPow(out, g);
  for (let i = 0; i < out.length; i++) out[i] = 1 - out[i];
}

// Brightness is a power on the photo's lightness, outside every auto solve: the solve is bounded
// (a white photo inverted pins it), and a bound must not swallow the slider. + = a lighter photo,
// so fewer dots on paper and MORE lit dots in dark mode (dots are the light parts there).
const brightExp = b => Math.pow(2, -1.25 * b);

const TAN22 = 0.41421356;
/**
 * Sobel gradient of L: `mag` normalised so a full black/white step reads 1, and `thin`, the
 * non-maximum-suppressed ridge (one sample wide), so emphasised edges are lines, not bands.
 */
export function edgeMap(L, W, H) {
  const N = W * H;
  const mag = new Float32Array(N);
  const dir = new Uint8Array(N);
  for (let y = 0, i = 0; y < H; y++) {
    const ym = (y > 0 ? y - 1 : 0) * W, y0 = y * W, yp = (y < H - 1 ? y + 1 : H - 1) * W;
    for (let x = 0; x < W; x++, i++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
      const a = L[ym + xm], b = L[ym + x], c = L[ym + xp];
      const d = L[y0 + xm], f = L[y0 + xp];
      const g = L[yp + xm], hh = L[yp + x], k = L[yp + xp];
      const gx = (c + 2 * f + k) - (a + 2 * d + g);
      const gy = (g + 2 * hh + k) - (a + 2 * b + c);
      const m = Math.sqrt(gx * gx + gy * gy) / 4;
      mag[i] = m < 1 ? m : 1;
      // gradient direction in 4 bins without atan2: 0 = horizontal, 1 = diag /, 2 = vertical, 3 = diag \
      const ax = gx < 0 ? -gx : gx, ay = gy < 0 ? -gy : gy;
      dir[i] = ay <= TAN22 * ax ? 0 : ax <= TAN22 * ay ? 2 : (gx > 0) === (gy > 0) ? 1 : 3;
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

// ------------------------------------------------------------------------------------- looks
// One entry point, toneGrid(img, tone), dispatching on tone.look. Every look returns lightness in
// the output polarity (after invert), with .edge and .stats, and honours every slider.

/** Tone controls with defaults filled in, numbers clamped to range, the look validated. */
export function normalizeTone(tone) {
  const t = { ...TONE_DEFAULTS, ...tone };
  // A slider read as NaN or a string must not blank the picture (NaN gamma made every L NaN), and
  // contrast below -1 would flip it: non-numbers fall back to the default, numbers clamp to range.
  for (const [k, a, b] of TONE_RANGE) {
    const v = +t[k];
    t[k] = Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : TONE_DEFAULTS[k];
  }
  if (!LOOK_IDS.has(t.look)) t.look = TONE_DEFAULTS.look;
  t.auto = !!t.auto;
  t.invert = !!t.invert;
  return t;
}

/**
 * Apply the tone controls to a sampled grid { W, H, L, A? }. Pure and deterministic.
 * extra.target: ink coverage the auto midtones aim for (null = levels only, e.g. colour blocks).
 * extra.boost 0..1: small-grid help (more detail and contrast), set by the converter.
 * extra.stretch 0..1: strength of the auto levels (colour blocks keep the photo's own exposure more).
 * Returns the final lightness (after invert and edge emphasis) with two extra properties:
 *   .edge  = edgeMap of the toned image (before edge emphasis), for the dithers
 *   .stats = { look, lo, hi, gamma, coverage, std, flat }
 */
export function toneGrid(img, tone, extra = {}) {
  const t = normalizeTone(tone);
  const x = { target: 0.4, boost: 0, stretch: 1, ...extra };
  const run = LOOK_FN[t.look];
  const res = run(img, t, x);
  return finish(res.out, img, t, { look: t.look, ...res.stats });
}

// edge emphasis + stats, shared by every look
function finish(out, img, t, stats) {
  const { W, H } = img, N = W * H;
  const wts = centreWeights(W, H);
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
  out.stats = { lo: 0, hi: 1, gamma: 1, ...stats, coverage: 1 - mean, std, flat: std < 0.03 };
  return out;
}

// Levels into `out` (photo polarity); returns [lo, hi].
function levelled(img, t, wts, stretch, out) {
  const { L } = img, N = L.length;
  let [lo, hi] = t.auto ? levels(histogram(L, wts)) : [0, 1];
  lo *= stretch; hi = 1 - (1 - hi) * stretch;
  const span = Math.max(1e-3, hi - lo);
  for (let i = 0; i < N; i++) out[i] = clamp01((L[i] - lo) / span);
  return [lo, hi];
}

// Dark mode: transparent parts (a logo's background, past the photo's edge) are paper in both
// themes, so they are multiplied to black before the flip.
function invertInPlace(out, A) {
  const N = out.length;
  if (A) for (let i = 0; i < N; i++) out[i] = A[i] * out[i];
  for (let i = 0; i < N; i++) out[i] = 1 - out[i];
}

// Manual contrast around `mid`, plus (manual mode only) an additive brightness.
function contrastAround(out, contrast, mid, add = 0) {
  const c = contrast >= 0 ? 1 + 2 * contrast : 1 + contrast;
  if (c === 1 && add === 0) return false;
  for (let i = 0; i < out.length; i++) out[i] = clamp01((out[i] - mid) * c + mid + add);
  return true;
}

// ------------------------------------------------------------------------------ look: soft
// The original curve: levels, a mild unsharp mask, contrast, midtones solved for the ink target.
function toneSoft(img, t, { target, boost, stretch }) {
  const { W, H } = img, N = W * H;
  const wts = centreWeights(W, H);
  const out = new Float32Array(N);
  const [lo, hi] = levelled(img, t, wts, stretch, out);

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
  const autoTarget = t.auto && target != null;
  const mid = t.auto ? percentile(h, 0.5) : 0.5;
  if (contrastAround(out, t.contrast + 0.3 * boost, mid, autoTarget ? 0 : t.brightness * 0.4)) h = histogram(out, wts);

  // Midtones: solve for the ink target, then brightness and the manual gamma on top.
  let g = autoTarget ? solveGamma(h, target, t.invert) : 1;
  if (autoTarget) g *= brightExp(t.brightness);
  g /= t.gamma;
  applyPow(out, g);
  if (t.invert) invertInPlace(out, img.A);
  return { out, stats: { lo, hi, gamma: g } };
}

// ----------------------------------------------------------------------------- look: photo
// Detail-preserving local tone mapping (HDR style), in the DOT polarity (low = a dot):
//   I = levels(L), flipped first in dark mode
//   B = guidedFilter(I)   edge-preserving base: lighting and big shapes
//   D = I - B             eyes, brows, mouth, stripes, texture
//   out = base pulled to two region levels (split at the subject's Otsu level), squeezed toward
//         mid grey where features live, plus the contrast-normalised detail (tanh soft clip);
//   midtones for the ink target on the subject; flat low-saliency areas snap to paper / solid;
//   then small features are pushed to the extremes: 1-bit dots only show a feature whose grey
//   lands at <= ~0.15 or >= ~0.85, whatever it is surrounded by.
const PHOTO = Object.freeze({
  baseScale: 0.08,  // guided-filter radius / max(W, H)
  eps: 0.06,        // guided-filter range term (steps above ~sqrt(eps) stay in the base)
  expand: 0.7,      // pull of the base toward two region levels
  lvLo: 0.1, lvHi: 0.95, pivotK: 10,
  gain: 2.6,        // detail gain at 36+ columns
  gainSmall: 1.2,   // extra detail gain at 16 columns (times boost)
  limit: 0.5,       // soft clip of the boosted detail
  bgDetail: 0.3,    // detail gain factor where saliency is 0
  bgClean: 0.7,     // pull of flat low-saliency regions toward paper / solid
  snap: 0.06,       // end snap
  gMin: 0.8, gMax: 1.6,    // (the push runs first: the solve wins back the ink it moved to paper)
  sigC: 0.04,       // local detail amplitude at which the base squeeze is half on
  midCompress: 0.3, // base slope inside detailed regions
  sigN: 0.05,       // floor of the detail normaliser (flat noise is not amplified)
  push: 1,          // feature push to the extremes (0 = off)
  pushLo: 0.05, pushHi: 0.16,   // |detail| where the push ramps in
  pushR0: 0.12, pushR1: 0.3,    // local range (5 x 5) where the push ramps in: smooth areas stay
  brightShift: 0.5,             // brightness shift after the power: must pass the dither's lone-dot
                                //   cleanup (0.3 / 0.7) to show on solids and paper
});

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
  for (let i = 0; i < N; i++) a[i] = a[i] * I[i] + b[i];
  return a;
}

/**
 * Flat background connected to the border: grown from low-gradient border samples through
 * neighbours that differ by < tol (a sky's slow gradient joins, a subject's edge does not).
 * Returns a feathered 0..1 mask, or null when there is no subject to separate it from.
 */
function borderBackground(V, W, H, tol = 0.035) {
  const N = W * H;
  if (W < 6 || H < 6) return null;
  const S = Float32Array.from(V);
  boxBlur(S, W, H, 1, 1);
  const bg = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const flat = i => {
    const x = i % W, y = (i / W) | 0;
    const l = S[y * W + (x > 0 ? x - 1 : x)], r = S[y * W + (x < W - 1 ? x + 1 : x)];
    const u = S[(y > 0 ? y - 1 : y) * W + x], d = S[(y < H - 1 ? y + 1 : y) * W + x];
    return Math.abs(r - l) + Math.abs(d - u) < 2.5 * tol;
  };
  const seed = i => { if (!bg[i] && flat(i)) { bg[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (sp) {
    const i = stack[--sp], x = i % W, v = S[i];
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
    for (let k = 0; k < 4; k++) {
      const j = nb[k];
      if (j < 0 || j >= N || bg[j]) continue;
      if (Math.abs(S[j] - v) < tol && flat(j)) { bg[j] = 1; stack[sp++] = j; }
    }
  }
  let n = 0;
  for (let i = 0; i < N; i++) n += bg[i];
  if (n < 0.03 * N || n > 0.85 * N) return null;   // no background, or no subject
  const m = new Float32Array(N);
  for (let i = 0; i < N; i++) m[i] = bg[i];
  boxBlur(m, W, H, 1, 1);
  for (let i = 0; i < N; i++) m[i] = bg[i] ? m[i] : 0;   // feather inward only: the subject keeps its rim
  return m;
}

/** Running min and max over a (2r + 1)^2 window (separable, borders clamped). */
function localMinMax(V, W, H, r) {
  const N = W * H;
  const tmn = new Float32Array(N), tmx = new Float32Array(N);
  const mn = new Float32Array(N), mx = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      let a = 1e9, b = -1e9;
      const x0 = x > r ? x - r : 0, x1 = x + r < W ? x + r : W - 1;
      for (let k = x0; k <= x1; k++) { const v = V[o + k]; if (v < a) a = v; if (v > b) b = v; }
      tmn[o + x] = a; tmx[o + x] = b;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = y > r ? y - r : 0, y1 = y + r < H ? y + r : H - 1;
    for (let x = 0; x < W; x++) {
      let a = 1e9, b = -1e9;
      for (let k = y0; k <= y1; k++) { const p = k * W + x; if (tmn[p] < a) a = tmn[p]; if (tmx[p] > b) b = tmx[p]; }
      mn[y * W + x] = a; mx[y * W + x] = b;
    }
  }
  return [mn, mx];
}

function tonePhoto(img, t, { target, boost }) {
  const P = PHOTO;
  const { W, H, A } = img, N = W * H;
  const cp = radialMap(W, H, 2, 0);                  // centre prior
  const cp8 = radialMap(W, H, 2, 0, 0.8);           // cp^0.8
  const wC = radialMap(W, H, 2, 0.2);
  const I = new Float32Array(N);
  const [lo, hi] = levelled(img, t, wC, 1, I);
  const photoPol = t.invert ? Float32Array.from(I) : I;
  if (t.invert) for (let i = 0; i < N; i++) I[i] = 1 - (A ? A[i] : 1) * I[i];

  // base / detail split at a scale tied to the grid: ~8% of the long side
  const r = Math.max(1, Math.round(P.baseScale * Math.max(W, H)));
  const B = guidedFilter(I, W, H, r, P.eps);
  const D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = I[i] - B[i];

  // saliency: centre prior x local energy (detail + base gradient): a busy centre counts, a flat
  // rim does not
  const E = new Float32Array(N);
  for (let y = 0, i = 0; y < H; y++) {
    const yu = (y > 0 ? y - 1 : 0) * W, yd = (y < H - 1 ? y + 1 : H - 1) * W, y0 = y * W;
    for (let x = 0; x < W; x++, i++) {
      const gx = B[y0 + (x < W - 1 ? x + 1 : x)] - B[y0 + (x > 0 ? x - 1 : 0)];
      const gy = B[yd + x] - B[yu + x];
      E[i] = Math.abs(D[i]) + 0.5 * Math.sqrt(gx * gx + gy * gy);
    }
  }
  boxBlur(E, W, H, r, 2);
  const e90 = Math.max(1e-3, percentile(histogram(E, cp), 0.9));
  const S = new Float32Array(N), wS = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const en = Math.min(1, E[i] / e90);
    S[i] = clamp01(1.25 * cp8[i] * (0.35 + 0.65 * en));
    wS[i] = 0.08 + S[i];
  }

  // m splits the subject's base into dark and light regions (weighted Otsu): the light stripes of a
  // lighthouse against a bright sky still count as light, which a median split does not give
  const m = Math.min(0.85, Math.max(0.15, otsu(histogram(B, wS))));
  const detailScale = t.detail / 0.35;
  const gain = (P.gain + P.gainSmall * boost) * detailScale * 0.35;
  // local detail amplitude: where features live the base is squeezed toward mid grey so the boosted
  // detail swings to both paper and solid; flat regions keep the expanded (clean) base
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = D[i] * D[i];
  boxBlur(sig, W, H, r, 1);
  // region levels as a LUT over the base (the split sigmoid is fixed for this call)
  const NL = 256, lut = new Float32Array(NL + 2);
  for (let k = 0; k <= NL; k++) {
    const b = k / NL, sg = P.lvLo + (P.lvHi - P.lvLo) / (1 + Math.exp(-(b - m) * P.pivotK));
    lut[k] = b + P.expand * (sg - b) * Math.min(1, b / 0.04, (1 - b) / 0.04);
  }
  lut[NL + 1] = lut[NL];
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const b = B[i];
    const xb = (b <= 0 ? 0 : b >= 1 ? 1 : b) * NL, kb = xb | 0;
    let tb = lut[kb] + (lut[kb + 1] - lut[kb]) * (xb - kb);
    const sd = sig[i] > 0 ? Math.sqrt(sig[i]) : 0;
    const wgt = P.bgDetail + (1 - P.bgDetail) * S[i];
    tb += (sd / (sd + P.sigC)) * wgt * (m + P.midCompress * (b - m) - tb);
    // contrast-normalised detail: weak texture in shadow gets the swing of strong texture in light
    const d = P.limit * tanhA(gain * wgt * D[i] / (sd + P.sigN));
    out[i] = clamp01(tb + d);
  }

  // feature push: small features go to the extremes a 1-bit dot can show. Each sample is placed
  // in the INPUT's own local range (min..max over 5 x 5 samples) and an S-curve sends it to paper
  // or solid; the amount follows the detail layer |D| (a feature smaller than the base filter), so
  // eyes, pupils and a lighthouse's stripes snap while the rim of a big shape (kept in the base by
  // the guided filter) and smooth areas (a small local range) do not move.
  const push = P.push * Math.min(1.5, 0.6 + 0.4 * detailScale + 0.3 * boost);
  if (push > 0) {
    const [mn, mx] = localMinMax(I, W, H, 2);
    const d0 = P.pushLo, ds = 1 / (P.pushHi - P.pushLo);
    for (let i = 0; i < N; i++) {
      const R = mx[i] - mn[i];
      if (R < P.pushR0) continue;
      // |D| (a feature smaller than the base) or a large local range (a light stripe in shadow is
      // darker than a base dominated by the sky around the tower, but still spans the range)
      const ad = D[i] < 0 ? -D[i] : D[i];
      let u = (ad - d0) * ds; u = u < 0 ? 0 : u > 1 ? 1 : u;
      let ur = (R - P.pushR0) / (P.pushR1 - P.pushR0); ur = ur > 1 ? 1 : ur;
      const g = Math.max(u * u * (3 - 2 * u), ur * ur * (3 - 2 * ur));
      const k = Math.min(1, push * g * ur * (0.5 + 0.5 * S[i]));
      const z = (I[i] - (mn[i] + mx[i]) * 0.5) / R * 8;
      const s = sigmoidA(z);
      out[i] += k * (s - out[i]);
    }
  }

  let h = histogram(out, wS);
  if (t.contrast !== 0 || (!t.auto && t.brightness !== 0)) {
    // manual brightness is photo-polarity: + = lighter photo = fewer dots, or more in dark mode
    const add = t.auto ? 0 : (t.invert ? -1 : 1) * t.brightness * 0.4;
    // -1 keeps a quarter of the contrast: the pushed features would otherwise collapse to one grey
    contrastAround(out, t.contrast < 0 ? 0.75 * t.contrast : t.contrast, t.auto ? percentile(h, 0.5) : 0.5, add);
    h = histogram(out, wS);
  }

  // midtones for the ink target on the subject: bounded, the base curve already placed the regions
  let g = t.auto && target != null ? Math.max(P.gMin, Math.min(P.gMax, solveGamma(h, target, false))) : 1;
  g /= t.gamma;
  applyPow(out, g);

  // clean backgrounds: flat, low-saliency regions snap toward paper or solid
  if (P.bgClean > 0) {
    for (let i = 0; i < N; i++) {
      const s = 1 - S[i];
      const amt = P.bgClean * s * s * (1 - Math.min(1, E[i] / e90));
      if (amt <= 0) continue;
      const o = out[i];
      out[i] = o + amt * (sigmoidA((o - 0.5) * 14) - o);
    }
  }

  const sn = P.snap;
  for (let i = 0; i < N; i++) out[i] = clamp01((out[i] - sn) / (1 - 2 * sn));

  // brightness (auto): the push leaves most samples at 0 or 1, where a power alone does nothing, so
  // a shift follows it; photo polarity, so + = fewer dots on paper and more lit dots in dark mode
  if (t.auto && t.brightness !== 0) {
    const e = brightExp(t.brightness), sh = P.brightShift * t.brightness;
    if (t.invert) { applyPowInk(out, e); for (let i = 0; i < N; i++) out[i] = clamp01(out[i] - sh); }
    else { applyPow(out, e); for (let i = 0; i < N; i++) out[i] = clamp01(out[i] + sh); }
  }

  // dark mode: a flat backdrop joined to the border is paper (no dots), not a sheet of lit dots
  if (t.invert) {
    const bg = borderBackground(photoPol, W, H);
    if (bg) for (let i = 0; i < N; i++) out[i] += bg[i] * (1 - out[i]);
  }
  return { out, stats: { lo, hi, gamma: g, m } };
}

// --------------------------------------------------------------------------- look: texture
// Local contrast for textured subjects (fur, hair, fabric): CLAHE on a coarse tile grid, gated by
// an activity mask so flat backdrops keep their tone, a small unsharp mask, midtones for the ink
// target measured on the active subject, and flat near-white / near-black areas eased to paper /
// solid (no speckle).
const TEXTURE = Object.freeze({
  tiles: 4, clip: 2.0, bins: 64,
  amount: 0.65,    // CLAHE blend (0 = levels only)
  sharpen: 0.5,    // unsharp mask gain at ~1.2 dots
  salient: 0.6,    // how much local activity weights the ink target
  actScale: 0.05, refMin: 0.025, gate0: 0.2, gate1: 0.6, floor: 0.3,
  gmin: 0.5, gmax: 2,
  clean: 0.9, cleanAt: 0.66,
  inkScale: 1.12,  // a touch more ink than the other looks: a tabby coat must read as dark
});

/** Weighted percentile of non-negative values (256 bins over [0, max]). */
function weightedPct(values, wts, p) {
  let mx = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > mx) mx = values[i];
  if (!(mx > 0)) return 0;
  const hist = new Float64Array(256);
  let total = 0;
  const s = 255 / mx;
  for (let i = 0; i < values.length; i++) { hist[Math.min(255, (values[i] * s) | 0)] += wts[i]; total += wts[i]; }
  let acc = 0;
  for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= total * p) return (k + 0.5) / s; }
  return mx;
}

/**
 * Contrast-limited adaptive histogram equalisation of `src` (0..1) into `dst`: tx x ty tiles, clip
 * in multiples of the mean bin count; each tile's clipped CDF is linear inside a bin and the four
 * nearest tile mappings blend bilinearly (no bands, no seams).
 */
export function clahe(src, dst, W, H, tx, ty, clip, bins) {
  const b1 = bins + 1;
  const luts = new Float32Array(tx * ty * b1);
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
          hist[v <= 0 ? 0 : v >= 1 ? bins - 1 : Math.min(bins - 1, (v * bins) | 0)]++; n++;
        }
      }
      const o = (j * tx + i) * b1;
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
  const cell = (g, n) => {
    if (g <= 0 || n === 1) return [0, 0, 0];
    if (g >= n - 1) return [n - 1, n - 1, 0];
    const a = Math.floor(g);
    return [a, a + 1, g - a];
  };
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

function toneTexture(img, t, { target, boost, stretch }) {
  const P = TEXTURE;
  const { W, H } = img, N = W * H;
  const cw = centreWeights(W, H);
  const out = new Float32Array(N);
  const [lo, hi] = levelled(img, t, cw, stretch, out);
  const long = Math.max(W, H);
  const rFine = boxRadiusForSigma(Math.max(1, 0.02 * long));

  // activity = blurred |fine detail|, relative to its own p90: gates CLAHE and the unsharp mask
  // and weights the ink target (the subject decides the exposure, not the backdrop)
  const blur0 = Float32Array.from(out);
  boxBlur(blur0, W, H, rFine);
  const mask = new Float32Array(N);
  for (let i = 0; i < N; i++) mask[i] = Math.abs(out[i] - blur0[i]);
  boxBlur(mask, W, H, boxRadiusForSigma(Math.max(1.5, P.actScale * long)));
  const ref = Math.max(P.refMin, weightedPct(mask, cw, 0.9));
  const gs = 1 / Math.max(1e-3, P.gate1 - P.gate0);
  for (let i = 0; i < N; i++) {
    const u = clamp01((mask[i] / ref - P.gate0) * gs);
    mask[i] = u * u * (3 - 2 * u);
  }

  const dScale = t.detail / 0.35;
  const amount = Math.min(1, P.amount * Math.min(1.4, dScale) * (1 + 0.15 * boost));
  if (amount > 0 && W >= 4 && H >= 4) {
    const tx = Math.max(1, Math.round(P.tiles * W / long));
    const ty = Math.max(1, Math.round(P.tiles * H / long));
    const eq = clahe(out, new Float32Array(N), W, H, tx, ty, P.clip, P.bins);
    for (let i = 0; i < N; i++) out[i] += (eq[i] - out[i]) * amount * (P.floor + (1 - P.floor) * mask[i]);
  }

  const sharpen = P.sharpen * Math.min(1.5, dScale) * (1 + 0.6 * boost);
  if (sharpen > 0) {
    const base = Float32Array.from(out);
    boxBlur(base, W, H, rFine);
    for (let i = 0; i < N; i++) {
      let d = sharpen * (0.3 + 0.7 * mask[i]) * (out[i] - base[i]);
      d = d < -0.25 ? -0.25 : d > 0.25 ? 0.25 : d;
      out[i] = clamp01(out[i] + d);
    }
  }

  const wts = new Float32Array(N);
  for (let i = 0; i < N; i++) wts[i] = cw[i] * (1 - P.salient + P.salient * mask[i]);
  let h = histogram(out, wts);
  const autoTarget = t.auto && target != null;
  if (contrastAround(out, t.contrast, t.auto ? percentile(h, 0.5) : 0.5, autoTarget ? 0 : t.brightness * 0.4)) h = histogram(out, wts);

  // bounded tighter than soft: CLAHE already spreads the tones, a steep power flattens highlights
  let g = autoTarget ? Math.max(P.gmin, Math.min(P.gmax, solveGamma(h, Math.min(0.8, target * P.inkScale), t.invert))) : 1;
  if (autoTarget) g *= brightExp(t.brightness);
  g /= t.gamma;
  applyPow(out, g);

  // flat near-white (near-black) areas dither to a sprinkle of lone dots (holes): ease them the rest
  // of the way to paper (solid) where activity is low
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
  if (t.invert) invertInPlace(out, img.A);
  return { out, stats: { lo, hi, gamma: g, amount } };
}

// ---------------------------------------------------------------------------- look: sketch
// LINE + TONE, the way an illustrator draws a face at 56 x 60 dots: XDoG ink lines (Winnemoeller
// et al. 2012) kept with hysteresis and without short fragments, over a light tone whose darkest
// areas are capped (hatched, never solid, so thick dark areas do not swallow the lines).
const SKETCH = Object.freeze({
  sigma: 0.7, sigmaGrow: 0.004, k: 1.6, p: 30, eps: -0.06, phi: 20,
  strong: 0.8, weak: 0.3, minLen: 4, keepDot: 0.9,
  toneTarget: 0.25, toneDetail: 0.2, lineInk: 1.6, halo: 0.35, invTarget: 0.4,
  maxInk: 0.62,     // darkest the tone layer gets (1 - L): shading, not fill
});

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

/** The line layer: ink 0..1 per sample (0 = no line), from a levelled lightness `base`. */
export function xdogLines(base, W, H, o = SKETCH) {
  const N = W * H;
  const sigma = o.sigma + o.sigmaGrow * Math.max(W, H);
  const tmp = new Float32Array(N);
  const g1 = gauss(base, W, H, sigma, tmp, new Float32Array(N));
  const g2 = gauss(base, W, H, sigma * o.k, tmp, new Float32Array(N));
  const ink = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const S = (1 + o.p) * g1[i] - o.p * g2[i];
    if (S < o.eps) ink[i] = -tanhA(o.phi * (S - o.eps));
  }
  // hysteresis: strong samples seed, weak ones join only when connected to a seed (8-neighbours)
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
  const label = new Uint8Array(N);
  const members = new Int32Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (!keep[s0] || label[s0]) continue;
    let n = 0, peak = 0;
    sp = 0; stack[sp++] = s0; label[s0] = 1;
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
          if (keep[j] && !label[j]) { label[j] = 1; stack[sp++] = j; }
        }
      }
    }
    if (n < o.minLen && peak < o.keepDot) for (let q = 0; q < n; q++) keep[members[q]] = 0;
  }
  for (let i = 0; i < N; i++) if (!keep[i]) ink[i] = 0;
  return ink;
}

// A crop past the photo's edge has a pale fringe; the DoG would rule a line along it.
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

function toneSketch(img, t, { target, boost, stretch }) {
  const o = SKETCH;
  const { W, H } = img, N = W * H;
  // lines are drawn from levels + midtones at a mid ink level, no sharpening (the DoG is the
  // sharpening), never inverted (lines always follow the dark features); detail scales the lines
  const base = toneSoft(img, { ...t, invert: false, detail: 0, brightness: 0, contrast: 0, gamma: 1 },
    { target: 0.45, boost: 0, stretch }).out;
  const dScale = Math.min(1.6, t.detail / 0.35);
  // brightness thins the lines (a lighter photo has fewer dark features) in both themes: in dark
  // mode a line is a gap in the lit dots, so fewer lines = more lit dots
  const lp = { ...o, p: o.p * (0.4 + 0.6 * dScale), eps: o.eps * (1.4 - 0.4 * Math.min(1, dScale)) - 0.12 * t.brightness };
  const ink = t.detail > 0 ? xdogLines(base, W, H, lp) : new Float32Array(N);
  clearPaddedSides(ink, img.A, W, H);

  const tTarget = Math.max(0.05, (t.invert ? o.invTarget : o.toneTarget) * (target == null ? 1 : target / 0.4));
  const toneT = { ...t, detail: Math.min(t.detail, o.toneDetail) };
  const res = toneSoft(img, toneT, { target: tTarget, boost, stretch });
  const toneL = res.out;
  // cap the shading: a thick dark area becomes dense hatching, and a line on it still shows
  // (both themes: toneL is already in the output polarity, low = a dot)
  // brightness also shifts the capped shading: the soft power cannot move its solid darks
  const cap = o.maxInk, sh = 0.3 * t.brightness * (t.invert ? -1 : 1);
  for (let i = 0; i < N; i++) toneL[i] = clamp01(1 - cap * (1 - toneL[i]) + sh);

  // a sliver of paper beside each line (of darkness in dark mode), or the line drowns in shading
  if (o.halo > 0) {
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
      toneL[i] = !t.invert ? toneL[i] + (1 - toneL[i]) * o.halo : toneL[i] * (1 - o.halo) + o.halo;
    }
  }
  // on a light subject the lines carry most of the ink, so brightness also fades weak lines
  const lineInk = o.lineInk * Math.pow(2, -0.9 * t.brightness);
  const out = new Float32Array(N);
  if (!t.invert) {
    for (let i = 0; i < N; i++) out[i] = Math.min(toneL[i], 1 - clamp01(ink[i] * lineInk));
  } else {
    // dark mode: dots are the light parts, so a line (a dark feature) is carved out of the lit tone
    for (let i = 0; i < N; i++) out[i] = Math.max(toneL[i], clamp01(ink[i] * lineInk));
  }
  let lines = 0;
  for (let i = 0; i < N; i++) if (ink[i] > 0) lines++;
  return { out, stats: { ...res.stats, lineFrac: lines / (N || 1) } };
}

// ---------------------------------------------------------------------------- look: poster
// Two levels and clean shapes: levels, a light denoise, a threshold at the subject's Otsu split
// (brightness moves it), a steep sigmoid so flat areas are pure paper or pure ink and only the
// anti-aliased rim of a shape is grey (the dither turns it into a clean edge).
function tonePoster(img, t, { stretch }) {
  const { W, H } = img, N = W * H;
  const wts = centreWeights(W, H);
  const out = new Float32Array(N);
  const [lo, hi] = levelled(img, t, wts, stretch, out);
  // denoise below a dot (film grain, JPEG noise would otherwise flicker across the threshold),
  // then a little unsharp so thin strokes survive the smoothing
  const sm = Float32Array.from(out);
  boxBlur(sm, W, H, 1, 1);
  const dScale = t.detail / 0.35;
  if (dScale > 0) {
    const base = Float32Array.from(sm);
    boxBlur(base, W, H, boxRadiusForSigma(Math.max(1, 0.02 * Math.max(W, H))));
    const k = 0.8 * Math.min(2, dScale);
    for (let i = 0; i < N; i++) sm[i] = clamp01(sm[i] + k * (sm[i] - base[i]));
  }
  if (Math.abs(t.gamma - 1) > 1e-4) applyPow(sm, 1 / t.gamma);
  const h = histogram(sm, wts);
  let th = t.auto ? Math.min(0.8, Math.max(0.2, otsu(h))) : 0.5;
  th = Math.min(0.95, Math.max(0.05, th - 0.45 * t.brightness));
  // steepness: contrast -1 gives a soft two-tone, +1 a hard cut
  const K = 14 * (t.contrast >= 0 ? 1 + 2 * t.contrast : 1 + 0.7 * t.contrast);
  for (let i = 0; i < N; i++) out[i] = sigmoidA((sm[i] - th) * K);
  // the sigmoid never reaches 0 or 1: snap its ends so flat areas are exact paper / ink
  const e0 = sigmoidA(-K * th), e1 = sigmoidA(K * (1 - th));
  const s0 = Math.max(e0, 0.12), s1 = Math.min(e1, 0.88);
  for (let i = 0; i < N; i++) out[i] = clamp01((out[i] - s0) / Math.max(1e-3, s1 - s0));
  if (t.invert) invertInPlace(out, img.A);
  return { out, stats: { lo, hi, gamma: 1, threshold: th } };
}

const LOOK_FN = { photo: tonePhoto, texture: toneTexture, sketch: toneSketch, soft: toneSoft, poster: tonePoster };

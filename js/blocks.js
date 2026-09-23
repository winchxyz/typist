// Block modes: colour half blocks, colour quadrants (chafa-style two-colour fit) and monochrome
// quadrants. Pure and deterministic.

import { ditherDots } from './dither.js';

// Quadrant mask (UL=1, UR=2, LL=4, LR=8) -> code point. 0 is a plain space.
export const QUAD_CP = [
  0x20, 0x2598, 0x259D, 0x2580, 0x2596, 0x258C, 0x259E, 0x259B,
  0x2597, 0x259A, 0x2590, 0x259C, 0x2584, 0x2599, 0x259F, 0x2588,
];
export const BLOCK_SET = new Set(QUAD_CP);

// sRGB byte -> linear, as a table (the per-pixel pow is the slow part otherwise)
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const toByte = v => {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

// Björn Ottosson's OKLab, linear sRGB in/out.
function linToLab(r, g, b, out, o) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}
function labToRGB(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const r = toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = toByte(-0.0041960771 * l - 0.7034186147 * m + 1.7076147010 * s);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Photo colour as OKLab per sample, with its lightness replaced by the toned lightness, so levels,
 * contrast, brightness and invert act on colour blocks too (hue kept, chroma scaled with L).
 * toned: Float32Array from toneGrid, or null for the raw colour.
 */
export function labGrid(rgb, toned, N) {
  const lab = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    linToLab(LIN[rgb[i * 3]], LIN[rgb[i * 3 + 1]], LIN[rgb[i * 3 + 2]], lab, i * 3);
    if (toned) {
      const Lt = Math.cbrt(LIN[Math.round(Math.max(0, Math.min(1, toned[i])) * 255)]);
      const L0 = lab[i * 3];
      const k = L0 > 0.02 ? Math.min(1.15, Lt / L0) : 1;   // lifting shadows must not neon them
      lab[i * 3] = Lt; lab[i * 3 + 1] *= k; lab[i * 3 + 2] *= k;
    }
  }
  return lab;
}

/** Half blocks: W = cols, H = 2 * rows. ▀ with fg = top sample, bg = bottom sample. */
export function blocksHalf(lab, W, H) {
  const cols = W, rows = H >> 1;
  const n = cols * rows;
  const cp = new Uint32Array(n), fg = new Uint32Array(n), bg = new Uint32Array(n);
  let ink = 0;
  for (let r = 0, c0 = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, c0++) {
      const t = ((2 * r) * W + c) * 3, b = ((2 * r + 1) * W + c) * 3;
      const top = labToRGB(lab[t], lab[t + 1], lab[t + 2]);
      const bot = labToRGB(lab[b], lab[b + 1], lab[b + 2]);
      // identical halves are a full block: fewer distinct glyphs, same picture
      cp[c0] = top === bot ? 0x2588 : 0x2580;
      fg[c0] = top; bg[c0] = bot;
      ink += 1 - (lab[t] + lab[b]) / 2;
    }
  }
  return { cols, rows, cp, fg, bg, ink: ink / Math.max(1, n) };
}

// The 8 ways to split a 2x2 cell into two groups (the complement of a mask is the same split).
const SPLITS = [15, 1, 2, 4, 8, 3, 5, 6];
const SUB = [[0, 0], [1, 0], [0, 1], [1, 1]];   // bit k -> (dx, dy): UL, UR, LL, LR

/**
 * Colour quadrants: W = 2 * cols, H = 2 * rows. Every split gets fg/bg = the OKLab means of its two
 * groups; the split with the least squared OKLab error wins. fg is the darker group, so the glyph's
 * ink stands for the dark part (matches the monochrome variant and reads right when colours drop).
 */
export function blocksQuad(lab, W, H) {
  const cols = W >> 1, rows = H >> 1;
  const n = cols * rows;
  const cp = new Uint32Array(n), fg = new Uint32Array(n), bg = new Uint32Array(n);
  const px = new Float32Array(12);
  let ink = 0;
  for (let r = 0, c0 = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, c0++) {
      for (let k = 0; k < 4; k++) {
        const i = ((2 * r + SUB[k][1]) * W + 2 * c + SUB[k][0]) * 3;
        px[k * 3] = lab[i]; px[k * 3 + 1] = lab[i + 1]; px[k * 3 + 2] = lab[i + 2];
      }
      let best = Infinity, bm = 15, A = [0, 0, 0], B = [0, 0, 0];
      for (const m of SPLITS) {
        const a = [0, 0, 0], b = [0, 0, 0];
        let na = 0, nb = 0;
        for (let k = 0; k < 4; k++) {
          const g = (m >> k) & 1 ? a : b;
          g[0] += px[k * 3]; g[1] += px[k * 3 + 1]; g[2] += px[k * 3 + 2];
          if ((m >> k) & 1) na++; else nb++;
        }
        for (let j = 0; j < 3; j++) { a[j] /= na || 1; b[j] /= nb || 1; }
        let e = 0;
        for (let k = 0; k < 4; k++) {
          const g = (m >> k) & 1 ? a : b;
          const d0 = px[k * 3] - g[0], d1 = px[k * 3 + 1] - g[1], d2 = px[k * 3 + 2] - g[2];
          e += d0 * d0 + d1 * d1 + d2 * d2;
        }
        if (e < best - 1e-9) { best = e; bm = m; A = a; B = b; }
      }
      let mask = bm;
      if (mask === 15) {
        const col = labToRGB(A[0], A[1], A[2]);
        cp[c0] = 0x2588; fg[c0] = col; bg[c0] = col;
      } else {
        if (A[0] > B[0]) { mask = 15 ^ mask; const t = A; A = B; B = t; }   // fg = darker group
        cp[c0] = QUAD_CP[mask];
        fg[c0] = labToRGB(A[0], A[1], A[2]);
        bg[c0] = labToRGB(B[0], B[1], B[2]);
      }
      ink += 1 - (px[0] + px[3] + px[6] + px[9]) / 4;
    }
  }
  return { cols, rows, cp, fg, bg, ink: ink / Math.max(1, n) };
}

/**
 * Monochrome blocks, no colour: dither the sub-cells to ink / paper and map to the mask table.
 * quad: W = 2 * cols, H = 2 * rows; half: W = cols, H = 2 * rows (each half covers two quadrants).
 */
export function blocksMono(L, W, H, { half = false, dither = 'atkinson', edge = null, edges = 0 } = {}) {
  const dots = ditherDots(L, W, H, dither, { edge, edges });
  const cols = half ? W : W >> 1, rows = H >> 1;
  const n = cols * rows;
  const cp = new Uint32Array(n);
  let on = 0;
  for (let r = 0, c0 = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, c0++) {
      let m = 0;
      if (half) {
        if (dots[(2 * r) * W + c]) m |= 3;
        if (dots[(2 * r + 1) * W + c]) m |= 12;
      } else {
        for (let k = 0; k < 4; k++) if (dots[(2 * r + SUB[k][1]) * W + 2 * c + SUB[k][0]]) m |= 1 << k;
      }
      cp[c0] = QUAD_CP[m];
      for (let b = m; b; b &= b - 1) on++;
    }
  }
  return { cols, rows, cp, fg: null, bg: null, ink: on / Math.max(1, n * 4) };
}

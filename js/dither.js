// Dithers for 1-bit dot grids and the Braille cell encoder. Pure and deterministic.
//
// Input: lightness L (1 = paper). A dot is ink, so the dithers work on v = 1 - L.
// Output: Uint8Array, 1 = raised dot.

export const DITHERS = ['atkinson', 'floyd', 'bayer', 'threshold'];

// 4x4 Bayer matrix. Its 4 columns span two Braille cells and its 4 rows one cell, so the pattern
// is aligned to the cell grid and a flat tone gives the same few code points everywhere.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Error diffusion kernels as [dx, dy, weight]; dx is mirrored on right-to-left rows.
const KERNELS = {
  // Atkinson spreads only 6/8 of the error: highlights stay clean and shadows solid, with fewer
  // stray dots than Floyd-Steinberg at 32-60 dots wide.
  atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
};

/**
 * Dither a W x H lightness grid into dots.
 * opts.edge  { mag, thin } from tone.edgeMap: diffused error is scaled by (1 - mag) so it does not
 *            bleed across hard edges (a dark brow does not spray dots into the skin under it).
 * opts.edges 0..1: OR the thinned edge ridge into the dots (edge emphasis).
 * opts.cleanup: drop lone dots in highlights and fill lone holes in shadows (error diffusion only;
 *            for Bayer, isolated dots ARE the light tones).
 */
export function ditherDots(L, W, H, method = 'atkinson', { edge = null, edges = 0, cleanup = true } = {}) {
  const N = W * H;
  const dots = new Uint8Array(N);
  if (method === 'bayer') {
    for (let y = 0, i = 0; y < H; y++) {
      const row = (y & 3) * 4;
      for (let x = 0; x < W; x++, i++) {
        if (1 - L[i] > (BAYER4[row + (x & 3)] + 0.5) / 16) dots[i] = 1;
      }
    }
  } else if (method === 'threshold') {
    for (let i = 0; i < N; i++) dots[i] = 1 - L[i] >= 0.5 ? 1 : 0;
  } else {
    const kern = KERNELS[method] || KERNELS.atkinson;
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = 1 - L[i];
    const mag = edge ? edge.mag : null;
    for (let y = 0; y < H; y++) {
      const rtl = y & 1;   // serpentine: alternate direction to break up diagonal worms
      for (let n = 0; n < W; n++) {
        const x = rtl ? W - 1 - n : n;
        const i = y * W + x;
        let v = buf[i];
        v = v < -0.5 ? -0.5 : v > 1.5 ? 1.5 : v;   // keep runaway error from smearing into far regions
        const q = v >= 0.5 ? 1 : 0;
        dots[i] = q;
        let err = v - q;
        if (mag) err *= 1 - mag[i];
        if (err === 0) continue;
        for (let k = 0; k < kern.length; k++) {
          const xx = x + (rtl ? -kern[k][0] : kern[k][0]);
          const yy = y + kern[k][1];
          if (xx < 0 || xx >= W || yy >= H) continue;
          buf[yy * W + xx] += err * kern[k][2];
        }
      }
    }
    if (cleanup) cleanDots(dots, L, W, H);
  }
  if (edges > 0 && edge) {
    // stronger slider = weaker edges qualify
    const thr = 0.55 - 0.45 * Math.min(1, edges);
    for (let i = 0; i < N; i++) if (edge.thin[i] && edge.mag[i] > thr) dots[i] = 1;
  }
  return dots;
}

/**
 * One cleanup pass on a copy of the neighbourhood: a dot with no 8-neighbours whose own tone is light
 * was put there by diffused error, not by the photo, so it goes; likewise a lone hole in a dark area.
 * The own-tone test keeps real single-dot features (a pupil, a catchlight).
 */
function cleanDots(dots, L, W, H) {
  const src = Uint8Array.from(dots);
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const v = 1 - L[i];
      const on = src[i];
      if (on ? v > 0.3 : v < 0.7) continue;
      let n = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx | dy) === 0 || xx < 0 || xx >= W) continue;
          n += src[yy * W + xx]; cnt++;
        }
      }
      if (on && n === 0) dots[i] = 0;
      else if (!on && n === cnt) dots[i] = 1;
    }
  }
}

// Bit for the dot at (column cx 0..1, row cy 0..3) inside a cell: dots 1-3 / 4-6 are the upper
// three rows of the left / right column (bits 0-2 / 3-5), dots 7 and 8 the bottom row (bits 6, 7).
export const BRAILLE_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** Pack a (2*cols) x (4*rows) dot grid into Braille code points (U+2800 + bits). */
export function encodeBraille(dots, W, H) {
  const cols = W >> 1, rows = H >> 2;
  const cp = new Uint32Array(cols * rows);
  let on = 0;
  for (let r = 0, c0 = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, c0++) {
      let bits = 0;
      for (let cy = 0; cy < 4; cy++) {
        const row = (r * 4 + cy) * W + c * 2;
        if (dots[row]) bits |= BRAILLE_BIT[cy][0];
        if (dots[row + 1]) bits |= BRAILLE_BIT[cy][1];
      }
      cp[c0] = 0x2800 + bits;
      for (let b = bits; b; b &= b - 1) on++;
    }
  }
  return { cols, rows, cp, ink: on / Math.max(1, cols * rows * 8) };
}

/** Braille code point -> dot grid of one cell, as [row][col] 0/1 (for renderers and tests). */
export function brailleDots(cp) {
  const bits = cp - 0x2800;
  return BRAILLE_BIT.map(r => [bits & r[0] ? 1 : 0, bits & r[1] ? 1 : 0]);
}

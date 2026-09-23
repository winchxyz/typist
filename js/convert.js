// Converter: photo + crop + options -> Grid. Memoised in layers so each control redoes only what it
// affects: the sample depends on crop + grid size + colour, the tone on the sample + tone controls,
// and the encode (dither / glyph match / block fit) runs on top of the cached tone.

import { sampleImage, decodeSource, toneGrid, TONE_DEFAULTS, CROP_DEFAULTS } from './tone.js';
import { ditherDots, encodeBraille, DITHERS } from './dither.js';
import { labGrid, blocksHalf, blocksQuad, blocksMono } from './blocks.js';

export { DITHERS, TONE_DEFAULTS, CROP_DEFAULTS };

// ascii.js is written in parallel and may be missing or broken while the app is built; Braille and
// blocks must keep working without it. Loaded once at module start, so run() stays synchronous.
let ascii = null;
let asciiError = null;
try { ascii = await import('./ascii.js'); } catch (e) { asciiError = e; }

/** Mean ink coverage the auto tone aims for, per encoder (null = levels only). */
export const INK_TARGET = { braille: 0.4, ascii: 0.4, mono: 0.42, color: null };

export const OPTS_DEFAULTS = Object.freeze({
  mode: 'braille', cols: 40, rows: 0, dither: 'atkinson', ascii: 'shape', blocks: 'quad', color: false,
});

// Fallback cell aspects when the caller gives no rows (targets.js rowsFor is the real source).
const ASPECT = { braille: 0.55, ascii: 0.46, blocks: 0.5 };

/**
 * Small grids (X free is 16 x 8 cells) lose eyes and mouths in the dither: ramp in extra detail and
 * contrast below 36 columns, full at 16. 0 at 36+ columns, so larger grids are untouched.
 */
export function smallGridBoost(cols) {
  return Math.max(0, Math.min(1, (36 - cols) / 20));
}

// ASCII: the glyph matcher reads an SX x SY raster per cell (8 x 17): 228k samples at 60 x 28, and
// toning that many dominated a fresh crop (~400 ms at 4x CPU throttling). The photo is sampled and
// toned at most ASCII_SAMPLE per cell (4x fewer) and asciiCells area-resamples that to its raster,
// so each sub-circle still integrates the photo (every coarse sample is an area average itself).
export const ASCII_SAMPLE = [4, 8];

/** Sample grid size and encoder for a set of options. */
export function sampleSize(o) {
  const { mode, cols, rows } = o;
  if (mode === 'braille') return [2 * cols, 4 * rows];
  if (mode === 'blocks') return o.blocks === 'half' ? [cols, 2 * rows] : [2 * cols, 2 * rows];
  if (mode === 'ascii') {
    if (!ascii) throw new Error('ASCII mode unavailable: ' + (asciiError ? asciiError.message : 'ascii.js not loaded'));
    const [SX, SY] = ascii.ASCII_SUB;
    return [cols * Math.min(SX, ASCII_SAMPLE[0]), rows * Math.min(SY, ASCII_SAMPLE[1])];
  }
  throw new Error('unknown mode ' + mode);
}

/** Raw rows of a Grid. Braille blanks are U+2800, ASCII / block blanks U+0020. */
export function gridLines(grid) {
  const out = [];
  for (let r = 0; r < grid.rows; r++) {
    let s = '';
    for (let c = 0; c < grid.cols; c++) s += String.fromCodePoint(grid.cp[r * grid.cols + c]);
    out.push(s);
  }
  return out;
}

class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k, v) {
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
}

export function createConverter() {
  // the photo decoded once (RGBA, long side <= 1024): every crop resamples it in plain JS, so a
  // fresh crop is cheap and gives the same samples in every engine
  let source = null;
  // a few entries each, so flipping between modes or grid sizes does not redo the work
  const samples = new LRU(6);
  const tones = new LRU(8);
  const stats = { samples: 0, tones: 0, encodes: 0 };
  let decodeMs = 0;

  function run(crop, opts = {}) {
    if (!source) throw new Error('converter: no source');
    const o = { ...OPTS_DEFAULTS, ...opts };
    const c = { ...CROP_DEFAULTS, ...crop };
    // NaN / Infinity from a parsed field must not size the grid (NaN cols gave a 0-wide Grid)
    const num = (v, d) => (Number.isFinite(+v) ? +v : d);
    o.cols = Math.max(1, Math.round(num(o.cols, OPTS_DEFAULTS.cols)));
    o.rows = Math.max(1, Math.round(num(o.rows, 0) || o.cols * (ASPECT[o.mode] || 0.5)));
    const tone = { ...TONE_DEFAULTS, ...o.tone };
    const colorBlocks = o.mode === 'blocks' && !!o.color;
    const [W, H] = sampleSize(o);

    const sKey = `${c.x},${c.y},${c.zoom},${c.rotation}|${W}x${H}|${colorBlocks ? 1 : 0}`;
    let img = samples.get(sKey);
    if (!img) {
      img = sampleImage(source, c, W, H, { color: colorBlocks });
      samples.set(sKey, img);
      stats.samples++;
    }

    const kind = o.mode === 'blocks' ? (colorBlocks ? 'color' : 'mono') : o.mode;
    const target = INK_TARGET[kind];
    const boost = kind === 'braille' || kind === 'mono' ? smallGridBoost(o.cols) : 0;
    const tKey = `${sKey}|${tone.auto ? 1 : 0},${tone.brightness},${tone.contrast},${tone.gamma},` +
      `${tone.detail},${tone.edges},${tone.invert ? 1 : 0}|${target}|${boost}`;
    let L = tones.get(tKey);
    if (!L) {
      // colour blocks should look like the photo: half-strength levels, little sharpening (halos
      // show in colour), no ink target
      L = kind === 'color'
        ? toneGrid(img, { ...tone, detail: tone.detail * 0.25 }, { target, boost, stretch: 0.5 })
        : toneGrid(img, tone, { target, boost });
      tones.set(tKey, L);
      stats.tones++;
    }

    stats.encodes++;
    let g;
    if (o.mode === 'braille') {
      const dots = ditherDots(L, W, H, o.dither, { edge: L.edge, edges: tone.edges });
      g = encodeBraille(dots, W, H);
      g.fg = g.bg = null;
    } else if (o.mode === 'blocks') {
      if (colorBlocks) {
        // lab depends only on the tone entry: cache it there
        const lab = L.lab || (L.lab = labGrid(img.rgb, L, W * H));
        g = o.blocks === 'half' ? blocksHalf(lab, W, H) : blocksQuad(lab, W, H);
      } else {
        g = blocksMono(L, W, H, { half: o.blocks === 'half', dither: o.dither, edge: L.edge, edges: tone.edges });
      }
    } else {
      const cp = ascii.asciiCells(L, W, H, o.cols, o.rows, { method: o.ascii, contrast: o.asciiContrast });
      let ink = 0;
      for (let i = 0; i < L.length; i++) ink += 1 - L[i];
      g = { cols: o.cols, rows: o.rows, cp, fg: null, bg: null, ink: ink / L.length };
    }
    return {
      mode: o.mode, cols: g.cols, rows: g.rows, cp: g.cp, fg: g.fg, bg: g.bg, ink: g.ink,
      tone: L.stats,
    };
  }

  return {
    stats,
    get asciiReady() { return !!ascii; },
    setSource(s) {
      samples.clear(); tones.clear();
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      source = s ? decodeSource(s) : null;
      decodeMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    },
    /** The decoded working buffer { width, height, data } (null before setSource). */
    get decoded() { return source; },
    get decodeMs() { return decodeMs; },
    run,
  };
}

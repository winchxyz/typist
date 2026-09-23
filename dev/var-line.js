// Contact sheet for variant "line" (and its baseline): rows = test photos, columns = the source
// crop, Braille 16 x 9, 28 x 15, 40 x 22 and 28 x 15 inverted (light dots on #111).
import { sampleImage, toneGrid, TONE_DEFAULTS } from '../js/tone.js';
import { ditherDots, encodeBraille } from '../js/dither.js';
import { smallGridBoost } from '../js/convert.js';
import { drawGrid } from '../js/raster.js';
import { toneVariant, LINE_DEFAULTS } from './var-line-tone.js';

const q = new URLSearchParams(location.search);
const V = q.get('v') || 'line';
const DBG = q.get('dbg') === '1';
const NAME = (q.get('name') || (V === 'baseline' ? 'var_line_baseline' : 'var_line')).replace(/[^a-z0-9_-]/gi, '');
const line = {};
for (const k of Object.keys(LINE_DEFAULTS)) if (q.has(k)) line[k] = +q.get(k);

const INK = '#17171a', PAPER = '#ffffff', BG = '#eceae4', MUTED = '#6b6962';
const logEl = document.getElementById('log');
const log = s => { logEl.textContent += s + '\n'; console.log(s); };

const ROWS = [
  { label: 'photo_hopper', src: '../tests/fixtures/photo_hopper.jpg', crop: { x: 0.5, y: 0.42, zoom: 1 } },
  { label: 'portrait', src: '../img/samples/portrait.jpg' },
  { label: 'pet', src: '../img/samples/pet.jpg' },
  { label: 'landmark', src: '../img/samples/landmark.jpg' },
  { label: 'logo', src: '../img/samples/logo.jpg' },
  { label: 'dark', src: '../tests/fixtures/dark.jpg' },
];
const COLS = [
  { label: 'source crop' },
  { label: 'Braille 16x9 (X)', cols: 16, rows: 9 },
  { label: 'Braille 28x15 (phone)', cols: 28, rows: 15 },
  { label: 'Braille 40x22', cols: 40, rows: 22 },
  { label: 'Braille 28x15 inverted', cols: 28, rows: 15, invert: true },
];
if (DBG) COLS.push({ label: 'line layer 28x15', cols: 28, rows: 15, linesOnly: true });

const TILE = 300, LABEL = 130, GAP = 14, HEAD = 64, COLHEAD = 26, ASPECT = 0.55;
const times = [];

function tone(img, cols, invert, linesOnly) {
  const t = { ...TONE_DEFAULTS, invert: !!invert };
  const extra = { target: 0.4, boost: smallGridBoost(cols) };
  if (V === 'baseline') return toneGrid(img, t, extra);
  const t0 = performance.now();
  const L = toneVariant(img, t, { ...extra, line });
  times.push({ W: img.W, H: img.H, ms: performance.now() - t0 });
  if (linesOnly) {
    const o = Float32Array.from(L.lines, v => 1 - Math.min(1, v * (line.lineInk ?? LINE_DEFAULTS.lineInk)));
    o.edge = null;
    return o;
  }
  return L;
}

function braille(bmp, crop, c) {
  const W = 2 * c.cols, H = 4 * c.rows;
  const img = sampleImage(bmp, crop || {}, W, H);
  const L = tone(img, c.cols, c.invert, c.linesOnly);
  const dots = ditherDots(L, W, H, 'atkinson', { edge: L.edge, edges: 0 });
  const g = encodeBraille(dots, W, H);
  return { mode: 'braille', cols: g.cols, rows: g.rows, cp: g.cp, ink: g.ink, stats: L.stats };
}

async function main() {
  const bmps = [];
  for (const r of ROWS) bmps.push(await createImageBitmap(await (await fetch(r.src)).blob()));
  const cellW = TILE / 16;   // row height from the tallest tile (16 x 9 at aspect 0.55)
  const rowH = Math.max(TILE, ...COLS.filter(c => c.cols).map(c => c.rows * (TILE / c.cols) / ASPECT));
  void cellW;
  const cv = document.createElement('canvas');
  cv.width = LABEL + COLS.length * (TILE + GAP) + GAP;
  cv.height = HEAD + COLHEAD + ROWS.length * (rowH + GAP) + GAP;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = INK; ctx.font = '700 22px system-ui, sans-serif';
  const title = V === 'baseline'
    ? 'Baseline — js/tone.js toneGrid (TONE_DEFAULTS) + Atkinson'
    : 'Variant "line" — XDoG ink lines + light dithered tone, Atkinson';
  ctx.fillText(title, GAP, 32);
  ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = MUTED;
  const o = { ...LINE_DEFAULTS, ...line };
  ctx.fillText(V === 'baseline' ? 'target 0.4, boost = smallGridBoost(cols), dither atkinson with edge damping'
    : Object.entries(o).map(([k, v]) => `${k} ${v}`).join('  ·  '), GAP, 52);
  ctx.font = '600 13px system-ui, sans-serif'; ctx.fillStyle = INK;
  COLS.forEach((c, j) => ctx.fillText(c.label, LABEL + GAP + j * (TILE + GAP), HEAD + 16));

  const info = [];
  ROWS.forEach((r, i) => {
    const y0 = HEAD + COLHEAD + i * (rowH + GAP);
    ctx.font = '600 14px system-ui, sans-serif'; ctx.fillStyle = INK;
    ctx.fillText(r.label, GAP, y0 + 20);
    const bmp = bmps[i];
    COLS.forEach((c, j) => {
      const x0 = LABEL + GAP + j * (TILE + GAP);
      if (!c.cols) {
        // the square crop exactly as the sampler sees it (224 px-wide sample, drawn at 300)
        const img = sampleImage(bmp, r.crop || {}, 150, 150);
        const id = new ImageData(150, 150);
        for (let k = 0; k < img.L.length; k++) {
          const v = Math.round(img.L[k] * 255);
          id.data[k * 4] = id.data[k * 4 + 1] = id.data[k * 4 + 2] = v; id.data[k * 4 + 3] = 255;
        }
        const tmp = document.createElement('canvas'); tmp.width = tmp.height = 150;
        tmp.getContext('2d').putImageData(id, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, x0, y0, TILE, TILE);
        return;
      }
      const g = braille(bmp, r.crop, c);
      const cw = TILE / c.cols, ch = cw / ASPECT;
      drawGrid(ctx, g, { x: x0, y: y0, cellW: cw, cellH: ch, ink: c.invert ? '#ececec' : INK, paper: c.invert ? '#111111' : PAPER });
      info.push(`${r.label} ${c.label}: ink ${(g.ink * 100).toFixed(1)}%` + (g.stats && g.stats.lineFrac != null ? ` lines ${(g.stats.lineFrac * 100).toFixed(1)}%` : ''));
    });
  });
  const png = cv.toDataURL('image/png');
  const res = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: NAME, data: png }) });
  if (!res.ok) throw new Error('save failed');
  document.getElementById('out').appendChild(cv);
  info.forEach(log);
  const byGrid = {};
  for (const t of times) (byGrid[t.W + 'x' + t.H] ||= []).push(t.ms);
  const timing = Object.fromEntries(Object.entries(byGrid).map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)]));
  window.__done = { ok: true, name: NAME, v: V, timing };
}

main().catch(e => { log('ERROR ' + e.stack); window.__done = { ok: false, error: e.message }; });

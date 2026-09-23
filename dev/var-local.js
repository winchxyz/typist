// Contact sheets for tone variant "local" and its baseline (current js/tone.js toneGrid).
// Rows = test photos (square crops), columns = source, Braille 16x9, 28x15, 40x22, 28x15 inverted.
import { sampleImage, toneGrid, TONE_DEFAULTS } from '../js/tone.js';
import { ditherDots, encodeBraille } from '../js/dither.js';
import { smallGridBoost } from '../js/convert.js';
import { drawGrid } from '../js/raster.js';
import { toneVariant, LOCAL_DEFAULTS } from './var-local-tone.js';

const q = new URLSearchParams(location.search);
const SAVE = q.get('save') !== '0';
const BASE = q.get('base') !== '0';
const TAG = (q.get('tag') || '').replace(/[^a-z0-9_-]/gi, '');
const params = {};
for (const k of Object.keys(LOCAL_DEFAULTS)) if (q.has(k)) params[k] = +q.get(k);

const INK = '#17171a', PAPER = '#ffffff', BG = '#eceae4', MUTED = '#6b6962';
const DARK = '#111111', LIGHT = '#f0efe9';
const ASPECT = 0.55, TILE = +(q.get('tile') || 300), GAP = 14, M = 16;
const logEl = document.getElementById('log');
const log = s => { logEl.textContent += s + '\n'; console.log(s); };

const ALL_ROWS = [
  { name: 'photo_hopper (real photo)', url: '../tests/fixtures/photo_hopper.jpg', crop: { x: 0.5, y: 0.42, zoom: 1 } },
  { name: 'portrait (bust)', url: '../img/samples/portrait.jpg' },
  { name: 'pet (cat)', url: '../img/samples/pet.jpg' },
  { name: 'landmark (lighthouse)', url: '../img/samples/landmark.jpg' },
  { name: 'logo (emblem)', url: '../img/samples/logo.jpg' },
  { name: 'dark.jpg', url: '../tests/fixtures/dark.jpg' },
];
// only=2,3 renders just those rows (with tile=600: a close-up for judging features)
const ROWS = q.has('only') ? q.get('only').split(',').map(k => ALL_ROWS[+k]) : ALL_ROWS;
const COLS = [
  { label: 'Source (square crop)' },
  { label: 'Braille 16x9 (X)', cols: 16 },
  { label: 'Braille 28x15 (phone)', cols: 28 },
  { label: 'Braille 40x22', cols: 40 },
  { label: 'Braille 28x15 inverted', cols: 28, invert: true },
];
const rowsFor = cols => Math.max(1, Math.round(cols * ASPECT));

async function loadBitmap(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  return createImageBitmap(await r.blob());
}

function drawSource(ctx, bmp, crop, x, y) {
  const c = { x: 0.5, y: 0.5, zoom: 1, ...crop };
  const side = Math.min(bmp.width, bmp.height) / c.zoom;
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, TILE, TILE);
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, TILE, TILE); ctx.clip();
  const s = TILE / side;
  ctx.drawImage(bmp, x + (side / 2 - c.x * bmp.width) * s, y + (side / 2 - c.y * bmp.height) * s,
    bmp.width * s, bmp.height * s);
  ctx.restore();
}

/** One Braille grid through `toneFn` + Atkinson, as the converter does it. */
function braille(img, cols, rows, invert, toneFn) {
  const W = 2 * cols, H = 4 * rows;
  const tone = { ...TONE_DEFAULTS, invert };
  const extra = { target: 0.4, boost: smallGridBoost(cols) };
  const t0 = performance.now();
  const L = toneFn(img, tone, extra);
  const ms = performance.now() - t0;
  const dots = ditherDots(L, W, H, 'atkinson', { edge: L.edge, edges: 0 });
  const g = encodeBraille(dots, W, H);
  return { grid: { mode: 'braille', cols, rows, cp: g.cp, ink: g.ink }, ms, stats: L.stats };
}

async function sheet(name, title, toneFn, sources) {
  const rowH = 22 + Math.ceil(TILE * 1.04) + 18;
  const width = M * 2 + COLS.length * TILE + (COLS.length - 1) * GAP;
  const height = 64 + ROWS.length * rowH + M;
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = INK; ctx.font = '700 20px system-ui, sans-serif'; ctx.textBaseline = 'top';
  ctx.fillText(title.split('  (')[0], M, 12);
  ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = MUTED;
  ctx.fillText((title.split('  (')[1] ? 'params: ' + title.split('  (')[1].slice(0, -1) + ' | ' : '') + 'Atkinson, drawGrid dots, cell aspect 0.55, ink target 0.4, smallGridBoost as the converter', M, 38);
  const times = [];
  for (let r = 0; r < ROWS.length; r++) {
    const y0 = 64 + r * rowH;
    const { bmp, crop } = sources[r];
    for (let c = 0; c < COLS.length; c++) {
      const col = COLS[c];
      const x = M + c * (TILE + GAP);
      ctx.fillStyle = INK; ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(c === 0 ? ROWS[r].name : col.label, x, y0 + 3);
      if (c === 0) {
        drawSource(ctx, bmp, crop, x, y0 + 22);
        ctx.fillStyle = MUTED; ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(`${bmp.width}x${bmp.height} crop x ${crop.x ?? 0.5} y ${crop.y ?? 0.5}`, x, y0 + 22 + Math.ceil(TILE * 1.04) + 2);
        continue;
      }
      const rows = rowsFor(col.cols);
      const img = sampleImage(bmp, crop, 2 * col.cols, 4 * rows);
      const { grid, ms, stats } = braille(img, col.cols, rows, !!col.invert, toneFn);
      times.push(ms);
      const cellW = TILE / col.cols, cellH = cellW / ASPECT;
      drawGrid(ctx, grid, {
        x, y: y0 + 22, cellW, cellH,
        ink: col.invert ? LIGHT : INK, paper: col.invert ? DARK : PAPER,
      });
      ctx.fillStyle = MUTED; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${col.cols}x${rows} · ink ${Math.round(grid.ink * 100)}% · gamma ${stats.gamma.toFixed(2)} · tone ${ms.toFixed(2)} ms`,
        x, y0 + 22 + Math.ceil(TILE * 1.04) + 2);
    }
  }
  document.getElementById('out').appendChild(cv);
  if (SAVE) {
    const res = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: cv.toDataURL('image/png') }) });
    if (!res.ok) throw new Error('save failed ' + res.status);
  }
  times.sort((a, b) => a - b);
  return { name, medianToneMs: +times[times.length >> 1].toFixed(3), maxToneMs: +times[times.length - 1].toFixed(3) };
}

try {
  const sources = [];
  for (const r of ROWS) sources.push({ bmp: await loadBitmap(r.url), crop: r.crop || {} });
  const P = { ...LOCAL_DEFAULTS, ...params };
  const desc = Object.entries(P).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ');
  const out = [];
  out.push(await sheet('var_local' + TAG, `Variant "local": CLAHE + subject-weighted ink  (${desc})`, (img, tone, extra) =>
    toneVariant(img, tone, { ...extra, params }), sources));
  if (BASE) out.push(await sheet('var_local_baseline' + TAG, 'Baseline: js/tone.js toneGrid (TONE_DEFAULTS)', toneGrid, sources));
  log(JSON.stringify(out));
  window.__done = { ok: true, params: P, out };
} catch (e) {
  log('ERROR ' + e.stack);
  window.__done = { ok: false, error: e.message };
}

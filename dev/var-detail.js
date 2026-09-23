// Contact sheet for tone variant "detail" (local tone mapping) and its baseline (js/tone.js toneGrid).
//   node tests/shoot.mjs "/dev/var-detail.html"                 -> shots/var_detail.png + var_detail_baseline.png
//   ?which=variant|baseline|both   ?p=gain:2,eps:0.03 (param overrides)   ?dither=atkinson (plain js/dither.js)
//   ?debug=1  also writes shots/var_detail_debug.png (layers: input, base, detail, saliency, output)
import { sampleImage, toneGrid, TONE_DEFAULTS } from '../js/tone.js';
import { ditherDots, encodeBraille } from '../js/dither.js';
import { drawGrid } from '../js/raster.js';
import { smallGridBoost, INK_TARGET } from '../js/convert.js';
import { toneVariant, ditherVariant, DETAIL_PARAMS } from './var-detail-tone.js';

const q = new URLSearchParams(location.search);
const WHICH = q.get('which') || 'both';
const DITHER = q.get('dither') || 'variant';
const DEBUG = q.get('debug') === '1';
const TAG = (q.get('tag') || '').replace(/[^a-z0-9_-]/gi, '');
const PARAMS = {};
for (const kv of (q.get('p') || '').split(',').filter(Boolean)) {
  const [k, v] = kv.split(':');
  if (k in DETAIL_PARAMS) PARAMS[k] = Number.isFinite(+v) ? +v : v;
}

const ASPECT = 0.55, TILE = 300, GAP = 10, LABEL_W = 132, HEAD = 64, COL_HEAD = 26, CAP = 20;
const ROWS = [
  { id: 'photo_hopper', label: 'photo_hopper.jpg', url: '../tests/fixtures/photo_hopper.jpg', crop: { x: 0.5, y: 0.42, zoom: 1 } },
  { id: 'portrait', label: 'portrait.jpg', url: '../img/samples/portrait.jpg' },
  { id: 'pet', label: 'pet.jpg', url: '../img/samples/pet.jpg' },
  { id: 'landmark', label: 'landmark.jpg', url: '../img/samples/landmark.jpg' },
  { id: 'logo', label: 'logo.jpg', url: '../img/samples/logo.jpg' },
  { id: 'dark', label: 'dark.jpg', url: '../tests/fixtures/dark.jpg' },
];
const COLS = [
  { label: 'source crop' },
  { label: 'Braille 16×9 (X)', cols: 16 },
  { label: 'Braille 28×15 (phone)', cols: 28 },
  { label: 'Braille 40×22', cols: 40 },
  { label: 'Braille 28×15 inverted', cols: 28, invert: true },
];

async function load(url) {
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob);
}

function render(bmp, crop, col, which) {
  const cols = col.cols, rows = Math.max(1, Math.round(cols * ASPECT));
  const W = 2 * cols, H = 4 * rows;
  const img = sampleImage(bmp, crop, W, H);
  const tone = { ...TONE_DEFAULTS, invert: !!col.invert };
  const extra = { target: INK_TARGET.braille, boost: smallGridBoost(cols) };
  const t0 = performance.now();
  let L, dots;
  if (which === 'baseline') {
    L = toneGrid(img, tone, extra);
    dots = ditherDots(L, W, H, 'atkinson', { edge: L.edge, edges: tone.edges });
  } else {
    L = toneVariant(img, tone, { ...extra, params: PARAMS });
    dots = DITHER === 'atkinson'
      ? ditherDots(L, W, H, 'atkinson', { edge: L.edge, edges: tone.edges })
      : ditherVariant(L, W, H, { edge: L.edge, edges: tone.edges });
  }
  const ms = performance.now() - t0;
  const g = encodeBraille(dots, W, H);
  return { grid: { mode: 'braille', cols: g.cols, rows: g.rows, cp: g.cp }, ink: g.ink, ms, img, L };
}

function drawSource(ctx, bmp, crop, x, y) {
  const c = { x: 0.5, y: 0.5, zoom: 1, rotation: 0, ...crop };
  const side = Math.min(bmp.width, bmp.height) / c.zoom;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, TILE, TILE);
  ctx.beginPath(); ctx.rect(x, y, TILE, TILE); ctx.clip();
  ctx.translate(x + TILE / 2, y + TILE / 2);
  ctx.scale(TILE / side, TILE / side);
  ctx.rotate(c.rotation * Math.PI / 180);
  ctx.translate(-c.x * bmp.width, -c.y * bmp.height);
  ctx.drawImage(bmp, 0, 0);
  ctx.restore();
}

async function sheet(which, bitmaps) {
  const rowH = Math.ceil(TILE / Math.min(...COLS.filter(c => c.cols).map(c => c.cols)) / ASPECT * Math.round(16 * ASPECT)) + CAP + GAP;
  const cv = document.createElement('canvas');
  cv.width = LABEL_W + COLS.length * (TILE + GAP) + GAP;
  cv.height = HEAD + COL_HEAD + ROWS.length * rowH + GAP;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#eceae4'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#17171a';
  ctx.font = '700 22px system-ui, sans-serif';
  const title = which === 'baseline'
    ? 'Baseline: js/tone.js toneGrid (TONE_DEFAULTS) + js/dither.js atkinson'
    : 'Variant "detail": local tone mapping (guided-filter base compressed, detail boosted, subject ink target)';
  ctx.fillText(title, 16, 30);
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = '#55534c';
  const sub = which === 'baseline'
    ? 'target 0.4, boost = smallGridBoost(cols), cell aspect 0.55, dots by js/raster.js drawGrid'
    : 'params ' + JSON.stringify({ ...DETAIL_PARAMS, ...PARAMS }).replace(/"/g, '') +
      ' · dither ' + (DITHER === 'atkinson' ? 'js/dither.js atkinson' : 'edge-aware atkinson + IGN threshold');
  ctx.fillText(sub, 16, 52);
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillStyle = '#17171a';
  COLS.forEach((c, j) => ctx.fillText(c.label, LABEL_W + GAP + j * (TILE + GAP), HEAD + 18));
  const times = [];
  for (let r = 0; r < ROWS.length; r++) {
    const row = ROWS[r];
    const y = HEAD + COL_HEAD + r * rowH;
    ctx.font = '600 14px system-ui, sans-serif'; ctx.fillStyle = '#17171a';
    ctx.fillText(row.label, 12, y + 20);
    const bmp = bitmaps[row.id];
    ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#6b6962';
    ctx.fillText(`${bmp.width}×${bmp.height}`, 12, y + 38);
    for (let j = 0; j < COLS.length; j++) {
      const col = COLS[j];
      const x = LABEL_W + GAP + j * (TILE + GAP);
      if (!col.cols) { drawSource(ctx, bmp, row.crop, x, y); continue; }
      const res = render(bmp, row.crop, col, which);
      const cellW = TILE / col.cols, cellH = cellW / ASPECT;
      drawGrid(ctx, res.grid, {
        x, y, cellW, cellH,
        ink: col.invert ? '#f2f2f2' : '#000000', paper: col.invert ? '#111111' : '#ffffff',
      });
      ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#6b6962';
      ctx.fillText(`${col.cols}×${res.grid.rows} · ink ${Math.round(res.ink * 100)}% · tone+dither ${res.ms.toFixed(2)} ms`,
        x, y + res.grid.rows * cellH + 15);
      times.push(res.ms);
    }
  }
  const name = (which === 'baseline' ? 'var_detail_baseline' : 'var_detail') + TAG;
  const resp = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: cv.toDataURL('image/png') }) });
  if (!resp.ok) throw new Error('save failed');
  document.body.appendChild(cv);
  return { name, maxMs: Math.max(...times), meanMs: times.reduce((a, b) => a + b, 0) / times.length };
}

// Layers for two rows at 28 columns, as grey images (for judging the base / detail split).
async function debugSheet(bitmaps) {
  const ids = ['photo_hopper', 'pet', 'landmark'];
  const names = ['input I', 'base', 'detail x3', 'saliency', 'before bg clean', 'output'];
  const S = 5, W = 56, H = 60;
  const cv = document.createElement('canvas');
  cv.width = 20 + names.length * (W * S + 10); cv.height = 30 + ids.length * (H * S + 30);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#eceae4'; ctx.fillRect(0, 0, cv.width, cv.height);
  ids.forEach((id, r) => {
    const row = ROWS.find(x => x.id === id);
    const img = sampleImage(bitmaps[id], row.crop, W, H);
    const L = toneVariant(img, TONE_DEFAULTS, { target: 0.4, boost: smallGridBoost(28), params: PARAMS, debug: true });
    const { I, B, D, S: sal, pre } = L.debug;
    const maps = [I, B, D.map(v => 0.5 + 3 * v), sal, pre, L];
    maps.forEach((m, j) => {
      const id2 = ctx.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const v = Math.max(0, Math.min(255, m[i] * 255));
        id2.data[i * 4] = id2.data[i * 4 + 1] = id2.data[i * 4 + 2] = v; id2.data[i * 4 + 3] = 255;
      }
      const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
      tmp.getContext('2d').putImageData(id2, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const x = 10 + j * (W * S + 10), y = 30 + r * (H * S + 30);
      ctx.drawImage(tmp, x, y, W * S, H * S);
      ctx.fillStyle = '#17171a'; ctx.font = '13px system-ui';
      ctx.fillText(`${id} · ${names[j]}`, x, y - 6);
    });
  });
  await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: 'var_detail_debug' + TAG, data: cv.toDataURL('image/png') }) });
}

try {
  const bitmaps = {};
  for (const r of ROWS) bitmaps[r.id] = await load(r.url);
  const out = [];
  if (WHICH !== 'baseline') out.push(await sheet('variant', bitmaps));
  if (WHICH !== 'variant') out.push(await sheet('baseline', bitmaps));
  if (DEBUG) await debugSheet(bitmaps);
  window.__done = { ok: true, out };
} catch (e) {
  console.error(e);
  window.__done = { ok: false, error: String(e && e.stack || e) };
}

// Contact sheets for the tone LOOKS (js/tone.js), through the real converter (js/convert.js).
//   node tests/shoot.mjs "/dev/looks.html"            -> shots/looks.png (28 x 15 + photo 40 x 22 + inverted)
//                                                       shots/looks_x.png (15 x 8, the X post size)
//   ?tag=_it2     suffix for the shot names            ?only=sheet|x    one sheet
//   ?rows=pet,landmark   only these rows; ?pick=0,1,7 only these columns (zoomed inspection)
//   ?perf=1       tone change (toneGrid + atkinson) for 60 x 40 Braille per look, median ms
import { createConverter, smallGridBoost, INK_TARGET } from '../js/convert.js';
import { sampleImage, toneGrid, LOOKS, TONE_DEFAULTS } from '../js/tone.js';
import { ditherDots } from '../js/dither.js';
import { drawGrid } from '../js/raster.js';

const q = new URLSearchParams(location.search);
const TAG = (q.get('tag') || '').replace(/[^a-z0-9_-]/gi, '');
const ONLY = q.get('only') || '';
const PERF = q.get('perf') === '1';
const ONLY_ROWS = (q.get('rows') || '').split(',').filter(Boolean);
const PICK = (q.get('pick') || '').split(',').filter(Boolean).map(Number);
const pick = cols => (PICK.length ? cols.filter((c, j) => PICK.includes(j)) : cols);

const TILE = +(q.get('tile') || 280);
const ASPECT = 0.55, GAP = 12, LABEL_W = 150, HEAD = 70, COL_HEAD = 30, CAP = 22;
const ROWS = [
  { id: 'hopper', label: 'photo_hopper.jpg', note: 'face crop', url: '../tests/fixtures/photo_hopper.jpg', crop: { x: 0.5, y: 0.42, zoom: 1 } },
  { id: 'portrait', label: 'portrait.jpg', url: '../img/samples/portrait.jpg' },
  { id: 'pet', label: 'pet.jpg', url: '../img/samples/pet.jpg' },
  { id: 'landmark', label: 'landmark.jpg', url: '../img/samples/landmark.jpg' },
  { id: 'logo', label: 'logo.jpg', url: '../img/samples/logo.jpg' },
  { id: 'dark', label: 'dark.jpg', url: '../tests/fixtures/dark.jpg' },
].filter(r => !ONLY_ROWS.length || ONLY_ROWS.includes(r.id));
const rowsFor = cols => Math.max(1, Math.round(cols * ASPECT));

async function load(url) {
  return createImageBitmap(await (await fetch(url)).blob());
}

function drawSource(ctx, bmp, crop, x, y, size) {
  const c = { x: 0.5, y: 0.5, zoom: 1, rotation: 0, ...crop };
  const side = Math.min(bmp.width, bmp.height) / c.zoom;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
  ctx.beginPath(); ctx.rect(x, y, size, size); ctx.clip();
  ctx.translate(x + size / 2, y + size / 2);
  ctx.scale(size / side, size / side);
  ctx.rotate(c.rotation * Math.PI / 180);
  ctx.translate(-c.x * bmp.width, -c.y * bmp.height);
  ctx.drawImage(bmp, 0, 0);
  ctx.restore();
}

// One Braille tile through the converter: exactly what the app shows for these options.
function tile(conv, crop, col) {
  const cols = col.cols, rows = rowsFor(cols);
  const t0 = performance.now();
  const g = conv.run(crop || {}, { mode: 'braille', cols, rows, dither: 'atkinson', tone: { look: col.look, invert: !!col.invert } });
  return { g, ms: performance.now() - t0 };
}

async function sheet(name, title, allCols, tileW, bitmaps) {
  const cols = pick(allCols);
  const heights = cols.filter(c => c.cols).map(c => rowsFor(c.cols) * (tileW / c.cols) / ASPECT);
  const rowH = Math.ceil(Math.max(tileW, ...heights)) + CAP + GAP;
  const cv = document.createElement('canvas');
  cv.width = LABEL_W + cols.length * (tileW + GAP) + GAP;
  cv.height = HEAD + COL_HEAD + ROWS.length * rowH + GAP;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#eceae4'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#17171a';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.fillText(title, 16, 32);
  ctx.font = '13px system-ui, sans-serif'; ctx.fillStyle = '#55534c';
  ctx.fillText('js/tone.js toneGrid (tone.look) via createConverter().run, Braille atkinson, TONE_DEFAULTS otherwise; ' +
    'cell aspect 0.55; dots drawn by js/raster.js drawGrid; ms = fresh run (sample + tone + dither)', 16, 56);
  ctx.font = '600 15px system-ui, sans-serif'; ctx.fillStyle = '#17171a';
  cols.forEach((c, j) => ctx.fillText(c.label, LABEL_W + GAP + j * (tileW + GAP), HEAD + 20));
  const log = [];
  for (let r = 0; r < ROWS.length; r++) {
    const row = ROWS[r], bmp = bitmaps[row.id];
    const conv = createConverter();
    conv.setSource(bmp);
    const y = HEAD + COL_HEAD + r * rowH;
    ctx.font = '600 15px system-ui, sans-serif'; ctx.fillStyle = '#17171a';
    ctx.fillText(row.label, 12, y + 20);
    ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#6b6962';
    ctx.fillText(`${bmp.width}×${bmp.height}${row.note ? ' · ' + row.note : ''}`, 12, y + 38);
    for (let j = 0; j < cols.length; j++) {
      const col = cols[j];
      const x = LABEL_W + GAP + j * (tileW + GAP);
      if (!col.cols) { drawSource(ctx, bmp, row.crop, x, y, tileW); continue; }
      if (col.grey) { drawGrey(ctx, bmp, row.crop, col, x, y, tileW); continue; }
      const { g, ms } = tile(conv, row.crop, col);
      const cellW = tileW / col.cols, cellH = cellW / ASPECT;
      drawGrid(ctx, g, { x, y, cellW, cellH, ink: col.invert ? '#f2f2f2' : '#000000', paper: col.invert ? '#111111' : '#ffffff' });
      ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#6b6962';
      ctx.fillText(`${g.cols}×${g.rows} · ink ${Math.round(g.ink * 100)}% · ${ms.toFixed(1)} ms`, x, y + g.rows * cellH + 16);
      log.push({ row: row.id, col: col.label, ink: +g.ink.toFixed(3), ms: +ms.toFixed(2) });
    }
  }
  const resp = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: name + TAG, data: cv.toDataURL('image/png') }) });
  if (!resp.ok) throw new Error('save failed ' + name);
  document.body.appendChild(cv);
  return { name: name + TAG, w: cv.width, h: cv.height, maxMs: Math.max(...log.map(l => l.ms)) };
}

// The toned lightness before the dither, as grey pixels (?grey=photo adds this column).
function drawGrey(ctx, bmp, crop, col, x, y, tileW) {
  const cols = col.cols, rows = rowsFor(cols), W = 2 * cols, H = 4 * rows;
  const img = sampleImage(bmp, crop || {}, W, H);
  const L = toneGrid(img, { look: col.look, invert: !!col.invert }, { target: INK_TARGET.braille, boost: smallGridBoost(cols) });
  const id = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(Math.max(0, Math.min(1, L[i])) * 255);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  tmp.getContext('2d').putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const cellW = tileW / cols, cellH = cellW / ASPECT;
  ctx.drawImage(tmp, x, y, tileW, rows * cellH);
  ctx.imageSmoothingEnabled = true;
}

// Tone change budget: toneGrid + atkinson for 60 x 40 Braille (120 x 160 samples), per look.
function perf(bitmaps) {
  const out = {};
  const cols = 60, rows = 40, W = 2 * cols, H = 4 * rows;
  const extra = { target: INK_TARGET.braille, boost: smallGridBoost(cols) };
  for (const id of ['hopper', 'pet']) {
    const row = ROWS.find(r => r.id === id);
    const img = sampleImage(bitmaps[id], row.crop || {}, W, H);
    for (const look of LOOKS) {
      const xs = [];
      for (let k = 0; k < 24; k++) {
        const tone = { ...TONE_DEFAULTS, look: look.id, brightness: (k % 7) / 10 - 0.3 };
        const t0 = performance.now();
        const L = toneGrid(img, tone, extra);
        ditherDots(L, W, H, 'atkinson', { edge: L.edge, edges: 0 });
        if (k >= 4) xs.push(performance.now() - t0);
      }
      xs.sort((a, b) => a - b);
      out[id + ':' + look.id] = { med: +xs[xs.length >> 1].toFixed(2), p90: +xs[Math.floor(xs.length * 0.9)].toFixed(2) };
    }
  }
  return out;
}

try {
  const bitmaps = {};
  for (const r of ROWS) bitmaps[r.id] = await load(r.url);
  const res = [];
  const PROBE = q.get('probe');
  if (PROBE) {
    // ?probe=landmark;x0=14;x1=28;y0=10;y1=50: toned L (digit = L x 9) and dots, as text
    const row = ROWS.find(r => r.id === PROBE), cols = 28, rows = rowsFor(cols), W = 2 * cols, H = 4 * rows;
    const img = sampleImage(bitmaps[PROBE], row.crop || {}, W, H);
    const L = toneGrid(img, { look: q.get('look') || 'photo' }, { target: INK_TARGET.braille, boost: smallGridBoost(cols) });
    const dots = ditherDots(L, W, H, 'atkinson', { edge: L.edge, edges: 0 });
    const g = +(q.get('x0') || 0), h = +(q.get('x1') || W), a = +(q.get('y0') || 0), b = +(q.get('y1') || H);
    const lines = [];
    for (let y = a; y < b; y++) {
      let l1 = '', l2 = '', l3 = '';
      for (let x = g; x < h; x++) { const i = y * W + x; l1 += Math.round(L[i] * 9); l2 += dots[i] ? '#' : '.'; l3 += Math.round(img.L[i] * 9); }
      lines.push(l3 + '  ' + l1 + '  ' + l2);
    }
    window.__done = { ok: true, probe: lines };
  } else if (PERF) {
    const p = perf(bitmaps);
    document.body.insertAdjacentHTML('beforeend', '<pre>' + JSON.stringify(p, null, 1) + '</pre>');
    window.__done = { ok: true, perf: p };
  } else {
    const main = [{ label: 'source' }]
      .concat(LOOKS.map(l => ({ label: `${l.name} 28×15`, cols: 28, look: l.id })))
      .concat([{ label: 'Photo 40×22', cols: 40, look: 'photo' }, { label: 'Photo 28×15 inverted', cols: 28, look: 'photo', invert: true }]);
    const G = q.get('grey');
    if (G) main.push({ label: G + ' 28×15 grey L', cols: 28, look: G, grey: true });
    if (ONLY !== 'x') res.push(await sheet('looks', 'Typist looks · Braille 28×15 (phone), Photo at 40×22 and inverted', main, TILE, bitmaps));
    const xs = [{ label: 'source' }].concat(LOOKS.map(l => ({ label: `${l.name} 15×8`, cols: 15, look: l.id })));
    if (ONLY !== 'sheet') res.push(await sheet('looks_x', 'Typist looks · Braille 15×8 (X post size)', xs, TILE, bitmaps));
    window.__done = { ok: true, res };
  }
} catch (e) {
  console.error(e);
  window.__done = { ok: false, error: String(e && e.stack || e) };
}

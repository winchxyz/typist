// Sampling check: the decode-once pure resampler against the old per-crop canvas resample, and a
// timing breakdown (decode / sample / tone / encode) per mode. See perf2.html for the commands.
import { sampleImage, decodeSource, toneGrid, CROP_DEFAULTS, cropSide } from '../js/tone.js';
import { createConverter, sampleSize, smallGridBoost } from '../js/convert.js';
import { ditherDots, encodeBraille } from '../js/dither.js';
import { asciiCells } from '../js/ascii.js';
import { drawGrid } from '../js/raster.js';

const q = new URLSearchParams(location.search);
const SHEET = q.get('sheet') || 'compare';
const SAVE = q.get('save') !== '0';
const ENGINE = /Firefox/.test(navigator.userAgent) ? 'firefox' : /Chrome/.test(navigator.userAgent) ? 'chromium' : 'webkit';
const logEl = document.getElementById('log');
const log = s => { logEl.textContent += s + '\n'; console.log(s); };

async function bitmap(url) { return createImageBitmap(await (await fetch(url)).blob()); }
async function save(name, canvas) {
  if (!SAVE) return;
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: canvas.toDataURL('image/png') }) });
  if (!r.ok) throw new Error('save failed ' + r.status);
}

// ---------------------------------------------------------------- the old canvas path (reference)
let scratch = null;
function oldSample(source, crop, W, H) {
  crop = { ...CROP_DEFAULTS, ...crop };
  const w = source.width, h = source.height;
  const side = cropSide(w, h, crop);
  const S = Math.max(1, Math.min(4, Math.ceil(side / Math.max(1, Math.min(W, H)))));
  const cw = W * S, ch = H * S;
  if (!scratch) scratch = document.createElement('canvas');
  scratch.width = cw; scratch.height = ch;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(cw / side, ch / side);
  ctx.rotate((crop.rotation || 0) * Math.PI / 180);
  ctx.translate(-crop.x * w, -crop.y * h);
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, cw, ch).data;
  const L = new Float32Array(W * H), A = new Float32Array(W * H), inv = 1 / (S * S);
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
    let ra = 0, ga = 0, ba = 0, aa = 0;
    for (let sy = 0; sy < S; sy++) {
      let p = ((y * S + sy) * cw + x * S) * 4;
      for (let sx = 0; sx < S; sx++, p += 4) { const a = d[p + 3]; ra += d[p] * a; ga += d[p + 1] * a; ba += d[p + 2] * a; aa += a; }
    }
    const a = aa * inv / 255, wt = 255 * (1 - a);
    const r = ra * inv / 255 + wt, g = ga * inv / 255 + wt, b = ba * inv / 255 + wt;
    L[i] = Math.min(1, Math.max(0, (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255));
    A[i] = a;
  }
  return { W, H, L, rgb: null, A: A.some(v => v < 0.998) ? A : null };
}

function braille(img, cols, rows) {
  const L = toneGrid(img, {}, { target: 0.4, boost: smallGridBoost(cols) });
  const g = encodeBraille(ditherDots(L, img.W, img.H, 'atkinson', { edge: L.edge, edges: 0 }), img.W, img.H);
  return { mode: 'braille', cols, rows, cp: g.cp };
}

function greyImage(ctx, L, W, H, x, y, scale) {
  const id = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { const v = L[i] * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, x, y, W * scale, H * scale);
}

async function sheetCompare() {
  const files = [q.get('img') || '/tests/fixtures/photo_hopper.jpg', '/img/samples/portrait.jpg', '/tests/fixtures/logo_alpha.png', '/img/samples/landmark.jpg'];
  const crops = [
    { label: 'centre', crop: {} },
    { label: 'x.4 y.55 zoom1.7 rot30', crop: { x: 0.4, y: 0.55, zoom: 1.7, rotation: 30 } },
    { label: 'rot90 zoom1.3', crop: { rotation: 90, zoom: 1.3 } },
    { label: 'zoom0.7 x.3 (past edge)', crop: { zoom: 0.7, x: 0.3 } },
  ];
  const cols = 40, rows = 22, W = 2 * cols, H = 4 * rows;
  const cellW = 5, cellH = 10, gs = 2;   // Braille cell px, grey sample scale
  const panelW = Math.max(cols * cellW, W * gs);
  const colW = panelW * 3 + 40, rowH = H * gs + rows * cellH + 50;
  const cv = document.createElement('canvas');
  cv.width = colW * crops.length + 20; cv.height = rowH * files.length + 40;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#eceae4'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#17171a'; ctx.font = '600 13px system-ui';
  ctx.fillText(`${ENGINE}: per crop  old canvas | new pure | |diff| x4 (grey L 80x88 on top, Braille 40x22 atkinson below)`, 10, 18);
  const stats = [];
  for (let f = 0; f < files.length; f++) {
    const bmp = await bitmap(files[f]);
    const dec = decodeSource(bmp);
    for (let k = 0; k < crops.length; k++) {
      const { label, crop } = crops[k];
      const a = oldSample(bmp, crop, W, H), b = sampleImage(dec, crop, W, H);
      const d = new Float32Array(W * H);
      let md = 0, sd = 0;
      for (let i = 0; i < d.length; i++) { const e = Math.abs(a.L[i] - b.L[i]); sd += e; if (e > md) md = e; d[i] = 1 - Math.min(1, 4 * e); }
      const ga = braille(a, cols, rows), gb = braille(b, cols, rows);
      let cells = 0;
      for (let i = 0; i < ga.cp.length; i++) cells += ga.cp[i] !== gb.cp[i];
      const x0 = 10 + k * colW, y0 = 30 + f * rowH;
      ctx.fillStyle = '#17171a'; ctx.font = '12px system-ui';
      ctx.fillText(`${files[f].split('/').pop()} · ${label} · mean ${(sd / d.length).toFixed(4)} max ${md.toFixed(3)} · cells ${cells}/${ga.cp.length}`, x0, y0 + 12);
      [a.L, b.L, d].forEach((L, j) => greyImage(ctx, L, W, H, x0 + j * (panelW + 10), y0 + 20, gs));
      [ga, gb].forEach((g, j) => drawGrid(ctx, g, { x: x0 + j * (panelW + 10), y: y0 + 26 + H * gs, cellW, cellH, paper: '#fff' }));
      stats.push({ file: files[f].split('/').pop(), label, mean: +(sd / d.length).toFixed(4), max: +md.toFixed(3), cells, decoded: [dec.width, dec.height], native: [bmp.width, bmp.height] });
    }
  }
  document.getElementById('out').appendChild(cv);
  await save(`sample_compare_${ENGINE}`, cv);
  return { ok: true, sheet: 'compare', engine: ENGINE, stats };
}

// ASCII at the encoder's full 8 x 17 raster per cell vs the converter's capped sample raster.
async function sheetAscii() {
  const { ASCII_SUB } = await import('../js/ascii.js');
  const [SX, SY] = ASCII_SUB;
  const files = [q.get('img') || '/tests/fixtures/photo_hopper.jpg', '/img/samples/portrait.jpg', '/img/samples/landmark.jpg', '/img/samples/logo.jpg'];
  const cols = +(q.get('w') || 60), rows = Math.round(cols * 0.46), cellW = 8, cellH = 17;
  const cv = document.createElement('canvas');
  cv.width = (cols * cellW + 20) * 2 + 20; cv.height = (rows * cellH + 30) * files.length + 30;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#eceae4'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#17171a'; ctx.font = '600 13px system-ui';
  ctx.fillText(`${ENGINE}: ASCII shape ${cols}x${rows} · left: sampled + toned at ${SX}x${SY} per cell · right: converter (${sampleSize({ mode: 'ascii', cols: 1, rows: 1 }).join('x')} per cell)`, 10, 18);
  const stats = [];
  for (let f = 0; f < files.length; f++) {
    const bmp = await bitmap(files[f]);
    const c = createConverter();
    c.setSource(bmp);
    const img = sampleImage(c.decoded, {}, cols * SX, rows * SY);
    const L = toneGrid(img, {}, { target: 0.4 });
    const full = { mode: 'ascii', cols, rows, cp: asciiCells(L, cols * SX, rows * SY, cols, rows, { method: 'shape' }) };
    const capped = c.run({}, { mode: 'ascii', cols, rows });
    let cells = 0;
    for (let i = 0; i < full.cp.length; i++) cells += full.cp[i] !== capped.cp[i];
    const y = 30 + f * (rows * cellH + 30);
    ctx.fillStyle = '#17171a'; ctx.font = '12px system-ui';
    ctx.fillText(`${files[f].split('/').pop()} · cells differing ${cells}/${full.cp.length}`, 10, y + 12);
    [full, capped].forEach((g, j) => drawGrid(ctx, g, { x: 10 + j * (cols * cellW + 20), y: y + 18, cellW, cellH, paper: '#fff', font: '14px "Cascadia Mono", Consolas, monospace' }));
    stats.push({ file: files[f].split('/').pop(), cells });
  }
  document.getElementById('out').appendChild(cv);
  await save(`sample_ascii_${ENGINE}`, cv);
  return { ok: true, sheet: 'ascii', stats };
}

// ---------------------------------------------------------------- timing breakdown
const med = xs => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
async function sheetPerf() {
  const url = q.get('img') || '/img/samples/portrait.jpg';
  const bmp = await bitmap(url);
  const N = +(q.get('n') || 9);
  const out = { engine: ENGINE, img: url };
  const c = createConverter();
  let t0 = performance.now();
  c.setSource(bmp);
  out.decode = performance.now() - t0;
  const dec = c.decoded;
  out.decoded = [dec.width, dec.height];
  t0 = performance.now();
  c.run({}, { mode: 'braille', cols: 60, rows: 40 });   // first run also builds the summed-area table
  out.firstRun = performance.now() - t0;
  const cases = [
    { name: 'braille60x40', o: { mode: 'braille', cols: 60, rows: 40 } },
    { name: 'ascii60x28', o: { mode: 'ascii', cols: 60, rows: 28 } },
    { name: 'blocksColour60x30', o: { mode: 'blocks', cols: 60, rows: 30, color: true } },
    { name: 'braille200x110', o: { mode: 'braille', cols: 200, rows: 110 } },
  ];
  for (const { name, o } of cases) {
    const fresh = [], tone = [], samp = [], tn = [], enc = [];
    const [W, H] = sampleSize({ blocks: 'quad', ...o });
    for (let i = 0; i < N + 2; i++) {
      const crop = { x: 0.5 + i * 1e-4, y: 0.5, zoom: 1.1, rotation: i % 2 ? 7 : 0 };
      let t = performance.now();
      c.run(crop, o);
      const f = performance.now() - t;
      t = performance.now();
      c.run(crop, { ...o, tone: { brightness: 0.01 * (i + 1) } });
      const tc = performance.now() - t;
      // the same fresh crop split into its stages
      t = performance.now();
      const img = sampleImage(dec, { ...crop, y: 0.5001 }, W, H, { color: !!o.color });
      const ts = performance.now() - t;
      t = performance.now();
      const L = toneGrid(img, {}, { target: o.color ? null : 0.4 });
      const tt = performance.now() - t;
      t = performance.now();
      if (o.mode === 'braille') encodeBraille(ditherDots(L, W, H, 'atkinson', { edge: L.edge }), W, H);
      else if (o.mode === 'ascii') asciiCells(L, W, H, o.cols, o.rows, { method: 'shape' });
      const te = performance.now() - t;
      if (i >= 2) { fresh.push(f); tone.push(tc); samp.push(ts); tn.push(tt); enc.push(te); }
    }
    out[name] = { WH: [W, H], fresh: +med(fresh).toFixed(1), freshMax: +Math.max(...fresh).toFixed(1), tone: +med(tone).toFixed(1),
      sample: +med(samp).toFixed(1), toneGrid: +med(tn).toFixed(1), encode: +med(enc).toFixed(1) };
  }
  out.decode = +out.decode.toFixed(1); out.firstRun = +out.firstRun.toFixed(1);
  return { ok: true, sheet: 'perf', ...out };
}

try {
  const fn = { compare: sheetCompare, perf: sheetPerf, ascii: sheetAscii }[SHEET];
  if (!fn) throw new Error('unknown sheet ' + SHEET);
  const res = await fn();
  log(JSON.stringify(res, null, 1));
  window.__done = res;
} catch (e) {
  log('ERROR ' + (e.stack || e.message));
  window.__done = { ok: false, error: e.message };
}

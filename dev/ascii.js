// Visual check for js/ascii.js: the Hopper photo, the four samples, a dark photo and a synthetic
// test card at 32 and 60 columns, drawn with raster.js drawGrid in the font the glyph vectors were
// made from. Each source gets [toned input | shape on plain levels | shape on the converter's tone]:
//   levels = a plain grayscale resample at the matcher's own raster (8 x 17 per cell), 1 / 99 %
//            levels: what the matcher does with a neutral input;
//   tone   = exactly what the app shows: createConverter().run(mode 'ascii'), whose lightness is
//            tone.js toneGrid on the converter's 4 x 8 per cell sample (recomputed here from the
//            same exports so it can be drawn and dumped; the page checks that both give the same text).
// Saves shots/<tag>_<cols>.png (overview) and shots/<tag>_<id>_<cols>.png (one source, big).
// Query: tag=ascii3, contrast=1, ramp=1 (add a ramp column on the tone input), save=0,
//        only=hopper,card, dump=1 (also save the lightness grids as raw float32 for node tuning:
//        shots/<tag>_L_<id>_<cols>_<levels|tone>_<W>x<H>.f32), tune={json} (matcher overrides).
import { asciiCells, ASCII_SUB, CELL_ASPECT, SHAPES_CURRENT } from '../js/ascii.js';
import { FONT } from '../js/shape-vectors.js';
import { drawGrid } from '../js/raster.js';
import { createConverter, sampleSize, INK_TARGET } from '../js/convert.js';
import { sampleImage, toneGrid, TONE_DEFAULTS } from '../js/tone.js';

const q = new URLSearchParams(location.search);
const contrast = q.has('contrast') ? +q.get('contrast') : 1;
const TAG = q.get('tag') || 'ascii3';
const WITH_RAMP = q.get('ramp') === '1';
const DUMP = q.get('dump') === '1';
const TUNE = q.get('tune') ? JSON.parse(q.get('tune')) : null;   // tuning overrides (exploration only)
const FAMILY = (FONT && FONT.family) || 'monospace';
const [SX, SY] = ASCII_SUB;
const PAPER = '#fbfaf6', INK = '#17171a';

async function loadBitmap(url) {
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

function testCard(size = 720) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
  g.strokeStyle = '#000'; g.fillStyle = '#000'; g.lineCap = 'butt';
  const u = size / 100;
  g.lineWidth = 0.6 * u;   // about one glyph stroke at 32-60 columns
  g.beginPath(); g.arc(50 * u, 50 * u, 30 * u, 0, Math.PI * 2); g.stroke();       // circle outline
  g.beginPath(); g.moveTo(4 * u, 96 * u); g.lineTo(34 * u, 66 * u); g.stroke();  // 45 deg '/'
  g.beginPath(); g.moveTo(66 * u, 66 * u); g.lineTo(96 * u, 96 * u); g.stroke(); // 45 deg '\'
  g.beginPath(); g.moveTo(8 * u, 4 * u); g.lineTo(8 * u, 40 * u); g.stroke();    // vertical '|'
  g.beginPath(); g.moveTo(60 * u, 10 * u); g.lineTo(96 * u, 10 * u); g.stroke(); // horizontal
  g.lineWidth = 2 * u;
  g.beginPath(); g.moveTo(60 * u, 26 * u); g.lineTo(96 * u, 26 * u); g.stroke(); // thick horizontal
  g.lineWidth = 0.6 * u;
  g.beginPath(); g.moveTo(16 * u, 4 * u); g.lineTo(34 * u, 40 * u); g.stroke();  // steep diagonal
  g.beginPath(); g.arc(50 * u, 50 * u, 9 * u, 0, Math.PI * 2); g.fill();         // filled disc
  g.fillStyle = '#e4e4e4'; g.fillRect(62 * u, 34 * u, 34 * u, 10 * u);            // light grey patch
  g.fillStyle = '#000';
  g.font = `bold ${15 * u}px Arial, sans-serif`; g.textAlign = 'center';
  g.fillText('ASCII', 50 * u, 88 * u);                                            // text-like shapes
  const grad = g.createLinearGradient(40 * u, 0, 96 * u, 0);
  grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
  g.fillStyle = grad; g.fillRect(40 * u, 94 * u, 56 * u, 5 * u);                   // tone ramp
  return c;
}

// Plain levels: square centre crop -> W x H lightness at the matcher's raster, over white,
// 1 / 99 % levels, no other tone work.
function levelsL(src, cols, rows) {
  const W = cols * SX, H = rows * SY;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.imageSmoothingQuality = 'high';
  const side = Math.min(src.width, src.height);
  g.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0; i < L.length; i++) L[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  const s = Float32Array.from(L).sort();
  const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.floor(s.length * 0.99)];
  const span = Math.max(0.05, hi - lo);
  for (let i = 0; i < L.length; i++) L[i] = Math.min(1, Math.max(0, (L[i] - lo) / span));
  return { L, W, H };
}

// The converter's lightness for ASCII: its own sample size and toneGrid call (convert.js run()).
function toneL(conv, cols, rows) {
  const [W, H] = sampleSize({ mode: 'ascii', cols, rows });
  const img = sampleImage(conv.decoded, {}, W, H);
  return { L: toneGrid(img, { ...TONE_DEFAULTS }, { target: INK_TARGET.ascii, boost: 0 }), W, H };
}

function toLines(cp, cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r++) out.push(String.fromCodePoint(...cp.subarray(r * cols, (r + 1) * cols)));
  return out;
}

function drawGray(g, L, W, H, x, y, w, h) {
  const img = new ImageData(W, H);
  for (let i = 0; i < L.length; i++) {
    const v = L[i] * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').putImageData(img, 0, 0);
  g.drawImage(c, x, y, w, h);
}

async function save(name, canvas) {
  if (q.get('save') === '0') return null;
  const r = await fetch('/__shot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data: canvas.toDataURL('image/png') }),
  });
  return (await r.json()).file;
}

async function dump(name, L) {
  await fetch('/__file?name=' + encodeURIComponent(name), { method: 'POST', body: new Uint8Array(L.buffer, L.byteOffset, L.byteLength) });
}

// One block per source: [tone input | shape on levels | shape on tone (| ramp on tone)].
async function block(src, conv, id, cols, cellW) {
  const rows = Math.max(1, Math.round(cols * CELL_ASPECT));
  const cellH = cellW / CELL_ASPECT;
  const artW = cols * cellW, artH = rows * cellH;
  const PAD = 12, LABEL = 20;
  const lv = levelsL(src, cols, rows), tn = toneL(conv, cols, rows);
  if (DUMP) {
    await dump(`${TAG}_L_${id}_${cols}_levels_${lv.W}x${lv.H}.f32`, lv.L);
    await dump(`${TAG}_L_${id}_${cols}_tone_${tn.W}x${tn.H}.f32`, tn.L);
  }
  const cols3 = [['levels', lv, 'shape'], ['tone', tn, 'shape']];
  if (WITH_RAMP) cols3.push(['tone', tn, 'ramp']);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(artH + PAD + cols3.length * (artW + PAD));
  canvas.height = Math.ceil(artH + LABEL);
  const g = canvas.getContext('2d');
  g.fillStyle = PAPER; g.fillRect(0, 0, canvas.width, canvas.height);
  drawGray(g, tn.L, tn.W, tn.H, 0, LABEL, artH, artH);
  g.fillStyle = '#6b6a66'; g.font = '13px system-ui';
  g.fillText(`${id} (tone input)`, 0, LABEL - 6);
  const res = {};
  cols3.forEach(([kind, { L, W, H }, method], m) => {
    const t0 = performance.now();
    const cp = asciiCells(L, W, H, cols, rows, { method, contrast, tune: TUNE });
    const ms = performance.now() - t0;
    const x = artH + PAD + m * (artW + PAD);
    drawGrid(g, { mode: 'ascii', cols, rows, cp }, { x, y: LABEL, cellW, cellH, ink: INK, paper: '#fff', font: `"${FAMILY}"` });
    g.fillStyle = '#6b6a66'; g.font = '13px system-ui';
    g.fillText(`${id}  ${kind}  ${method}  ${cols} x ${rows}  ${ms.toFixed(1)} ms`, x, LABEL - 6);
    res[kind + (method === 'ramp' ? 'Ramp' : '')] = { ms: +ms.toFixed(2), lines: toLines(cp, cols, rows), cp };
  });
  // the app's own path must give the same text as the tone column
  const grid = conv.run({}, { mode: 'ascii', cols, rows, ascii: 'shape', asciiContrast: contrast });
  const same = grid.cp.length === res.tone.cp.length && grid.cp.every((v, i) => v === res.tone.cp[i]);
  return { canvas, res, same };
}

// Overview: blocks in a grid of `per` columns.
async function sheet(name, blocks, per) {
  const PAD = 16;
  const bw = Math.max(...blocks.map(b => b.canvas.width)), bh = Math.max(...blocks.map(b => b.canvas.height));
  const nr = Math.ceil(blocks.length / per);
  const canvas = document.createElement('canvas');
  canvas.width = PAD + per * (bw + PAD);
  canvas.height = PAD + nr * (bh + PAD);
  const g = canvas.getContext('2d');
  g.fillStyle = PAPER; g.fillRect(0, 0, canvas.width, canvas.height);
  blocks.forEach((b, i) => g.drawImage(b.canvas, PAD + (i % per) * (bw + PAD), PAD + Math.floor(i / per) * (bh + PAD)));
  document.getElementById('out').appendChild(canvas);
  return save(name, canvas);
}

try {
  await document.fonts.load(`16px "${FAMILY}"`);
  const list = [
    ['hopper', '/tests/fixtures/photo_hopper.jpg'],
    ['portrait', '/img/samples/portrait.jpg'],
    ['pet', '/img/samples/pet.jpg'],
    ['landmark', '/img/samples/landmark.jpg'],
    ['logo', '/img/samples/logo.jpg'],
    ['dark', '/tests/fixtures/dark.jpg'],
  ];
  const only = q.get('only') ? q.get('only').split(',') : null;
  const sources = [];
  for (const [id, url] of list) if (!only || only.includes(id)) sources.push({ id, src: await loadBitmap(url) });
  if (!only || only.includes('card')) sources.push({ id: 'card', src: testCard() });
  for (const s of sources) { s.conv = createConverter(); s.conv.setSource(s.src); }
  // Warm up (JIT) so the timings below are steady-state.
  for (let i = 0; i < 5; i++) {
    const { L, W, H } = levelsL(sources[0].src, 60, 28);
    asciiCells(L, W, H, 60, 28, { method: 'shape' });
  }
  const files = [], text = {}, ms = {}, mismatch = [];
  for (const [cols, cellW, per] of [[32, 12, 2], [60, 9, 1]]) {
    const blocks = [];
    for (const { id, src, conv } of sources) {
      const b = await block(src, conv, id, cols, cellW);
      blocks.push(b);
      if (!b.same) mismatch.push(`${id}${cols}`);
      text[`${id}${cols}`] = b.res.tone.lines;
      ms[`${id}${cols}`] = [b.res.levels.ms, b.res.tone.ms];
      files.push(await save(`${TAG}_${id}_${cols}`, b.canvas));
    }
    files.push(await sheet(`${TAG}_${cols}`, blocks, per));
  }
  window.__done = { ok: mismatch.length === 0, font: FAMILY, shapesCurrent: SHAPES_CURRENT, contrast, mismatch, files, ms, text };
} catch (e) {
  window.__done = { ok: false, error: String(e && e.stack || e) };
}

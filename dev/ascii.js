// Visual check for js/ascii.js: fixtures + a synthetic test card, shape vs ramp, drawn in the font
// the glyph vectors were made from, saved as shots/ascii_*.png. The lightness grid here is a plain
// grayscale resample with 1% / 99% levels (the real converter tones it; this page only needs a
// representative input).
import { asciiCells, ASCII_SUB, CELL_ASPECT, SHAPES_CURRENT } from '../js/ascii.js';
import { FONT } from '../js/shape-vectors.js';

const q = new URLSearchParams(location.search);
const contrast = q.has('contrast') ? +q.get('contrast') : 1;
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
  g.lineWidth = 0.4 * u;   // about one glyph stroke at 32-60 columns
  g.beginPath(); g.arc(50 * u, 50 * u, 30 * u, 0, Math.PI * 2); g.stroke();       // circle outline
  g.beginPath(); g.moveTo(4 * u, 96 * u); g.lineTo(34 * u, 66 * u); g.stroke();  // 45 deg '/'
  g.beginPath(); g.moveTo(66 * u, 66 * u); g.lineTo(96 * u, 96 * u); g.stroke(); // 45 deg '\'
  g.beginPath(); g.moveTo(8 * u, 4 * u); g.lineTo(8 * u, 40 * u); g.stroke();    // vertical '|'
  g.beginPath(); g.moveTo(60 * u, 10 * u); g.lineTo(96 * u, 10 * u); g.stroke(); // horizontal
  g.beginPath(); g.moveTo(60 * u, 26 * u); g.lineTo(96 * u, 26 * u); g.stroke();
  g.beginPath(); g.moveTo(16 * u, 4 * u); g.lineTo(34 * u, 40 * u); g.stroke();  // steep diagonal
  g.beginPath(); g.arc(50 * u, 50 * u, 9 * u, 0, Math.PI * 2); g.fill();         // filled disc
  g.font = `bold ${15 * u}px Arial, sans-serif`; g.textAlign = 'center';
  g.fillText('ASCII', 50 * u, 88 * u);                                            // text-like shapes
  const grad = g.createLinearGradient(40 * u, 0, 96 * u, 0);
  grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
  g.fillStyle = grad; g.fillRect(40 * u, 94 * u, 56 * u, 5 * u);                   // tone ramp
  return c;
}

// Square centre crop -> W x H lightness (sample pixels are not square: the crop maps onto the
// cols x rows cell grid, as the real sampler does).
function lightness(src, cols, rows) {
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

function toLines(cp, cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r++) out.push(String.fromCodePoint(...cp.subarray(r * cols, (r + 1) * cols)));
  return out;
}

function drawText(g, lines, x, y, cellW) {
  const size = cellW / FONT.advanceEm, lineH = cellW / CELL_ASPECT;
  const base = (lineH - (FONT.ascentEm + FONT.descentEm) * size) / 2 + FONT.ascentEm * size;
  g.font = `${size}px "${FAMILY}"`;
  g.fillStyle = INK; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  lines.forEach((line, r) => {
    for (let i = 0; i < line.length; i++) g.fillText(line[i], x + i * cellW, y + r * lineH + base);
  });
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

// One sheet: a row per source, [gray input | shape | ramp].
async function sheet(name, sources, cols, cellW) {
  const rows = Math.max(1, Math.round(cols * CELL_ASPECT));
  const artW = cols * cellW, artH = rows * cellW / CELL_ASPECT;
  const PAD = 16, LABEL = 22;
  const canvas = document.createElement('canvas');
  canvas.width = PAD + (artH + PAD) + 2 * (artW + PAD);
  canvas.height = PAD + sources.length * (artH + LABEL + PAD);
  const g = canvas.getContext('2d');
  g.fillStyle = PAPER; g.fillRect(0, 0, canvas.width, canvas.height);
  const report = {};
  sources.forEach(({ id, src }, i) => {
    const y = PAD + i * (artH + LABEL + PAD) + LABEL;
    const { L, W, H } = lightness(src, cols, rows);
    drawGray(g, L, W, H, PAD, y, artH, artH);
    const res = {};
    ['shape', 'ramp'].forEach((method, m) => {
      const t0 = performance.now();
      const cp = asciiCells(L, W, H, cols, rows, { method, contrast });
      const ms = performance.now() - t0;
      const lines = toLines(cp, cols, rows);
      const x = PAD + artH + PAD + m * (artW + PAD);
      g.fillStyle = '#fff'; g.fillRect(x, y, artW, artH);
      drawText(g, lines, x, y, cellW);
      g.fillStyle = '#6b6a66'; g.font = '13px system-ui';
      g.fillText(`${id}  ${method}  ${cols} x ${rows}  ${ms.toFixed(1)} ms`, x, y - 6);
      res[method] = { ms: +ms.toFixed(2), lines };
    });
    g.fillStyle = '#6b6a66'; g.font = '13px system-ui';
    g.fillText(`${id} input`, PAD, y - 6);
    report[id] = res;
  });
  document.getElementById('out').appendChild(canvas);
  return { file: await save(name, canvas), report };
}

try {
  await document.fonts.load(`16px "${FAMILY}"`);
  const fx = ['portrait_exif6.jpg', 'logo_alpha.png', 'dark.jpg'];
  const sources = [];
  for (const f of fx) sources.push({ id: f.replace(/\..*/, ''), src: await loadBitmap('/tests/fixtures/' + f) });
  sources.push({ id: 'card', src: testCard() });
  // Warm up (JIT) so the timings below are steady-state.
  for (let i = 0; i < 5; i++) {
    const { L, W, H } = lightness(sources[0].src, 60, 28);
    asciiCells(L, W, H, 60, 28, { method: 'shape' });
  }
  const s32 = await sheet('ascii_32', sources, 32, 12);
  const s60 = await sheet('ascii_60', sources, 60, 9);
  const card = await sheet('ascii_card', [sources[3]], 90, 8);
  const pick = (s, id) => s.report[id].shape.lines;
  window.__done = {
    ok: true, font: FAMILY, shapesCurrent: SHAPES_CURRENT, contrast,
    files: [s32.file, s60.file, card.file],
    ms: Object.fromEntries(Object.entries(s60.report).map(([k, v]) => [k, v.shape.ms])),
    portrait32: pick(s32, 'portrait_exif6'),
    card60: pick(s60, 'card'),
  };
} catch (e) {
  window.__done = { ok: false, error: String(e && e.stack || e) };
}

// Converter visual check: each fixture as Braille (4 dithers at 40 and 28 cols), colour and mono
// blocks, inverted Braille and the X size (16 cols). Braille is drawn as geometric dots, never with a
// font (Windows' Segoe UI Symbol draws the blank U+2800 narrower than the other patterns).
import { createConverter, DITHERS } from '../js/convert.js';
import { QUAD_CP } from '../js/blocks.js';

const q = new URLSearchParams(location.search);
const FIXTURES = [
  { file: 'portrait_exif6.jpg', crop: { x: 0.5, y: 0.4, zoom: 1.25, rotation: 0 } },
  { file: 'dark.jpg', crop: {} },
  { file: 'logo_alpha.png', crop: {} },
  { file: 'flat.png', crop: {} },
].filter(f => !q.get('fx') || f.file === q.get('fx'));
const SAVE = q.get('save') !== '0';
const ENGINE = /Firefox/.test(navigator.userAgent) ? 'ff' : /Chrome/.test(navigator.userAgent) ? 'cr' : 'wk';
const P = +(q.get('pw') || 300);   // panel width in px
const INK = '#17171a', PAPER = '#ffffff', DARK = '#1b1c20', LIGHT_INK = '#e8e6e1';
const logEl = document.getElementById('log');
const log = s => { logEl.textContent += s + '\n'; };

async function loadFixture(file) {
  // an <img> applies EXIF orientation in every engine; bake it into a canvas as the source
  const img = new Image();
  img.src = '/tests/fixtures/' + file;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

const MASK = new Map(QUAD_CP.map((cp, m) => [cp, m]));
const hex = v => '#' + v.toString(16).padStart(6, '0');

function drawBraille(ctx, g, x, y, w, { ink = INK, paper = PAPER, dotR = 0.36 } = {}) {
  const cw = w / g.cols, ch = cw / 0.55;
  ctx.fillStyle = paper; ctx.fillRect(x, y, w, g.rows * ch);
  ctx.fillStyle = ink;
  const px = cw / 2, py = ch / 4, r = dotR * Math.min(px, py);
  ctx.beginPath();
  for (let row = 0; row < g.rows; row++) for (let col = 0; col < g.cols; col++) {
    const bits = g.cp[row * g.cols + col] - 0x2800;
    for (let k = 0; k < 8; k++) {
      if (!(bits >> k & 1)) continue;
      // bits 0-2 left column rows 0-2, 3-5 right column rows 0-2, 6 / 7 bottom row left / right
      const dx = k < 3 ? 0 : k < 6 ? 1 : k - 6;
      const dy = k < 3 ? k : k < 6 ? k - 3 : 3;
      const cx = x + col * cw + (dx + 0.5) * px, cy = y + row * ch + (dy + 0.5) * py;
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  return g.rows * ch;
}

function drawBlocks(ctx, g, x, y, w) {
  const cw = w / g.cols, ch = cw / 0.5;
  for (let row = 0; row < g.rows; row++) for (let col = 0; col < g.cols; col++) {
    const i = row * g.cols + col;
    const m = MASK.get(g.cp[i]) ?? 0;
    const fg = g.fg ? hex(g.fg[i]) : INK, bg = g.bg ? hex(g.bg[i]) : PAPER;
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = (m >> k & 1) ? fg : bg;
      const qx = x + col * cw + (k & 1) * cw / 2, qy = y + row * ch + (k >> 1) * ch / 2;
      // overlap by a hair so anti-aliasing does not draw seams
      ctx.fillRect(Math.floor(qx), Math.floor(qy), Math.ceil(cw / 2) + 1, Math.ceil(ch / 2) + 1);
    }
  }
  return g.rows * ch;
}

function drawSource(ctx, src, crop, x, y, w) {
  const c = { x: 0.5, y: 0.5, zoom: 1, rotation: 0, ...crop };
  const side = Math.min(src.width, src.height) / c.zoom;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, w); ctx.clip();
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, w);
  ctx.translate(x + w / 2, y + w / 2);
  ctx.scale(w / side, w / side);
  ctx.rotate(c.rotation * Math.PI / 180);
  ctx.drawImage(src, -c.x * src.width, -c.y * src.height);
  ctx.restore();
  return w;
}

const rowsFor = (cols, a) => Math.max(1, Math.round(cols * a));

async function sheet(fx, conv) {
  const src = await loadFixture(fx.file);
  conv.setSource(src);
  const gap = 14, lab = 18;
  const cols5 = 5;
  const canvas = document.createElement('canvas');
  canvas.width = cols5 * (P + gap) + gap;
  canvas.height = 3 * (P + lab + gap) + gap + 24;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f1efea'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#17171a'; ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillText(`${fx.file}  ·  ${ENGINE}  ·  crop ${JSON.stringify(fx.crop)}`, gap, 18);
  const cell = (ci, ri) => [gap + ci * (P + gap), 24 + gap + ri * (P + lab + gap)];
  const label = (ci, ri, s) => {
    const [x, y] = cell(ci, ri);
    ctx.fillStyle = '#55545a'; ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(s, x, y + 12);
  };
  const info = [];
  [40, 28].forEach((cols, ri) => {
    DITHERS.forEach((d, ci) => {
      const g = conv.run(fx.crop, { mode: 'braille', cols, rows: rowsFor(cols, 0.55), dither: d });
      const [x, y] = cell(ci, ri);
      label(ci, ri, `braille ${d} ${cols}x${g.rows}  ink ${g.ink.toFixed(2)}`);
      drawBraille(ctx, g, x, y + lab, P);
      if (d === 'atkinson') info.push({ cols, ink: +g.ink.toFixed(3), gamma: +g.tone.gamma.toFixed(2), lo: g.tone.lo, hi: g.tone.hi });
    });
  });
  // row 0 col 4: source crop; row 1 col 4: X size (16 cols)
  label(4, 0, 'source crop');
  drawSource(ctx, src, fx.crop, cell(4, 0)[0], cell(4, 0)[1] + lab, P);
  const gx = conv.run(fx.crop, { mode: 'braille', cols: 16, rows: 8, dither: 'atkinson' });
  label(4, 1, `braille atkinson 16x8 (X)  ink ${gx.ink.toFixed(2)}`);
  drawBraille(ctx, gx, cell(4, 1)[0], cell(4, 1)[1] + lab, P);
  // row 2: colour quad, colour half, mono quad, inverted Braille 40 and 28 on dark paper
  const gq = conv.run(fx.crop, { mode: 'blocks', cols: 40, rows: 20, blocks: 'quad', color: true });
  label(0, 2, 'blocks quad colour 40x20');
  drawBlocks(ctx, gq, cell(0, 2)[0], cell(0, 2)[1] + lab, P);
  const gh = conv.run(fx.crop, { mode: 'blocks', cols: 40, rows: 20, blocks: 'half', color: true });
  label(1, 2, 'blocks half colour 40x20');
  drawBlocks(ctx, gh, cell(1, 2)[0], cell(1, 2)[1] + lab, P);
  const gm = conv.run(fx.crop, { mode: 'blocks', cols: 40, rows: 20, blocks: 'quad', color: false });
  label(2, 2, `blocks quad mono 40x20  ink ${gm.ink.toFixed(2)}`);
  drawBlocks(ctx, gm, cell(2, 2)[0], cell(2, 2)[1] + lab, P);
  [40, 28].forEach((cols, k) => {
    const gi = conv.run(fx.crop, { mode: 'braille', cols, rows: rowsFor(cols, 0.55), tone: { invert: true } });
    label(3 + k, 2, `braille inverted ${cols}  ink ${gi.ink.toFixed(2)}`);
    drawBraille(ctx, gi, cell(3 + k, 2)[0], cell(3 + k, 2)[1] + lab, P, { ink: LIGHT_INK, paper: DARK });
  });
  document.getElementById('out').appendChild(canvas);
  const name = `conv_${fx.file.replace(/\..*$/, '')}_${ENGINE}`;
  if (SAVE) {
    await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: canvas.toDataURL('image/png') }) });
  }
  return { file: fx.file, shot: name, src: [src.width, src.height], info };
}

function perf(conv, src) {
  conv.setSource(src);
  const o = { mode: 'braille', cols: 60, rows: 40 };
  conv.run({ x: 0.3 }, o); conv.run({ x: 0.3 }, { ...o, tone: { contrast: 0.9 } });   // warm up
  const fresh = [], tone = [], dith = [];
  for (let k = 0; k < 15; k++) {
    const crop = { x: 0.45 + k * 0.005, y: 0.45, zoom: 1.1 };
    let t0 = performance.now(); conv.run(crop, o); fresh.push(performance.now() - t0);
    t0 = performance.now(); conv.run(crop, { ...o, tone: { contrast: 0.05 * k + 0.01 } }); tone.push(performance.now() - t0);
    t0 = performance.now(); conv.run(crop, { ...o, tone: { contrast: 0.05 * k + 0.01 }, dither: 'floyd' }); dith.push(performance.now() - t0);
  }
  const med = a => +a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(2);
  const max = a => +Math.max(...a).toFixed(2);
  return { fresh: med(fresh), freshMax: max(fresh), tone: med(tone), toneMax: max(tone), dither: med(dith) };
}

(async () => {
  try {
    const conv = createConverter();
    const sheets = [];
    for (const fx of FIXTURES) sheets.push(await sheet(fx, conv));
    const timing = perf(conv, await loadFixture('portrait_exif6.jpg'));
    log(JSON.stringify({ sheets, timing }, null, 1));
    window.__done = { ok: true, engine: ENGINE, timing, sheets };
  } catch (e) {
    log(String(e.stack || e));
    window.__done = { ok: false, error: String(e.stack || e) };
  }
})();

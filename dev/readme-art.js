// README images from the real modules: every dot, letter and block below is Typist output for the
// showcase artwork (img/showcase/halo.jpg), through createConverter().run exactly as the app calls it.
//   node tests/shoot.mjs "/dev/readme-art.html?shot=banner"   -> shots/readme_banner.png
//   ?shot=banner|looks|styles|phones|chats|desktop|paste|explore|all   ;look=texture   ;cols=64 (banner)
//   ;dcols=46 ;acols=56 ;alook=poster ;slook=texture (styles)   ;tag=_v2   (docs/ steps: readme-art.html)
// phones / chats / desktop compose the app screenshots shots/readme_app_*.png (made first with
// node tests/readme-app-shot.mjs).
// The pasted text is monochrome (it takes the colour of the app it lands in); where dots or letters
// are coloured here, the colour is the photo's own colour at that dot, sampled from the image.
import { createConverter, gridLines } from '../js/convert.js';
import { LOOKS } from '../js/tone.js';
import { drawGrid, brailleGeometry, BRAILLE_SLOTS } from '../js/raster.js';
import { autoFit, rowsFor, cellAspect, formatFor } from '../js/targets.js';

const q = new URLSearchParams(location.search);
const SHOT = q.get('shot') || 'all';
const TAG = (q.get('tag') || '').replace(/[^a-z0-9_-]/gi, '');
const SRC = '../img/showcase/halo.jpg';

// the artwork's own black, so the photo's edges vanish into the page
const BG = '#141412';
const INK = '#ece8df';          // light dots / type on dark
const MUTED = '#8e8a7f';
const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = 'Geist, system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, Consolas, monospace';

// square crops (the app's crop is square): the whole figure with its halo, and a closer one for
// phone-size grids where the hood and the halo have to carry the picture
const CROP = { x: 0.5, y: 0.45, zoom: 1, rotation: 0 };
const CROP_CLOSE = { x: 0.52, y: 0.4, zoom: +(q.get('zoom') || 1.18), rotation: 0 };

async function load(url) {
  return createImageBitmap(await (await fetch(url)).blob());
}

function canvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

async function save(name, cv) {
  const resp = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: 'readme_' + name + TAG, data: cv.toDataURL('image/png') }) });
  if (!resp.ok) throw new Error('save failed ' + name);
  document.body.appendChild(cv);
  return { name: 'readme_' + name + TAG, w: cv.width, h: cv.height };
}

function cropRect(bmp, crop) {
  const side = Math.min(bmp.width, bmp.height) / crop.zoom;
  return { sx: crop.x * bmp.width - side / 2, sy: crop.y * bmp.height - side / 2, side };
}

/** The photo's colour per sample of a W x H grid over the square crop (box average). */
function colourGrid(bmp, crop, W, H) {
  const { sx, sy, side } = cropRect(bmp, crop);
  const n = Math.round(side);
  const c = canvas(n, n).getContext('2d', { willReadFrequently: true });
  c.drawImage(bmp, sx, sy, side, side, 0, 0, n, n);
  const px = c.getImageData(0, 0, n, n).data;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * n / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * n / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * n / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * n / W));
      let r = 0, g = 0, b = 0, k = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * n + xx) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; k++;
        }
      }
      const o = (y * W + x) * 3;
      out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k;
    }
  }
  return out;
}

// A dot is tiny: at the photo's own lightness a dark-robe dot would vanish. Keep the hue, lift the
// value so the brightest channel reaches `floor` (never darker than the photo).
function lift(r, g, b, floor = 0.8, cap = 3.4) {
  const m = Math.max(r, g, b, 1) / 255;
  const k = Math.min(cap, Math.max(1, floor / m));
  return [Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)];
}

/**
 * Braille grid drawn as dots in the photo's colour. `alpha(u, v)` (u, v in 0..1 over the art) fades
 * dots in and out (the banner's photo-to-text flow).
 */
function drawColourBraille(ctx, grid, colours, { x, y, cellW, cellH, dotR = 0.34, alpha = null, floor = 0.8 }) {
  const { cols, rows, cp } = grid;
  const W = 2 * cols, H = 4 * rows;
  const { r, centers } = brailleGeometry(cellW, cellH, dotR);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const bits = cp[row * cols + col] - 0x2800;
      if (bits <= 0) continue;
      for (let k = 0; k < 8; k++) {
        if (!((bits >> k) & 1)) continue;
        const sx = 2 * col + BRAILLE_SLOTS[k][0], sy = 4 * row + BRAILLE_SLOTS[k][1];
        const cx = x + col * cellW + centers[k][0], cy = y + row * cellH + centers[k][1];
        const a = alpha ? alpha((cx - x) / (cols * cellW), (cy - y) / (rows * cellH)) : 1;
        if (a <= 0.01) continue;
        const o = (sy * W + sx) * 3;
        const [R, G, B] = lift(colours[o], colours[o + 1], colours[o + 2], floor);
        ctx.fillStyle = `rgba(${R | 0},${G | 0},${B | 0},${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** ASCII grid in Geist Mono, each glyph in the photo's colour at its cell. */
function drawColourAscii(ctx, grid, colours, { x, y, cellW, cellH, floor = 0.78 }) {
  const { cols, rows, cp } = grid;
  ctx.font = `100px ${MONO}`;
  const adv = ctx.measureText('M').width / 100 || 0.6;
  const px = Math.min(cellW / adv, cellH / 1.05);
  ctx.font = `${px}px ${MONO}`;
  const mm = ctx.measureText('Mg');
  const base = (cellH + mm.fontBoundingBoxAscent - mm.fontBoundingBoxDescent) / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const v = cp[row * cols + col];
      if (v === 0x20) continue;
      const o = (row * cols + col) * 3;
      const [R, G, B] = lift(colours[o], colours[o + 1], colours[o + 2], floor);
      ctx.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
      ctx.fillText(String.fromCodePoint(v), x + (col + 0.5) * cellW, y + row * cellH + base);
    }
  }
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

const smooth = (a, b, t) => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };

// ------------------------------------------------------------------------------------ banner
async function banner(bmp) {
  const Wc = 1760, Hc = 800, S = 800, X0 = +(q.get('x0') || 40), Y0 = 0;
  // Texture (CLAHE) keeps the robe's weave; Photo drops most of it on this dark picture
  const look = q.get('look') || 'texture';
  const cols = +(q.get('cols') || 64), rows = rowsFor(cols, 0.55);
  const cv = canvas(Wc, Hc), ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, Wc, Hc);

  const conv = createConverter();
  conv.setSource(bmp);
  const g = conv.run(CROP, { mode: 'braille', cols, rows, dither: 'atkinson', tone: { look, invert: true } });
  const colours = colourGrid(bmp, CROP, 2 * cols, 4 * rows);

  // the boundary leans a little and breathes, so the photo seems to come apart into dots rather
  // than being cut by a ruler
  const edge = v => 0.44 + 0.06 * (v - 0.5) + 0.018 * Math.sin(v * 7.1);
  const band = 0.16;
  // ...and the smoke thins out before the art's right edge instead of stopping at a straight line
  const dotsAlpha = (u, v) => smooth(edge(v) - band / 2, edge(v) + band / 2, u) * (1 - smooth(0.86, 1.0, u));

  // photo, masked by the same boundary (row by row)
  const { sx, sy, side } = cropRect(bmp, CROP);
  const ph = canvas(S, S), p = ph.getContext('2d');
  p.drawImage(bmp, sx, sy, side, side, 0, 0, S, S);
  const mask = canvas(S, S), m = mask.getContext('2d');
  for (let yy = 0; yy < S; yy += 2) {
    const e = edge(yy / S);
    const gr = m.createLinearGradient((e - band / 2 - 0.06) * S, 0, (e + band / 2 - 0.04) * S, 0);
    gr.addColorStop(0, 'rgba(0,0,0,1)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = gr;
    m.fillRect(0, yy, S, 2);
  }
  p.globalCompositeOperation = 'destination-in';
  p.drawImage(mask, 0, 0);
  ctx.drawImage(ph, X0, Y0);

  drawColourBraille(ctx, g, colours, { x: X0, y: Y0, cellW: S / cols, cellH: S / rows, alpha: dotsAlpha, floor: 0.82 });

  // soft falloff at the top and bottom edge of the figure so nothing reads as a pasted rectangle
  const fade = (y0, y1) => {
    const gr = ctx.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, 'rgba(20,20,18,0)');
    gr.addColorStop(1, 'rgba(20,20,18,1)');
    ctx.fillStyle = gr;
    ctx.fillRect(X0 - 2, Math.min(y0, y1), S + 4, Math.abs(y1 - y0));
  };
  fade(Hc - 90, Hc);

  // wordmark and line
  const TX = +(q.get('tx') || 1000);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = `italic 232px ${SERIF}`;
  ctx.fillText('Typist', TX - 8, 392);
  ctx.font = `68px ${SERIF}`;
  const a = 'Any photo. ';
  ctx.fillText(a, TX, 494);
  const aw = ctx.measureText(a).width;
  ctx.font = `italic 68px ${SERIF}`;
  ctx.fillStyle = '#e4cf4a';
  ctx.fillText('In text.', TX + aw, 494);
  ctx.fillStyle = MUTED;
  ctx.font = `400 27px ${SANS}`;
  ctx.fillText('Text art you can paste into Instagram, X and Telegram.', TX + 2, 572);
  ctx.fillText('Runs in your browser. Your photo is never uploaded.', TX + 2, 614);
  return save('banner', cv);
}

// ------------------------------------------------------------------------------------ looks
async function looks(bmp) {
  const fit = autoFit('ig', 'braille');                  // what an Instagram comment holds on a 390 px phone
  const { cols, rows } = fit;
  const M = 64, GAP = 36, N = LOOKS.length, Wc = 1760;
  const tile = (Wc - 2 * M - (N - 1) * GAP) / N;
  const pad = 20, cellW = (tile - 2 * pad) / cols, cellH = cellW / cellAspect('ig', 'braille');
  const artH = rows * cellH;
  const Hc = M + artH + 2 * pad + 140;
  const cv = canvas(Wc, Math.round(Hc)), ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, Wc, Hc);
  const conv = createConverter();
  conv.setSource(bmp);
  LOOKS.forEach((l, j) => {
    const x = M + j * (tile + GAP), y = M - 16;
    const g = conv.run(CROP_CLOSE, { mode: 'braille', cols, rows, dither: 'atkinson', tone: { look: l.id, invert: true } });
    roundRect(ctx, x, y, tile, artH + 2 * pad, 22, '#0d0d0c');
    drawGrid(ctx, g, { x: x + pad, y: y + pad, cellW, cellH, ink: INK, dotR: 0.34 });
    ctx.fillStyle = INK;
    ctx.font = `italic 44px ${SERIF}`;
    ctx.textAlign = 'left';
    ctx.fillText(l.name, x + 4, y + artH + 2 * pad + 58);
  });
  ctx.fillStyle = MUTED;
  ctx.font = `400 22px ${SANS}`;
  ctx.textAlign = 'left';
  ctx.fillText(`The five looks at ${cols} × ${rows}, the size of an Instagram comment on a phone, inverted for dark mode`, M + 4, Hc - 36);
  return save('looks', cv);
}

// ------------------------------------------------------------------------------------ styles
async function styles(bmp) {
  const M = 64, GAP = 44, Wc = 1760, N = 3;
  const tile = (Wc - 2 * M - (N - 1) * GAP) / N;
  const pad = 26, art = tile - 2 * pad;
  const Hc = Math.round(M + tile + 120);
  const cv = canvas(Wc, Hc), ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, Wc, Hc);
  const conv = createConverter();
  conv.setSource(bmp);
  const panels = [
    { name: 'Dots', sub: 'Braille · Instagram, X, Telegram', mode: 'braille', cols: +(q.get('dcols') || 46), aspect: cellAspect('tg', 'braille') },
    { name: 'Letters', sub: 'ASCII in a code block · Telegram', mode: 'ascii', cols: +(q.get('acols') || 56), aspect: cellAspect('tg', 'ascii') },
    { name: 'Blocks', sub: 'Colour · PNG, SVG, HTML', mode: 'blocks', cols: 50, aspect: cellAspect('plain', 'blocks') },
  ];
  panels.forEach((P, j) => {
    const x = M + j * (tile + GAP), y = M - 16;
    const rows = rowsFor(P.cols, P.aspect);
    const cellW = art / P.cols, cellH = art / rows;
    roundRect(ctx, x, y, tile, tile, 22, '#0d0d0c');
    // letters get their own look: one glyph per cell carries less than 8 dots, and Texture's weave
    // turns into noise there; Poster keeps the big shapes (halo, hood edge, hand) on a clean ground
    const look = P.mode === 'ascii' ? (q.get('alook') || 'poster') : (q.get('slook') || 'texture');
    const opts = { mode: P.mode, cols: P.cols, rows, dither: 'atkinson', tone: { look, invert: P.mode !== 'blocks' } };
    if (P.mode === 'blocks') Object.assign(opts, { color: true, blocks: 'quad' });
    const g = conv.run(CROP, opts);
    if (P.mode === 'braille') {
      drawColourBraille(ctx, g, colourGrid(bmp, CROP, 2 * P.cols, 4 * rows), { x: x + pad, y: y + pad, cellW, cellH, floor: 0.8 });
    } else if (P.mode === 'ascii') {
      drawColourAscii(ctx, g, colourGrid(bmp, CROP, P.cols, rows), { x: x + pad, y: y + pad, cellW, cellH });
    } else {
      ctx.save();
      ctx.beginPath(); ctx.rect(x + pad, y + pad, art, art); ctx.clip();
      drawGrid(ctx, g, { x: x + pad, y: y + pad, cellW, cellH });
      ctx.restore();
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `italic 46px ${SERIF}`;
    ctx.fillText(P.name, x + 4, y + tile + 62);
    const nw = ctx.measureText(P.name).width;
    ctx.fillStyle = MUTED;
    ctx.font = `400 22px ${SANS}`;
    ctx.fillText(P.sub, x + nw + 22, y + tile + 60);
  });
  return save('styles', cv);
}

// ------------------------------------------------------------------------------------ paste
// The copied text itself (formatFor's payload), set as text in a chat bubble, selected, with a
// real Braille font: proof it is characters, not a picture. Drawn with the text's own characters.
async function paste(bmp) {
  const conv = createConverter();
  conv.setSource(bmp);
  const fit = autoFit('tg', 'braille');
  const g = conv.run(CROP_CLOSE, { mode: 'braille', cols: fit.cols, rows: fit.rows, dither: 'atkinson', tone: { invert: true } });
  const payload = formatFor('tg', g);
  return { text: payload.text, count: payload.count, cols: payload.cols, rows: payload.rows, lines: gridLines(g).length };
}

// ------------------------------------------------------------------------------------ app shots
// Real app screenshots (made by a Playwright run into shots/readme_app_*.png) set on a soft ground.
function ground(ctx, w, h) {
  const gr = ctx.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#1e1d1b');
  gr.addColorStop(1, '#141412');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
  // a faint warmth behind the middle, the halo's yellow
  const glow = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, w * 0.45);
  glow.addColorStop(0, 'rgba(228,207,74,0.07)');
  glow.addColorStop(1, 'rgba(228,207,74,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
}

function framed(ctx, img, x, y, w, h, r) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 48; ctx.shadowOffsetY = 18;
  roundRect(ctx, x, y, w, h, r, '#000');
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

const PHONE_ROWS = {
  app_phone: [
    { file: 'ig', name: 'Instagram', sub: 'a comment · 26 × 15 · 404 of 2,200' },
    { file: 'xlong', name: 'X Premium', sub: 'a long post · folds after 5 rows' },
    { file: 'tg', name: 'Telegram', sub: 'a message · 24 × 14 · 349 of 4,096' },
  ],
  app_chats: [
    { file: 'steamb', name: 'Steam', sub: 'a profile Info Box · 60 × 32 · 5,791 of 8,000 bytes' },
    { file: 'ytlive', name: 'YouTube', sub: 'live chat · 17 × 10 · 197 of 200' },
    { file: 'twitch', name: 'Twitch', sub: 'chat · 30 × 15 · 495 of 500' },
  ],
};
const phones = () => phoneRow('app_phone');
const chats = () => phoneRow('app_chats');

async function phoneRow(name) {
  const theme = q.get('theme') || 'dark';
  const items = PHONE_ROWS[name];
  const imgs = await Promise.all(items.map(it => load(`../shots/readme_app_phone_${theme}_${it.file}.png`)));
  const Wc = 1760, pw = 480, ph = Math.round(pw * imgs[0].height / imgs[0].width), GAP = 64, TOP = 72;
  const left = (Wc - 3 * pw - 2 * GAP) / 2;
  const Hc = TOP + ph + 136;
  const cv = canvas(Wc, Hc), ctx = cv.getContext('2d');
  ground(ctx, Wc, Hc);
  items.forEach((it, j) => {
    const x = left + j * (pw + GAP);
    framed(ctx, imgs[j], x, TOP, pw, ph, 46);
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `italic 42px ${SERIF}`;
    ctx.fillText(it.name, x + 6, TOP + ph + 66);
    ctx.fillStyle = MUTED;
    ctx.font = `400 21px ${SANS}`;
    ctx.fillText(it.sub, x + 8, TOP + ph + 102);
  });
  return save(name, cv);
}

async function desktop() {
  const theme = q.get('theme') || 'dark';
  const img = await load(`../shots/readme_app_desktop_${theme}.png`);
  const Wc = 1760, M = 56, w = Wc - 2 * M, h = Math.round(w * img.height / img.width);
  const cv = canvas(Wc, h + 2 * M), ctx = cv.getContext('2d');
  ground(ctx, Wc, h + 2 * M);
  framed(ctx, img, M, M, w, h, 18);
  return save('app_desktop', cv);
}

// ------------------------------------------------------------------------------------ explore
async function explore(bmp) {
  const cols = +(q.get('cols') || 64), rows = rowsFor(cols, 0.55);
  const S = 420, GAP = 20;
  const cv = canvas(LOOKS.length * (S + GAP) + GAP, 2 * (S + GAP) + GAP), ctx = cv.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, cv.width, cv.height);
  const conv = createConverter();
  conv.setSource(bmp);
  const colours = colourGrid(bmp, CROP, 2 * cols, 4 * rows);
  LOOKS.forEach((l, j) => {
    const g = conv.run(CROP, { mode: 'braille', cols, rows, dither: 'atkinson', tone: { look: l.id, invert: true } });
    drawColourBraille(ctx, g, colours, { x: GAP + j * (S + GAP), y: GAP, cellW: S / cols, cellH: S / rows });
    drawGrid(ctx, g, { x: GAP + j * (S + GAP), y: 2 * GAP + S, cellW: S / cols, cellH: S / rows, ink: INK, dotR: 0.34 });
    ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText(l.id, GAP + j * (S + GAP) + 6, GAP + 22);
  });
  return save('explore', cv);
}

try {
  await document.fonts.ready;
  await Promise.all([`italic 100px ${SERIF}`, `100px ${SERIF}`, `400 20px ${SANS}`, `500 20px ${SANS}`, `20px ${MONO}`]
    .map(f => document.fonts.load(f).catch(() => null)));
  const bmp = await load(SRC);
  const want = SHOT === 'all' ? ['banner', 'looks', 'styles', 'phones', 'chats', 'desktop'] : SHOT.split(',');
  const jobs = { banner, looks, styles, paste, explore, phones, chats, desktop };
  const out = [];
  for (const k of want) out.push(await jobs[k](bmp));
  window.__done = { ok: true, out, fonts: document.fonts.check(`italic 40px ${SERIF}`) && document.fonts.check(`20px ${MONO}`) };
} catch (e) {
  console.error(e);
  window.__done = { ok: false, error: String(e && e.stack || e) };
}

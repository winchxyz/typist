// Welcome hero options (dev only): five different heroes on the real welcome layout, through the
// app's own modules (converter, looks, dot raster, samples, chat preview).
//   dev/hero.html?opt=A|B|C|D|E;theme=light|dark   one option on the welcome screen
//   E only: ;look=..;dither=..;black=..;white=..;floor=..;glow=..;sat=..;gamma=..;p=.. (wide pitch)
//   dev/hero.html?sheet=1                          contact sheet of looks per crop -> shots/hero_sheet.png
// Every option draws Braille dots on a uniform dot lattice (pitch p = 2 dots per cell across,
// 4 down), sized so a dot is at least ~2.5 CSS px in radius on a 390 px phone, in the theme's
// text colour, inverted on dark (dots = the light parts). Reduced motion shows the finished frame.
import { createConverter, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/convert.js';
import { LOOKS } from '../js/tone.js';
import { drawGrid } from '../js/raster.js';
import { loadSample, SAMPLES, thumbUrl } from '../js/samples.js';
import { formatFor, cellAspect, rowsFor } from '../js/targets.js';
import { renderPreview } from '../js/preview.js';

const q = new URLSearchParams(location.search);
const OPT = (q.get('opt') || 'A').toUpperCase();
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme');
const $ = id => document.getElementById(id);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => getComputedStyle(document.documentElement).colorScheme === 'dark';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dprOf = () => Math.min(3, window.devicePixelRatio || 1);

// ------------------------------------------------------------------------------ the art
const bitmaps = new Map();
async function bitmap(id) {
  if (!bitmaps.has(id)) bitmaps.set(id, loadSample(id));
  return bitmaps.get(id);
}

/**
 * The region of the photo with aspect `aspect` (w / h): the largest such rectangle, shrunk by
 * `zoom`, centred on (cx, cy) in 0..1 photo coords and kept inside the photo.
 */
function regionOf(bmp, aspect, { cx = 0.5, cy = 0.5, zoom = 1 } = {}) {
  const iw = bmp.width, ih = bmp.height;
  let w = iw, h = iw / aspect;
  if (h > ih) { h = ih; w = ih * aspect; }
  w /= zoom; h /= zoom;
  const x = clamp(cx * iw - w / 2, 0, iw - w), y = clamp(cy * ih - h / 2, 0, ih - h);
  return { x, y, w, h };
}

/**
 * Braille Grid of a non-square region: the converter crops squares, so the region is stretched
 * onto a square canvas and sampled at 2c x 4r dots, which undoes the stretch on a uniform lattice.
 */
function artOf(bmp, cols, rows, crop, tone = {}, dither = 'atkinson') {
  const rect = regionOf(bmp, (2 * cols) / (4 * rows), crop);
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(bmp, rect.x, rect.y, rect.w, rect.h, 0, 0, S, S);
  const conv = createConverter();
  conv.setSource(cv);
  const grid = conv.run(CROP_DEFAULTS, { mode: 'braille', cols, rows, tone: { ...TONE_DEFAULTS, ...tone }, dither });
  return { grid, rect };
}

/** Canvas sized for a cols x rows grid at dot pitch p, painted by `paint(ctx)` in CSS px. */
function sizeCanvas(cv, w, h) {
  const dpr = dprOf();
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/** A copy of `grid` keeping only the dots `keep(i, bit)` says yes to. */
function partialGrid(grid, keep) {
  const cp = new Uint32Array(grid.cp.length);
  for (let i = 0; i < cp.length; i++) {
    const bits = grid.cp[i] - 0x2800;
    let b = 0;
    if (bits) for (let k = 0; k < 8; k++) if ((bits >> k) & 1 && keep(i, k)) b |= 1 << k;
    cp[i] = 0x2800 + b;
  }
  return { ...grid, cp };
}

// Braille bit -> (dx, dy) in dots inside the cell (raster.js BRAILLE_SLOTS)
const SLOT = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];

/** Hero box in CSS px (the #welcomeArt content box). */
function heroBox() {
  const a = $('welcomeArt');
  const s = getComputedStyle(a);
  const w = a.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  const h = a.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
  return { w, h, wide: innerWidth >= 700 };
}

/** Grid size filling w x h at pitch p (whole cells). */
function fitCells(w, h, p) {
  return { cols: Math.max(4, Math.floor(w / p / 2)), rows: Math.max(2, Math.floor(h / p / 4)) };
}

// ------------------------------------------------------------------------------ options
// A. Scenic: the lighthouse at sunset, typed in row by row.
// Threshold, not error diffusion: at 50-60 dots across, diffusion scatters lone dots through the
// sky and fur; a plain threshold keeps clean shapes and outlines.
const A = {
  sample: 'landmark', look: 'photo', dither: 'threshold', dotR: 0.42,
  // phones: a landscape band (tower, sun, cliff top); wide: a portrait column
  cropPhone: { cx: 0.55, cy: 0.34, zoom: 1.14 }, cropWide: { cx: 0.56, cy: 0.45, zoom: 1.15 },
  // light: the clouds' faint streaks drop out, the striped tower stays
  tone: {}, toneLight: { brightness: 0.3 },
};
// B. Before and after: the cat photo | its dots, a slow wipe.
const B = {
  sample: 'pet', look: 'photo', lookLight: 'sketch', dither: 'threshold', dotR: 0.42,
  cropPhone: { cx: 0.54, cy: 0.36, zoom: 1.0 }, cropWide: { cx: 0.54, cy: 0.40, zoom: 1.05 },
  tone: {},
};
// C. Emblem: bold dots coming up by tone, like a print. A mark keeps its polarity: the black
// shapes are the dots in both themes (inverted, the white paper became a solid square of dots).
const C = { sample: 'logo', look: 'photo', dither: 'threshold', dotR: 0.46, crop: { cx: 0.5, cy: 0.5, zoom: 0.94 }, tone: {}, invert: 'never' };
// D. In the chat: an Instagram comment whose text is the art.
const D = { sample: 'landmark', look: 'photo', dither: 'threshold', crop: { cx: 0.55, cy: 0.36, zoom: 1.1 }, tone: {}, toneLight: { brightness: 0.3 } };

function tuneFrom(o) {
  // ?look=..;dither=..;dotR=..;edges=..;detail=.. override the option's settings (iteration)
  const out = { ...o, tone: { ...o.tone } };
  if (q.get('look')) out.look = q.get('look');
  if (q.get('dither')) out.dither = q.get('dither');
  if (q.get('dotR')) out.dotR = +q.get('dotR');
  for (const k of ['edges', 'detail', 'contrast', 'gamma', 'brightness']) if (q.get(k)) out.tone[k] = +q.get(k);
  return out;
}

async function heroA(host) {
  const o = tuneFrom(A);
  const bmp = await bitmap(o.sample);
  const box = heroBox();
  const p = box.wide ? 6.6 : 6.4;
  // wide: portrait column no taller than 1.45 x its width
  const w = box.w, h = box.wide ? Math.min(box.h, box.w * 1.45) : box.h;
  const { cols, rows } = fitCells(w, h, p);
  const { grid } = artOf(bmp, cols, rows, box.wide ? o.cropWide : o.cropPhone, { look: o.look, invert: isDark(), ...o.tone, ...(isDark() ? {} : o.toneLight) }, o.dither);
  const cv = document.createElement('canvas');
  cv.className = 'hero-frame';
  host.replaceChildren(cv);
  const W = cols * 2 * p, H = rows * 4 * p;
  const ink = css('--text');
  const total = cols * rows;
  const paint = n => {
    const ctx = sizeCanvas(cv, W, H);
    const g = n >= total ? grid : partialGrid(grid, i => i < n);
    drawGrid(ctx, g, { cellW: 2 * p, cellH: 4 * p, ink, dotR: o.dotR });
    // the typewriter carriage: a caret after the last typed cell
    if (n < total) {
      const r = Math.floor(n / cols), c = n % cols;
      ctx.fillStyle = css('--accent');
      ctx.fillRect(c * 2 * p + 1, r * 4 * p + 2, 2 * p - 2, 4 * p - 4);
    }
  };
  return { cv, grid, cols, rows, p, settings: { ...o, cols, rows, p },
    animate: dur => typeRows(total, cols, dur, paint) };
}

/** Row by row at a steady typing rhythm, with a short pause at each carriage return. */
function typeRows(total, cols, dur, paint) {
  return new Promise(resolve => {
    if (reduced()) { paint(total); resolve(); return; }
    const rows = total / cols;
    const t0 = performance.now();
    const tick = now => {
      const k = Math.min(1, (now - t0) / dur);
      // each row takes 1 unit to type + 0.25 for the return
      const u = k * rows * 1.25, r = Math.floor(u / 1.25), f = Math.min(1, (u - r * 1.25) / 1);
      paint(k >= 1 ? total : Math.min(total, r * cols + Math.round(f * cols)));
      if (k < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// E. Night: the showcase artwork (img/showcase/halo.jpg, the user's own: a hooded figure with a
// golden halo on black), whole, in glowing Braille dots on a near-black card in both themes, like
// frame 0 of the intro film (dev/intro.js). The dots are the app's inverted Braille (dots = the
// light parts); each dot takes the photo's own colour under it, lifted so it glows, so the halo
// comes out in its own gold, the robe sage and the hand pale; a soft bloom, a warm light behind
// the halo. Typed in row by row behind a gold carriage.
const E = {
  src: '../img/showcase/halo.jpg', dotR: 0.42, tone: {},
  // photo levels before converting: the ground (~19/255), the smoke (~25) and the face (~28) go to
  // black, so the dots draw the figure and nothing else; `white` is where the halo and hand top out
  black: 31,
  minR: 2.5,                          // CSS px: the smallest dot radius on a 390 px phone
  sat: 1.15, floor: 0.34, gamma: 0.85, glow: 0.62,
  // The figure in the photo (0..1): the halo's tips down to the hem, the black margins and most of
  // the smoke on the right left out; it stands on the card's bottom edge as it does in the photo
  // (never on the JPEG's last rows, a light seam). Phones get ~30 x 36 dots: a plain threshold
  // keeps the hood, the face and the hand as clean shapes, where error diffusion scatters the robe
  // into loose dots; the frame stops above the hem so the figure is bigger. Wide screens get ~50 x
  // 70 dots, enough for Atkinson's texture on the robe.
  phone: { look: 'soft', dither: 'threshold', white: 150, frame: { x: 0.015, y: 0.065, w: 0.915, h: 0.835 } },
  wide: { look: 'soft', dither: 'atkinson', white: 105, frame: { x: 0.015, y: 0.06, w: 0.915, h: 0.93 } },
};

/** The photo's pixels of `rect`, drawn at w x h (the browser's downscale averages them). */
function pixelsOf(bmp, rect, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return { cv, ctx, data: ctx.getImageData(0, 0, w, h) };
}

async function heroE(host) {
  host.classList.add('hero-e');     // before measuring: E has its own padding on phones
  const box = heroBox();
  const o = tuneFrom({ ...E, ...(box.wide ? E.wide : E.phone) });
  for (const k of ['black', 'white', 'floor', 'glow', 'sat', 'gamma', 'minR']) if (q.get(k)) o[k] = +q.get(k);
  const bmp = await createImageBitmap(await (await fetch(o.src)).blob());
  const F = o.frame, fAspect = (F.w * bmp.width) / (F.h * bmp.height);

  // Card and lattice. Phones: the card fills the strip above the sheet and the figure is as tall as
  // the smallest dot allows. Wide: a portrait card as wide as the column (capped), finer dots.
  let cardW, cardH, p, cols, rows, top;
  if (!box.wide) {
    cardW = box.w; cardH = box.h; top = 7;
    const pMin = o.minR / o.dotR;
    rows = Math.max(4, Math.floor((cardH - top) / (4 * pMin)));
    p = Math.min(7.5, (cardH - top) / (4 * rows));
    cols = Math.max(4, Math.round((rows * 4 * p * fAspect) / (2 * p)));
  } else {
    cardW = Math.min(box.w, 400);
    top = 16;
    p = +(q.get('p') || 5.6);
    cols = Math.floor((cardW - 28) / (2 * p));
    rows = Math.round((cols * 2) / fAspect / 4);
    rows = Math.min(rows, Math.floor((box.h - top) / (4 * p)));
    cardH = rows * 4 * p + top;
  }
  const DW = cols * 2, DH = rows * 4, AW = DW * p, AH = DH * p;
  const ax = Math.round((cardW - AW) / 2), ay = cardH - AH;   // the art stands on the bottom edge

  // the photo region with the lattice's aspect: the frame's centre across, its bottom at the hem
  const A = DW / DH;
  let rw = F.w * bmp.width, rh = rw / A;
  if (rh > F.h * bmp.height) { rh = F.h * bmp.height; rw = rh * A; }
  const rect = {
    x: clamp((F.x + F.w / 2) * bmp.width - rw / 2, 0, bmp.width - rw),
    y: clamp((F.y + F.h) * bmp.height - rh, 0, bmp.height - rh), w: rw, h: rh,
  };

  // Braille through the app's converter: the region stretched onto a square (sampled back at
  // 2c x 4r dots, which undoes the stretch), levels applied first
  const src = pixelsOf(bmp, rect, 768, 768);
  {
    const d = src.data.data, k = 255 / (o.white - o.black);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = (d[i] - o.black) * k; d[i + 1] = (d[i + 1] - o.black) * k; d[i + 2] = (d[i + 2] - o.black) * k;
    }
    src.ctx.putImageData(src.data, 0, 0);
  }
  const conv = createConverter();
  conv.setSource(src.cv);
  const grid = conv.run(CROP_DEFAULTS, { mode: 'braille', cols, rows, tone: { ...TONE_DEFAULTS, look: o.look, invert: true, ...o.tone }, dither: o.dither });
  const on = new Uint8Array(DW * DH), CELL = new Uint32Array(DW * DH);
  for (let i = 0; i < grid.cp.length; i++) {
    const bits = grid.cp[i] - 0x2800, c = i % cols, r = (i / cols) | 0;
    for (let k = 0; k < 8; k++) if ((bits >> k) & 1) on[(r * 4 + SLOT[k][1]) * DW + c * 2 + SLOT[k][0]] = 1;
  }
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) CELL[y * DW + x] = (y >> 2) * cols + (x >> 1);

  // one colour per dot: the photo's average under it, normalised to its white point, a little
  // more saturated, its value lifted towards a floor so every dot glows (hue kept: gold stays gold)
  const colour = pixelsOf(bmp, rect, DW, DH);
  {
    const d = colour.data.data, wp = o.white / 255;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] / 255 / wp, g = d[i + 1] / 255 / wp, b = d[i + 2] / 255 / wp;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = Y + (r - Y) * o.sat; g = Y + (g - Y) * o.sat; b = Y + (b - Y) * o.sat;
      const m = Math.max(r, g, b, 0.03);
      const k = (o.floor + (1 - o.floor) * Math.pow(Math.min(1, m), o.gamma)) / m;
      d[i] = r * k * 255; d[i + 1] = g * k * 255; d[i + 2] = b * k * 255; d[i + 3] = 255;
    }
    colour.ctx.putImageData(colour.data, 0, 0);
  }

  const frame = document.createElement('div');
  frame.className = 'hero-frame hero-night';
  frame.style.width = cardW + 'px'; frame.style.height = cardH + 'px';
  const cv = document.createElement('canvas');
  frame.append(cv);
  host.replaceChildren(frame);
  const dpr = dprOf();
  const off = document.createElement('canvas');
  off.width = Math.round(cardW * dpr); off.height = Math.round(cardH * dpr);
  const octx = off.getContext('2d');
  // canvas filters are missing in older WebKit: the bloom then comes from a small copy scaled up
  const probe = document.createElement('canvas').getContext('2d');
  probe.filter = 'blur(2px)';
  const hasFilter = probe.filter === 'blur(2px)';
  const small = document.createElement('canvas');

  // where the halo and the body sit on the card, for the ground's two lights
  const toCard = (px, py) => [ax + ((px * bmp.width - rect.x) / rect.w) * AW, ay + ((py * bmp.height - rect.y) / rect.h) * AH];
  const [hx, hy] = toCard(0.535, 0.14), [bx, by] = toCard(0.45, 0.62);

  const total = cols * rows;
  const FADE = 4;                     // a cell's dots come up over its last cells of carriage travel
  const paint = n => {
    const ctx = sizeCanvas(cv, cardW, cardH);
    // ground: near-black, a warm light behind the halo, a darker olive one behind the figure
    ctx.fillStyle = '#0b0a09'; ctx.fillRect(0, 0, cardW, cardH);
    const lit = clamp(n / total, 0, 1);
    const glowAt = (x, y, rad, rgb, a) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(${rgb}, ${a})`); g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, cardW, cardH);
    };
    glowAt(hx, hy, AW * 0.8, '214, 180, 70', 0.10 * (0.35 + 0.65 * lit));
    glowAt(bx, by, AW * 1.0, '96, 104, 60', 0.08 * (0.35 + 0.65 * lit));
    // dots, white, alpha binned so each alpha is one path, then coloured through source-in
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'source-over'; octx.globalAlpha = 1;
    octx.clearRect(0, 0, off.width, off.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const BINS = 12, bins = Array.from({ length: BINS + 1 }, () => []);
    for (let i = 0; i < on.length; i++) {
      if (!on[i]) continue;
      const a = clamp((n - CELL[i]) / FADE, 0, 1);
      if (a > 0.02) bins[Math.round(a * BINS)].push(i);
    }
    const r = o.dotR * p;
    octx.fillStyle = '#fff';
    for (let b = 1; b <= BINS; b++) {
      if (!bins[b].length) continue;
      octx.globalAlpha = b / BINS;
      octx.beginPath();
      for (const i of bins[b]) {
        const x = ax + ((i % DW) + 0.5) * p, y = ay + (((i / DW) | 0) + 0.5) * p;
        octx.moveTo(x + r, y); octx.arc(x, y, r, 0, Math.PI * 2);
      }
      octx.fill();
    }
    octx.globalAlpha = 1;
    octx.globalCompositeOperation = 'source-in';
    octx.imageSmoothingEnabled = false;
    octx.drawImage(colour.cv, ax, ay, AW, AH);
    octx.globalCompositeOperation = 'source-over';
    // bloom under the sharp dots
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = o.glow;
    if (hasFilter) {
      ctx.filter = `blur(${(p * 2 * dpr).toFixed(1)}px)`;
      ctx.drawImage(off, 0, 0);
      ctx.filter = 'none';
    } else {
      const s = Math.max(1, Math.round(p * dpr));
      small.width = Math.ceil(off.width / s); small.height = Math.ceil(off.height / s);
      const sctx = small.getContext('2d');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(off, 0, 0, small.width, small.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(small, 0, 0, off.width, off.height);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
    // the carriage
    if (n < total) {
      const c = Math.floor(n) % cols, rr = Math.floor(Math.floor(n) / cols);
      ctx.save();
      ctx.fillStyle = '#e7c552';
      ctx.shadowColor = 'rgba(231, 197, 82, 0.85)';
      ctx.shadowBlur = 3 * p;
      ctx.fillRect(ax + c * 2 * p + 0.5, ay + rr * 4 * p + 1, 2 * p - 1, 4 * p - 2);
      ctx.restore();
    }
  };
  const end = total + FADE;
  return { cv: frame, grid, cols, rows, p, settings: { look: o.look, dither: o.dither, dotR: o.dotR, cols, rows, p: +p.toFixed(2), card: [cardW, cardH].map(Math.round), ink: +grid.ink.toFixed(3) },
    animate: dur => new Promise(resolve => {
      if (reduced() || !dur) { paint(end); resolve(); return; }
      // row by row at a steady rhythm, a short pause at each carriage return
      const t0 = performance.now();
      const tick = now => {
        const k = Math.min(1, (now - t0) / dur);
        const u = k * rows * 1.2, row = Math.floor(u / 1.2), f = Math.min(1, (u - row * 1.2) / 1);
        paint(k >= 1 ? end : row * cols + f * cols);
        if (k < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    }) };
}

async function heroB(host) {
  const o = tuneFrom(B);
  const bmp = await bitmap(o.sample);
  const box = heroBox();
  const p = box.wide ? 6.6 : 6.4;
  const w = box.w, h = box.wide ? Math.min(box.h, box.w * 1.3) : box.h;
  const { cols, rows } = fitCells(w, h, p);
  const dark = isDark();
  const { grid, rect } = artOf(bmp, cols, rows, box.wide ? o.cropWide : o.cropPhone, { look: dark ? o.look : o.lookLight || o.look, invert: dark, ...o.tone }, o.dither);
  const W = cols * 2 * p, H = rows * 4 * p;
  const frame = document.createElement('div');
  frame.className = 'hero-frame hero-split';
  const cv = document.createElement('canvas');
  frame.append(cv);
  const capL = Object.assign(document.createElement('span'), { className: 'hero-cap', textContent: 'Photo' });
  const capR = Object.assign(document.createElement('span'), { className: 'hero-cap r', textContent: 'Text' });
  frame.append(capL, capR);
  host.replaceChildren(frame);
  const ink = css('--text'), paper = css('--surface');
  const paint = split => {
    const ctx = sizeCanvas(cv, W, H);
    const sx = Math.round(W * split);
    // art side (right of the split)
    ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip();
    drawGrid(ctx, grid, { cellW: 2 * p, cellH: 4 * p, ink, dotR: o.dotR });
    ctx.restore();
    // photo side
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip();
    ctx.drawImage(bmp, rect.x, rect.y, rect.w, rect.h, 0, 0, W, H);
    ctx.restore();
    // the seam
    ctx.fillStyle = ink; ctx.fillRect(sx - 1, 0, 2, H);
    ctx.beginPath(); ctx.arc(sx, H / 2, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = paper; ctx.beginPath(); ctx.arc(sx, H / 2, 3, 0, Math.PI * 2); ctx.fill();
    capL.style.opacity = split > 0.22 ? 1 : 0; capR.style.opacity = split < 0.78 ? 1 : 0;
  };
  const rest = 0.5;
  return { cv, grid, cols, rows, p, settings: { ...o, cols, rows, p },
    animate: dur => new Promise(resolve => {
      if (reduced()) { paint(rest); resolve(); return; }
      // photo first, then the dots sweep across it, then the seam settles in the middle
      const t0 = performance.now();
      const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const tick = now => {
        const t = Math.min(1, (now - t0) / dur);
        let s;
        if (t < 0.15) s = 1;
        else if (t < 0.7) s = 1 - ease((t - 0.15) / 0.55);
        else s = rest * ease((t - 0.7) / 0.3);
        paint(s);
        if (t < 1) requestAnimationFrame(tick); else { paint(rest); resolve(); }
      };
      requestAnimationFrame(tick);
    }) };
}

async function heroC(host) {
  const o = tuneFrom(C);
  const bmp = await bitmap(o.sample);
  const box = heroBox();
  // big bold dots: fewer of them; the emblem is square
  const side = Math.min(box.w, box.h, box.wide ? 360 : 260);
  const p = box.wide ? 7.4 : 6.2;
  const n = Math.floor(side / p / 4) * 2;   // cols, so that 2n dots across, 4 * n/2 rows
  const cols = n, rows = n / 2;
  const { grid } = artOf(bmp, cols, rows, o.crop, { look: o.look, invert: o.invert === 'never' ? false : isDark(), ...o.tone }, o.dither);
  const cv = document.createElement('canvas');
  cv.className = 'hero-frame';
  host.replaceChildren(cv);
  const W = cols * 2 * p, H = rows * 4 * p;
  const ink = css('--text');
  // arrival order: dots deep inside the shapes first, edges last (a print coming up)
  const DX = cols * 2, DY = rows * 4;
  const on = new Uint8Array(DX * DY);
  for (let i = 0; i < grid.cp.length; i++) {
    const bits = grid.cp[i] - 0x2800, c = i % cols, r = (i / cols) | 0;
    for (let k = 0; k < 8; k++) if ((bits >> k) & 1) on[(r * 4 + SLOT[k][1]) * DX + c * 2 + SLOT[k][0]] = 1;
  }
  const depth = new Float32Array(DX * DY);
  const R = 3;
  for (let y = 0; y < DY; y++) for (let x = 0; x < DX; x++) {
    if (!on[y * DX + x]) continue;
    let s = 0, m = 0;
    for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
      const xx = x + u, yy = y + v;
      m++;
      if (xx >= 0 && yy >= 0 && xx < DX && yy < DY && on[yy * DX + xx]) s++;
    }
    // a little deterministic grain so equal depths do not arrive as flat bands
    const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    depth[y * DX + x] = s / m + 0.12 * (h - Math.floor(h));
  }
  const order = [...depth.keys()].filter(i => on[i]).sort((a, b) => depth[b] - depth[a]);
  const rank = new Float32Array(DX * DY);
  order.forEach((i, j) => { rank[i] = (j + 1) / order.length; });
  const paint = k => {
    const ctx = sizeCanvas(cv, W, H);
    const g = k >= 1 ? grid : partialGrid(grid, (i, b) => {
      const c = i % cols, r = (i / cols) | 0;
      return rank[(r * 4 + SLOT[b][1]) * DX + c * 2 + SLOT[b][0]] <= k;
    });
    drawGrid(ctx, g, { cellW: 2 * p, cellH: 4 * p, ink, dotR: o.dotR });
  };
  return { cv, grid, cols, rows, p, settings: { ...o, cols, rows, p },
    animate: dur => new Promise(resolve => {
      if (reduced()) { paint(1); resolve(); return; }
      const t0 = performance.now();
      const tick = now => {
        const t = Math.min(1, (now - t0) / dur);
        paint(1 - Math.pow(1 - t, 2));
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    }) };
}

async function heroD(host) {
  const o = tuneFrom(D);
  const bmp = await bitmap(o.sample);
  const box = heroBox();
  const dark = isDark();
  const theme = dark ? 'dark' : 'light';
  // the comment at the Instagram cell size, zoomed so its dots are big (k), in a card that fits
  // (renderPreview draws dots at 0.32 x the column pitch: r = 1.8 px at 1:1, 2.2 px at k = 1.2)
  const k = 1.2;
  const phone = Math.floor((box.wide ? Math.min(box.w, 330) : box.w) / k);
  const aspect = cellAspect('ig', 'braille');
  const cols = Math.min(26, Math.floor((phone - 88) / 11.25));
  // phones: no header, and the Reply / compose rows tuck under the sheet, so the art gets the height
  host.classList.toggle('hero-d', !box.wide);
  const rows = box.wide ? Math.min(Math.round(cols * 1.05), Math.floor((box.h / k - 200) / 19.5))
    : Math.max(4, Math.floor((box.h / k - 30) / 19.5));
  void rowsFor; void aspect;
  // the IG cell is 0.75 x 1.3 em: dots 2 x 4 per cell -> region aspect in physical px
  const rect = regionOf(bmp, (cols * 11.25) / (rows * 19.5), o.crop);
  const S = 1024, sc = document.createElement('canvas');
  sc.width = sc.height = S;
  sc.getContext('2d').drawImage(bmp, rect.x, rect.y, rect.w, rect.h, 0, 0, S, S);
  const conv = createConverter();
  conv.setSource(sc);
  const grid = conv.run(CROP_DEFAULTS, { mode: 'braille', cols, rows, tone: { ...TONE_DEFAULTS, look: o.look, invert: dark, ...o.tone, ...(dark ? {} : o.toneLight) }, dither: o.dither });
  const payload = formatFor('ig', grid);
  const wrap = document.createElement('div');
  wrap.className = 'hero-frame hero-chat';
  host.replaceChildren(wrap);
  const draw = g => renderPreview(wrap, { target: 'ig', payload: formatFor('ig', g), grid: g, device: 'ios', theme, phone, dpr: dprOf() * k, inset: 0 });
  wrap.style.zoom = k;
  const total = cols * rows;
  const paint = n => draw(n >= total ? grid : partialGrid(grid, i => i < n));
  return { cv: wrap, grid, cols, rows, p: 0, settings: { ...o, cols, rows, phone, zoom: k, payloadCount: payload.count },
    animate: dur => typeRows(total, cols, dur, paint) };
}

// ------------------------------------------------------------------------------ welcome shell
function buildSamples() {
  const host = $('samples');
  for (const s of SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sample';
    b.innerHTML = '<img alt="" width="80" height="80" decoding="async"><span></span>';
    b.querySelector('img').src = thumbUrl(s.id);
    b.querySelector('span').textContent = s.name;
    host.append(b);
  }
}

async function main() {
  buildSamples();
  const sheet = $('welcome');
  const setH = () => document.documentElement.style.setProperty('--sheet-h', `${sheet.offsetHeight}px`);
  setH();
  new ResizeObserver(setH).observe(sheet);
  await document.fonts.ready;
  await Promise.all([...document.images].map(i => (i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
  setH();
  const make = { A: heroA, B: heroB, C: heroC, D: heroD, E: heroE }[OPT] || heroA;
  const host = $('welcomeArt');
  let hero = await make(host);
  const DUR = { A: 2600, B: 3600, C: 2200, D: 2400, E: 2800 }[OPT] || 2400;
  await hero.animate(DUR);
  window.addEventListener('resize', async () => { hero = await make(host); hero.animate(0); });
  const r = host.firstElementChild.getBoundingClientRect(), c = sheet.getBoundingClientRect();
  window.__done = { ok: true, opt: OPT, cols: hero.cols, rows: hero.rows, p: hero.p,
    dotR: hero.settings.dotR, rPx: hero.p ? +(Math.min(hero.settings.dotR, 0.46) * hero.p).toFixed(2) : null,
    hero: [r.left, r.top, r.width, r.height].map(Math.round), card: [c.left, c.top, c.width, c.height].map(Math.round),
    cardVisible: c.top >= 0 && c.bottom <= innerHeight + 0.5 && sheet.scrollHeight <= sheet.clientHeight + 1,
    overlap: r.bottom > c.top + 0.5 && r.right > c.left + 0.5, settings: hero.settings };
}

// ------------------------------------------------------------------------------ contact sheet
async function contactSheet() {
  document.body.classList.add('sheet');
  const rowsDef = [
    { id: 'landmark', label: 'lighthouse phone 27x8', cols: 27, rows: 8, crop: A.cropPhone },
    { id: 'landmark', label: 'lighthouse wide 24x17', cols: 24, rows: 17, crop: A.cropWide },
    { id: 'pet', label: 'cat phone 27x8', cols: 27, rows: 8, crop: B.cropPhone },
    { id: 'pet', label: 'cat wide 24x15', cols: 24, rows: 15, crop: B.cropWide },
    { id: 'logo', label: 'emblem 20x10', cols: 20, rows: 10, crop: C.crop },
    { id: 'logo', label: 'emblem 16x8', cols: 16, rows: 8, crop: C.crop },
  ].filter(r => !q.get('rows') || q.get('rows').split(',').includes(r.id));
  const dithers = (q.get('dithers') || 'atkinson').split(',');
  const P = +(q.get('p') || 4), GAP = 14, LAB = 26;
  const variants = [];
  for (const d of dithers) for (const l of LOOKS) for (const inv of [false, true]) variants.push({ look: l.id, inv, d });
  const cellW = Math.max(...rowsDef.map(r => r.cols * 2 * P)), heights = rowsDef.map(r => r.rows * 4 * P);
  const cv = document.createElement('canvas');
  const Wt = 170 + variants.length * (cellW + GAP), Ht = rowsDef.reduce((s, h, i) => s + heights[i] + LAB + GAP, 30);
  cv.width = Wt; cv.height = Ht;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#888'; ctx.fillRect(0, 0, Wt, Ht);
  ctx.font = '13px sans-serif';
  let y = 30;
  variants.forEach((v, j) => { ctx.fillStyle = '#000'; ctx.fillText(`${v.look} ${v.inv ? 'inv/dark' : 'light'} ${v.d}`, 170 + j * (cellW + GAP), 18); });
  for (const [ri, r] of rowsDef.entries()) {
    const bmp = await bitmap(r.id);
    ctx.fillStyle = '#000'; ctx.fillText(r.label, 6, y + 20);
    for (const [j, v] of variants.entries()) {
      const { grid } = artOf(bmp, r.cols, r.rows, r.crop, { look: v.look, invert: v.inv }, v.d);
      const x = 170 + j * (cellW + GAP);
      drawGrid(ctx, grid, { x, y, cellW: 2 * P, cellH: 4 * P, ink: v.inv ? '#edeae4' : '#1c1b19', paper: v.inv ? '#161514' : '#e7e3dc', dotR: 0.42 });
    }
    y += heights[ri] + LAB + GAP;
  }
  document.body.append(cv);
  const name = 'hero_sheet' + (q.get('tag') || '');
  await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: cv.toDataURL('image/png') }) });
  window.__done = { ok: true, sheet: name, variants: variants.length };
}

(q.get('sheet') ? contactSheet() : main()).catch(e => {
  console.error(e);
  window.__done = { ok: false, error: String(e && e.stack || e) };
});

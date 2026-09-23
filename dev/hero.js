// Welcome hero options (dev only): four different heroes on the real welcome layout, through the
// app's own modules (converter, looks, dot raster, samples, chat preview).
//   dev/hero.html?opt=A|B|C|D;theme=light|dark     one option on the welcome screen
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
const A = {
  sample: 'landmark', look: 'photo', dither: 'atkinson', dotR: 0.42,
  // phones: a landscape band (tower, sun, sea); wide: a portrait column
  cropPhone: { cx: 0.56, cy: 0.40, zoom: 1.0 }, cropWide: { cx: 0.56, cy: 0.42, zoom: 1.0 },
  tone: {},
};
// B. Before and after: the cat photo | its dots, a slow wipe.
const B = {
  sample: 'pet', look: 'photo', dither: 'atkinson', dotR: 0.42,
  cropPhone: { cx: 0.54, cy: 0.33, zoom: 1.25 }, cropWide: { cx: 0.54, cy: 0.40, zoom: 1.05 },
  tone: {},
};
// C. Emblem: bold dots coming up by tone, like a print.
const C = { sample: 'logo', look: 'poster', dither: 'atkinson', dotR: 0.46, crop: { cx: 0.5, cy: 0.5, zoom: 0.94 }, tone: {} };
// D. In the chat: an Instagram comment whose text is the art.
const D = { sample: 'landmark', look: 'photo', dither: 'atkinson', crop: { cx: 0.56, cy: 0.40, zoom: 1.0 }, tone: {} };

function tuneFrom(o) {
  // ?look=..;dither=..;dotR=..;cx=..;cy=..;zoom=.. override the option's settings (iteration)
  const out = { ...o };
  if (q.get('look')) out.look = q.get('look');
  if (q.get('dither')) out.dither = q.get('dither');
  if (q.get('dotR')) out.dotR = +q.get('dotR');
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
  const { grid } = artOf(bmp, cols, rows, box.wide ? o.cropWide : o.cropPhone, { look: o.look, invert: isDark(), ...o.tone }, o.dither);
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

async function heroB(host) {
  const o = tuneFrom(B);
  const bmp = await bitmap(o.sample);
  const box = heroBox();
  const p = box.wide ? 6.6 : 6.4;
  const w = box.w, h = box.wide ? Math.min(box.h, box.w * 1.3) : box.h;
  const { cols, rows } = fitCells(w, h, p);
  const dark = isDark();
  const { grid, rect } = artOf(bmp, cols, rows, box.wide ? o.cropWide : o.cropPhone, { look: o.look, invert: dark, ...o.tone }, o.dither);
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
  const { grid } = artOf(bmp, cols, rows, o.crop, { look: o.look, invert: isDark(), ...o.tone }, o.dither);
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
  const k = box.wide ? 1.2 : 1.25;
  const phone = Math.floor((box.wide ? Math.min(box.w, 330) : box.w) / k);
  const aspect = cellAspect('ig', 'braille');
  const cols = Math.min(26, Math.floor((phone - 88) / 11.25));
  const rows = box.wide ? rowsFor(cols, aspect) : Math.max(4, Math.floor((box.h / k - 90) / 19.5));
  // the IG cell is 0.75 x 1.3 em: dots 2 x 4 per cell -> region aspect in physical px
  const rect = regionOf(bmp, (cols * 11.25) / (rows * 19.5), o.crop);
  const S = 1024, sc = document.createElement('canvas');
  sc.width = sc.height = S;
  sc.getContext('2d').drawImage(bmp, rect.x, rect.y, rect.w, rect.h, 0, 0, S, S);
  const conv = createConverter();
  conv.setSource(sc);
  const grid = conv.run(CROP_DEFAULTS, { mode: 'braille', cols, rows, tone: { ...TONE_DEFAULTS, look: o.look, invert: dark }, dither: o.dither });
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
  const make = { A: heroA, B: heroB, C: heroC, D: heroD }[OPT] || heroA;
  const host = $('welcomeArt');
  let hero = await make(host);
  const DUR = { A: 2600, B: 3600, C: 2200, D: 2400 }[OPT] || 2400;
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
    { id: 'landmark', label: 'lighthouse phone 28x9', cols: 28, rows: 9, crop: A.cropPhone },
    { id: 'landmark', label: 'lighthouse wide 23x16', cols: 23, rows: 16, crop: A.cropWide },
    { id: 'pet', label: 'cat phone 28x9', cols: 28, rows: 9, crop: B.cropPhone },
    { id: 'pet', label: 'cat wide 23x15', cols: 23, rows: 15, crop: B.cropWide },
    { id: 'logo', label: 'emblem 20x10', cols: 20, rows: 10, crop: C.crop },
    { id: 'portrait', label: 'portrait phone 28x9', cols: 28, rows: 9, crop: { cx: 0.5, cy: 0.36, zoom: 1.3 } },
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

// Typist intro film (dev only): 1920 x 1080, 16 s at 30 fps, every frame a pure function of t.
//   window.renderAt(t)  draws the frame for t seconds (sync); window.__done once assets are ready.
// Storyboard
//   0.0-2.6   poster: the halo figure as luminous Braille dots, wordmark and tagline; a slow push-in
//   2.6-6.0   the photo takes the art's place, then the art is typed back in over it, row by row
//   6.0-10.0  pasted where it goes: Instagram comment, X post, Telegram (js/preview.js, dark)
//   10.0-13.0 the five looks on the same art
//   13.0-16.0 end card over the dimmed art
// The art is the app's own output: createConverter on img/showcase/halo.jpg, inverted Braille (dots
// are the light parts). The big art is coloured with the photo's own colour under each dot; the
// phone screens show the plain monochrome payload exactly as formatFor() builds it.
import { createConverter, TONE_DEFAULTS, CROP_DEFAULTS, LOOKS } from '../js/convert.js';
import { BRAILLE_SLOTS } from '../js/raster.js';
import { formatFor, autoFit } from '../js/targets.js';
import { renderPreview } from '../js/preview.js';

const W = 1920, H = 1080;
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);

// ------------------------------------------------------------------------------ settings
const COLS = num('cols', 64), ROWS = num('rows', 40);   // 128 x 160 dots: the photo's own 4:5
const DW = COLS * 2, DH = ROWS * 4;
const ART_H = num('arth', 900);
const P = ART_H / DH;                 // dot pitch (px) on a uniform lattice
const ART_W = DW * P;
const DOT_R = num('dotr', 0.4);       // dot radius / pitch
const DITHER = q.get('dither') || 'atkinson';
const GLOW = num('glow', 0.5);
const SAT = num('sat', 1.12), FLOOR = num('floor', 0.5);
const POSTER_CX = 1352, CY = 540;
const HERO = q.get('look') || 'texture';   // the look of the poster / typing / end card art
const PLOOK = q.get('plook') || 'texture';   // the look of the pasted payloads

// ------------------------------------------------------------------------------ timing helpers
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const lin = (t, a, b) => clamp01((t - a) / (b - a));
const smoother = x => x * x * x * (x * (x * 6 - 15) + 10);
const ease = (t, a, b) => smoother(lin(t, a, b));
const easeOut = (t, a, b) => { const x = lin(t, a, b); return 1 - (1 - x) ** 3; };
const mix = (a, b, k) => a + (b - a) * k;
/** 0 before inA, 1 between inB and outA, 0 after outB (smooth ramps). */
const window01 = (t, inA, inB, outA, outB) => ease(t, inA, inB) * (1 - ease(t, outA, outB));

// ------------------------------------------------------------------------------ assets
const stage = document.getElementById('stage');
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const main = canvas(W, H);
stage.appendChild(main);
const ctx = main.getContext('2d');
const off = canvas(W, H);             // dots, before they are coloured and composited with a bloom
const octx = off.getContext('2d');

const img = new Image();
img.src = '../img/showcase/halo.jpg';
await img.decode();
const IW = img.naturalWidth, IH = img.naturalHeight;
const srcCv = canvas(IW, IH);
const sctx = srcCv.getContext('2d', { willReadFrequently: true });
sctx.drawImage(img, 0, 0);
// The JPEG's last row is a light seam (L 89 against 44 above it). Repeat the row above it, so the
// converter does not read it as a line of dots along the bottom edge (it did in Poster and Soft).
sctx.drawImage(srcCv, 0, IH - 3, IW, 1, 0, IH - 2, IW, 2);
const PIX = sctx.getImageData(0, 0, IW, IH).data;
// The photo as drawn in the film: its black level (about 19/255) pulled to 0, then composited with
// 'lighten', so its rectangle melts into the ground and the glow instead of showing as a box.
const photoCv = canvas(IW, IH);
{
  const pc = photoCv.getContext('2d');
  const id = pc.createImageData(IW, IH);
  const BLACK = 19, k = 255 / (255 - BLACK);
  for (let y = 0; y < IH; y++) {
    // the JPEG's last two rows are a light seam: repeat the row above them
    const sy = Math.min(y, IH - 3);
    for (let x = 0; x < IW; x++) {
      const i = (y * IW + x) * 4, j = (sy * IW + x) * 4;
      id.data[i] = (PIX[j] - BLACK) * k; id.data[i + 1] = (PIX[j + 1] - BLACK) * k; id.data[i + 2] = (PIX[j + 2] - BLACK) * k;
      id.data[i + 3] = 255;
    }
  }
  pc.putImageData(id, 0, 0);
}

// The converter crops squares: the 4:5 photo is stretched onto a square and sampled at 2c x 4r
// dots, which undoes the stretch on a uniform dot lattice (same trick as dev/hero.js).
const sq = canvas(1024, 1024);
sq.getContext('2d').drawImage(srcCv, 0, 0, 1024, 1024);
const heroConv = createConverter();
heroConv.setSource(sq);
const heroTone = look => ({ ...TONE_DEFAULTS, look, invert: true });
const GRIDS = {};
for (const l of LOOKS) GRIDS[l.id] = heroConv.run(CROP_DEFAULTS, { mode: 'braille', cols: COLS, rows: ROWS, tone: heroTone(l.id), dither: DITHER });

/** Grid -> one byte per dot of the DW x DH lattice. */
function dotsOf(grid) {
  const d = new Uint8Array(DW * DH);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const bits = grid.cp[r * COLS + c] - 0x2800;
      for (let k = 0; k < 8; k++) {
        if ((bits >> k) & 1) { const [sx, sy] = BRAILLE_SLOTS[k]; d[(4 * r + sy) * DW + 2 * c + sx] = 1; }
      }
    }
  }
  return d;
}
/**
 * The sharper looks leave a few lone specks in the outer band of the lattice (edge effects of the
 * detail filter at the crop border), which read as dust around the art. Clear a dot within 4 of
 * the border when its 5 x 5 neighbourhood holds at most 2 other dots. The hero look is untouched.
 */
function despeckle(d) {
  const out = d.slice();
  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW; x++) {
      if (!d[y * DW + x] || (x >= 4 && y >= 4 && x < DW - 4 && y < DH - 4)) continue;
      let n = 0;
      for (let v = Math.max(0, y - 2); v <= Math.min(DH - 1, y + 2); v++) {
        for (let u = Math.max(0, x - 2); u <= Math.min(DW - 1, x + 2); u++) n += d[v * DW + u];
      }
      if (n - 1 <= 2) out[y * DW + x] = 0;
    }
  }
  return out;
}
const DOTS = {};
for (const l of LOOKS) DOTS[l.id] = l.id === HERO ? dotsOf(GRIDS[l.id]) : despeckle(dotsOf(GRIDS[l.id]));
const CELL = new Uint32Array(DW * DH);   // dot -> its Braille cell (row-major, the typing order)
for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) CELL[y * DW + x] = (y >> 2) * COLS + (x >> 1);

// The photo's colour under each dot (box average of its footprint), lifted so a dot glows: the hue
// and a little extra saturation are kept, the value is raised towards a floor, so the halo stays
// golden, the robe soft olive and the hand pale.
const colour = canvas(DW, DH);
{
  const cctx = colour.getContext('2d');
  const id = cctx.createImageData(DW, DH);
  const fx = IW / DW, fy = IH / DH;
  for (let y = 0; y < DH; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < DW; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) { const o = (yy * IW + xx) * 4; r += PIX[o]; g += PIX[o + 1]; b += PIX[o + 2]; n++; }
      }
      r /= n * 255; g /= n * 255; b /= n * 255;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = Y + (r - Y) * SAT; g = Y + (g - Y) * SAT; b = Y + (b - Y) * SAT;
      const m = Math.max(r, g, b, 0.03);
      const T = FLOOR + (1 - FLOOR) * Math.pow(Math.min(1, m), 0.65);
      const k = T / m;
      const o = (y * DW + x) * 4;
      id.data[o] = Math.round(Math.min(1, Math.max(0, r * k)) * 255);
      id.data[o + 1] = Math.round(Math.min(1, Math.max(0, g * k)) * 255);
      id.data[o + 2] = Math.round(Math.min(1, Math.max(0, b * k)) * 255);
      id.data[o + 3] = 255;
    }
  }
  cctx.putImageData(id, 0, 0);
}

// Static film grain (seeded): keeps the dark gradients from banding in H.264.
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const grain = canvas(W, H);
{
  const g = grain.getContext('2d');
  const id = g.createImageData(W, H);
  const rnd = mulberry32(20260923);
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(rnd() * 255);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  grain.style.opacity = String(num('grain', 0.035));
  grain.style.mixBlendMode = 'overlay';
}

// ------------------------------------------------------------------------------ payloads (phones)
const photoConv = createConverter();
photoConv.setSource(srcCv);
const PHONES = [
  { target: 'ig', label: 'Instagram comment', crop: { x: 0.5, y: 0.43, zoom: 1.02 } },
  { target: 'x', label: 'X post', crop: { x: 0.52, y: 0.33, zoom: 1.35 } },
  { target: 'tg', label: 'Telegram', crop: { x: 0.5, y: 0.43, zoom: 1.02 } },
].map(p => {
  const fit = autoFit(p.target, 'braille');
  const grid = photoConv.run({ ...CROP_DEFAULTS, ...p.crop }, { mode: 'braille', cols: fit.cols, rows: fit.rows, tone: heroTone(PLOOK), dither: DITHER });
  const payload = formatFor(p.target, grid);
  return { ...p, grid, payload };
});

// ------------------------------------------------------------------------------ DOM
function mk(cls, html, parent = stage) {
  const e = document.createElement('div');
  e.className = 'abs ' + cls;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
}
const fmt = n => n.toLocaleString('en-US');
await document.fonts.ready;
await Promise.all([
  document.fonts.load('italic 212px "Instrument Serif"'), document.fonts.load('70px "Instrument Serif"'),
  document.fonts.load('400 25px Geist'), document.fonts.load('500 25px Geist'), document.fonts.load('400 22px "Geist Mono"'),
]);

// poster
const P_X = 168;
const wordmark = mk('wordmark', 'Typist');
const tagline = mk('tagline', 'Any photo. <em>In text.</em>');
const sub = mk('sub', 'Text art you can paste into a comment, a post or a chat.');
const meta = mk('meta', 'Instagram&ensp;·&ensp;X&ensp;·&ensp;Telegram');

// typing caption
const cap1 = mk('cap1', 'Your photo,');
const cap2 = mk('cap2', 'typed out in Braille.');
const counter = mk('counter', '');
const TOTAL_CELLS = COLS * ROWS, TOTAL_CHARS = COLS * ROWS + ROWS - 1;

// phones
const heading = mk('heading', 'Paste it into a comment, <em>a post or a chat.</em>');
const ZOOM = 1.34;
const slots = PHONES.map(p => {
  const slot = mk('slot', '');
  const phone = document.createElement('div');
  phone.className = 'phone';
  slot.appendChild(phone);
  const res = renderPreview(phone, { target: p.target, payload: p.payload, grid: p.grid, device: 'ios', theme: 'dark', phone: 390, dpr: 3 });
  if (p.target === 'x') {
    // a 280-character post leaves the X screen half empty: its reply bar at the foot balances the
    // three phones (same scenery as Instagram's "Add a comment…" row, same styles)
    const comp = document.createElement('div');
    comp.className = 'pv-igcompose';
    const av = phone.querySelector('.pv-xpost .pv-av').cloneNode(true);
    av.style.width = av.style.height = '32px';
    const field = document.createElement('i');
    field.textContent = 'Post your reply';
    comp.append(av, field);
    phone.firstChild.appendChild(comp);
  }
  const lab = document.createElement('div');
  lab.className = 'plabel';
  lab.innerHTML = `<b>${p.label}</b><span>${fmt(p.payload.count)} / ${fmt(p.payload.limit)} · <i>fits</i></span>`;
  lab.style.position = 'absolute';
  lab.style.left = '0';
  lab.style.width = (390 * ZOOM) + 'px';
  lab.style.top = (500 * ZOOM + 34) + 'px';
  slot.appendChild(lab);
  return { slot, phone, lab, res, p };
});

// looks
const looksH = mk('looks-h', 'Five looks. <em>One tap.</em>');
const lookEls = LOOKS.map(l => mk('look', `<i></i><span>${l.name}</span>`));

// end card
const eWord = mk('wordmark', 'Typist');
const eTag = mk('tagline', 'Any photo. <em>In text.</em>');
const eUrl = mk('url', 'winchxyz.github.io/typist');
const eBy = mk('by', 'by @winchxyz');

stage.appendChild(grain);
grain.style.pointerEvents = 'none';

const size = e => ({ w: e.offsetWidth, h: e.offsetHeight });
function place(e, x, y, opacity = 1, extra = '') {
  e.style.transform = `translate(${x}px, ${y}px)${extra}`;
  e.style.opacity = String(opacity);
  e.style.visibility = opacity > 0.001 ? 'visible' : 'hidden';
}

// ------------------------------------------------------------------------------ drawing
/** Art box (top-left x, y and pitch) for a centre and scale. */
const boxAt = (cx, cy, s) => ({ x: cx - (ART_W * s) / 2, y: cy - (ART_H * s) / 2, p: P * s, w: ART_W * s, h: ART_H * s });

/**
 * Dots into `off`, alpha per dot from alphaOf(i) (0..1, binned to 1/24 steps so each alpha is one
 * path), then coloured with the photo's colour field (source-in, nearest neighbour: each dot sits
 * inside its own lattice square) and composited onto the frame with a soft bloom.
 */
function drawDots(box, alphaOf, layerAlpha = 1, bloom = GLOW) {
  if (layerAlpha <= 0.001) return;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.globalCompositeOperation = 'source-over';
  octx.globalAlpha = 1;
  octx.clearRect(0, 0, W, H);
  const BINS = 24;
  const bins = Array.from({ length: BINS + 1 }, () => []);
  for (let i = 0; i < DW * DH; i++) {
    const a = alphaOf(i);
    if (a <= 0.02) continue;
    bins[Math.round(clamp01(a) * BINS)].push(i);
  }
  const r = DOT_R * box.p;
  octx.fillStyle = '#fff';
  for (let b = 1; b <= BINS; b++) {
    const list = bins[b];
    if (!list.length) continue;
    octx.globalAlpha = b / BINS;
    octx.beginPath();
    for (const i of list) {
      const cx = box.x + ((i % DW) + 0.5) * box.p, cy = box.y + (Math.floor(i / DW) + 0.5) * box.p;
      octx.moveTo(cx + r, cy);
      octx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    octx.fill();
  }
  octx.globalAlpha = 1;
  octx.globalCompositeOperation = 'source-in';
  octx.imageSmoothingEnabled = false;
  octx.drawImage(colour, box.x, box.y, box.w, box.h);
  octx.globalCompositeOperation = 'source-over';

  ctx.save();
  if (bloom > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${(box.p * 2.2).toFixed(2)}px)`;
    ctx.globalAlpha = bloom * layerAlpha;
    ctx.drawImage(off, 0, 0);
    ctx.filter = 'none';
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = layerAlpha;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}

/** A warm glow behind the halo and a darker olive one behind the figure. */
function drawGround(box, k) {
  ctx.fillStyle = '#0b0a09';
  ctx.fillRect(0, 0, W, H);
  if (k <= 0) return;
  const hx = box.x + box.w * 0.53, hy = box.y + box.h * 0.14;
  let g = ctx.createRadialGradient(hx, hy, 0, hx, hy, box.w * 0.75);
  g.addColorStop(0, `rgba(214, 180, 70, ${0.075 * k})`);
  g.addColorStop(1, 'rgba(214, 180, 70, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const fx = box.x + box.w * 0.45, fy = box.y + box.h * 0.62;
  g = ctx.createRadialGradient(fx, fy, 0, fx, fy, box.w * 0.9);
  g.addColorStop(0, `rgba(96, 104, 60, ${0.07 * k})`);
  g.addColorStop(1, 'rgba(96, 104, 60, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

const staticAlpha = d => i => d[i];
/**
 * E: the dots under the end card's words fade a little more (a soft ellipse around the text
 * block), so the small lines (url, by) read cleanly while the halo above the wordmark keeps its
 * glow. Done per dot rather than as a canvas scrim, which darkened the ground into a visible oval.
 */
function scrimOf(box, e) {
  if (e <= 0) return () => 1;
  return i => {
    const x = box.x + ((i % DW) + 0.5) * box.p - 960;
    const y = (box.y + (Math.floor(i / DW) + 0.5) * box.p - 556) / 0.6;
    const r = Math.sqrt(x * x + y * y) / 560;
    const depth = r >= 1 ? 0 : r < 0.55 ? mix(0.5, 0.34, r / 0.55) : mix(0.34, 0, smoother((r - 0.55) / 0.45));
    return 1 - depth * e;
  };
}
const crossAlpha = (a, b, k) => i => (a[i] && b[i] ? 1 : a[i] ? 1 - k : b[i] ? k : 0);

// ------------------------------------------------------------------------------ the timeline
const T_TYPE0 = 3.45, T_TYPE1 = 5.75;       // typing
const LOOK_T = [10.0, 10.62, 11.24, 11.86, 12.48];   // each look's start
const PH_T = [6.3, 6.75, 7.2];               // phone entries

/** Typed cells (fractional) at t: a steady rhythm that eases in and out a little. */
function typedAt(t) {
  const x = lin(t, T_TYPE0, T_TYPE1);
  return TOTAL_CELLS * mix(x, smoother(x), 0.35);
}

/** Which look is shown at t and the crossfade to the next one. */
function lookAt(t) {
  let i = 0;
  for (let k = 0; k < LOOK_T.length; k++) if (t >= LOOK_T[k] - 0.1) i = k;
  // crossfade 0.2 s centred on each boundary
  const next = LOOK_T[i + 1];
  const k = next ? ease(t, next - 0.1, next + 0.1) : 0;
  return { i, k };
}

function renderAt(t) {
  // ---- where the art is and what it shows
  let cx = POSTER_CX, s = 1, artA = 1;
  // A: push-in, carried through the typing
  s = 1 + 0.045 * ease(t, 0.7, 3.3);
  // B -> C: the art steps back and fades
  artA *= 1 - ease(t, 5.95, 6.4);
  s -= 0.03 * ease(t, 5.95, 6.4);
  // D: back at scale 1 on the right
  if (t >= 9.5) { s = 1; artA = ease(t, 9.95, 10.4); }
  // E: to the centre, dimmed, a slow push-in
  const e = ease(t, 12.95, 13.85);
  cx = mix(cx, 960, e);
  s *= mix(1, 1.06, e) * (1 + 0.025 * ease(t, 13.85, 16));
  artA *= mix(1, 0.3, e);
  const box = boxAt(cx, CY, s);

  drawGround(box, artA * (1 - 0.6 * e));

  // ---- B: the photo in the art's place, then typed back in
  const photoA = ease(t, 2.75, 3.35) * (t < 6.5 ? 1 : 0);
  const n = typedAt(t);
  if (photoA > 0 && artA > 0) {
    ctx.save();
    const row = Math.min(ROWS, Math.floor(n / COLS)), inRow = n - row * COLS;
    ctx.beginPath();
    if (row < ROWS) {
      ctx.rect(box.x + inRow * 2 * box.p, box.y + row * 4 * box.p, box.w - inRow * 2 * box.p, 4 * box.p);
      ctx.rect(box.x, box.y + (row + 1) * 4 * box.p, box.w, box.h - (row + 1) * 4 * box.p);
    }
    ctx.clip();
    ctx.globalAlpha = photoA * artA;
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(photoCv, box.x, box.y, box.w, box.h);
    ctx.restore();
  }

  // ---- dots
  if (t < 9.5) {
    const hero = DOTS[HERO];
    if (t < T_TYPE0 - 0.01) {
      // A and the fade into the photo: the full art, fading out as the photo arrives
      drawDots(box, staticAlpha(hero), artA * (1 - photoA));
    } else {
      // typing: a cell's dots come up over its last 5 cells of travel
      drawDots(box, i => (hero[i] ? clamp01((n - CELL[i]) / 5) : 0), artA);
    }
    // the carriage
    if (t >= T_TYPE0 && n < TOTAL_CELLS) {
      const c = Math.floor(n) % COLS, r = Math.floor(Math.floor(n) / COLS);
      ctx.save();
      ctx.fillStyle = '#e7c552';
      ctx.shadowColor = 'rgba(231, 197, 82, 0.8)';
      ctx.shadowBlur = 14;
      ctx.globalAlpha = artA;
      ctx.fillRect(box.x + c * 2 * box.p + 0.5, box.y + r * 4 * box.p + 1, 2 * box.p - 1, 4 * box.p - 2);
      ctx.restore();
    }
  } else {
    const { i, k } = lookAt(t);
    let a = DOTS[LOOKS[i].id], b = LOOKS[i + 1] ? DOTS[LOOKS[i + 1].id] : a;
    let kk = k;
    // E: back from Poster to Photo for the end card
    if (t > 12.9) { a = DOTS.poster; b = DOTS[HERO]; kk = ease(t, 12.95, 13.45); }
    const base = crossAlpha(a, b, kk), veil = scrimOf(box, e);
    drawDots(box, i => base(i) * veil(i), artA, GLOW * mix(1, 0.6, e));
  }

  // ---- DOM layers
  // A: poster text
  // out before the caption comes in: the two share the left column and must never overlap
  const pA = 1 - ease(t, 2.5, 2.95), pY = -14 * ease(t, 2.5, 2.95);
  place(meta, P_X + 4, 304 + pY, pA);
  place(wordmark, P_X - 8, 352 + pY, pA);
  place(tagline, P_X, 598 + pY, pA);
  place(sub, P_X + 2, 700 + pY, pA);

  // B: caption and counter
  const c1 = window01(t, 3.0, 3.5, 5.85, 6.25), c2 = window01(t, 3.5, 4.0, 5.85, 6.25);
  place(cap1, P_X, 396 + 10 * (1 - ease(t, 3.0, 3.5)), c1);
  place(cap2, P_X, 486 + 10 * (1 - ease(t, 3.5, 4.0)), c2);
  const typedCells = Math.min(TOTAL_CELLS, Math.floor(n));
  const typedChars = typedCells + Math.min(ROWS - 1, Math.floor(typedCells / COLS));
  counter.innerHTML = `<b>${fmt(typedChars).padStart(5, ' ')}</b> characters&ensp;·&ensp;${COLS} × ${ROWS}`;
  place(counter, P_X + 2, 626, window01(t, 3.3, 3.7, 5.85, 6.25));

  // C: phones
  const hA = window01(t, 6.1, 6.6, 9.55, 9.95);
  const hs = size(heading);
  place(heading, (W - hs.w) / 2, 96 + 10 * (1 - ease(t, 6.1, 6.6)) - 12 * ease(t, 9.55, 9.95), hA);
  const slotW = 390 * ZOOM, gap = 70, x0 = (W - (3 * slotW + 2 * gap)) / 2;
  slots.forEach((sl, k) => {
    const a = window01(t, PH_T[k], PH_T[k] + 0.55, 9.5 + 0.06 * k, 9.9 + 0.06 * k);
    const y = 196 + 70 * (1 - easeOut(t, PH_T[k], PH_T[k] + 0.9)) - 16 * ease(t, 9.5 + 0.06 * k, 9.9 + 0.06 * k);
    place(sl.slot, x0 + k * (slotW + gap), y, a);
    sl.lab.style.opacity = String(ease(t, PH_T[k] + 0.3, PH_T[k] + 0.8));
  });

  // D: looks
  const lA = window01(t, 10.0, 10.45, 12.85, 13.25);
  place(looksH, P_X, 318 + 10 * (1 - ease(t, 10.0, 10.45)), lA);
  const cur = lookAt(t);
  lookEls.forEach((el, k) => {
    // active: bright with its gold dot; a crossfade moves both together
    const on = k === cur.i ? 1 - cur.k : k === cur.i + 1 ? cur.k : 0;
    el.style.color = `rgba(241, 236, 226, ${0.34 + 0.66 * on})`;
    el.firstChild.style.opacity = String(on);
    el.firstChild.style.transform = `scale(${0.4 + 0.6 * on})`;
    place(el, P_X + 2, 452 + k * 64 + 8 * (1 - ease(t, 10.1 + 0.05 * k, 10.55 + 0.05 * k)), lA * ease(t, 10.1 + 0.05 * k, 10.55 + 0.05 * k));
  });

  // E: end card
  const ew = size(eWord), et = size(eTag), eu = size(eUrl), eb = size(eBy);
  const rise = (a, b) => 12 * (1 - ease(t, a, b));
  // the words start once the art has mostly dimmed, so the wordmark never ghosts over bright dots
  place(eWord, (W - ew.w) / 2 - 6, 318 + rise(13.5, 14.1), ease(t, 13.5, 14.1));
  place(eTag, (W - et.w) / 2, 560 + rise(13.7, 14.3), ease(t, 13.7, 14.3));
  place(eUrl, (W - eu.w) / 2, 694 + rise(14.0, 14.6), ease(t, 14.0, 14.6));
  place(eBy, (W - eb.w) / 2, 748 + rise(14.15, 14.75), ease(t, 14.15, 14.75));
}

window.renderAt = renderAt;
window.introInfo = {
  cols: COLS, rows: ROWS, pitch: P, artW: ART_W, artH: ART_H,
  payloads: PHONES.map(p => ({ target: p.target, cols: p.payload.cols, rows: p.payload.rows, count: p.payload.count, limit: p.payload.limit, fits: p.payload.fits, wraps: p.payload.wraps })),
  phoneH: slots.map(s => s.phone.firstChild.scrollHeight),
  ink: Object.fromEntries(LOOKS.map(l => [l.id, +GRIDS[l.id].ink.toFixed(3)])),
};
renderAt(q.has('t') ? +q.get('t') : 0);
window.__done = { ok: true, ...window.introInfo };

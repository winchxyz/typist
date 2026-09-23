// Glyph shape-vector generator (dev only). Renders every ASCII_CHARSET glyph into a cell of the
// code-block aspect (CELL_ASPECT) the way a browser lays out a line box, measures the matcher's
// sampling circles (circleWeights, the same function the matcher uses) and whole-cell coverage, picks a
// density ramp from the measured coverage, and saves the module text to shots/shape-vectors.js.
import { ASCII_CHARSET, CELL_ASPECT, CIRCLES, CIRCLE_R, DIMS, GEOMETRY_KEY, GRID, SHIFTS, circleWeights } from '../js/ascii.js';

const q = new URLSearchParams(location.search);
const log = (...a) => { document.getElementById('log').textContent += a.join(' ') + '\n'; };
const EM = 240;   // render size; the cell is ~150 x 320 px, plenty for 6 circle means

// Phone code-block fonts we cannot load here (em-relative, from their font tables):
// Menlo (iOS / macOS Telegram, = DejaVu Sans Mono metrics) and Roboto Mono (Android).
const PHONE = {
  'Menlo': { adv: 0.602, cap: 0.729, xh: 0.547 },
  'Roboto Mono': { adv: 0.600, cap: 0.711, xh: 0.528 },
};
const CANDIDATES = ['Consolas', 'Lucida Console', 'Geist Mono', 'Cascadia Mono', 'Ubuntu Mono', 'Courier New'];

const ctx2 = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d', { willReadFrequently: true });
};

function installed(family) {
  const g = ctx2(10, 10);
  const probe = 'mmmmmmmmmmlli10OQ';
  g.font = '72px serif';
  const a = g.measureText(probe).width;
  g.font = `72px "${family}", serif`;
  return Math.abs(g.measureText(probe).width - a) > 0.5;
}

function metrics(family) {
  const g = ctx2(10, 10);
  g.font = `${EM}px "${family}"`;
  const m = g.measureText('H'), x = g.measureText('x'), M = g.measureText('M'), i = g.measureText('i');
  return {
    family,
    adv: M.width / EM,
    mono: Math.abs(M.width - i.width) < 0.01,
    cap: m.actualBoundingBoxAscent / EM,
    xh: x.actualBoundingBoxAscent / EM,
    asc: m.fontBoundingBoxAscent / EM,
    desc: m.fontBoundingBoxDescent / EM,
  };
}

// Proportions that decide where ink lands in the cell: cap and x-height relative to the advance.
function phoneDistance(m) {
  let d = 0;
  for (const p of Object.values(PHONE)) {
    d += (m.cap / m.adv - p.cap / p.adv) ** 2 + (m.xh / m.adv - p.xh / p.adv) ** 2 + (m.adv - p.adv) ** 2;
  }
  return Math.sqrt(d / Object.keys(PHONE).length);
}

const found = CANDIDATES.filter(installed).map(metrics).filter(m => m.mono);
for (const m of found) m.dist = phoneDistance(m);
found.sort((a, b) => a.dist - b.dist);
for (const m of found) {
  log(`${m.family.padEnd(15)} adv ${m.adv.toFixed(3)}  cap ${m.cap.toFixed(3)}  x ${m.xh.toFixed(3)}  ` +
      `asc ${m.asc.toFixed(3)}  desc ${m.desc.toFixed(3)}  cap/adv ${(m.cap / m.adv).toFixed(3)}  ` +
      `x/adv ${(m.xh / m.adv).toFixed(3)}  dist-to-phone ${m.dist.toFixed(3)}`);
}
const font = q.get('font') ? metrics(q.get('font')) : found[0];
log('chosen:', font.family);

// Cell: advance wide, advance / CELL_ASPECT tall; the glyph's font box is centred in the line box
// (CSS half-leading), which is how a <pre> / code block places it.
const cellW = Math.round(font.adv * EM);
const cellH = Math.round(cellW / CELL_ASPECT);
const size = EM * cellW / (font.adv * EM);   // font size that makes the advance exactly cellW
const baseline = (cellH - (font.asc + font.desc) * size) / 2 + font.asc * size;
const lineEm = cellH / size;
log(`cell ${cellW} x ${cellH} px at ${size.toFixed(1)} px font, line-height ${lineEm.toFixed(3)} em, baseline ${baseline.toFixed(1)} px`);

const g = ctx2(cellW, cellH);
g.font = `${size}px "${font.family}"`;
g.textBaseline = 'alphabetic';
g.textAlign = 'left';
g.fillStyle = '#000';
const circ = circleWeights(cellW, cellH, 1);
const glyphs = Array.from(ASCII_CHARSET);
const rawVec = [], coverage = [], alphas = [], shifted = [];
const measure = (ch, dx) => {
  g.clearRect(0, 0, cellW, cellH);
  g.fillText(ch, dx * cellW, baseline);
  const a = g.getImageData(0, 0, cellW, cellH).data;
  const ink = new Float32Array(cellW * cellH);
  for (let p = 0; p < ink.length; p++) ink[p] = a[p * 4 + 3] / 255;
  return { ink, vec: circ.map(({ px, wt }) => { let t = 0; for (let k = 0; k < px.length; k++) t += wt[k] * ink[px[k]]; return t; }) };
};
for (const ch of glyphs) {
  const { ink, vec } = measure(ch, 0);
  coverage.push(ink.reduce((t, v) => t + v, 0) / ink.length);
  rawVec.push(vec);
  alphas.push(ink);
  // Sideways-shifted copies (clipped to the cell) stand for the same glyph: a line a quarter cell
  // off-centre is still read as '|', not as 'L'.
  shifted.push(SHIFTS.map(dx => (dx ? measure(ch, dx).vec : vec)));
}
// Raw ink per circle (0..1). Harri normalises each dimension by its maximum over the set; the
// matcher here compares unit directions and a separate tone term instead, and a per-dimension
// scale would bend the directions.
const dimMax = Array.from({ length: DIMS }, (_, k) => Math.max(...rawVec.map(v => v[k])));
const vectors = shifted;
const vmaxAll = Math.max(...dimMax);
log('circle max ink:', dimMax.map(v => v.toFixed(3)).join(' '));

// Ramp: evenly spaced coverage levels from the densest "blobby" glyph down to space. Glyphs with a
// strong direction ( _ | / \ ( ) [ ] { } < > ^ ' " , ) would draw false edges in flat tone, and
// letters / digits read as text, so they are used only when no symbol is near a level.
const DIRECTIONAL = new Set(Array.from('_|/\\()[]{}<>^\'",!'));
const isSymbol = ch => !/[A-Za-z0-9]/.test(ch);
// Letters allowed as a fallback: round or symmetric ones without ascenders / descenders that
// read as texture rather than words.
const BLOBBY = new Set(Array.from('oexzcsvunmwaOXBMWNQ08'));
const pool = glyphs.map((ch, i) => ({ ch, cov: coverage[i] }))
  .filter(o => !DIRECTIONAL.has(o.ch) && (isSymbol(o.ch) || BLOBBY.has(o.ch)));
const cmax = Math.max(...pool.map(o => o.cov));
const LEVELS = 12;
const ramp = [];
const step = cmax / (LEVELS - 1);
for (let l = 0; l < LEVELS; l++) {
  const target = cmax - l * step;
  const free = pool.filter(o => !ramp.includes(o.ch));
  const near = (list) => list.reduce((b, o) => (Math.abs(o.cov - target) < Math.abs(b.cov - target) ? o : b));
  const sym = free.filter(o => isSymbol(o.ch));
  let pick = near(sym);
  if (Math.abs(pick.cov - target) > 0.6 * step) pick = near(free);
  ramp.push(pick.ch);
}
const rampStr = ramp.join('');
log('ramp:', JSON.stringify(rampStr), ramp.map(ch => coverage[glyphs.indexOf(ch)].toFixed(3)).join(' '));

// Module text (LF only).
const r4 = v => (Math.round(v * 1e4) / 1e4).toString();
const lines = [];
lines.push('// Generated by dev/shapes.html from the installed font below; do not edit by hand.');
lines.push(`// VECTORS: ${DIMS} numbers per glyph = mean ink (0..1) under the ${GRID[0]} x ${GRID[1]} sampling circles of`);
lines.push('// js/ascii.js (row-major, top row first); one row per SHIFTS entry (glyph drawn that fraction of');
lines.push('// a cell sideways). COVERAGE: ink fraction of the cell.');
lines.push('// Font choice: the installed monospace closest to phone code-block fonts (Menlo on iOS, Roboto');
lines.push('// Mono on Android) in advance, cap height and x-height; see dev/shapes.html for the table.');
lines.push(`export const FONT = ${JSON.stringify({
  family: font.family, advanceEm: +font.adv.toFixed(4), capEm: +font.cap.toFixed(4), xHeightEm: +font.xh.toFixed(4),
  ascentEm: +font.asc.toFixed(4), descentEm: +font.desc.toFixed(4), lineEm: +lineEm.toFixed(4),
  cellPx: [cellW, cellH], renderer: navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] || 'unknown',
})};`);
lines.push(`export const GEOMETRY_KEY = ${JSON.stringify(GEOMETRY_KEY)};`);
lines.push(`export const GLYPHS = ${JSON.stringify(ASCII_CHARSET)};`);
lines.push(`export const SHIFTS = ${JSON.stringify(SHIFTS)};`);
lines.push('export const VECTORS = [');
glyphs.forEach((ch, i) => vectors[i].forEach((v, j) => lines.push(`  ${v.map(r4).join(', ')}, // ${JSON.stringify(ch)} ${SHIFTS[j]}`)));
lines.push('];');
lines.push('export const COVERAGE = [');
for (let i = 0; i < glyphs.length; i += 12) lines.push('  ' + coverage.slice(i, i + 12).map(r4).join(', ') + ',');
lines.push('];');
lines.push(`export const RAMP = ${JSON.stringify(rampStr)};   // dark -> light, evenly spaced measured coverage`);
const text = lines.join('\n') + '\n';

// Contact sheet: every glyph cell with its circles, shaded by the normalised vector.
const COLS = 16, PAD = 6;
const tw = Math.round(cellW / 2), th = Math.round(cellH / 2);
const sheet = document.createElement('canvas');
const sheetRows = Math.ceil(glyphs.length / COLS);
sheet.width = COLS * (tw + PAD) + PAD; sheet.height = sheetRows * (th + PAD) + PAD + 40;
document.body.appendChild(sheet);
const s = sheet.getContext('2d');
s.fillStyle = '#fff'; s.fillRect(0, 0, sheet.width, sheet.height);
glyphs.forEach((ch, i) => {
  const x0 = PAD + (i % COLS) * (tw + PAD), y0 = PAD + Math.floor(i / COLS) * (th + PAD);
  const img = s.createImageData(cellW, cellH);
  const al = alphas[i];
  for (let p = 0; p < al.length; p++) {
    const v = 255 - al[p] * 230;
    img.data[p * 4] = v; img.data[p * 4 + 1] = v; img.data[p * 4 + 2] = v; img.data[p * 4 + 3] = 255;
  }
  const tmp = ctx2(cellW, cellH); tmp.putImageData(img, 0, 0);
  s.drawImage(tmp.canvas, x0, y0, tw, th);
  s.strokeStyle = '#ccc'; s.strokeRect(x0 + 0.5, y0 + 0.5, tw - 1, th - 1);
  CIRCLES.forEach(([cx, cy], k) => {
    s.beginPath();
    s.arc(x0 + cx * tw, y0 + cy * tw, CIRCLE_R * tw, 0, Math.PI * 2);
    s.fillStyle = `rgba(220, 60, 40, ${0.55 * vectors[i][0][k] / vmaxAll})`;
    s.fill();
    s.strokeStyle = 'rgba(220, 60, 40, 0.5)'; s.stroke();
  });
});
s.fillStyle = '#17171a'; s.font = '16px system-ui';
s.fillText(`${font.family}  cell ${cellW}x${cellH}  ramp ${rampStr}`, PAD, sheet.height - 14);

const save = q.get('save') !== '0';
const results = {};
if (save) {
  results.module = await (await fetch('/__file?name=shape-vectors.js', { method: 'POST', body: text })).json();
  results.sheet = await (await fetch('/__shot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ascii_glyphs', data: sheet.toDataURL('image/png') }),
  })).json();
}
window.__done = {
  ok: true, font: font.family, fonts: found.map(m => ({ family: m.family, dist: +m.dist.toFixed(3), adv: +m.adv.toFixed(3) })),
  cell: [cellW, cellH], ramp: rampStr, dimMax: dimMax.map(v => +v.toFixed(3)), saved: save,
};

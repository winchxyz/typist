// Typist lab: contact sheets that show the converter, formatters and raster together.
//   sheet=modes    4 samples x 8 encodings at w columns        -> shots/lab_modes.png (+ per sample)
//   sheet=targets  each sample formatted for each target        -> shots/lab_targets.png (+ per sample)
//   sheet=perf     converter timings, fresh crop + tone change  -> shots/lab_perf_<engine><tag>.json
//   sheet=raster   pixel checks of js/raster.js drawGrid          -> shots/lab_raster.png
// Everything drawn goes through js/raster.js drawGrid, the same code the PNG export and film use.
import { createConverter, sampleSize } from '../js/convert.js';
import { sampleImage } from '../js/tone.js';
import { SAMPLES, loadSample } from '../js/samples.js';
import { drawGrid, gridFromText, brailleGeometry, BLOCK_MASK } from '../js/raster.js';

const q = new URLSearchParams(location.search);
const SHEET = q.get('sheet') || 'modes';
const SAVE = q.get('save') !== '0';
const TAG = (q.get('tag') || '').replace(/[^a-z0-9_-]/gi, '');
const ENGINE = /Firefox/.test(navigator.userAgent) ? 'firefox'
  : /Chrome/.test(navigator.userAgent) ? 'chromium' : 'webkit';
const INK = '#17171a', PAPER = '#ffffff', BG = '#eceae4', MUTED = '#6b6962', RED = '#c0392b', AMBER = '#b7791f';
const MONO = '"Geist Mono", "Cascadia Mono", Consolas, monospace';
const UI = '600 13px system-ui, sans-serif', SMALL = '12px system-ui, sans-serif';
const logEl = document.getElementById('log');
const log = s => { logEl.textContent += s + '\n'; console.log(s); };

// targets.js (formatters) is built in parallel; the sheets say so loudly when it is missing and
// fall back to a local estimate, so the raster and converter can still be judged.
let T = null, tErr = null;
try { T = await import('../js/targets.js'); } catch (e) { tErr = e; }

const ASPECT = { braille: 0.55, ascii: 0.46, blocks: 0.5 };
function aspectFor(target, mode) {
  try { const a = T && T.cellAspect(target, mode); if (a > 0) return a; } catch { /* fallback */ }
  return ASPECT[mode];
}
const rowsFor = (cols, a) => (T && T.rowsFor ? T.rowsFor(cols, a) : Math.max(1, Math.round(cols * a)));

const MODES = [
  { label: 'Braille · atkinson', mode: 'braille', dither: 'atkinson' },
  { label: 'Braille · floyd', mode: 'braille', dither: 'floyd' },
  { label: 'Braille · bayer', mode: 'braille', dither: 'bayer' },
  { label: 'Braille · threshold', mode: 'braille', dither: 'threshold' },
  { label: 'ASCII · shape', mode: 'ascii', ascii: 'shape' },
  { label: 'ASCII · ramp', mode: 'ascii', ascii: 'ramp' },
  { label: 'Blocks · colour quad', mode: 'blocks', blocks: 'quad', color: true },
  { label: 'Blocks · mono quad', mode: 'blocks', blocks: 'quad', color: false, dither: 'atkinson' },
];

async function save(name, canvas) {
  if (!SAVE) return;
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: canvas.toDataURL('image/png') }) });
  if (!r.ok) throw new Error('save failed ' + r.status);
}
async function saveFile(name, text) {
  if (!SAVE) return;
  await fetch('/__file?name=' + encodeURIComponent(name), { method: 'POST', body: text });
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, c.width, c.height);
  return [c, ctx];
}
function text(ctx, s, x, y, font = SMALL, color = INK) { ctx.font = font; ctx.fillStyle = color; ctx.fillText(s, x, y); }
function wrap(ctx, s, x, y, maxW, lh, font = SMALL, color = INK) {
  ctx.font = font; ctx.fillStyle = color;
  let line = '';
  for (const w of s.split(' ')) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = w; } else line = t;
  }
  if (line) { ctx.fillText(line, x, y); y += lh; }
  return y;
}

async function loadAll() {
  const out = [];
  for (const s of SAMPLES) out.push({ ...s, bmp: await loadSample(s.id) });
  return out;
}

// ---------------------------------------------------------------- modes
async function sheetModes() {
  const cols = +(q.get('w') || 40), PW = +(q.get('pw') || 320), GAP = 16, HEAD = 34, FOOT = 22;
  const samples = await loadAll();
  const panels = [];   // [sample][mode] -> { grid, ms, err, cellW, cellH }
  for (const s of samples) {
    const conv = createConverter();
    conv.setSource(s.bmp);
    const row = [];
    for (const m of MODES) {
      const a = aspectFor(m.mode === 'ascii' ? 'tg' : 'plain', m.mode);
      const rows = rowsFor(cols, a);
      const cellW = PW / cols, cellH = cellW / a;
      try {
        const t0 = performance.now();
        const grid = conv.run({}, { ...m, cols, rows });
        row.push({ grid, ms: performance.now() - t0, cellW, cellH });
      } catch (e) { row.push({ err: e.message, cellW, cellH, rows }); }
    }
    panels.push(row);
  }
  const panelH = Math.max(...panels.flat().map(p => (p.grid ? p.grid.rows : p.rows) * p.cellH));
  const cellBlock = (PW + GAP), rowBlock = HEAD + panelH + FOOT + GAP;

  const paint = (ctx, s, row, x0, y0, perRow) => {
    // the photo first, then the encodings, wrapping after perRow panels
    const items = [{ photo: true }, ...row.map((p, i) => ({ ...p, m: MODES[i] }))];
    items.forEach((it, i) => {
      const x = x0 + (i % perRow) * cellBlock, y = y0 + Math.floor(i / perRow) * rowBlock;
      if (it.photo) {
        text(ctx, `${s.name} (${s.id})`, x, y + 20, UI);
        ctx.drawImage(s.bmp, x, y + HEAD, PW, PW);
        text(ctx, 'source 1024 px, full square crop', x, y + HEAD + PW + 16, SMALL, MUTED);
        return;
      }
      text(ctx, it.m.label, x, y + 20, UI);
      if (it.err) { wrap(ctx, 'ERROR ' + it.err, x, y + HEAD + 16, PW, 16, SMALL, RED); return; }
      const g = it.grid;
      const paper = g.mode === 'blocks' && g.fg ? null : PAPER;
      drawGrid(ctx, g, { x, y: y + HEAD, cellW: it.cellW, cellH: it.cellH, ink: INK, paper, font: MONO });
      text(ctx, `${g.cols}×${g.rows}  ink ${(g.ink * 100).toFixed(0)}%  ${it.ms.toFixed(1)} ms`,
        x, y + HEAD + g.rows * it.cellH + 16, SMALL, MUTED);
    });
  };

  const [c, ctx] = canvas(GAP + 9 * cellBlock, GAP + samples.length * rowBlock + 30);
  text(ctx, `Typist lab · modes · ${cols} columns · ${ENGINE} · cell aspects braille ${aspectFor('plain', 'braille')}` +
    ` ascii ${aspectFor('tg', 'ascii')} blocks ${aspectFor('plain', 'blocks')}` + (T ? '' : '  (targets.js missing: fallback aspects)'),
  GAP, 24, UI);
  samples.forEach((s, i) => paint(ctx, s, panels[i], GAP, 30 + GAP + i * rowBlock, 9));
  document.getElementById('out').appendChild(c);
  const base = cols === 40 ? 'lab_modes' : `lab_modes_w${cols}`;   // the SPEC sheet stays at w=40
  await save(base, c);
  // per-sample 3 x 3 zoom sheets: small enough to inspect at full resolution
  for (let i = 0; i < samples.length; i++) {
    const [z, zctx] = canvas(GAP + 3 * cellBlock, GAP + 3 * rowBlock);
    paint(zctx, samples[i], panels[i], GAP, GAP, 3);
    await save(`${base}_${samples[i].id}`, z);
  }
  const summary = panels.map((row, i) => samples[i].id + ': ' +
    row.map((p, j) => `${MODES[j].label.replace(/ · /, '/')}=${p.err ? 'ERR' : (p.grid.ink * 100).toFixed(0) + '%'}`).join(' '));
  return { ok: panels.flat().every(p => !p.err), sheet: 'modes', summary, errors: panels.flat().filter(p => p.err).map(p => p.err) };
}

// ---------------------------------------------------------------- targets
const CASES = [
  { key: 'ig', target: 'ig', mode: 'braille', label: 'Instagram comment' },
  { key: 'x', target: 'x', mode: 'braille', label: 'X post (free)' },
  { key: 'xlong', target: 'xlong', mode: 'braille', label: 'X long post' },
  { key: 'tg', target: 'tg', mode: 'braille', label: 'Telegram · Braille' },
  { key: 'tga', target: 'tg', mode: 'ascii', label: 'Telegram · ASCII fenced' },
  { key: 'tgc', target: 'tgc', mode: 'braille', label: 'Telegram caption', opts: { caption: true } },
];

// Only used when targets.js is missing: the SPEC's limits and counters, no warnings logic beyond
// over-budget / fold, flagged on the sheet as an estimate.
const FALLBACK = {
  ig: { limit: 2200, weight: 1, maxCols: 28 }, x: { limit: 280, weight: 2, maxCols: 30 },
  xlong: { limit: 25000, weight: 2, maxCols: 30, fold: 280 }, tg: { limit: 4096, weight: 1, maxCols: 34 },
  tgc: { limit: 1024, weight: 1, maxCols: 34 },
};
function fallbackFit(c) {
  const f = FALLBACK[c.target], a = ASPECT[c.mode], fence = c.mode === 'ascii' ? 8 : 0;
  const maxC = c.mode === 'ascii' ? 38 : f.maxCols;
  for (let cols = maxC; cols >= 4; cols--) {
    const rows = rowsFor(cols, a);
    if (f.weight * cols * rows + rows - 1 + fence <= f.limit) return { cols, rows };
  }
  return { cols: 4, rows: rowsFor(4, a) };
}
function fallbackFormat(c, grid) {
  const f = FALLBACK[c.target];
  let lines = [];
  for (let r = 0; r < grid.rows; r++) {
    let s = '';
    for (let i = 0; i < grid.cols; i++) s += String.fromCodePoint(grid.cp[r * grid.cols + i]);
    lines.push(s);
  }
  if (c.mode === 'ascii') lines = lines.map(l => l.replace(/`/g, ' '));
  const body = lines.join('\n');
  const t = c.mode === 'ascii' ? '```\n' + body + '\n```' : body;
  const count = c.mode === 'ascii' ? t.length : f.weight * grid.cols * grid.rows + grid.rows - 1;
  const warnings = [{ level: 'warn', message: 'targets.js missing: local estimate, not the real formatter' }];
  if (count > f.limit) warnings.push({ level: 'error', message: 'over budget' });
  if (f.fold) warnings.push({ level: 'info', message: `timeline folds after ~${f.fold}` });
  return { text: t, count, limit: f.limit, fits: count <= f.limit, warnings, cols: grid.cols, rows: grid.rows };
}

// Cell size on a 390 px phone: FIT when targets.js provides it (fontPx x cellEm, lineEm), else scale
// the art to the bubble width.
function phoneCell(c, fit, bubbleW) {
  try {
    const f = T && T.FIT && (T.FIT[c.target]?.[c.mode] || T.FIT[c.target]);
    if (f && f.fontPx && f.cellEm) {
      const cellW = f.fontPx * f.cellEm;
      return { cellW, cellH: f.lineEm ? f.fontPx * f.lineEm : cellW / aspectFor(c.target, c.mode), fromFit: true };
    }
  } catch { /* fallback */ }
  const cellW = Math.min(bubbleW / fit.cols, 12);
  return { cellW, cellH: cellW / aspectFor(c.target, c.mode), fromFit: false };
}

async function sheetTargets() {
  const FW = 390, GAP = 18, PAD = 12, BUBBLE = FW - 2 * PAD - 24;
  const samples = await loadAll();
  const cells = [];   // [sample][case]
  for (const s of samples) {
    const conv = createConverter();
    conv.setSource(s.bmp);
    const row = [];
    for (const c of CASES) {
      try {
        const opts = { phone: 390, ...(c.opts || {}) };
        const fit = T ? T.autoFit(c.target, c.mode, opts) : fallbackFit(c);
        const grid = conv.run({}, { mode: c.mode, cols: fit.cols, rows: fit.rows, dither: 'atkinson', ascii: 'shape' });
        const out = T ? T.formatFor(c.target, grid, opts) : fallbackFormat(c, grid);
        // draw the payload itself: fences stripped, everything else exactly as pasted
        let body = out.text;
        if (c.mode === 'ascii') body = body.replace(/^```\n/, '').replace(/\n```$/, '');
        const shown = gridFromText(body, c.mode);
        const checks = [];
        if (/\r/.test(out.text)) checks.push('CR in payload');
        if (/[﻿￾￿]/.test(out.text)) checks.push('BOM/nonchar in payload');
        if (c.mode === 'braille' && / /.test(out.text)) checks.push('U+0020 in Braille payload');
        if (c.mode === 'ascii' && /`/.test(body)) checks.push('backtick inside fence');
        if (out.text.endsWith('\n')) checks.push('trailing newline');
        row.push({ fit, grid, out, shown, checks, cell: phoneCell(c, fit, BUBBLE) });
      } catch (e) { row.push({ err: e.message }); }
    }
    cells.push(row);
  }
  // measure each frame's height first so a row of frames lines up
  const artH = cells.flat().map(p => (p.err ? 60 : p.shown.rows * p.cell.cellH));
  const frameH = Math.min(900, Math.max(...artH)) + 150;
  const rowBlock = 28 + frameH + GAP;
  const W = GAP + CASES.length * (FW + GAP);

  const paint = (ctx, s, row, x0, y0, cases = CASES) => {
    text(ctx, `${s.name} (${s.id})`, x0, y0 + 18, UI);
    row.forEach((p, j) => {
      const c = cases[j];
      const x = x0 + j * (FW + GAP), y = y0 + 28;
      // phone frame + chat bubble
      ctx.fillStyle = '#f7f7f8'; ctx.fillRect(x, y, FW, frameH);
      ctx.strokeStyle = '#bbb'; ctx.strokeRect(x + 0.5, y + 0.5, FW - 1, frameH - 1);
      text(ctx, c.label, x + PAD, y + 20, UI);
      if (p.err) { wrap(ctx, 'ERROR ' + p.err, x + PAD, y + 44, FW - 2 * PAD, 16, SMALL, RED); return; }
      const { cellW, cellH, fromFit } = p.cell;
      const aw = p.shown.cols * cellW, ah = Math.min(p.shown.rows * cellH, frameH - 150);
      ctx.fillStyle = PAPER; ctx.fillRect(x + PAD, y + 32, Math.max(aw, 40) + 24, ah + 24);
      ctx.save();
      ctx.beginPath(); ctx.rect(x + PAD, y + 32, FW - 2 * PAD, ah + 24); ctx.clip();
      drawGrid(ctx, p.shown, { x: x + PAD + 12, y: y + 44, cellW, cellH, ink: INK, font: MONO });
      ctx.restore();
      if (x + PAD + 12 + aw > x + FW - PAD) {   // wider than the phone: mark where it gets cut
        ctx.fillStyle = RED; ctx.fillRect(x + FW - PAD - 3, y + 32, 3, ah + 24);
      }
      let ty = y + 32 + ah + 24 + 18;
      const o = p.out;
      text(ctx, `${o.cols ?? p.shown.cols}×${o.rows ?? p.shown.rows} cells · ${o.count.toLocaleString('en')} / ` +
        `${o.limit.toLocaleString('en')} ${o.fits ? 'fits' : 'OVER'}` + (o.foldRow != null ? ` · fold row ${o.foldRow}` : ''),
      x + PAD, ty, UI, o.fits ? INK : RED);
      ty += 17;
      text(ctx, `cell ${cellW.toFixed(1)}×${cellH.toFixed(1)} px ${fromFit ? '(FIT)' : '(scaled to bubble)'}` +
        (o.maxCols ? ` · maxCols ${o.maxCols}` : ''), x + PAD, ty, SMALL, MUTED);
      ty += 17;
      for (const k of p.checks) { text(ctx, 'PAYLOAD: ' + k, x + PAD, ty, SMALL, RED); ty += 16; }
      for (const w of o.warnings || []) {
        if (ty > y + frameH - 8) break;
        ty = wrap(ctx, `${w.level}: ${w.message}`, x + PAD, ty, FW - 2 * PAD, 15, SMALL,
          w.level === 'error' ? RED : w.level === 'warn' ? AMBER : MUTED);
      }
    });
  };

  const [cv, ctx] = canvas(W, 40 + samples.length * rowBlock);
  text(ctx, `Typist lab · targets at autoFit, 390 px phone frame · ${ENGINE}` +
    (T ? '' : `  ·  targets.js MISSING (${tErr && tErr.message}): local estimate`), GAP, 26, UI, T ? INK : RED);
  samples.forEach((s, i) => paint(ctx, s, cells[i], GAP, 40 + i * rowBlock));
  document.getElementById('out').appendChild(cv);
  await save('lab_targets', cv);
  for (let i = 0; i < samples.length; i++) {
    const [z, zctx] = canvas(GAP + 3 * (FW + GAP), 2 * rowBlock + GAP);
    paint(zctx, samples[i], cells[i].slice(0, 3), GAP, 0, CASES.slice(0, 3));
    paint(zctx, { ...samples[i], name: samples[i].name + ' (cont.)' }, cells[i].slice(3), GAP, rowBlock, CASES.slice(3));
    await save(`lab_targets_${samples[i].id}`, z);
  }
  const summary = cells.map((row, i) => samples[i].id + ': ' + row.map((p, j) => CASES[j].key + '=' +
    (p.err ? 'ERR' : `${p.shown.cols}x${p.shown.rows} ${p.out.count}/${p.out.limit}${p.out.fits ? '' : ' OVER'}` +
      (p.checks.length ? ' [' + p.checks.join(',') + ']' : ''))).join(' '));
  const bad = cells.flat().filter(p => p.err || p.checks.length);
  return { ok: !!T && bad.length === 0, sheet: 'targets', targetsJs: !!T, targetsError: tErr && tErr.message, summary,
    errors: bad.map(p => p.err || p.checks.join(',')) };
}

// ---------------------------------------------------------------- perf
const stat = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return { med: s[s.length >> 1], max: s[s.length - 1], mean: xs.reduce((a, b) => a + b, 0) / xs.length };
};

async function sheetPerf() {
  // P interleaved passes of N runs per case: load from other processes and GC pauses spread over
  // all cases instead of landing on whichever case happened to run at that moment.
  const N = +(q.get('n') || 6), P = +(q.get('passes') || 3), WARM = 2;
  const [s] = await loadAll();
  const cases = [{ ...MODES[0], label: 'Braille · atkinson (SPEC budget)', cols: 60, rows: 40, budget: true }];
  for (const cols of [28, 40, 60]) {
    for (const m of MODES) {
      const a = aspectFor(m.mode === 'ascii' ? 'tg' : 'plain', m.mode);
      cases.push({ ...m, cols, rows: rowsFor(cols, a) });
    }
  }
  const only = q.get('only');
  const todo = cases.filter(c => !only || c.label.includes(only));
  const acc = todo.map(() => ({ fresh: [], tone: [], samp: [], passMed: [], err: null, WH: null }));
  const time = (runs, fn, into) => {
    const xs = [];
    for (let i = 0; i < runs + WARM; i++) {
      const t0 = performance.now();
      fn(i);
      if (i >= WARM) xs.push(performance.now() - t0);
    }
    into.push(...xs);
    return xs;
  };
  for (let p = 0; p < P; p++) {
    for (let k = 0; k < todo.length; k++) {
      const c = todo[k], A = acc[k];
      if (A.err) continue;
      const conv = createConverter();
      conv.setSource(s.bmp);
      const opts = { mode: c.mode, cols: c.cols, rows: c.rows, dither: c.dither, ascii: c.ascii, blocks: c.blocks, color: c.color };
      try {
        const [W, H] = sampleSize({ blocks: 'quad', ...opts });
        A.WH = [W, H];
        const off = p * 100;   // every pass uses crops no earlier pass cached
        // the canvas resample alone (what a fresh crop costs before tone + encode)
        time(N, i => sampleImage(s.bmp, { x: 0.5 + (off + i + 1) * 1e-4 }, W, H, { color: !!(c.mode === 'blocks' && c.color) }), A.samp);
        // fresh crop: every run moves the crop a hair, so sample + tone + encode all rerun
        const fx = time(N, i => conv.run({ x: 0.5 + (off + i + 1) * 1e-4 }, opts), A.fresh);
        A.passMed.push(stat(fx).med);
        // tone-only change: same crop, brightness moves, the cached sample is reused
        const crop = { x: 0.5 };
        conv.run(crop, opts);
        time(N, i => conv.run(crop, { ...opts, tone: { brightness: (off + i + 1) * 1e-3 } }), A.tone);
      } catch (e) { A.err = e.message; }
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const results = todo.map((c, k) => {
    const A = acc[k];
    if (A.err) return { label: c.label, cols: c.cols, rows: c.rows, err: A.err };
    return { label: c.label, cols: c.cols, rows: c.rows, fresh: { ...stat(A.fresh), best: Math.min(...A.passMed) },
      tone: stat(A.tone), sample: stat(A.samp), sampleWH: A.WH, budget: !!c.budget };
  });
  const f1 = v => v.toFixed(1);
  const html = ['<table><tr><th>mode</th><th>grid</th><th>fresh med</th><th>fresh max</th><th>fresh mean</th>' +
    '<th>tone med</th><th>tone max</th><th>tone mean</th><th>sample med</th></tr>'];
  for (const r of results) {
    if (r.err) { html.push(`<tr><td>${r.label}</td><td>${r.cols}×${r.rows}</td><td colspan=6>${r.err}</td></tr>`); continue; }
    const over = r.fresh.med > 30 || r.tone.med > 10 ? ' class=over' : '';
    html.push(`<tr${over}><td>${r.label}</td><td>${r.cols}×${r.rows}</td><td>${f1(r.fresh.med)}</td><td>${f1(r.fresh.max)}</td>` +
      `<td>${f1(r.fresh.mean)}</td><td>${f1(r.tone.med)}</td><td>${f1(r.tone.max)}</td><td>${f1(r.tone.mean)}</td><td>${f1(r.sample.med)} (${r.sampleWH.join('×')})</td></tr>`);
  }
  html.push('</table>');
  const out = document.getElementById('out');
  out.innerHTML = `<p><b>Typist lab · perf · ${ENGINE}${TAG} · ${s.id} · n=${N}×${P} passes</b> (ms; fresh = new crop, tone = brightness change)</p>` + html.join('');
  await saveFile(`lab_perf_${ENGINE}${TAG}.json`, JSON.stringify({ engine: ENGINE, tag: TAG, n: N, passes: P, results }, null, 1));
  const rows = results.map(r => r.err ? `${r.label} ${r.cols}x${r.rows} ERR ${r.err}`
    : `${r.label} ${r.cols}x${r.rows} fresh ${f1(r.fresh.med)}/${f1(r.fresh.max)}/best ${f1(r.fresh.best)} tone ${f1(r.tone.med)}/${f1(r.tone.max)}/${f1(r.tone.mean)} sample ${f1(r.sample.med)} @${r.sampleWH.join('x')}`);
  return { ok: results.every(r => !r.err), sheet: 'perf', engine: ENGINE, tag: TAG, rows };
}


// ---------------------------------------------------------------- raster self-test
async function sheetRaster() {
  const fails = [];
  let n = 0;
  const check = (ok, msg) => { n++; if (!ok) fails.push(msg); };
  const [c, ctx] = canvas(560, 200);
  const px = (x, y) => ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  const dark = p => p[0] + p[1] + p[2] < 200, light = p => p[0] + p[1] + p[2] > 600;
  const one = (mode, cp, extra = {}) => ({ mode, cols: 1, rows: 1, cp: Uint32Array.of(cp), fg: null, bg: null, ink: 0, ...extra });
  // every Braille bit lands on its own slot and nowhere else
  const cw = 20, chh = 40;
  const { centers, r } = brailleGeometry(cw, chh, 0.32);
  check(Math.abs(r - 0.32 * cw / 2) < 1e-9, 'dot radius = 0.32 x column pitch');
  for (let k = 0; k < 8; k++) {
    const x = 10 + k * 26, y = 10;
    drawGrid(ctx, one('braille', 0x2800 + (1 << k)), { x, y, cellW: cw, cellH: chh, ink: '#000', paper: '#fff' });
    for (let j = 0; j < 8; j++) {
      const p = px(x + centers[j][0], y + centers[j][1]);
      check(j === k ? dark(p) : light(p), `braille bit ${k}: slot ${j} ${j === k ? 'should be ink' : 'should be paper'}`);
    }
  }
  for (const cp of [0x2800, 0x20]) {
    drawGrid(ctx, one('braille', cp), { x: 220, y: 10, cellW: cw, cellH: chh, ink: '#000', paper: '#fff' });
    check(centers.every(([dx, dy]) => light(px(220 + dx, 10 + dy))), `braille U+${cp.toString(16)} draws nothing`);
  }
  // quadrant masks for every block glyph, monochrome
  const qc = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  let bx = 250;
  for (const [cp, mask] of BLOCK_MASK) {
    if (cp === 0x2800) continue;
    drawGrid(ctx, one('blocks', cp), { x: bx, y: 10, cellW: 14, cellH: 28, ink: '#000', paper: '#fff' });
    for (let k = 0; k < 4; k++) {
      const p = px(bx + qc[k][0] * 14, 10 + qc[k][1] * 28);
      check((mask >> k) & 1 ? dark(p) : light(p), `block U+${cp.toString(16)} quadrant ${k}`);
    }
    bx += 17;
    if (bx > 540) bx = 250;
  }
  // colour: fg on the glyph's quadrants, bg elsewhere
  drawGrid(ctx, one('blocks', 0x2580, { fg: Uint32Array.of(0xff0000), bg: Uint32Array.of(0x0000ff) }), { x: 10, y: 70, cellW: 14, cellH: 28 });
  const top = px(17, 77), bot = px(17, 91);
  check(top[0] > 240 && top[2] < 15 && bot[2] > 240 && bot[0] < 15, 'colour ▀: fg top, bg bottom');
  // no seams between abutting blocks at a fractional cell size
  const N = 12, full = { mode: 'blocks', cols: N, rows: N, cp: new Uint32Array(N * N).fill(0x2588), fg: null, bg: null };
  drawGrid(ctx, full, { x: 40.3, y: 70.6, cellW: 7.3, cellH: 9.7, ink: '#000', paper: '#fff' });
  const d = ctx.getImageData(42, 72, Math.floor(N * 7.3) - 4, Math.floor(N * 9.7) - 4).data;
  let seam = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 30) seam++;
  check(seam === 0, `seams in solid blocks: ${seam} light pixels`);
  // ASCII: glyph ink stays inside its cell
  const A = { mode: 'ascii', cols: 3, rows: 1, cp: Uint32Array.of(0x4d, 0x20, 0x57), fg: null, bg: null };
  drawGrid(ctx, A, { x: 180, y: 80, cellW: 12, cellH: 26, ink: '#000', paper: '#fff', font: MONO });
  const a = ctx.getImageData(180, 80, 36, 26).data;
  const colInk = [0, 0, 0];
  for (let y = 0; y < 26; y++) for (let x = 0; x < 36; x++) if (a[(y * 36 + x) * 4] < 128) colInk[Math.floor(x / 12)]++;
  check(colInk[0] > 10 && colInk[1] === 0 && colInk[2] > 10, 'ascii M _ W: ink only in cells 0 and 2 (' + colInk + ')');
  // payload text -> grid round trip (Braille rows of different length pad with U+2800)
  const g = gridFromText(String.fromCodePoint(0x28FF, 0x2801, 0x0A, 0x2802), 'braille');
  check(g.cols === 2 && g.rows === 2 && g.cp[3] === 0x2800 && g.cp[2] === 0x2802, 'gridFromText pads short rows');
  document.getElementById('out').appendChild(c);
  await save('lab_raster', c);
  return { ok: fails.length === 0, sheet: 'raster', checks: n, failed: fails.length, fails };
}

try {
  if (document.fonts && document.fonts.load) await document.fonts.load(`16px ${MONO}`).catch(() => {});
  const fn = { modes: sheetModes, targets: sheetTargets, perf: sheetPerf, raster: sheetRaster }[SHEET];
  if (!fn) throw new Error('unknown sheet ' + SHEET);
  const t0 = performance.now();
  const res = await fn();
  res.secs = +((performance.now() - t0) / 1000).toFixed(1);
  log(JSON.stringify(res, null, 1));
  window.__done = res;
} catch (e) {
  log('ERROR ' + (e.stack || e.message));
  window.__done = { ok: false, error: e.message };
}

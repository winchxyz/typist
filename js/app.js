// Typist app shell: state, intake, the editor and its panels, copy / share / download, welcome.
//
// One state object (the document) drives everything: render() runs the converter (~5 ms, main
// thread, never debounced, coalesced to one run per frame), formats the payload for the target and
// redraws the preview, the fit meter, the target chips and the action buttons. The look thumbnails
// are the only extra conversions and run in idle time, only while the Look panel is visible.
//
// preview.js draws the chat preview, copy.js puts the payload on the clipboard / X / Telegram,
// export.js makes the files and crop.js is the crop screen.

import { createConverter, LOOKS, TONE_DEFAULTS, CROP_DEFAULTS, DITHERS } from './convert.js';
import { TARGETS, formatFor, autoFit, maxCols, rowsFor, cellAspect, modeAllowed, limitFor, countFor } from './targets.js';
import { SAMPLES, loadSample, thumbUrl } from './samples.js';
import { decodeImage, fromDrawable, imageErrorMessage, autoCrop, encodeForStorage } from './imageio.js';
import { drawGrid } from './raster.js';
import { sliderRow, popover, toast as uiToast, announce, reducedMotion } from './ui.js';
import { tgShareUrl, linkFits } from './links.js';
import { History } from './history.js';
import { loadSettings, saveSettings, savePhoto, loadPhoto } from './store.js';
import { shareSiteOnX, starCount } from './share.js';
import { renderPreview } from './preview.js';
import { copyFor, isCoarse } from './copy.js';
import { exportTxt, exportPNG, exportSVG, exportHTML, svgBlob, htmlBlob, downloadBlob, fileName } from './export.js';
import { createCropper } from './crop.js';

const $ = id => document.getElementById(id);
const nf = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : '∞');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ric = window.requestIdleCallback
  ? (fn, o) => window.requestIdleCallback(fn, o)
  : fn => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 16);
const cic = window.cancelIdleCallback || clearTimeout;
const mq = q => matchMedia(q);
const wide = mq('(min-width: 1024px)');
const sideBySide = mq('(min-width: 1280px)');

// ------------------------------------------------------------------------------------ targets
// UI targets (chips) -> formatter targets: X splits into post / long post, File is 'plain'.
const UI_TARGETS = [
  { id: 'ig', chip: 'Instagram', tile: 'Instagram comment', key: '1' },
  { id: 'x', chip: 'X', tile: 'X post', key: '2' },
  { id: 'tg', chip: 'Telegram', tile: 'Telegram', key: '3' },
  { id: 'tgc', chip: 'Channel', tile: 'Telegram channel', key: '4' },
  { id: 'file', chip: 'File', tile: 'File', key: '5' },
];
const UI_IDS = new Set(UI_TARGETS.map(t => t.id));
const PLACE = { ig: 'Instagram', x: 'X', xlong: 'X', tg: 'Telegram', tgc: 'Telegram channels', plain: 'files' };
// a file has no budget and no screen: these widths read well as an image or a .txt
const FILE_COLS = { braille: 48, ascii: 72, blocks: 56 };
const COLS_MIN = 4, COLS_MAX = 200;

// the chat app's own surface per theme (the look thumbnails): content, not app chrome
const PV = {
  light: { bg: '#ffffff', ink: '#101114', bubble: '#eef0f4' },
  dark: { bg: '#0f1012', ink: '#eceef1', bubble: '#1e2127' },
};

// The preview shows the AUDIENCE's screen, and most people who see a comment or a post are on a
// phone: Android on an Android phone, iPhone everywhere else. The Windows preview is one tap away.
// Where the author sits matters only for Telegram, whose desktop app is where Braille slants.
function detectDevice() {
  return /Android/i.test(navigator.userAgent || '') ? 'android' : 'ios';
}
const AUTHOR_ON_WINDOWS = /Windows/i.test(navigator.userAgent || '');
const DEVICE_NAME = { ios: 'iPhone', android: 'Android', windows: 'Windows' };

// ------------------------------------------------------------------------------------ state
const DOC_KEYS = ['target', 'targetOpts', 'mode', 'look', 'dither', 'ascii', 'blocks', 'color', 'cols', 'blank', 'tone', 'crop'];
const state = {
  target: 'ig',
  targetOpts: { x: 'post', tg: 'phone', tgc: 'post' },
  mode: 'braille',          // preferred style; a target that cannot show it uses its default
  look: 'photo',
  dither: 'atkinson',
  ascii: 'shape',
  blocks: 'quad',
  color: false,
  cols: null,               // null = auto (autoFit for the target)
  blank: 'u2800',
  tone: { ...TONE_DEFAULTS },
  crop: { ...CROP_DEFAULTS },
  device: detectDevice(),
  previewTheme: mq('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
};
const prefs = { theme: 'system', igWarned: false, modePicked: false, source: null };

// toasts: short (2.4 s), gone at the next touch anywhere, below menus (css .toasts z-index)
const toast = (message, opts = {}) => uiToast(message, { ms: opts.action ? 6000 : opts.error ? 4500 : 2400, ...opts });
document.addEventListener('pointerdown', e => {
  if (!e.target.closest?.('.toast')) document.getElementById('toasts')?.replaceChildren();
}, true);

// Stored settings are untrusted (old versions, hand edits): every field is checked against a
// whitelist or a range, anything else falls back to the default.
const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : d);
const TONE_RANGE = { brightness: [-1, 1], contrast: [-1, 1], gamma: [0.3, 3], detail: [0, 1], edges: [0, 1] };
function cleanTone(t) {
  const out = { ...TONE_DEFAULTS };
  if (!t || typeof t !== 'object') return out;
  for (const [k, [a, b]] of Object.entries(TONE_RANGE)) out[k] = num(t[k], a, b, TONE_DEFAULTS[k]);
  for (const k of ['auto', 'invert']) if (typeof t[k] === 'boolean') out[k] = t[k];
  return out;
}
function cleanCrop(c) {
  if (!c || typeof c !== 'object') return null;
  const ok = ['x', 'y', 'zoom'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k]));
  if (!ok) return null;
  return { ...CROP_DEFAULTS, x: clamp(c.x, -1, 2), y: clamp(c.y, -1, 2), zoom: clamp(c.zoom, 0.5, 6),
    rotation: num(c.rotation, -360, 360, 0) };
}
const saved = loadSettings();
if (saved && saved.state && typeof saved.state === 'object') {
  const s = saved.state;
  state.target = pick(s.target, [...UI_IDS], 'ig');
  const to = s.targetOpts || {};
  state.targetOpts = { x: pick(to.x, ['post', 'long'], 'post'), tg: pick(to.tg, ['phone', 'desktop'], 'phone'), tgc: pick(to.tgc, ['post', 'caption'], 'post') };
  state.mode = pick(s.mode, ['braille', 'ascii', 'blocks'], 'braille');
  state.look = pick(s.look, LOOKS.map(l => l.id), 'photo');
  state.dither = pick(s.dither, DITHERS, 'atkinson');
  state.ascii = pick(s.ascii, ['shape', 'ramp'], 'shape');
  state.blocks = pick(s.blocks, ['quad', 'half'], 'quad');
  state.color = s.color === true;
  state.cols = Number.isInteger(s.cols) ? clamp(s.cols, COLS_MIN, COLS_MAX) : null;
  state.blank = pick(s.blank, ['u2800', 'dot'], 'u2800');
  state.tone = cleanTone(s.tone);
  state.crop = cleanCrop(s.crop) || { ...CROP_DEFAULTS };
  state.device = pick(s.device, Object.keys(DEVICE_NAME), state.device);
  state.previewTheme = pick(s.previewTheme, ['light', 'dark'], state.previewTheme);
}
if (saved && saved.prefs && typeof saved.prefs === 'object') {
  const p = saved.prefs;
  prefs.theme = pick(p.theme, ['system', 'light', 'dark'], 'system');
  prefs.igWarned = p.igWarned === true;
  prefs.modePicked = p.modePicked === true;
  prefs.source = typeof p.source === 'string' ? p.source : null;
}
const forParam = new URLSearchParams(location.search).get('for');
if (forParam && UI_IDS.has(forParam)) state.target = forParam;

const snapshot = () => JSON.parse(JSON.stringify(Object.fromEntries(DOC_KEYS.map(k => [k, state[k]]))));
function persist() {
  saveSettings({ v: 1, state: { ...snapshot(), device: state.device, previewTheme: state.previewTheme }, prefs });
}
const history = new History({ onChange: h => {
  $('btnUndo').disabled = !h.canUndo;
  $('btnRedo').disabled = !h.canRedo;
  $('btnUndo').title = h.canUndo ? `Undo ${h.undoLabel.toLowerCase()} (Z)` : 'Undo (Z)';
  $('btnRedo').title = h.canRedo ? `Redo ${h.redoLabel.toLowerCase()} (Shift+Z)` : 'Redo (Shift+Z)';
} });
function commit(label) {
  if (photo) {
    history.commit(snapshot(), label);
    // a merged burst that ends where it began (5 then 1 within 600 ms) is not a step
    const h = history;
    if (h.index > 0 && h.stack[h.index] === h.stack[h.index - 1]) {
      h.stack.splice(h.index, 1); h.labels.splice(h.index, 1); h.index--; h.lastLabel = null; h.onChange?.(h);
    }
  }
  // the "Resized … · Undo" note belongs to the target switch; any other edit retires it
  if (label !== 'Target' && resizedNote) { resizedNote = null; if (cur) updateFit(); }
  persist();
}
function restore(snap) {
  if (!snap) return;
  resizedNote = null;
  for (const k of DOC_KEYS) state[k] = snap[k];
  syncControls();
  render();
  persist();
}

/** The formatter's view of the current UI target. */
function resolve(ui = state.target) {
  const to = state.targetOpts;
  const id = ui === 'file' ? 'plain' : ui === 'x' && to.x === 'long' ? 'xlong' : ui;
  // Telegram on Windows (Telegram Desktop) slants Braille; Letters in a code block are exact
  // there, so they are the default until the person picks a style themselves
  const want = state.mode === 'braille' && !prefs.modePicked && AUTHOR_ON_WINDOWS && (ui === 'tg' || ui === 'tgc') ? 'ascii' : state.mode;
  const mode = modeAllowed(id, want) ? want : TARGETS[id].defaultMode;
  const phone = ui === 'tg' && to.tg === 'desktop' ? 'desktop' : 390;
  const fopts = { blank: mode === 'braille' && ui !== 'file' ? state.blank : 'u2800', caption: ui === 'tgc' && to.tgc === 'caption', phone };
  return { ui, id, mode, phone, fopts };
}
const autoCols = r => (r.ui === 'file' ? FILE_COLS[r.mode] : autoFit(r.id, r.mode, r.fopts).cols);
const colsOf = r => clamp(state.cols ?? autoCols(r), COLS_MIN, COLS_MAX);

/** Analytic fit of `cols` on a target (the chips' bars): 'ok' | 'tight' | 'bad'. */
function fitOn(r, cols) {
  const rows = rowsFor(cols, cellAspect(r.id, r.mode));
  const count = countFor(r.id, r.mode, cols, rows, r.fopts);
  const limit = limitFor(r.id, r.fopts);
  if (r.ui === 'file') return { level: 'ok', count, limit, rows, max: Infinity };
  const max = maxCols(r.id, r.mode, { phone: r.phone });
  const over = count > limit, wraps = cols > max;
  // tight: fits, but within 5% of the budget (one more column would not)
  const level = over || wraps ? 'bad' : count > 0.95 * limit ? 'tight' : 'ok';
  return { level, count, limit, rows, max, over, wraps };
}

// ------------------------------------------------------------------------------------ render
const conv = createConverter();
let photo = null;
let photoSeq = 0;
let grid = null, payload = null, cur = null;
let raf = 0;
let firstDone = false;
let resolveReady;
const ready = new Promise(r => { resolveReady = r; });

function schedule() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
}

const toneOpts = () => ({ ...state.tone, look: state.look });

function render() {
  if (!photo) return;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  const r = resolve();
  const cols = colsOf(r);
  const rows = rowsFor(cols, cellAspect(r.id, r.mode));
  const t0 = performance.now();
  try {
    grid = conv.run(state.crop, {
      mode: r.mode, cols, rows, tone: toneOpts(), dither: state.dither, ascii: state.ascii,
      blocks: state.blocks, color: state.color && r.ui === 'file',
    });
  } catch (e) {
    console.error(e);
    toast('That style is not available right now. Showing dots.', { error: true });
    state.mode = 'braille';
    return render();
  }
  const ms = performance.now() - t0;
  payload = formatFor(r.id, grid, r.fopts);
  cur = { r, cols, rows, ms, fit: fitOn(r, cols) };
  // the note is only true while the art fits
  if (resizedNote && (payload.count > payload.limit || payload.wraps)) resizedNote = null;
  drawPreviews();
  drawMini();
  updateFit();
  updateTargets();
  updateActions();
  syncSize();
  syncLookPanel();
  queueThumbs();
  if (!firstDone) {
    firstDone = true;
    document.body.classList.remove('booting');
    window.__done = { ok: true, screen: 'editor', target: r.id, mode: r.mode, cols, rows, ms: +ms.toFixed(1) };
    resolveReady();
  }
}

// ------------------------------------------------------------------------------------ preview
function previewSlots() {
  if (sideBySide.matches && !cropping) return [['pv0', 'light'], ['pv1', 'dark']];
  return [['pv0', state.previewTheme]];
}

function artLabel(r) {
  const where = { ig: 'an Instagram comment', x: 'an X post', xlong: 'an X long post', tg: 'a Telegram message',
    tgc: r.fopts.caption ? 'a Telegram photo caption' : 'a Telegram channel post', plain: 'a file' }[r.id];
  return `Text art of your photo, ${grid.cols} by ${grid.rows} characters, for ${where}`;
}

function drawPreviews() {
  const r = cur.r;
  const slots = previewSlots();
  $('pv1').hidden = slots.length < 2;
  $('btnPvTheme').hidden = slots.length > 1;
  // phones: Crop / Compare / theme / device sit in the preview's own header row (no extra row);
  // the header keeps its title in the middle, clear of the pills
  const phoneTools = !wide.matches;
  const bar = $('previewBar');
  for (const [id, theme] of slots) {
    const el = $(id);
    el.dataset.pvTheme = theme;
    // the preview is a 390 px phone at 1:1 (what fits here fits there); a narrower screen shows
    // the same phone scaled down rather than a different wrap
    const k = Math.min(1, (el.clientWidth || 390) / 390);
    let inset = 0;
    if (phoneTools) {
      const side = Math.max(bar.querySelector('.pv-left').offsetWidth, bar.querySelector('.pv-right').offsetWidth);
      inset = Math.round((side + 12 + 8) / k);
    }
    // dark preview, art not inverted: say so on the preview itself, with the fix
    const banner = theme === 'dark' && !state.tone.invert && r.ui !== 'file'
      ? { text: 'Shows as a negative in dark mode', action: 'Invert', onAction: () => setInvert(true) } : null;
    cur.pv = renderPreview(el, { target: r.id, payload, grid, device: state.device, theme, phone: 390, opts: r.fopts, inset, banner });
    el.style.setProperty('--pv-k', k < 0.999 ? k.toFixed(4) : '1');
    $('stage').style.setProperty('--pv-k', k < 0.999 ? k.toFixed(4) : '1');
  }
  syncFileChips();
  if (comparing) placePeek();
}

// File: the formats are visible choices under the preview, not only a menu
function syncFileChips() {
  $('fileChips').hidden = !(cur && cur.r.ui === 'file') || !!cropping;
}

// phones: while the tabs' controls cover the preview, a small copy of the art stays in view
const miniEl = $('miniArt');
let pvVisible = 1;
function drawMini() {
  const show = !!cur && !wide.matches && (!!cropping || pvVisible < 0.3);
  miniEl.hidden = !show;
  if (!show) return;
  const cv = miniEl.querySelector('canvas');
  const css = cropping ? 88 : 96, dpr = Math.min(3, window.devicePixelRatio || 1), S = Math.round(css * dpr);
  if (cv.width !== S) { cv.width = S; cv.height = S; }
  const c = PV[state.previewTheme];
  miniEl.style.background = c.bg;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, S, S);
  const g = copiedGrid(), r = cur.r;
  const pad = S * 0.07;
  let cw = (S - 2 * pad) / g.cols, ch = cw / cellAspect(r.id, r.mode);
  if (ch * g.rows > S - 2 * pad) { ch = (S - 2 * pad) / g.rows; cw = ch * cellAspect(r.id, r.mode); }
  drawGrid(ctx, g, { x: (S - cw * g.cols) / 2, y: (S - ch * g.rows) / 2, cellW: cw, cellH: ch, ink: c.ink, font: "'Geist Mono', monospace" });
}
if ('IntersectionObserver' in window) {
  // the sticky top bar + tabs and the fixed action bar cover the page's top and bottom
  const io = new IntersectionObserver(es => {
    for (const e of es) pvVisible = e.isIntersecting ? e.intersectionRatio : 0;
    drawMini();
  }, { rootMargin: '-94px 0px -100px 0px', threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.6, 1] });
  io.observe($('pv0'));
}
miniEl.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
});

// ------------------------------------------------------------------------------------ fit meter
let resizedNote = null;   // { from, to, until }
function updateFit() {
  const { r, cols, rows, fit } = cur;
  const p = payload;
  const line = $('fitLine');
  const fitEl = $('fit');
  const shear = r.ui !== 'file' && fit.level !== 'bad' && slantsOnWindows(r);
  const level = r.ui === 'file' ? 'none' : shear ? 'tight' : fit.level;
  const cls = `fit fit-${level === 'bad' ? 'bad' : level === 'tight' ? 'tight' : level === 'none' ? 'none' : 'ok'}`;
  if (fitEl.className !== cls) fitEl.className = cls;
  $('fitFill').style.width = r.ui === 'file' ? '100%' : `${Math.min(100, (p.count / p.limit) * 100)}%`;
  let html, fix = null;
  if (resizedNote && performance.now() < resizedNote.until) {
    html = `Resized ${resizedNote.from} → ${resizedNote.to} wide · <button type="button" class="text-btn" data-fix="undo-resize">Undo</button>`;
    fix = resizedNote.from;
  } else if (r.ui === 'file') {
    html = `${cols} × ${rows} characters · ${nf(p.count)} in all · <b>Any size</b>`;
  } else {
    const where = r.phone === 'desktop' ? 'in the app' : 'on a phone';
    const head = `${nf(p.count)} / ${nf(p.limit)}`;
    if (p.count > p.limit) html = `${head} · ${cols} wide · <b>${nf(p.count - p.limit)} over</b>`;
    else if (p.wraps) html = `${head} · ${cols} of ${p.maxCols} wide · <b>Wraps</b> ${where}`;
    else if (shear) {
      // Telegram: Letters are exact on Windows; elsewhere the Windows-safe blank keeps rows straight
      const letters = modeAllowed(r.id, 'ascii');
      html = `${head} · <b>Slants on Windows</b> · <button type="button" class="text-btn" data-fix="${letters ? 'letters' : 'safe'}">${letters ? 'Use Letters' : 'Windows-safe blanks'}</button>`;
    } else if (fit.level === 'tight') html = `${head} · ${cols} of ${p.maxCols} wide · <b>Tight</b>`;
    else html = `${head} · ${cols} of ${p.maxCols} wide · <b>Fits</b>`;
    if (!shear && p.foldRow != null) html += ` · ${p.foldRow} rows, then “Show more”`;
  }
  // rewrite only on change: no churn for assistive tech or layout on every slider step
  if (html !== line.dataset.html) { line.dataset.html = html; line.innerHTML = html; }
  line.dataset.from = fix ?? '';
}

/** Braille with clean blanks slants in Telegram Desktop and Windows browsers (SPEC device finding). */
function slantsOnWindows(r) {
  if (r.mode !== 'braille' || r.fopts.blank !== 'u2800') return false;
  if (!(r.ui === 'tg' || r.ui === 'tgc' || state.device === 'windows')) return false;
  // only when some row starts with blanks before its first dot (else nothing moves)
  const { cols, rows, cp } = grid;
  for (let y = 0; y < rows; y++) {
    const o = y * cols;
    if (cp[o] !== 0x2800) continue;
    for (let x = 1; x < cols; x++) if (cp[o + x] !== 0x2800) return true;
  }
  return false;
}

$('fitLine').addEventListener('click', e => {
  const b = e.target.closest('[data-fix]');
  if (!b || !cur) return;
  const what = b.dataset.fix;
  if (what === 'undo-resize') {
    const from = Number($('fitLine').dataset.from);
    resizedNote = null;
    if (Number.isFinite(from) && from > 0) state.cols = from;
    render(); commit('Width');
  } else if (what === 'letters') {
    prefs.modePicked = true;
    state.mode = 'ascii'; state.cols = null;
    render(); commit('Style');
    announce(`Letters. ${$('fitLine').textContent}`);
  } else if (what === 'safe') {
    state.blank = 'dot';
    render(); commit('Blank cells');
    announce(`Windows-safe blanks. ${$('fitLine').textContent}`);
  }
});

// the Instagram "Action Blocked" tip: once, as a line under the fit meter, until dismissed
function showTip(text) {
  const tip = $('fitTip');
  tip.querySelector('span').textContent = text;
  tip.hidden = false;
}
$('fitTip').querySelector('button').addEventListener('click', () => { $('fitTip').hidden = true; });

// ------------------------------------------------------------------------------------ targets UI
function budgetText(ui) {
  const to = state.targetOpts;
  if (ui === 'ig') return '2,200 characters';
  if (ui === 'x') return to.x === 'long' ? '25,000 (Premium)' : '280 characters';
  if (ui === 'tg') return '4,096 characters';
  if (ui === 'tgc') return to.tgc === 'caption' ? '1,024 (caption)' : '4,096 characters';
  return 'PNG, SVG, HTML, text';
}

function buildTargets() {
  const row = $('targetRow'), cards = $('targetCards'), tiles = $('welcomeTargets');
  for (const t of UI_TARGETS) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'tchip'; chip.setAttribute('role', 'radio'); chip.dataset.v = t.id;
    chip.innerHTML = '<span></span><i class="fitbar" aria-hidden="true"></i>';
    chip.firstChild.textContent = t.chip;
    row.append(chip);

    const card = document.createElement('button');
    card.type = 'button'; card.className = 'tcard'; card.setAttribute('role', 'radio'); card.dataset.v = t.id;
    card.innerHTML = '<b></b><span></span><i class="fitbar" aria-hidden="true"></i>';
    card.querySelector('b').textContent = t.id === 'file' ? 'File' : t.tile;
    card.title = `Shortcut: ${t.key}`;
    cards.append(card);

    if (t.id !== 'file') {
      const tile = document.createElement('button');
      tile.type = 'button'; tile.className = 'wtile'; tile.setAttribute('role', 'radio'); tile.dataset.v = t.id;
      tile.innerHTML = '<b></b><span></span>';
      tile.querySelector('b').textContent = t.tile;
      tile.querySelector('span').textContent = budgetText(t.id);
      tiles.append(tile);
    }
  }
  for (const host of [row, cards, tiles]) {
    host.addEventListener('click', e => {
      const b = e.target.closest('[data-v]');
      if (b) setTarget(b.dataset.v);
    });
    host.addEventListener('keydown', e => radioKeys(e, host));
  }
  $('wFile').addEventListener('click', () => setTarget('file'));
  // the chip row's edge fade only while there is more to scroll to
  const edge = () => row.classList.toggle('at-end', row.scrollLeft + row.clientWidth >= row.scrollWidth - 2);
  row.addEventListener('scroll', edge, { passive: true });
  window.addEventListener('resize', edge);
  requestAnimationFrame(edge);
  syncTargetChecks();
}

function radioKeys(e, host) {
  const items = [...host.querySelectorAll('[role="radio"]')];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return;
  e.preventDefault(); e.stopPropagation();
  const j = (i + d + items.length) % items.length;
  items[j].focus();
  items[j].click();
}

function syncTargetChecks() {
  for (const el of document.querySelectorAll('#targetRow [data-v], #targetCards [data-v], #welcomeTargets [data-v], #wFile')) {
    const v = el.id === 'wFile' ? 'file' : el.dataset.v;
    const on = v === state.target;
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.tabIndex = on || el.id === 'wFile' ? 0 : -1;
  }
  for (const el of document.querySelectorAll('#targetCards [data-v] span, #welcomeTargets [data-v] span')) {
    el.textContent = budgetText(el.parentElement.dataset.v);
  }
}

// Chip / card bars: green = fits as it is, amber = tight, grey = picking it resizes the art to
// fit (the "Resizes to N wide" description), red = cannot fit even at its own best width.
function updateTargets() {
  syncTargetChecks();
  const width = cur.cols;
  for (const t of UI_TARGETS) {
    const r = resolve(t.id);
    let cls, word, desc = '';
    if (t.id === 'file') { cls = 'fit-none'; word = ''; }
    else if (t.id === state.target) {
      const f = cur.fit;
      cls = `fit-${f.level}`;
      word = f.level === 'bad' ? (f.over ? ', over the limit' : ', rows wrap') : f.level === 'tight' ? ', tight' : ', fits';
    } else {
      const f = fitOn(r, width);
      if (f.level !== 'bad') { cls = `fit-${f.level}`; word = f.level === 'tight' ? ', tight' : ', fits'; }
      else {
        const auto = autoCols(r);
        const fa = fitOn(r, auto);
        if (fa.level === 'bad') { cls = 'fit-bad'; word = ', does not fit'; }
        else { cls = 'fit-none'; word = ''; desc = `Resizes to ${auto} wide`; }
      }
    }
    for (const el of document.querySelectorAll(`#targetRow [data-v="${t.id}"], #targetCards [data-v="${t.id}"]`)) {
      el.classList.remove('fit-ok', 'fit-tight', 'fit-bad', 'fit-none');
      el.classList.add(cls);
      el.setAttribute('aria-label', `${t.tile}${word}`);
      if (desc) { el.setAttribute('aria-description', desc); el.title = desc; }
      else { el.removeAttribute('aria-description'); el.title = el.classList.contains('tcard') ? `Shortcut: ${t.key}` : ''; }
    }
  }
}

function setTarget(ui) {
  if (!UI_IDS.has(ui)) return;
  if (ui === state.target) return;
  const before = cur ? cur.cols : null;
  state.target = ui;
  state.cols = null;                         // a new target auto-fits
  $('styleWhy').textContent = '';
  $('styleWhy').classList.remove('why');
  if (!photo) { syncTargetChecks(); persist(); return; }
  render();
  if (before && cur.cols !== before) {
    resizedNote = { from: before, to: cur.cols, until: performance.now() + 4000 };
    updateFit();
    setTimeout(() => { if (resizedNote && performance.now() >= resizedNote.until) { resizedNote = null; if (cur) updateFit(); } }, 4050);
  }
  commit('Target');
  announce(`${UI_TARGETS.find(t => t.id === ui).tile}. ${$('fitLine').textContent}`);
  document.querySelector(`#targetRow [data-v="${ui}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

// ------------------------------------------------------------------------------------ actions
const PRIMARY = { ig: 'Copy for Instagram', x: 'Post on X', xlong: 'Copy for X', tg: 'Copy for Telegram', tgc: 'Copy for the channel', plain: 'Download' };
const actionSets = [];
let copiedUntil = 0;

function makeMenu(up, label, items) {
  const menu = document.createElement('div');
  menu.className = 'menu' + (up ? ' up' : '');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  menu.innerHTML = `<div class="menu-label">${label}</div>` +
    items.map(([k, a, b]) => `<button type="button" role="menuitem" data-fmt="${k}">${a}<small>${b}</small></button>`).join('');
  menuKeys(menu);
  return menu;
}

/** role="menu" keyboard contract: arrows move between items (wrapping), Home / End jump. */
function menuKeys(menu) {
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('[role^="menuitem"], .seg [role="radio"][aria-checked="true"]')].filter(x => !x.hidden && x.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    let j = -1;
    if (e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[j].focus();
  });
}

function makeActions(host, up) {
  const sec = document.createElement('button');
  sec.type = 'button'; sec.className = 'btn secondary sec-btn';
  // PNG on every target (SPEC "Download PNG for every art"); long-press / right-click: Large (4x)
  const pngWrap = document.createElement('div');
  pngWrap.className = 'png-wrap';
  const png = document.createElement('button');
  png.type = 'button'; png.className = 'btn secondary png-btn';
  png.title = 'Download a PNG of the art (S). Right-click or long-press for a larger one.';
  setBtn(png, 'download', 'PNG');
  png.setAttribute('aria-label', 'Download PNG');
  const pngMenu = makeMenu(up, 'PNG size', [['png', 'Standard', '2×'], ['png4', 'Large', '4×']]);
  pngWrap.append(png, pngMenu);
  const wrap = document.createElement('div');
  wrap.className = 'act-wrap';
  const pri = document.createElement('button');
  pri.type = 'button'; pri.className = 'btn primary';
  const menu = makeMenu(up, 'Download as', [['txt', 'Text', '.txt'], ['png', 'Image', 'PNG'], ['svg', 'Vector', 'SVG'], ['html', 'Web page', 'HTML']]);
  wrap.append(pri, menu);
  host.append(sec, pngWrap, wrap);
  const set = { sec, pri, menu, png, pngMenu };
  pri.addEventListener('click', e => onPrimary(e, set));
  sec.addEventListener('click', e => onSecondary(e, set));
  png.addEventListener('click', e => { if (!pngMenu.hidden) { closeMenu(pngMenu, png); return; } download('png', e); });
  png.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(pngMenu, png); });
  for (const [m, owner] of [[menu, pri], [pngMenu, png]]) {
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-fmt]');
      if (!b) return;
      closeMenu(m, owner);
      download(b.dataset.fmt, e);
    });
    m.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(m, owner); owner.focus(); } });
    document.addEventListener('pointerdown', e => { if (!m.hidden && !m.parentElement.contains(e.target)) closeMenu(m, owner); });
  }
  actionSets.push(set);
}
function openMenu(m, owner) {
  m.hidden = false;
  owner.setAttribute('aria-expanded', 'true');
  m.querySelector('button')?.focus();
}
function closeMenu(m, owner) { m.hidden = true; owner.setAttribute('aria-expanded', 'false'); }

function actionModel() {
  const { r } = cur;
  const p = payload;
  if (r.ui !== 'file') {
    // the width goes on a second line, so the label never truncates on a 360 px phone
    const sub = `${autoCols(r)} wide`;
    if (p.count > p.limit) return { fix: true, label: `Fit to ${nf(p.limit)}`, sub };
    if (p.wraps) return { fix: true, label: `Fit to ${r.phone === 'desktop' ? 'the app' : 'phone'}`, sub };
  }
  return { fix: false, label: PRIMARY[r.id] };
}

function setBtn(btn, icon, label, sub = '') {
  btn.innerHTML = `${icon ? `<svg class="ic" aria-hidden="true"><use href="#i-${icon}"/></svg>` : ''}<span class="lbl"></span>`;
  const l = btn.querySelector('.lbl');
  l.textContent = label;
  if (sub) { const sm = document.createElement('small'); sm.textContent = sub; l.append(sm); l.classList.add('two'); }
}

/** Desktop Telegram: the t.me link carries the art only when it is short enough (links.js). */
function tgLinkFits() {
  try { return linkFits(tgShareUrl(payload.text), 'tg'); } catch { return false; }
}

function updateActions() {
  if (!cur) return;
  const m = actionModel();
  const { r } = cur;
  const coarse = isCoarse(null);
  for (const { sec, pri } of actionSets) {
    sec.parentElement.classList.toggle('fixing', m.fix);
    if (performance.now() < copiedUntil) continue;
    pri.classList.remove('done');
    pri.classList.toggle('fix', m.fix);
    const icon = m.fix ? null : r.ui === 'file' ? 'download' : r.id === 'x' ? 'x' : 'copy';
    setBtn(pri, icon, m.label, m.sub);
    if (m.fix) pri.setAttribute('aria-label', `${m.label}, ${m.sub}`); else pri.removeAttribute('aria-label');
    if (r.ui === 'file') { pri.setAttribute('aria-haspopup', 'menu'); pri.setAttribute('aria-expanded', 'false'); } else pri.removeAttribute('aria-haspopup');
    sec.removeAttribute('aria-disabled');
    sec.removeAttribute('aria-label');
    sec.classList.remove('icon-only', 'narrow-icon');
    // Film waits for phase 4: no disabled placeholder. A Telegram link that cannot carry the art
    // (desktop, Dots past LINK_MAX) would only copy again: no button then either.
    let secLabel = '', show = true;
    if (m.fix) { setBtn(sec, null, 'Copy anyway'); secLabel = 'Copy anyway'; }
    else if (r.ui === 'tg' || r.ui === 'tgc') {
      if (coarse) { setBtn(sec, 'share', 'Share'); secLabel = 'Share to Telegram'; sec.classList.add('narrow-icon'); }
      else if (tgLinkFits()) { setBtn(sec, 'share', 'Open'); secLabel = 'Open in Telegram'; }
      else show = false;
    } else if (r.ui === 'x') { setBtn(sec, 'copy', 'Copy'); secLabel = 'Copy only (no X window)'; }
    else show = false;
    sec.hidden = !show;
    sec.title = secLabel;
    if (show && !m.fix && secLabel !== sec.textContent) sec.setAttribute('aria-label', secLabel);
  }
}

function onPrimary(e, set) {
  if (!cur) return;
  const m = actionModel();
  if (m.fix) {
    state.cols = null;
    render();
    commit('Width');
    announce(`Resized to ${cur.cols} columns. ${$('fitLine').textContent}`);
    return;
  }
  if (cur.r.ui === 'file') {
    if (set.menu.hidden) openMenu(set.menu, set.pri); else closeMenu(set.menu, set.pri);
    return;
  }
  runCopy(e, 'auto');
}

function onSecondary(e) {
  if (!cur) return;
  const m = actionModel();
  const ui = cur.r.ui;
  if (m.fix) return runCopy(e, 'copy');
  if (ui === 'tg' || ui === 'tgc') return runCopy(e, 'share');
  if (ui === 'x') return runCopy(e, 'copy');
}

// copyFor does its clipboard / popup / share work synchronously inside the click (Safari only
// allows clipboard writes and window.open in the gesture), so nothing is awaited before it.
function runCopy(e, action) {
  const { r } = cur;
  const p = payload;
  let job;
  try {
    job = copyFor(r.id, p, { event: e, device: isCoarse(null, e) ? 'phone' : 'desktop', action });
  } catch (err) { console.error(err); job = Promise.resolve({ how: 'manual', text: p.text }); }
  Promise.resolve(job).then(res => res || { how: 'manual' }, () => ({ how: 'manual' })).then(res => afterCopy(res, r, p));
}

function afterCopy(res, r, p) {
  if (res.how === 'cancelled' || res.how === 'none') return;
  if (res.how === 'manual') return openManual(res.text || p.text);
  if (res.how === 'share') { toast(res.hint || 'Shared.'); announce(res.hint || 'Shared.'); return; }
  // "Copied" only when the clipboard really has it (an X window can open with the copy denied)
  if (res.ok) flashCopied();
  if (res.blocked && res.href) {
    const app = r.id === 'x' || r.id === 'xlong' ? 'X' : 'Telegram';
    toast(res.hint || `Copied. Your browser blocked the ${app} window.`, {
      ms: 8000,
      action: { label: `Open ${app}`, run: () => { const t = window.open(res.href, '_blank'); if (t) { try { t.opener = null; } catch { /* cross-origin */ } } } },
    });
    return;
  }
  const msg = res.hint || (res.ok ? 'Copied.' : 'Done.');
  toast(msg);
  announce(msg);
  // Instagram's Action Blocked tip: once, as a quiet line under the fit meter (not in the toast)
  if (res.notice && !prefs.igWarned) {
    prefs.igWarned = true; persist();
    showTip(res.notice);
  }
}

function flashCopied() {
  copiedUntil = performance.now() + 1600;
  for (const { pri } of actionSets) { pri.classList.add('done'); pri.classList.remove('fix'); setBtn(pri, 'check', 'Copied'); }
  clearTimeout(flashCopied.t);
  flashCopied.t = setTimeout(() => { copiedUntil = 0; updateActions(); }, 1650);
}

/** The file's colours follow invert: dark dots on white, or light dots on near-black. */
function fileColours() {
  return state.tone.invert ? { ink: '#f2f2f0', paper: '#111113' } : { ink: '#17171a', paper: '#ffffff' };
}
/** The Grid as copied: the Windows-safe blank puts a U+2840 dot in every blank Braille cell. */
function copiedGrid() {
  if (grid.mode !== 'braille' || cur.r.fopts.blank !== 'dot') return grid;
  const cp = grid.cp.map(c => (c === 0x2800 ? 0x2840 : c));
  return { ...grid, cp };
}
const fileTarget = () => (cur.r.ui === 'file' ? 'file' : cur.r.id);
const nameFor = ext => fileName({ target: fileTarget(), cols: grid.cols, rows: grid.rows }, ext);

async function download(fmt, e) {
  if (!cur) return;
  const { r } = cur;
  const g = copiedGrid();
  const col = fileColours();
  const ext = fmt === 'png4' ? 'png' : fmt;
  const name = nameFor(ext);
  const coarse = isCoarse(null, e);
  try {
    let blob;
    if (fmt === 'txt') blob = exportTxt(r.id === 'plain' ? payload : g);
    else if (ext === 'png') blob = await exportPNG(g, { target: r.id, scale: fmt === 'png4' ? 4 : 2, ...col, transparent: false });
    else if (fmt === 'svg') blob = svgBlob(exportSVG(g, { target: r.id, ...col, pad: 8 }));
    else if (fmt === 'html') blob = htmlBlob(exportHTML(g, { target: r.id, ...col, colour: state.color }));
    if (!(blob instanceof Blob)) throw new Error('no file');
    // phones: a PNG goes to the share sheet (straight to Photos / Instagram) when it takes files
    if (ext === 'png' && coarse && navigator.canShare) {
      const file = new File([blob], name, { type: 'image/png' });
      let can = false;
      try { can = navigator.canShare({ files: [file] }); } catch { can = false; }
      if (can) {
        try { await navigator.share({ files: [file] }); toast(`Shared ${name}`); return; } catch (err) {
          if (err && err.name === 'AbortError') return;
          // no user activation left after encoding: download instead
        }
      }
    }
    downloadBlob(blob, name);
    toast(`Saved ${name}`);
    announce(`Saved ${name}`);
  } catch (err) {
    console.error(err);
    toast('That download failed. Try another format.', { error: true });
  }
}

function openManual(text) {
  const dlg = $('manualDlg');
  const ta = $('manualText');
  ta.value = text;
  if (!dlg.open) dlg.showModal();
  ta.focus();
  ta.select();
}
$('manualSelect').addEventListener('click', () => { const ta = $('manualText'); ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); });
$('manualDownload').addEventListener('click', () => { downloadBlob(exportTxt($('manualText').value), nameFor('txt')); });
for (const b of document.querySelectorAll('dialog [data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

// ------------------------------------------------------------------------------------ segmented
function segBind(el, onPick) {
  el.addEventListener('click', e => {
    const b = e.target.closest('[role="radio"]');
    if (b && el.contains(b)) onPick(b.dataset.v, b);
  });
  el.addEventListener('keydown', e => {
    const items = [...el.querySelectorAll('[role="radio"]')];
    const i = items.indexOf(document.activeElement);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (i < 0 || !d) return;
    e.preventDefault(); e.stopPropagation();
    const j = (i + d + items.length) % items.length;
    items[j].focus();
    items[j].click();
  });
}
function segSet(el, v) {
  const items = [...el.querySelectorAll('[role="radio"]')];
  for (const b of items) {
    const on = b.dataset.v === String(v);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
}

// ------------------------------------------------------------------------------------ Look panel
function whyNot(mode, r) {
  const where = PLACE[r.id];
  if (mode === 'ascii') return `Letters don’t line up on ${where}: it uses a proportional font. They do in Telegram.`;
  if (mode === 'blocks') {
    return r.id === 'tg' || r.id === 'tgc'
      ? 'Blocks don’t line up in Telegram chats. Choose File to save them as an image or text.'
      : `Blocks don’t line up on ${where}. Choose File to save them as an image or text.`;
  }
  return '';
}

function buildLook() {
  const host = $('looks');
  for (const l of LOOKS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'look'; b.setAttribute('role', 'radio'); b.dataset.v = l.id;
    b.innerHTML = '<span class="thumb"><canvas aria-hidden="true"></canvas><span class="skeleton"></span></span><span class="name"></span>';
    b.querySelector('.name').textContent = l.name;
    host.append(b);
  }
  segBind(host, v => {
    if (v === state.look) return;
    state.look = v; segSet(host, v); render(); commit('Look');
  });
  segBind($('styleSeg'), v => {
    const r = resolve();
    const why = $('styleWhy');
    if (!modeAllowed(r.id, v) || (v === 'blocks' && r.id !== 'plain')) {
      why.textContent = whyNot(v, r);
      why.classList.add('why');
      segSet($('styleSeg'), r.mode);
      return;
    }
    why.textContent = ''; why.classList.remove('why');
    const picked = prefs.modePicked;
    prefs.modePicked = true;
    if (v === r.mode && v === state.mode) { if (!picked) persist(); return; }
    state.mode = v;
    state.cols = null;
    render(); commit('Style');
  });
  segBind($('ditherSeg'), v => { state.dither = v; segSet($('ditherSeg'), v); render(); commit('Dithering'); });
  segBind($('asciiSeg'), v => { state.ascii = v; segSet($('asciiSeg'), v); render(); commit('Letters'); });
  segBind($('blocksSeg'), v => { state.blocks = v; segSet($('blocksSeg'), v); render(); commit('Blocks'); });
  $('colorSwitch').addEventListener('change', e => { state.color = e.target.checked; render(); commit('Colour'); });
}

function syncLookPanel() {
  const r = cur ? cur.r : resolve();
  segSet($('looks'), state.look);
  segSet($('styleSeg'), r.mode);
  for (const b of $('styleSeg').querySelectorAll('[role="radio"]')) {
    const ok = modeAllowed(r.id, b.dataset.v) && (b.dataset.v !== 'blocks' || r.id === 'plain');
    if (ok) b.removeAttribute('aria-disabled'); else b.setAttribute('aria-disabled', 'true');
    b.title = ok ? '' : whyNot(b.dataset.v, r);
  }
  // the user's style is not possible here: say why once, quietly
  const why = $('styleWhy');
  if (state.mode !== r.mode && !why.classList.contains('why')) why.textContent = whyNot(state.mode, r).replace(':', ', so this uses dots:');
  else if (state.mode === r.mode && !why.classList.contains('why')) why.textContent = '';
  for (const el of document.querySelectorAll('#lookMore [data-for]')) {
    el.classList.toggle('on', el.dataset.for.split(' ').includes(r.mode));
  }
  $('colorSwitch').closest('.switch-row').hidden = r.ui !== 'file';
  segSet($('ditherSeg'), state.dither);
  segSet($('asciiSeg'), state.ascii);
  segSet($('blocksSeg'), state.blocks);
  $('colorSwitch').checked = !!state.color;
}

// thumbnails of the user's own photo in each look, in idle time, only while visible
let thumbKey = '', thumbJob = 0;
function lookVisible() {
  if (wide.matches) return true;
  return $('panel-look').classList.contains('active');
}
function queueThumbs(force = false) {
  if (!photo || !cur || !lookVisible()) return;
  const { r, cols, rows } = cur;
  const tone = { ...state.tone };
  const key = JSON.stringify([photo.id, state.crop, cols, rows, r.mode, state.dither, state.ascii, state.blocks, tone, state.previewTheme]);
  if (key === thumbKey && !force) return;
  thumbKey = key;
  cic(thumbJob);
  const items = [...$('looks').querySelectorAll('.look')];
  let i = 0;
  const step = deadline => {
    while (i < items.length && (deadline.didTimeout || deadline.timeRemaining() > 3)) {
      drawThumb(items[i], r, cols, rows);
      i++;
    }
    if (i < items.length) thumbJob = ric(step, { timeout: 400 });
  };
  thumbJob = ric(step, { timeout: 400 });
}
function drawThumb(btn, r, cols, rows) {
  const look = btn.dataset.v;
  const g = conv.run(state.crop, {
    mode: r.mode, cols, rows, tone: { ...state.tone, look }, dither: state.dither, ascii: state.ascii,
    blocks: state.blocks, color: false,
  });
  const cv = btn.querySelector('canvas');
  const css = btn.querySelector('.thumb').clientWidth || 72;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const S = Math.round(css * dpr);
  cv.width = S; cv.height = S;
  const c = PV[state.previewTheme];
  const ctx = cv.getContext('2d');
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, S, S);
  const pad = S * 0.08;
  const cw = (S - 2 * pad) / cols;
  const ch = cw / cellAspect(r.id, r.mode);
  const h = ch * rows;
  drawGrid(ctx, g, { x: pad, y: (S - h) / 2, cellW: cw, cellH: ch, ink: c.ink, font: "'Geist Mono', monospace" });
  btn.querySelector('.skeleton')?.remove();
}

// ------------------------------------------------------------------------------------ Size panel
function buildSize() {
  $('colsMinus').addEventListener('click', () => stepCols(-1));
  $('colsPlus').addEventListener('click', () => stepCols(1));
  $('autoBadge').addEventListener('click', () => { if (state.cols == null) return; state.cols = null; render(); commit('Width'); });
  segBind($('variantSeg'), v => {
    const ui = state.target;
    if (!(ui in state.targetOpts)) return;
    state.targetOpts[ui] = v;
    state.cols = null;
    render(); commit('Target option');
  });
  segBind($('blankSeg'), v => { state.blank = v; segSet($('blankSeg'), v); render(); commit('Blank cells'); });
}

function stepCols(d) {
  if (!cur) return;
  const r = cur.r;
  const next = clamp(cur.cols + d, COLS_MIN, COLS_MAX);
  if (next === cur.cols) return;
  state.cols = next === autoCols(r) ? null : next;
  render();
  commit('Width');
  announce(`${cur.cols} columns, ${cur.rows} rows. ${$('fitLine').textContent}`);
}

let variantFor = '';
function syncSize() {
  if (!cur) return;
  const { r, cols, rows } = cur;
  $('colsNum').textContent = cols;
  $('colsMinus').disabled = cols <= COLS_MIN;
  $('colsPlus').disabled = cols >= COLS_MAX;
  const isAuto = state.cols == null || state.cols === autoCols(r);
  $('autoBadge').setAttribute('aria-pressed', String(isAuto));
  $('rowsHelper').textContent = `Height follows the crop · ${rows} rows`;
  const ui = r.ui;
  const key = `${ui}|${r.mode}`;
  const box = $('variantBox');
  if (key !== variantFor) {
    variantFor = key;
    let label = '', opts = [];
    if (ui === 'x') { label = 'Post'; opts = [['post', 'Post', '280'], ['long', 'Long post', 'Premium']]; }
    if (ui === 'tg') {
      label = 'Screen';
      opts = [['phone', 'Phone', `${maxCols('tg', r.mode, { phone: 390 })} wide`], ['desktop', `Desktop (${maxCols('tg', r.mode, { phone: 'desktop' })})`, 'Telegram Desktop']];
    }
    if (ui === 'tgc') { label = 'Post type'; opts = [['post', 'Text post', '4,096'], ['caption', 'Photo caption', '1,024']]; }
    box.hidden = !opts.length;
    $('variantLabel').textContent = label;
    $('variantSeg').innerHTML = opts.map(([v, a, b]) => `<button type="button" role="radio" data-v="${v}">${a}<small>${b}</small></button>`).join('');
  }
  if (ui in state.targetOpts) segSet($('variantSeg'), state.targetOpts[ui]);
  $('blankBox').hidden = !(r.mode === 'braille' && ui !== 'file');
  segSet($('blankSeg'), state.blank);
}

// ------------------------------------------------------------------------------------ Tone panel
const sliders = {};
function buildTone() {
  const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
  const defs = [
    ['toneSliders', 'brightness', 'Brightness', -1, 1, 0.01, pct],
    ['toneSliders', 'contrast', 'Contrast', -1, 1, 0.01, pct],
    ['toneMoreSliders', 'gamma', 'Gamma', 0.3, 3, 0.01, v => v.toFixed(2)],
    ['toneMoreSliders', 'detail', 'Detail', 0, 1, 0.01, v => `${Math.round(v * 100)}%`],
    ['toneMoreSliders', 'edges', 'Edges', 0, 1, 0.01, v => `${Math.round(v * 100)}%`],
  ];
  for (const [host, k, label, min, max, step, format] of defs) {
    const s = sliderRow({
      label, min, max, step, value: state.tone[k], def: TONE_DEFAULTS[k], format,
      onInput: v => { state.tone[k] = v; schedule(); },
      onCommit: v => { state.tone[k] = v; render(); commit(label); },
    });
    sliders[k] = s;
    $(host).append(s.el);
  }
  $('invertSwitch').addEventListener('change', e => setInvert(e.target.checked));
  $('autoSwitch').addEventListener('change', e => { state.tone.auto = e.target.checked; render(); commit('Auto levels'); });
}
function setInvert(on) {
  state.tone.invert = !!on;
  $('invertSwitch').checked = !!on;
  render();
  commit('Invert');
  announce(on ? 'Inverted for dark mode' : 'Not inverted');
}

function syncControls() {
  for (const [k, s] of Object.entries(sliders)) s.set(state.tone[k]);
  $('invertSwitch').checked = !!state.tone.invert;
  $('autoSwitch').checked = !!state.tone.auto;
  syncTargetChecks();
  syncLookPanel();
  syncPreviewTools();
}

// ------------------------------------------------------------------------------------ tabs
const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
function selectTab(name) {
  for (const t of tabs) { const on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === name);
  queueThumbs();
}
for (const t of tabs) t.addEventListener('click', () => selectTab(t.dataset.tab));
$('tabs').addEventListener('keydown', e => {
  const i = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
  const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
  if (j >= 0) { e.preventDefault(); tabs[j].focus(); selectTab(tabs[j].dataset.tab); }
});

// ------------------------------------------------------------------------------------ preview tools
function syncPreviewTools() {
  const dark = state.previewTheme === 'dark';
  const b = $('btnPvTheme');
  b.querySelector('use').setAttribute('href', dark ? '#i-moon' : '#i-sun');
  b.setAttribute('aria-label', dark ? 'Preview in light mode' : 'Preview in dark mode');
  b.title = dark ? 'Dark preview (tap for light)' : 'Light preview (tap for dark)';
  $('deviceName').textContent = DEVICE_NAME[state.device];
  for (const it of document.querySelectorAll('#deviceMenu [data-device]')) it.setAttribute('aria-checked', String(it.dataset.device === state.device));
}
$('btnPvTheme').addEventListener('click', () => {
  state.previewTheme = state.previewTheme === 'dark' ? 'light' : 'dark';
  syncPreviewTools(); persist();
  if (cur) { drawPreviews(); queueThumbs(); }
});
const deviceMenu = popover($('btnDevice'), $('deviceMenu'));
menuKeys($('deviceMenu'));
$('deviceMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-device]');
  if (!b) return;
  state.device = b.dataset.device;
  deviceMenu.close();
  syncPreviewTools(); persist();
  if (cur) drawPreviews();
});

// compare: hold to see the photo in place of the art
let comparing = false;
function drawCropped(ctx, src, crop, W, H) {
  const w = src.width, h = src.height;
  const side = Math.min(w, h) / Math.max(0.05, crop.zoom || 1);
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.scale(W / side, H / side);
  ctx.rotate(((crop.rotation || 0) * Math.PI) / 180);   // the sampler turns the photo clockwise
  ctx.drawImage(src, -crop.x * w, -crop.y * h);
  ctx.restore();
}
function artCanvas() {
  const host = $('pv0');
  return host.querySelector('canvas[role="img"]') || host.querySelector('canvas');
}
function placePeek() {
  const peek = $('photoPeek');
  const art = artCanvas();
  if (!art || !photo) return;
  const r0 = $('previews').getBoundingClientRect(), r1 = art.getBoundingClientRect();
  Object.assign(peek.style, { left: `${r1.left - r0.left}px`, top: `${r1.top - r0.top}px`, width: `${r1.width}px`, height: `${r1.height}px` });
  const cv = peek.querySelector('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(r1.width * dpr)); cv.height = Math.max(1, Math.round(r1.height * dpr));
  drawCropped(cv.getContext('2d'), photo.canvas, state.crop, cv.width, cv.height);
}
function setCompare(on) {
  if (!photo || cropping || on === comparing) return;
  comparing = on;
  $('btnCompare').setAttribute('aria-pressed', String(on));
  $('photoPeek').hidden = !on;
  if (on) placePeek();
}
{
  const b = $('btnCompare');
  b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); setCompare(true); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => setCompare(false));
  b.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } });
  b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') setCompare(false); });
  b.addEventListener('contextmenu', e => e.preventDefault());
}

// ------------------------------------------------------------------------------------ crop
let cropping = null;   // { start, api }
function enterCrop() {
  if (!photo || cropping) return;
  setCompare(false);
  const start = { ...state.crop };
  cropping = { start, api: null };
  document.body.classList.add('cropping');
  $('previews').hidden = true;
  $('previewBar').hidden = true;
  const host = $('cropHost');
  host.hidden = false;
  host.replaceChildren();
  const api = createCropper({
    host, image: photo.canvas, crop: { ...state.crop },
    onChange: c => { state.crop = { ...CROP_DEFAULTS, ...c }; schedule(); },
    onCommit: (c, info) => exitCrop(true, c, !info || info.changed !== false),
    onCancel: () => exitCrop(false),
    // cut-outs fit their visible area, photos the whole frame
    fitCrop: () => autoCrop(photo),
  });
  cropping.api = api;
  api.enter({ ...state.crop });
  syncFileChips();
  drawMini();
}
/** Close the crop screen without touching state.crop (callers decide what the crop becomes). */
function teardownCrop(apply = false) {
  if (!cropping) return null;
  const { start, api } = cropping;
  cropping = null;
  document.body.classList.remove('cropping');
  try { api.exit(apply); api.destroy(); } catch (e) { console.error(e); }
  $('cropHost').hidden = true;
  $('cropHost').replaceChildren();
  $('previews').hidden = false;
  $('previewBar').hidden = false;
  return start;
}
function exitCrop(apply, c, changed = true) {
  if (!cropping) return;
  const start = teardownCrop(apply);
  // Done without a change keeps the exact crop from before (crop.js rounds to 5 decimals)
  const keep = !apply || !changed;
  state.crop = keep ? start : { ...CROP_DEFAULTS, ...(c || state.crop) };
  render();
  if (!keep) { commit('Crop'); saveSession(); }
  $('btnCrop').focus();
}

$('btnCrop').addEventListener('click', enterCrop);

// ------------------------------------------------------------------------------------ photos
async function setPhoto(img, { sample = null, crop = null, silent = false, file = null } = {}) {
  // a photo that arrives while cropping (drop, paste) must not inherit the old photo's frame
  if (cropping) teardownCrop();
  photo = { ...img, id: ++photoSeq, sample };
  // the file itself when it is small: a reload then decodes the very same pixels (same art)
  if (file && file.size <= 8e6) photo.blob = file;
  conv.setSource(img.canvas);
  state.crop = crop ? { ...CROP_DEFAULTS, ...crop } : autoCrop(img);
  hideWelcome();
  render();
  history.reset(snapshot());
  prefs.source = sample ? `sample:${sample}` : 'photo';
  persist();
  thumbKey = '';
  queueThumbs();
  if (!silent) announce(sample ? `${img.name} sample loaded. ${$('fitLine').textContent}` : `Photo loaded. ${$('fitLine').textContent}`);
  if (img.small) toast('This photo is small, so fine details may get lost.');
  if (!sample) saveSession();
  requestAnimationFrame(() => { if (grid && grid.tone && grid.tone.flat) toast('This photo is very flat. One with a clear subject works best.'); });
}

async function saveSession() {
  if (!photo || photo.sample) return;
  clearTimeout(saveSession.t);
  saveSession.t = setTimeout(async () => {
    try {
      if (!photo.blob) photo.blob = await encodeForStorage(photo.canvas);
      // bytes, not a Blob: Safari refuses Blobs in IndexedDB in private windows
      const bytes = await photo.blob.arrayBuffer();
      await savePhoto({ bytes, type: photo.blob.type, name: photo.name, crop: state.crop, savedAt: Date.now() });
    } catch { /* storage is best-effort */ }
  }, 500);
}

let loading = 0;
async function openFile(file) {
  const t = setTimeout(() => toast('Reading your photo…'), 300);
  const my = ++loading;
  try {
    const img = await decodeImage(file);
    if (my !== loading) return;
    await setPhoto(img, { file });
  } catch (e) {
    console.warn(e);
    toast(imageErrorMessage(e), { error: true });
    announce(imageErrorMessage(e), true);
  } finally {
    clearTimeout(t);
  }
}

async function openSample(id, opts = {}) {
  try {
    const meta = SAMPLES.find(s => s.id === id) || SAMPLES[1];
    const bmp = await loadSample(meta.id);
    await setPhoto(fromDrawable(bmp, meta.name), { sample: meta.id, ...opts });
    return true;
  } catch (e) {
    console.warn('sample failed', e);
    toast('That sample could not be loaded. Choose a photo instead.', { error: true });
    return false;
  }
}

const fileInput = $('fileInput'), cameraInput = $('cameraInput');
function pickFile() { fileInput.value = ''; fileInput.click(); }
fileInput.addEventListener('change', () => { if (fileInput.files[0]) openFile(fileInput.files[0]); });
cameraInput.addEventListener('change', () => { if (cameraInput.files[0]) openFile(cameraInput.files[0]); });
$('btnChoose').addEventListener('click', pickFile);
$('btnNewTop').addEventListener('click', pickFile);
$('btnCamera').addEventListener('click', () => { cameraInput.value = ''; cameraInput.click(); });

// drag and drop, paste: anywhere, on every screen
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropzone').hidden = true; });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  const files = [...e.dataTransfer.files];
  const img = files.find(f => f.type.startsWith('image/')) || files[0];
  if (files.length > 1) toast('Using the first photo.');
  if (img) openFile(img);
});
window.addEventListener('paste', e => {
  if (e.target.closest?.('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const f = item.getAsFile();
  if (f) openFile(new File([f], f.name || 'pasted image.png', { type: f.type }));
});

// ------------------------------------------------------------------------------------ welcome
let welcomeAnim = 0;
let welcomeDone = false;
function showWelcome() {
  document.body.classList.add('welcoming');
  $('welcome').hidden = false;
  document.body.classList.remove('booting');
  buildSamples();
  const sheet = $('welcome');
  const setH = () => document.documentElement.style.setProperty('--sheet-h', `${sheet.offsetHeight}px`);
  setH();
  new ResizeObserver(setH).observe(sheet);
  typeWelcome();
}
function hideWelcome() {
  if ($('welcome').hidden) return;
  $('welcome').hidden = true;
  document.body.classList.remove('welcoming');
  cancelAnimationFrame(welcomeAnim);
}
let samplesBuilt = false;
function buildSamples() {
  if (samplesBuilt) return;
  samplesBuilt = true;
  const host = $('samples');
  for (const s of SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sample';
    b.innerHTML = '<img alt="" width="80" height="80" decoding="async"><span></span>';
    b.querySelector('img').src = thumbUrl(s.id);
    b.querySelector('span').textContent = s.name;
    b.setAttribute('aria-label', `Try the ${s.name.toLowerCase()} sample`);
    b.title = s.alt;
    b.addEventListener('click', () => openSample(s.id));
    host.append(b);
  }
}

// the pet types itself in as Braille behind the sheet, row by row
async function typeWelcome() {
  const cv = $('welcomeCanvas');
  const area = $('welcomeArt');
  let g;
  try {
    const c2 = createConverter();
    c2.setSource(await loadSample('pet'));
    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    const cols = 44;
    const rows = rowsFor(cols, cellAspect('ig', 'braille'));
    g = c2.run({ ...CROP_DEFAULTS, zoom: 1.08, y: 0.47 }, { mode: 'braille', cols, rows, tone: { ...TONE_DEFAULTS, invert: dark } });
  } catch (e) {
    console.warn('welcome art failed', e);
    welcomeDone = true;
    window.__done = window.__done || { ok: true, screen: 'welcome', art: false };
    return;
  }
  if ($('welcome').hidden) return;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1c1b19';
  const aspect = cellAspect('ig', 'braille');
  const fit = () => {
    const w = area.clientWidth - 32, h = area.clientHeight - 28;
    const side = Math.max(120, Math.min(w, h, 460));
    return { cw: side / g.cols, ch: side / g.cols / aspect, side };
  };
  const total = g.cols * g.rows;
  const partial = { ...g, cp: new Uint32Array(g.cp.length) };
  const paint = n => {
    const { cw, ch } = fit();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = g.cols * cw, H = g.rows * ch;
    cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    partial.cp.fill(0x2800);
    partial.cp.set(g.cp.subarray(0, n));
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGrid(ctx, partial, { cellW: cw, cellH: ch, ink, dotR: 0.34 });
  };
  const finish = () => {
    paint(total);
    welcomeDone = true;
    window.__done = window.__done || { ok: true, screen: 'welcome' };
  };
  if (reducedMotion()) { finish(); return; }
  const dur = 2200, t0 = performance.now();
  const tick = now => {
    if ($('welcome').hidden) return;
    const k = Math.min(1, (now - t0) / dur);
    // rows land at a steady typing rhythm; each row sweeps left to right
    paint(Math.round(total * k));
    if (k < 1) welcomeAnim = requestAnimationFrame(tick); else finish();
  };
  welcomeAnim = requestAnimationFrame(tick);
  window.addEventListener('resize', () => { if (welcomeDone && !$('welcome').hidden) paint(total); });
}

// ------------------------------------------------------------------------------------ menu, theme
const topMenu = popover($('btnMenu'), $('menu'));
menuKeys($('menu'));
function applyTheme() {
  const t = prefs.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  segSet($('themeSeg'), t);
}
segBind($('themeSeg'), v => { prefs.theme = v; applyTheme(); persist(); });
$('menu').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  topMenu.close();
  if (act === 'open') pickFile();
  if (act === 'about') $('aboutDlg').showModal();
  if (act === 'sharex' && !shareSiteOnX()) toast('Your browser blocked the X tab. Allow pop-ups for this site and try again.');
});
$('btnUndo').addEventListener('click', () => restore(history.undo()));
$('btnRedo').addEventListener('click', () => restore(history.redo()));

// ------------------------------------------------------------------------------------ keyboard
window.addEventListener('keydown', e => {
  if (e.defaultPrevented) return;
  const t = e.target;
  if (t.closest && t.closest('input, textarea, select, [contenteditable="true"], dialog[open]')) return;
  if (cropping) return;
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;
  if ((k === 'z' || k === 'Z') && !e.altKey) {
    e.preventDefault();
    restore(e.shiftKey ? history.redo() : history.undo());
    return;
  }
  if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); restore(history.redo()); return; }
  if (mod || e.altKey || !photo) return;
  const target = UI_TARGETS.find(x => x.key === k);
  if (target) { setTarget(target.id); return; }
  if (k === 'c' || k === 'C') {
    e.preventDefault();
    const set = actionSets[wide.matches ? 1 : 0] || actionSets[0];
    onPrimary(e, set);
  } else if (k === 's' || k === 'S') { e.preventDefault(); download('png', e); }
  else if (k === '[') stepCols(-1);
  else if (k === ']') stepCols(1);
  else if (k === 'i' || k === 'I') setInvert(!state.tone.invert);
  else if (k === 'f' || k === 'F') { e.preventDefault(); enterCrop(); }
  else if (k === '\\') { e.preventDefault(); setCompare(true); }
});
window.addEventListener('keyup', e => { if (e.key === '\\') setCompare(false); });
window.addEventListener('blur', () => setCompare(false));

// ------------------------------------------------------------------------------------ layout
// phones: the fit meter lives in the fixed action bar (always in view, right above the button it
// qualifies); desktop: under the preview
function placeFit() {
  const fit = $('fit');
  if (wide.matches) { if (fit.parentElement !== $('stage')) $('stage').append(fit); }
  else if (fit.parentElement !== $('actionBar')) $('actionBar').prepend(fit);
}
for (const m of [wide, sideBySide]) m.addEventListener('change', () => { placeFit(); if (cur) { drawPreviews(); drawMini(); queueThumbs(); } });
// toasts sit just above the action bar, whose height changes (the Instagram tip, cropping)
if ('ResizeObserver' in window) {
  new ResizeObserver(() => {
    const h = $('actionBar').offsetHeight;
    if (h) document.documentElement.style.setProperty('--bar-live', `${h}px`);
    else document.documentElement.style.removeProperty('--bar-live');
  }).observe($('actionBar'));
}

// File: .txt / PNG / SVG / HTML as chips under the preview
$('fileChips').addEventListener('click', e => {
  const b = e.target.closest('[data-fmt]');
  if (b) download(b.dataset.fmt, e);
});

// press and hold the art itself to see the photo (the Compare pill does the same)
{
  const host = $('previews');
  let timer = 0, start = null;
  const stop = () => { clearTimeout(timer); timer = 0; start = null; setCompare(false); };
  host.addEventListener('pointerdown', e => {
    if (!e.target.closest('canvas.pv-art') || e.button > 0) return;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => setCompare(true), 280);
  });
  host.addEventListener('pointermove', e => {
    // a scroll or a drag is not a hold
    if (start && !comparing && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { clearTimeout(timer); start = null; }
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) host.addEventListener(ev, stop);
  host.addEventListener('contextmenu', e => { if (e.target.closest('canvas.pv-art')) e.preventDefault(); });
}

// keyboard focus never hides under the fixed action bar (scroll-padding covers most engines)
document.addEventListener('focusin', e => {
  if (wide.matches || !(e.target instanceof Element) || e.target.closest('#actionBar, .topbar, dialog, .menu')) return;
  const r = e.target.getBoundingClientRect();
  const bar = $('actionBar').getBoundingClientRect().top;
  if (r.bottom > bar - 8) window.scrollBy({ top: r.bottom - bar + 16, behavior: 'auto' });
});
// canvases are drawn at devicePixelRatio: redraw when the window moves to another screen / zoom
function watchDpr() {
  matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => { if (cur) { drawPreviews(); queueThumbs(true); } watchDpr(); }, { once: true });
}
watchDpr();
let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { if (cur) { drawPreviews(); } });
});

// ------------------------------------------------------------------------------------ boot
async function boot() {
  applyTheme();
  buildTargets();
  buildLook();
  buildSize();
  buildTone();
  makeActions($('actionBar'), true);
  makeActions($('topActions'), false);
  placeFit();
  syncControls();
  selectTab('look');
  history.reset(snapshot());

  starCount().then(n => {
    if (n == null) return;
    const el = $('starCount');
    el.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    el.hidden = false;
  });

  const params = new URLSearchParams(location.search);
  const src = params.has('welcome') ? null : prefs.source;
  if (src === 'photo') {
    const rec = await loadPhoto();
    const blob = rec && (rec.blob || (rec.bytes && new Blob([rec.bytes], { type: rec.type || 'image/jpeg' })));
    if (blob) {
      try {
        const img = await decodeImage(blob, rec.name);
        await setPhoto(img, { crop: state.crop, silent: true, file: blob });
        return;
      } catch { /* fall through to the welcome */ }
    }
  } else if (src && src.startsWith('sample:')) {
    if (await openSample(src.slice(7), { crop: state.crop, silent: true })) return;
  }
  showWelcome();
}

// test hooks
window.TY = {
  get state() { return state; }, get grid() { return grid; }, get payload() { return payload; }, ready,
  get photo() { return photo; }, get cur() { return cur; }, get welcomeDone() { return welcomeDone; },
  history, setTarget, openSample, openFile, render, selectTab, enterCrop, exitCrop, setCompare, stepCols, setInvert, autoCols, download,
  clearNote() { resizedNote = null; if (cur) updateFit(); },
  set(patch) { Object.assign(state, patch); syncControls(); render(); commit('Test'); },
  async shot(name = 'app') {
    const art = artCanvas();
    if (!art) return null;
    return (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: art.toDataURL('image/png') }) })).json();
  },
};

boot().catch(e => {
  console.error(e);
  window.__done = { ok: false, error: String(e && e.message || e) };
});

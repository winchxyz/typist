// Bench for js/copy.js + js/export.js. See dev/copy.html for the query options.
import { createConverter } from '../js/convert.js';
import { loadSample } from '../js/samples.js';
import { formatFor, autoFit } from '../js/targets.js';
import { copyFor } from '../js/copy.js';
import { xIntentUrl, tgShareUrl, linkFits, SITE_URL } from '../js/links.js';
import { exportPNG, exportSVG, exportHTML, exportTxt, svgBlob, fileName, INK, PAPER } from '../js/export.js';

const q = new URLSearchParams(location.search);
const SHEET = q.get('sheet') || 'copy';
const DEVICE = q.get('device') || 'desktop';
const logEl = document.getElementById('log');
const log = s => { logEl.textContent += s + '\n'; };

// ---- instrumentation: which clipboard / popup calls happened, and inside the click or not ------
window.__calls = [];
let inClick = false;
const note = (api, extra = {}) => window.__calls.push({ api, inClick, t: performance.now(), ...extra });
const clip = navigator.clipboard;
const DENY = q.get('deny');
const reject = () => Promise.reject(new DOMException('Denied by the bench', 'NotAllowedError'));
if (clip) {
  const w = clip.write && clip.write.bind(clip), wt = clip.writeText && clip.writeText.bind(clip);
  // Firefox / WebKit: the Clipboard object's methods live on the prototype; own props shadow them.
  try {
    Object.defineProperty(clip, 'write', { configurable: true, value: items => {
      note('write', { types: items.flatMap(i => [...i.types]) });
      return DENY ? reject() : w(items);
    } });
    Object.defineProperty(clip, 'writeText', { configurable: true, value: t => {
      note('writeText'); return DENY ? reject() : wt(t);
    } });
  } catch (e) { log('cannot instrument clipboard: ' + e.message); }
}
const exec = document.execCommand.bind(document);
document.execCommand = (cmd, ...a) => {
  const r = DENY === 'all' && cmd === 'copy' ? false : exec(cmd, ...a);
  note('execCommand', { cmd, result: r });
  return r;
};
const open = window.open.bind(window);
window.open = (url, ...a) => {
  note('open', { url });
  return q.get('block') ? null : open(url, ...a);
};
if (q.get('share')) {
  const mode = q.get('share');
  navigator.share = data => {
    note('share', { data });
    if (mode === 'abort') return Promise.reject(new DOMException('Share canceled', 'AbortError'));
    if (mode === 'fail') return Promise.reject(new DOMException('No activation', 'NotAllowedError'));
    return Promise.resolve();
  };
  navigator.canShare = data => !!(data && typeof data.text === 'string');
}
// what a paste delivers (engines where the clipboard cannot be read by script)
window.__pasted = null;
document.addEventListener('paste', e => {
  const d = e.clipboardData;
  // WebKit lists every type it could convert to, even empty ones: keep the ones with data
  window.__pasted = { types: [...d.types].filter(t => d.getData(t) !== ''), text: d.getData('text/plain'), html: d.getData('text/html') };
  e.preventDefault();
});

// ---- art ------------------------------------------------------------------------------------------
const bmp = await loadSample('pet');
const conv = createConverter();
conv.setSource(bmp);
const art = (mode, cols, rows, extra = {}) => conv.run({}, { mode, cols, rows, dither: 'atkinson', ascii: 'shape', ...extra });
const fit = (t, mode, o = {}) => autoFit(t, mode, o);

if (SHEET === 'export') await exportSheet();
else copyBench();

function copyBench() {
  const defs = [
    ['ig', 'braille', fit('ig', 'braille'), {}, 'auto', 'Instagram comment'],
    ['x', 'braille', { cols: 16, rows: 8 }, {}, 'auto', 'X post: intent + clipboard'],
    ['x', 'braille', { cols: 16, rows: 8 }, {}, 'copy', 'X post: Copy only'],
    ['x', 'braille', { cols: 24, rows: 14 }, {}, 'auto', 'X post over 280: clipboard'],
    ['xlong', 'braille', fit('xlong', 'braille'), {}, 'auto', 'X long post'],
    ['tg', 'braille', fit('tg', 'braille'), {}, 'auto', 'Telegram, dots'],
    ['tg', 'ascii', fit('tg', 'ascii'), {}, 'auto', 'Telegram, letters (html on desktop)'],
    ['tgc', 'ascii', fit('tgc', 'ascii', { caption: true }), { caption: true }, 'auto', 'Channel caption, letters'],
    ['tgc', 'braille', fit('tgc', 'braille'), {}, 'auto', 'Channel post, dots'],
    ['tg', 'braille', { cols: 8, rows: 4 }, {}, 'share', 'Telegram share, short: t.me'],
    ['tg', 'braille', fit('tg', 'braille'), {}, 'share', 'Telegram share, long: clipboard'],
    ['tg', 'ascii', fit('tg', 'ascii'), {}, 'share', 'Telegram share, letters'],
    ['plain', 'blocks', { cols: 24, rows: 12 }, {}, 'auto', 'Plain text, blocks'],
  ];
  window.CASES = defs.map(([target, mode, size, fopts, action, label], i) => {
    const grid = art(mode, size.cols, size.rows);
    const payload = formatFor(target, grid, fopts);
    return { i, target, mode, action, label, payload, text: payload.text, html: payload.html,
             cols: grid.cols, rows: grid.rows, fits: payload.fits,
             xLink: linkFits(xIntentUrl(payload.text), 'x'), tgLink: linkFits(tgShareUrl(payload.text), 'tg'), site: SITE_URL };
  });
  const host = document.getElementById('cases');
  for (const c of window.CASES) {
    const b = document.createElement('button');
    b.id = 'case' + c.i;
    b.innerHTML = `${c.label}<small>${c.target} · ${c.mode} · ${c.cols}×${c.rows} · ${c.payload.count} · ${c.action}</small>`;
    b.addEventListener('click', e => {
      window.__calls = [];
      window.__last = null;
      inClick = true;
      let p;
      try { p = copyFor(c.target, c.payload, { event: e, device: DEVICE === 'auto' ? undefined : DEVICE, action: c.action }); }
      finally { inClick = false; }
      p.then(r => { window.__last = r; log(`#${c.i} ${c.label}: ${r.how} ${r.via || ''} | ${r.hint}`); },
        err => { window.__last = { error: String(err) }; log('error ' + err); });
    });
    host.append(b);
  }
  window.__done = { ok: true, cases: window.CASES.length, device: DEVICE };
}

async function exportSheet() {
  const out = document.getElementById('out');
  document.getElementById('cases').remove();
  document.getElementById('paste').remove();
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  out.append(sheet);
  for (const h of ['', 'PNG (2×, raster.js)', 'SVG', 'HTML page']) {
    const d = document.createElement('div'); d.className = 'head'; d.textContent = h; sheet.append(d);
  }
  const rows = [
    ['Braille', 'plain', art('braille', 40, 23), { }],
    ['Braille, dark', 'plain', art('braille', 40, 23, { tone: { invert: true } }), { ink: '#f2f0ea', paper: '#161514' }],
    ['ASCII (tg)', 'tg', art('ascii', 40, 18), {}],
    ['Blocks, mono', 'plain', art('blocks', 40, 20), {}],
    ['Blocks, colour', 'plain', art('blocks', 40, 20, { color: true }), {}],
  ];
  const report = [];
  for (const [label, target, grid, o] of rows) {
    const opts = { target, ink: o.ink || INK, paper: o.paper || PAPER };
    const l = document.createElement('div');
    l.className = 'label';
    l.innerHTML = `${label}<small>${grid.cols} × ${grid.rows} · ${fileName({ target, cols: grid.cols, rows: grid.rows }, 'png')}</small>`;
    sheet.append(l);
    const t0 = performance.now();
    const png = await exportPNG(grid, opts);
    const pngMs = performance.now() - t0;
    const img = new Image();
    img.src = URL.createObjectURL(png);
    await img.decode();
    const c1 = cell(img, `${img.naturalWidth}×${img.naturalHeight} · ${(png.size / 1024).toFixed(1)} KB · ${pngMs.toFixed(0)} ms`);
    const svg = exportSVG(grid, opts);
    const simg = new Image();
    simg.src = URL.createObjectURL(svgBlob(svg));
    await simg.decode();
    const c2 = cell(simg, `${(svg.length / 1024).toFixed(1)} KB`);
    const html = exportHTML(grid, opts);
    (window.__html = window.__html || {})[label] = html;
    const fr = document.createElement('iframe');
    fr.srcdoc = html;
    const c3 = cell(fr, `${(html.length / 1024).toFixed(1)} KB`);
    sheet.append(c1, c2, c3);
    await new Promise(res => { fr.onload = res; setTimeout(res, 2000); });
    const txt = await exportTxt(grid).text();
    report.push({ label, cols: grid.cols, rows: grid.rows, png: [img.naturalWidth, img.naturalHeight, png.size],
                  svg: svg.length, html: html.length, txt: txt.length });
  }
  log(JSON.stringify(report, null, 1));
  await document.fonts.ready;
  window.__done = { ok: true, report };
}

function cell(node, meta) {
  const d = document.createElement('div');
  const m = document.createElement('div');
  m.className = 'meta';
  m.textContent = meta;
  d.append(node, m);
  return d;
}

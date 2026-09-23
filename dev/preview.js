// Contact sheet for js/preview.js: rows = targets, columns = device x theme, plus one too-wide case
// per target so the wrapped rows show. Samples go through js/convert.js at autoFit size, exactly as
// the app will do it.
import { createConverter } from '../js/convert.js';
import { loadSample, imageUrl } from '../js/samples.js';
import { autoFit, formatFor, maxCols, rowsFor, cellAspect } from '../js/targets.js';
import { renderPreview, cellMetrics, shearOffsets, payloadRows } from '../js/preview.js';

const q = new URLSearchParams(location.search);
const PHONE = +q.get('phone') || 390;
const pick = (list, key) => (q.get(key) ? list.filter(x => q.get(key).split(',').includes(x.id)) : list);

const ROWS = pick([
  { id: 'ig', target: 'ig', mode: 'braille', sample: 'pet', label: 'Instagram comment' },
  { id: 'x', target: 'x', mode: 'braille', sample: 'logo', label: 'X post' },
  { id: 'xlong', target: 'xlong', mode: 'braille', sample: 'pet', label: 'X long post (Premium)' },
  { id: 'tg', target: 'tg', mode: 'braille', sample: 'logo', label: 'Telegram message · dots' },
  { id: 'tga', target: 'tg', mode: 'ascii', sample: 'pet', label: 'Telegram message · letters', sub: 'ASCII in a ``` fence' },
  { id: 'tgc', target: 'tgc', mode: 'braille', sample: 'logo', opts: { caption: true }, label: 'Channel · photo caption' },
], 'rows');
const COLS = pick([
  { id: 'ios-light', device: 'ios', theme: 'light', label: 'iPhone · light' },
  { id: 'ios-dark', device: 'ios', theme: 'dark', invert: true, label: 'iPhone · dark', sub: 'art inverted for dark mode' },
  { id: 'android-dark', device: 'android', theme: 'dark', invert: true, label: 'Android · dark', sub: 'art inverted for dark mode' },
  { id: 'win-light', device: 'windows', theme: 'light', label: 'Windows · light', sub: 'Segoe UI Symbol: blanks 0.651 em, dots 0.753 em' },
  { id: 'wide', device: 'ios', theme: 'light', wide: true, label: 'Too wide · iPhone light', sub: 'maxCols + 6 columns' },
], 'cols');

const sheet = document.getElementById('sheet');
document.getElementById('lede').textContent =
  `js/preview.js at 1:1 on a ${PHONE} px phone. Samples converted with js/convert.js (Atkinson, shape-aware letters) ` +
  'at autoFit size; the last column forces rows wider than the text column so the wrapped rows show.';
sheet.style.gridTemplateColumns = `190px repeat(${COLS.length}, ${PHONE}px)`;

const fmt = n => n.toLocaleString('en-US');
const add = (parent, tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  parent.appendChild(e);
  return e;
};

async function main() {
  await document.fonts.ready;
  await Promise.all(['15px "Geist Mono"', '13px Geist', 'italic 34px "Instrument Serif"'].map(f => document.fonts.load(f).catch(() => null)));
  const monoOk = document.fonts.check('15px "Geist Mono"');
  const convs = {};
  for (const id of new Set(ROWS.map(r => r.sample))) {
    const c = createConverter();
    c.setSource(await loadSample(id));
    convs[id] = c;
  }

  add(sheet, 'div', 'colhead', 'Target<span>sample · size</span>');
  for (const c of COLS) add(sheet, 'div', 'colhead', `${c.label}<span>${c.sub || '&nbsp;'}</span>`);

  const cells = [];
  for (const r of ROWS) {
    const opts = { phone: PHONE, ...(r.opts || {}) };
    const fit = autoFit(r.target, r.mode, opts);
    const head = add(sheet, 'div', 'rowhead');
    head.dataset.row = r.id;
    add(head, 'b', '', r.label);
    add(head, 'span', '', `${r.sample} · autoFit ${fit.cols} × ${fit.rows}`);
    if (r.sub) add(head, 'span', '', r.sub);
    for (const c of COLS) {
      const cell = add(sheet, 'div', 'cell');
      cell.dataset.row = r.id;
      try {
        let { cols, rows } = fit;
        if (c.wide) { cols = maxCols(r.target, r.mode, opts) + 6; rows = rowsFor(cols, cellAspect(r.target, r.mode)); }
        const grid = convs[r.sample].run({}, { mode: r.mode, cols, rows, dither: 'atkinson', ascii: 'shape',
          tone: { invert: !!c.invert } });
        const payload = formatFor(r.target, grid, opts);
        const host = add(cell, 'div', 'host');
        const out = renderPreview(host, { target: r.target, payload, grid, device: c.device, theme: c.theme, phone: PHONE, opts,
          media: r.opts && r.opts.caption ? imageUrl(r.sample) : null });
        const m = cellMetrics(r.target, r.mode, c.device);
        const shear = Math.min(0, ...shearOffsets(payloadRows(payload, grid).rows, m));
        const wr = out.wrappedRows;
        const bits = [
          `${cols} × ${rows}`,
          `${fmt(payload.count)} / ${fmt(payload.limit)}` + (payload.fits ? '' : ` <span class="bad">${fmt(payload.over)} over</span>`),
          `cell ${m.cellW.toFixed(2)} × ${m.cellH.toFixed(2)}`,
          wr.length ? `<span class="bad">rows ${wr.length === rows ? 'all' : wr.map(i => i + 1).join(', ')} wrap</span>`
            : '<span class="ok">no wraps</span>',
        ];
        if (m.shear) bits.push(`shear up to ${Math.abs(shear).toFixed(1)} px`);
        if (payload.foldRow != null) bits.push(`fold after row ${payload.foldRow}`);
        add(cell, 'div', 'note', bits.join(' · '));
        cells.push({ row: r.id, col: c.id, cols, rows, count: payload.count, wrapped: wr.length, lines: out.lines, shear: +shear.toFixed(2) });
      } catch (e) {
        add(cell, 'div', 'err', 'ERROR ' + (e.stack || e.message));
        cells.push({ row: r.id, col: c.id, error: e.message });
      }
    }
  }
  // caption photos decoded, then two paints so every canvas and web font has landed before the shot
  await Promise.all([...document.images].map(i => i.decode().catch(() => null)));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const errors = cells.filter(c => c.error);
  window.__done = { ok: !errors.length, phone: PHONE, monoOk, errors: errors.map(e => `${e.row}/${e.col}: ${e.error}`),
    cells: cells.map(c => c.error ? `${c.row}/${c.col} ERR` : `${c.row}/${c.col} ${c.cols}x${c.rows} lines=${c.lines} wrapped=${c.wrapped}` +
      (c.shear ? ` shear=${c.shear}` : '')) };
}

main().catch(e => { window.__done = { ok: false, error: e.stack || e.message }; });

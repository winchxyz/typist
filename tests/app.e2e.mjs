// App end to end: the whole flow in the real index.html, driven like a person would.
//   node tests/app.e2e.mjs [--browser chromium|firefox|webkit|all]
// welcome -> target tile -> photo_hopper.jpg upload / a sample -> editor -> every target (auto-fit,
// fit bars, primary label) -> Look thumbnails -> width stepper -> invert -> crop (drag, Done) ->
// copy for each target (clipboard == payload) -> X intent popup -> downloads (.txt / PNG / SVG /
// HTML, the PNG button on every target and mode) -> reload keeps the photo and the settings.
// Clipboard: a spy records every write (ClipboardItem, writeText, execCommand) in every engine;
// Chromium and Firefox also read the real clipboard back. x.com, t.me and the GitHub API are
// stubbed: no network. Needs the dev server on port 8860.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOPPER = path.join(here, 'fixtures', 'photo_hopper.jpg');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const which = opt('browser', 'chromium');
const ORIGIN = `http://localhost:${opt('port', 8860)}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typist-e2e-'));

// Records what the page hands to the clipboard, whatever the path.
const SPY = () => {
  window.__clip = [];
  const push = (via, text, html = false) => window.__clip.push({ via, text, html });
  const c = navigator.clipboard;
  if (c) {
    if (c.write) {
      const w = c.write.bind(c);
      c.write = items => {
        try {
          for (const it of items) if (it.types.includes('text/plain')) it.getType('text/plain').then(b => b.text()).then(t => push('item', t, it.types.includes('text/html')));
        } catch { /* odd item */ }
        return w(items);
      };
    }
    if (c.writeText) { const wt = c.writeText.bind(c); c.writeText = t => { push('writeText', t); return wt(t); }; }
  }
  document.addEventListener('copy', () => {
    const a = document.activeElement;
    if (a && a.tagName === 'TEXTAREA') push('exec', a.value);
  }, true);
};

async function run(browserName) {
  const CHROMIUM = browserName === 'chromium', FIREFOX = browserName === 'firefox';
  const browser = await pw[browserName].launch(CHROMIUM
    ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] }
    : FIREFOX ? { headless: true, firefoxUserPrefs: { 'dom.events.testing.asyncClipboard': true, 'dom.events.asyncClipboard.readText': true, 'dom.events.asyncClipboard.clipboardItem': true } }
      : { headless: true });
  const rows = [];
  const check = (name, pass, detail = '') => { rows.push({ browser: browserName, test: name, pass: !!pass, detail: String(detail).slice(0, 140) }); };
  const errors = [];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  if (CHROMIUM) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await context.route(/^https:\/\/(x\.com|t\.me)\//, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>stub' }));
  await context.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"stargazers_count":12}' }));
  await context.addInitScript(SPY);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  const TY = (fn, arg) => page.evaluate(fn, arg);
  const settle = () => page.waitForTimeout(120);

  // ---------------------------------------------------------------- welcome
  await page.goto(ORIGIN + '/?welcome=1');
  await page.waitForFunction(() => window.__done, null, { timeout: 60000 });
  await page.waitForFunction(() => window.TY && window.TY.welcomeDone, null, { timeout: 20000 });
  check('welcome: sheet visible', await page.isVisible('#welcome'));
  check('welcome: 6 target tiles (Reddit and File included) + 4 samples', (await page.locator('#welcomeTargets [data-v]').count()) === 6 && (await page.locator('#samples .sample').count()) === 4);
  await page.click('#welcomeTargets [data-v="x"]');
  check('welcome: tile picks X', await TY(() => window.TY.state.target) === 'x');
  await page.click('#welcomeTargets [data-v="ig"]');
  check('welcome: back to Instagram', await page.getAttribute('#welcomeTargets [data-v="ig"]', 'aria-checked') === 'true');

  // ---------------------------------------------------------------- upload
  await page.setInputFiles('#fileInput', HOPPER);
  await page.waitForFunction(() => window.TY.photo && window.TY.grid && !window.TY.photo.sample, null, { timeout: 20000 });
  await settle();
  let s = await TY(() => ({ welcome: !document.getElementById('welcome').hidden, mode: TY.grid.mode, fits: TY.payload.fits, fit: document.getElementById('fitLine').textContent }));
  check('upload: editor shows photo_hopper.jpg as dots', !s.welcome && s.mode === 'braille' && s.fits, JSON.stringify(s));
  check('upload: fit line says Fits (or the Windows slant note)', /Fits|Tight|Slants on Windows/.test(s.fit), s.fit);

  // ---------------------------------------------------------------- targets
  const expectLabel = { ig: 'Copy for Instagram', x: 'Post on X', tg: 'Copy for Telegram', tgc: 'Copy for the channel', reddit: 'Copy for Reddit', file: 'Download' };
  for (const t of ['x', 'tg', 'tgc', 'reddit', 'file', 'ig']) {
    await page.click(`#targetRow [data-v="${t}"]`);
    await settle();
    s = await TY(() => {
      const r = TY.cur.r;
      return { target: TY.state.target, auto: TY.state.cols, cols: TY.cur.cols, autoCols: TY.autoCols(r), fits: TY.payload.fits, wraps: TY.payload.wraps,
        label: document.querySelector('#actionBar .btn.primary .lbl').textContent,
        chip: document.querySelector(`#targetRow [data-v="${TY.state.target}"]`).className };
    });
    check(`target ${t}: selected and auto-fit`, s.target === t && s.auto === null && s.cols === s.autoCols, JSON.stringify(s));
    if (t !== 'file') check(`target ${t}: fits, no wrap, bar green or amber`, s.fits && !s.wraps && /fit-(ok|tight)/.test(s.chip), s.chip);
    check(`target ${t}: primary "${expectLabel[t]}"`, s.label === expectLabel[t], s.label);
  }
  const bars = await TY(() => [...document.querySelectorAll('#targetRow [data-v]')].map(b => b.dataset.v + ':' + (b.className.match(/fit-\w+/) || [''])[0]));
  check('target chips: every chip has a fit bar class', bars.every(b => /fit-(ok|tight|bad|none)$/.test(b)), bars.join(' '));

  // ---------------------------------------------------------------- Look
  await page.click('#tab-look');
  await page.waitForFunction(() => document.querySelectorAll('#looks .skeleton').length === 0, null, { timeout: 8000 }).catch(() => {});
  check('look: 5 thumbnails drawn', (await page.locator('#looks .look').count()) === 5 && (await page.locator('#looks .skeleton').count()) === 0);
  const cp0 = await TY(() => Array.from(TY.grid.cp).join(','));
  await page.click('#looks [data-v="sketch"]');
  await settle();
  s = await TY(() => ({ look: TY.state.look, checked: document.querySelector('#looks [data-v="sketch"]').getAttribute('aria-checked') }));
  const cp1 = await TY(() => Array.from(TY.grid.cp).join(','));
  check('look: Sketch picked and the art changes', s.look === 'sketch' && s.checked === 'true' && cp0 !== cp1, JSON.stringify(s));

  // ---------------------------------------------------------------- Size
  await page.click('#tab-size');
  const c0 = await TY(() => TY.cur.cols);
  await page.click('#colsPlus');
  await settle();
  s = await TY(() => ({ cols: TY.cur.cols, auto: document.getElementById('autoBadge').getAttribute('aria-pressed'), wraps: TY.payload.wraps, label: document.querySelector('#actionBar .btn.primary .lbl').textContent }));
  check('size: + makes it one wider, Auto off', s.cols === c0 + 1 && s.auto === 'false', JSON.stringify(s));
  check('size: too wide for the phone -> "Fit to phone"', !s.wraps || /^Fit to phone/.test(s.label), s.label);
  if (s.wraps) {
    await page.click('#actionBar .btn.primary');
    await settle();
    check('size: Fit button restores auto', await TY(() => TY.cur.cols) === c0);
  } else await page.click('#colsMinus');
  await page.click('#colsMinus');
  await settle();
  check('size: - makes it one narrower', await TY(() => TY.cur.cols) === c0 - 1);
  await page.click('#autoBadge');
  await settle();
  check('size: Auto badge restores the auto width', await TY(() => TY.cur.cols === TY.autoCols(TY.cur.r) && TY.state.cols === null));

  // ---------------------------------------------------------------- Tone: invert
  await page.click('#tab-tone');
  const inv0 = await TY(() => Array.from(TY.grid.cp).join(','));
  await page.click('#invertSwitch', { force: true });
  await settle();
  s = await TY(() => ({ invert: TY.state.tone.invert, cp: Array.from(TY.grid.cp).join(',') }));
  check('tone: invert flips the art', s.invert === true && s.cp !== inv0);

  // ---------------------------------------------------------------- crop
  const crop0 = await TY(() => ({ ...TY.state.crop }));
  await page.click('#btnCrop');
  await page.waitForSelector('.ty-crop:not([hidden]) canvas', { timeout: 5000 });
  const box = await page.locator('.ty-crop canvas').boundingBox();
  check('crop: frame visible, the buttons hidden, the fit meter kept', !!box && box.width > 200 && !(await page.isVisible('#actionBar .btn.primary')) && await page.isVisible('#fitLine'), JSON.stringify(box));
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx - i * 6, cy - i * 4);
  await page.mouse.up();
  await settle();
  const live = await TY(() => ({ ...TY.state.crop }));
  check('crop: dragging moves the crop live', Math.abs(live.x - crop0.x) > 0.01 || Math.abs(live.y - crop0.y) > 0.01, JSON.stringify(live));
  await page.click('.ty-crop [data-act="done"]');
  await settle();
  s = await TY(() => ({ open: document.body.classList.contains('cropping'), crop: TY.state.crop, bar: !document.getElementById('actionBar').hidden }));
  check('crop: Done keeps the new crop and closes', !s.open && Math.abs(s.crop.x - crop0.x) > 0.01 && await page.isVisible('#actionBar'), JSON.stringify(s.crop));

  // regressions from the QA round: Done without a change, a photo during crop, a no-op undo step
  const idx0 = await TY(() => TY.history.index), art0 = await TY(() => TY.payload.text);
  await page.click('#btnCrop');
  await page.waitForSelector('.ty-crop:not([hidden]) canvas', { timeout: 5000 });
  await page.click('.ty-crop [data-act="done"]');
  await settle();
  check('crop: Done without a change adds no step and keeps the art', await TY(() => TY.history.index) === idx0 && await TY(() => TY.payload.text) === art0);
  const dragged = await TY(() => ({ ...TY.state.crop }));
  await page.click('#btnCrop');
  await page.waitForSelector('.ty-crop:not([hidden]) canvas', { timeout: 5000 });
  const pid = await TY(() => TY.photo.id);
  await page.setInputFiles('#fileInput', path.join(here, 'fixtures', 'portrait_exif6.jpg'));
  await page.waitForFunction(p => window.TY.photo.id !== p, pid, { timeout: 20000 }).catch(() => {});
  await settle();
  s = await TY(() => ({ open: document.body.classList.contains('cropping'), crop: TY.state.crop }));
  // portrait_exif6.jpg auto-crops to (0.5, 0.42, 1): nothing of the previous photo's frame
  check('crop: a photo opened while cropping closes the crop and gets its own frame', !s.open && Math.abs(s.crop.x - dragged.x) > 0.005 && Math.abs(s.crop.zoom - 1) < 1e-6, JSON.stringify(s));
  const idx1 = await TY(() => TY.history.index);
  await page.keyboard.press('5');
  await page.keyboard.press('1');
  await settle();
  s = await TY(() => ({ index: TY.history.index, target: TY.state.target }));
  check('keys: 5 then 1 quickly leaves no no-op undo step', s.index === idx1 && s.target === 'ig', JSON.stringify(s));

  // ---------------------------------------------------------------- copy
  const norm = t => String(t).replace(/\r\n/g, '\n');
  async function lastClip() { return TY(() => (window.__clip.length ? window.__clip[window.__clip.length - 1] : null)); }
  async function readReal() {
    if (!CHROMIUM && !FIREFOX) return null;
    try { return await page.evaluate(() => navigator.clipboard.readText()); } catch { return null; }
  }
  async function copyCase(name, setup, button = '#actionBar .btn.primary', { toast = /./ } = {}) {
    await setup();
    await settle();
    await TY(() => { window.__clip.length = 0; });
    const want = await TY(() => TY.payload.text);
    await page.click(button);
    await page.waitForFunction(() => window.__clip.length > 0, null, { timeout: 4000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('#actionBar .btn.primary .lbl').textContent === 'Copied', null, { timeout: 2500 }).catch(() => {});
    const spy = await lastClip();
    check(`copy ${name}: the page writes the exact payload`, spy && spy.text === want, spy ? `${spy.via} ${spy.text.length} vs ${want.length}` : 'nothing written');
    const real = await readReal();
    if (real != null) check(`copy ${name}: clipboard reads back == payload`, norm(real) === want && !/\r(?!\n)/.test(real), `${real.length} vs ${want.length}`);
    const tt = await page.locator('.toast').last().textContent().catch(() => '');
    check(`copy ${name}: toast says the next step`, toast.test(tt || ''), tt);
    const lbl = await page.locator('#actionBar .btn.primary .lbl').textContent();
    check(`copy ${name}: button reads Copied`, lbl === 'Copied', lbl);
    await page.waitForTimeout(1700);
  }
  const target = t => async () => { await page.click(`#targetRow [data-v="${t}"]`); };
  await copyCase('Instagram', target('ig'), undefined, { toast: /Paste it into a comment/ });
  await copyCase('Telegram (dots)', target('tg'), undefined, { toast: /Paste it into any chat/ });
  await copyCase('Telegram (letters, fenced)', async () => {
    await page.click('#tab-look');
    await page.click('#styleSeg [data-v="ascii"]');
  }, undefined, { toast: /Paste it into any chat/ });
  check('telegram letters: payload is a ``` fence', await TY(() => TY.payload.text.startsWith('```\n') && TY.payload.text.endsWith('\n```')));
  await copyCase('Channel', target('tgc'), undefined, { toast: /channel/ });
  // Reddit: the art only survives in a Markdown code block, every row indented by 4 spaces
  await copyCase('Reddit (letters, code block)', target('reddit'), undefined, { toast: /code block/ });
  s = await TY(() => ({ mode: TY.payload.mode, lines: TY.payload.text.split('\n') }));
  check('reddit letters: every row is a 4-space code block line of printable ASCII',
    s.mode === 'ascii' && s.lines.every(l => /^ {4}[\x20-\x5f\x61-\x7e]*$/.test(l)), s.lines[0]);
  await copyCase('Reddit (dots, code block)', async () => {
    await page.click('#tab-look');
    await page.click('#styleSeg [data-v="braille"]');
  }, undefined, { toast: /code block/ });
  s = await TY(() => ({ mode: TY.payload.mode, lines: TY.payload.text.split('\n') }));
  check('reddit dots: 4-space indent, then Braille only',
    s.mode === 'braille' && s.lines.every(l => /^ {4}[\u2800-\u28ff]+$/.test(l)), s.lines[0]);
  // the rich-text editor on reddit.com reads text/html: a <pre><code> block of the same rows
  const clipR = await lastClip();
  check('reddit: the clipboard also carries an HTML code block', !!(clipR && clipR.html), clipR && clipR.via);
  check('reddit: the HTML is <pre><code> with the rows, no indent', await TY(() => {
    const h = TY.payload.html || '';
    const rows = TY.payload.text.split('\n').map(l => l.slice(4)).join('\n');
    return h.startsWith('<pre><code>') && h.endsWith('</code></pre>') && h.includes(rows.split('\n')[0]) && !/<pre><code> {4}/.test(h);
  }));
  await copyCase('X (Copy)', target('x'), '#actionBar .sec-btn', { toast: /new post/ });
  await copyCase('X long', async () => { await page.click('#tab-size'); await page.click('#variantSeg [data-v="long"]'); }, undefined, { toast: /Premium/ });
  await page.click('#variantSeg [data-v="post"]');
  await settle();

  // ---------------------------------------------------------------- X intent
  await TY(() => { window.__clip.length = 0; });
  const want = await TY(() => TY.payload.text);
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }).catch(() => null), page.click('#actionBar .btn.primary')]);
  if (popup) {
    const u = new URL(popup.url());
    check('X intent: popup opens x.com/intent/tweet with the exact text', u.host === 'x.com' && u.pathname === '/intent/tweet' && u.searchParams.get('text') === want && !u.searchParams.has('url'), popup.url().slice(0, 80));
    await popup.close();
  } else check('X intent: popup opens', false, 'no popup');
  await page.waitForTimeout(300);
  const spyX = await lastClip();
  check('X intent: clipboard written in the same click', spyX && spyX.text === want, spyX && spyX.via);
  await page.waitForTimeout(1700);

  // ---------------------------------------------------------------- downloads
  const PNG_SIG = '89504e470d0a1a0a';
  async function grab(click, name) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), click()]);
    if (!dl) { check(`download ${name}: download event`, false, 'none'); return null; }
    const file = path.join(tmp, `${browserName}-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(file) };
  }
  const pngOk = (d, cols, rows) => {
    if (!d) return false;
    const sig = d.buf.subarray(0, 8).toString('hex') === PNG_SIG;
    const w = d.buf.readUInt32BE(16), h = d.buf.readUInt32BE(20);
    return { ok: sig && w > cols * 4 && h > rows * 4, w, h };
  };
  await page.click('#targetRow [data-v="file"]');
  await settle();
  const g = await TY(() => ({ cols: TY.grid.cols, rows: TY.grid.rows, text: TY.payload.text }));
  const menuPick = fmt => async () => { await page.click('#actionBar .btn.primary'); await page.click(`#actionBar .act-wrap .menu [data-fmt="${fmt}"]`); };
  let d = await grab(menuPick('txt'), '.txt');
  if (d) check('download .txt: name and exact text', d.name === `typist-file-${g.cols}x${g.rows}.txt` && d.buf.toString('utf8') === g.text, d.name);
  d = await grab(menuPick('png'), 'PNG (menu)');
  if (d) { const p = pngOk(d, g.cols, g.rows); check('download PNG (menu): valid PNG', d.name.endsWith('.png') && p.ok, `${d.name} ${p.w}x${p.h}`); }
  d = await grab(menuPick('svg'), 'SVG');
  if (d) check('download SVG: an SVG document', d.name.endsWith('.svg') && /<svg[\s>]/.test(d.buf.toString('utf8').slice(0, 400)), d.name);
  d = await grab(menuPick('html'), 'HTML');
  if (d) check('download HTML: a page with the art', d.name.endsWith('.html') && /<pre/.test(d.buf.toString('utf8')), d.name);

  // the PNG button on every target and mode
  const cases = [['ig', 'braille'], ['x', 'braille'], ['tg', 'braille'], ['tg', 'ascii'], ['tgc', 'braille'], ['reddit', 'braille'], ['reddit', 'ascii'], ['file', 'braille'], ['file', 'ascii'], ['file', 'blocks']];
  for (const [t, mode] of cases) {
    await page.click(`#targetRow [data-v="${t}"]`);
    await TY(m => { TY.state.mode = m; TY.state.cols = null; TY.render(); }, mode);
    await settle();
    const gg = await TY(() => ({ cols: TY.grid.cols, rows: TY.grid.rows, mode: TY.grid.mode }));
    d = await grab(() => page.click('#actionBar .png-btn'), `PNG ${t} ${mode}`);
    if (d) {
      const p = pngOk(d, gg.cols, gg.rows);
      const tname = t === 'file' ? 'file' : t;
      check(`PNG button ${t} ${mode}: valid PNG named typist-${tname}-${gg.cols}x${gg.rows}.png`, p.ok && gg.mode === mode && d.name === `typist-${tname}-${gg.cols}x${gg.rows}.png`, `${d.name} ${p.w}x${p.h} ${gg.mode}`);
    }
  }
  await TY(() => { TY.state.mode = 'braille'; TY.render(); });
  await page.click('#targetRow [data-v="tg"]');
  await page.click('#tab-look');
  await page.click('#looks [data-v="poster"]');
  await settle();

  // ---------------------------------------------------------------- reload
  const before = await TY(() => ({ target: TY.state.target, look: TY.state.look, invert: TY.state.tone.invert, crop: TY.state.crop, text: TY.payload.text }));
  await page.waitForTimeout(900);   // settings save is debounced, the photo save too
  await page.goto(ORIGIN + '/');   // a plain visit (the test started on ?welcome=1)
  await page.waitForFunction(() => window.__done, null, { timeout: 30000 });
  await page.waitForFunction(() => window.TY.grid, null, { timeout: 20000 }).catch(() => {});
  const after = await TY(() => ({ welcome: !document.getElementById('welcome').hidden, photo: !!TY.photo, sample: TY.photo && TY.photo.sample,
    target: TY.state.target, look: TY.state.look, invert: TY.state.tone.invert, crop: TY.state.crop, text: TY.payload && TY.payload.text }));
  check('reload: the photo comes back, no welcome', after.photo && !after.welcome && !after.sample, JSON.stringify({ photo: after.photo, welcome: after.welcome }));
  check('reload: target, look, invert and crop kept', after.target === before.target && after.look === before.look && after.invert === before.invert
    && Math.abs(after.crop.x - before.crop.x) < 1e-6 && Math.abs(after.crop.zoom - before.crop.zoom) < 1e-6, JSON.stringify({ ...after, text: undefined }));
  check('reload: the same art', after.text === before.text, `${after.text && after.text.length} vs ${before.text.length}`);

  // ---------------------------------------------------------------- a sample from the welcome
  const p2 = await context.newPage();
  p2.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await p2.goto(ORIGIN + '/?welcome=1');
  await p2.waitForFunction(() => window.TY && window.TY.welcomeDone, null, { timeout: 20000 });
  await p2.click('#samples .sample >> nth=1');
  await p2.waitForFunction(() => window.TY.photo && window.TY.photo.sample === 'pet', null, { timeout: 20000 }).catch(() => {});
  check('sample: the pet opens in the editor', await p2.evaluate(() => !!(window.TY.photo && window.TY.photo.sample === 'pet' && document.getElementById('welcome').hidden)));
  await p2.close();

  check('no console errors or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  return rows;
}

const browsers = which === 'all' ? ['chromium', 'firefox', 'webkit'] : which.split(',');
let all = [];
for (const b of browsers) {
  try { all = all.concat(await run(b)); } catch (e) { all.push({ browser: b, test: 'run', pass: false, detail: e.message.slice(0, 200) }); }
}
for (const r of all) console.log(`${r.pass ? 'ok  ' : 'FAIL'} [${r.browser}] ${r.test}${r.pass ? '' : '  -- ' + r.detail}`);
const byB = {};
for (const r of all) { byB[r.browser] = byB[r.browser] || [0, 0]; byB[r.browser][r.pass ? 0 : 1]++; }
console.log(Object.entries(byB).map(([b, [p, f]]) => `${b}: ${p} passed, ${f} failed`).join('\n'));
process.exit(all.every(r => r.pass) ? 0 : 1);

// Copy end-to-end: click real buttons on dev/copy.html, read the clipboard back, compare exactly.
//   node tests/copy.e2e.mjs [--browser chromium|firefox|webkit] [--shots]
// Chromium: clipboard-read/write granted, clipboard read with navigator.clipboard.read() (types +
// contents). Firefox: the testing pref lets script read the clipboard. Elsewhere a real Ctrl+V into
// a textarea is the fallback reader. x.com and t.me are stubbed with page routes: no network.
// --shots also screenshots dev/copy.html?sheet=export to shots/export_sheet_<browser>.png.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium');
const ORIGIN = 'http://localhost:8860';
const BASE = ORIGIN + '/dev/copy.html';
const CHROMIUM = browserName === 'chromium';

const browser = await pw[browserName].launch(
  CHROMIUM ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] }
    : browserName === 'firefox' ? { headless: true, firefoxUserPrefs: {
      'dom.events.testing.asyncClipboard': true, 'dom.events.asyncClipboard.readText': true,
      'dom.events.asyncClipboard.clipboardItem': true } }
      : { headless: true });

const rows = [];
const skipped = [];
const check = (name, pass, detail = '') => rows.push({ test: name, pass: !!pass, detail: String(detail).slice(0, 110) });
const errors = [];

async function open(query = '', { mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: mobile, isMobile: mobile && browserName !== 'firefox',
  });
  if (CHROMIUM) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  // WebKit knows clipboard-read only (asking for clipboard-write fails later, at newPage)
  else if (browserName === 'webkit') { try { await context.grantPermissions(['clipboard-read'], { origin: ORIGIN }); } catch { /* unsupported */ } }
  await context.route(/^https:\/\/(x\.com|t\.me)\//, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>stub' }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  await page.goto(BASE + query);
  await page.waitForFunction(() => window.__done, null, { timeout: 60000 });
  const cases = await page.evaluate(() => window.CASES);
  return { context, page, cases };
}

// Put a sentinel on the clipboard so a stale value can never pass (where script may write).
async function clearClip(page) {
  try { await page.evaluate(() => navigator.clipboard.writeText('SENTINEL')); return true; } catch { return false; }
}

let readVia = null;
async function readClip(page) {
  try {
    const r = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const out = { types: [], text: null, html: null };
      for (const it of items) for (const t of it.types) {
        out.types.push(t);
        const s = await (await it.getType(t)).text();
        if (t === 'text/plain') out.text = s;
        if (t === 'text/html') out.html = s;
      }
      return out;
    });
    readVia = readVia || 'clipboard.read';
    return r;
  } catch { /* next */ }
  try {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    readVia = readVia || 'readText';
    return { types: null, text, html: null };
  } catch { /* next */ }
  // a real paste into the textarea
  await page.evaluate(() => { window.__pasted = null; const t = document.getElementById('paste'); t.value = ''; t.focus(); });
  await page.keyboard.press('Control+V');
  try {
    await page.waitForFunction(() => window.__pasted, null, { timeout: 2000 });
    readVia = readVia || 'paste';
    return await page.evaluate(() => window.__pasted);
  } catch { return null; }
}

// Click a case; returns { result, calls, popupUrl }
async function click(page, i, { popup = true } = {}) {
  const popupP = popup ? page.waitForEvent('popup', { timeout: 2500 }).catch(() => null) : null;
  await page.click('#case' + i);
  await page.waitForFunction(() => window.__last, null, { timeout: 10000 });
  const result = await page.evaluate(() => window.__last);
  const calls = await page.evaluate(() => window.__calls.map(c => ({ ...c, data: undefined, url: c.url })));
  let popupUrl = null;
  if (popupP) {
    const p = await popupP;
    if (p) { popupUrl = p.url(); if (!popupUrl || popupUrl === 'about:blank') { await p.waitForLoadState().catch(() => {}); popupUrl = p.url(); } await p.close().catch(() => {}); }
  }
  return { result, calls, popupUrl };
}

const stats = s => s == null ? 'null' : `len ${s.length}, ${(s.match(/\n/g) || []).length} LF, ${(s.match(/\u2800/g) || []).length} U+2800, fences ${(s.match(/```/g) || []).length}, CR ${s.includes('\r')}`;
// Chromium on Windows stores text/plain with CRLF on the OS clipboard (Blink converts every LF on
// write, for ClipboardItem, writeText and execCommand alike; readText does not convert back). The
// payload itself is LF-only (tests/targets.test.mjs). So on Windows the exact expected clipboard
// is the payload with each LF as CRLF, and nothing else: no lone CR, no extra CR.
let crlfSeen = false;
function sameText(name, got, want) {
  let ok = got === want;
  if (!ok && process.platform === 'win32' && got === want.replace(/\n/g, '\r\n')) { ok = true; crlfSeen = true; name += ' (CRLF on the Windows clipboard)'; }
  let detail = stats(got);
  if (!ok && got != null) {
    let k = 0; while (k < Math.min(got.length, want.length) && got[k] === want[k]) k++;
    detail = `first diff at ${k}: got U+${(got.charCodeAt(k) || 0).toString(16)} want U+${(want.charCodeAt(k) || 0).toString(16)} | got ${stats(got)} | want ${stats(want)}`;
  }
  check(name, ok, detail);
}
const clipFirst = calls => {
  const iClip = calls.findIndex(c => (c.api === 'execCommand' && c.cmd === 'copy' && c.result) || c.api === 'write' || c.api === 'writeText');
  const iOpen = calls.findIndex(c => c.api === 'open');
  return { iClip, iOpen, ok: iClip >= 0 && iOpen >= 0 && iClip < iOpen && calls[iClip].inClick && calls[iOpen].inClick };
};
const htmlBody = h => (h || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// ------------------------------------------------------------------ 1. desktop, every case
{
  const { context, page, cases } = await open('?device=desktop');
  for (const c of cases) {
    const cleared = await clearClip(page);
    const { result, calls, popupUrl } = await click(page, c.i);
    const tag = `desktop #${c.i} ${c.label}`;
    check(tag + ': ok', result.ok, `${result.how} via ${result.via} | ${result.hint}`);
    const clip = await readClip(page);
    if (!clip) { skipped.push(tag + ': clipboard unreadable'); continue; }
    sameText(tag + ': clipboard == formatFor text' + (cleared ? '' : ' (no sentinel)'), clip.text, c.text);
    const wantHtml = (c.target === 'tg' || c.target === 'tgc') && c.mode === 'ascii';
    if (clip.types) {
      const hasHtml = clip.types.includes('text/html');
      check(tag + `: text/html ${wantHtml ? 'written' : 'absent'}`, hasHtml === wantHtml, clip.types.join(','));
      if (wantHtml && hasHtml) check(tag + ': html is <pre>art</pre>', /<pre>/.test(clip.html) && htmlBody(clip.html) === c.text.slice(4, -4), clip.html.slice(0, 60));
    } else if (clip.html != null && clip.types == null) { /* readText only */ }
    const wantX = c.target === 'x' && c.action === 'auto' && c.fits && c.xLink;
    const wantTg = c.action === 'share' && c.tgLink;
    if (wantX) {
      const u = popupUrl && new URL(popupUrl);
      check(tag + ': popup x.com/intent/tweet', u && u.origin === 'https://x.com' && u.pathname === '/intent/tweet', popupUrl);
      check(tag + ': intent has exact text, no url param', u && u.searchParams.get('text') === c.text && [...u.searchParams.keys()].join() === 'text', u && [...u.searchParams.keys()].join());
      const o = clipFirst(calls);
      check(tag + ': clipboard written first, same click', o.ok, JSON.stringify(calls.map(k => k.api + (k.inClick ? '*' : ''))));
      check(tag + ': how intent', result.how === 'intent' && !result.blocked, result.how);
    } else if (wantTg) {
      const u = popupUrl && new URL(popupUrl);
      check(tag + ': popup t.me/share/url', u && u.origin === 'https://t.me' && u.pathname === '/share/url', popupUrl);
      check(tag + ': t.me url + exact text', u && u.searchParams.get('url') === c.site && u.searchParams.get('text') === c.text, '');
      check(tag + ': clipboard written first, same click', clipFirst(calls).ok, JSON.stringify(calls.map(k => k.api + (k.inClick ? '*' : ''))));
    } else {
      check(tag + ': no popup', !popupUrl && !calls.some(k => k.api === 'open'), popupUrl || '');
      if (c.action === 'share') check(tag + ': long t.me link falls back to the clipboard', result.how === 'clipboard' && result.tooLong, result.hint);
    }
    const inClick = calls.filter(k => k.api !== 'open')[0];
    check(tag + ': clipboard call inside the click', inClick && inClick.inClick, inClick && inClick.api);
  }
  await context.close();
}

// ------------------------------------------------------------------ 2. phones: no html, share sheet
{
  const { context, page, cases } = await open('?device=phone;share=ok'.replace(/;/g, '&'), { mobile: true });
  const tgAscii = cases.find(c => c.target === 'tg' && c.mode === 'ascii' && c.action === 'auto');
  await clearClip(page);
  let r = await click(page, tgAscii.i);
  const clip = await readClip(page);
  if (clip) {
    sameText('phone tg ascii: clipboard == text', clip.text, tgAscii.text);
    if (clip.types) check('phone tg ascii: no text/html on a coarse pointer', !clip.types.includes('text/html'), clip.types.join(','));
  } else skipped.push('phone tg ascii: clipboard unreadable');
  const share = cases.find(c => c.action === 'share' && !c.tgLink);
  r = await click(page, share.i);
  const shareCall = await page.evaluate(() => window.__calls.find(c => c.api === 'share'));
  check('phone share: navigator.share({ text }) only', r.result.how === 'share' && shareCall && shareCall.inClick
    && !r.calls.some(k => k.api === 'open'), `${r.result.how} ${JSON.stringify(r.calls.map(k => k.api))}`);
  const data = await page.evaluate(() => window.__calls.find(c => c.api === 'share').data);
  check('phone share: exact text, no url/files', data && data.text === share.text && Object.keys(data).join() === 'text', data && Object.keys(data).join());
  await context.close();
}
{
  const { context, page, cases } = await open('?device=phone&share=abort', { mobile: true });
  const share = cases.find(c => c.action === 'share');
  const r = await click(page, share.i);
  check('phone share cancelled -> how cancelled, nothing else', r.result.how === 'cancelled' && r.result.hint === null
    && !r.calls.some(k => k.api !== 'share'), JSON.stringify(r.calls.map(k => k.api)));
  await context.close();
}
{
  const { context, page, cases } = await open('?device=phone&share=fail', { mobile: true });
  const share = cases.find(c => c.action === 'share');
  await clearClip(page);
  const r = await click(page, share.i);
  check('phone share refused -> clipboard', r.result.how === 'clipboard' && r.result.ok, `${r.result.how} ${r.result.via}`);
  const clip = await readClip(page);
  if (clip) sameText('phone share refused: clipboard == text', clip.text, share.text);
  await context.close();
}
// pointer detection without a device hint
if (CHROMIUM || browserName === 'webkit') {
  const { context, page, cases } = await open('?device=auto', { mobile: true });
  const tgAscii = cases.find(c => c.target === 'tg' && c.mode === 'ascii' && c.action === 'auto');
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  await clearClip(page);
  await click(page, tgAscii.i);
  const clip = await readClip(page);
  if (clip && clip.types) check('auto device on a touch phone: no text/html', coarse && !clip.types.includes('text/html'), `coarse ${coarse} ${clip.types}`);
  else skipped.push('auto device (phone): clipboard types unreadable');
  await context.close();
}
{
  const { context, page, cases } = await open('?device=auto');
  const tgAscii = cases.find(c => c.target === 'tg' && c.mode === 'ascii' && c.action === 'auto');
  await clearClip(page);
  await click(page, tgAscii.i);
  const clip = await readClip(page);
  if (clip && clip.types) check('auto device on desktop: text/html written', clip.types.includes('text/html'), clip.types.join(','));
  else skipped.push('auto device (desktop): clipboard types unreadable');
  await context.close();
}

// ------------------------------------------------------------------ 3. refused clipboard, blocked popup
{
  const { context, page, cases } = await open('?deny=all');
  const ig = cases.find(c => c.target === 'ig');
  const r = await click(page, ig.i);
  check('clipboard refused + execCommand fails -> manual with the text', r.result.how === 'manual' && !r.result.ok
    && r.result.text === ig.text && /blocked copying/.test(r.result.hint), `${r.result.how} | ${r.result.hint}`);
  const tried = r.calls.map(k => k.api).join(',');
  check('manual: tried ClipboardItem, writeText, execCommand in order', /^(write,writeText|writeText),execCommand$/.test(tried), tried);
  const x = cases.find(c => c.target === 'x' && c.action === 'auto' && c.fits);
  const rx = await click(page, x.i);
  check('X with clipboard refused: still opens the intent', rx.result.how === 'intent' && !!rx.popupUrl, rx.result.hint);
  await context.close();
}
{
  const { context, page, cases } = await open('?deny=async');
  const tg = cases.find(c => c.target === 'tg' && c.mode === 'braille' && c.action === 'auto');
  await clearClip(page).catch(() => {});
  // the bench denies writes only after load, so the sentinel write above may be refused: fine
  const r = await click(page, tg.i);
  check('async clipboard refused -> execCommand copy', r.result.how === 'clipboard' && r.result.via === 'exec', `${r.result.how} ${r.result.via}`);
  const clip = await readClip(page);
  if (clip) sameText('execCommand copy: clipboard == text', clip.text, tg.text);
  await context.close();
}
{
  const { context, page, cases } = await open('?block=1');
  const x = cases.find(c => c.target === 'x' && c.action === 'auto' && c.fits);
  await clearClip(page);
  const r = await click(page, x.i);
  check('popup blocked -> clipboard + blocked + href for "Open X"', r.result.how === 'clipboard' && r.result.blocked
    && new URL(r.result.href).searchParams.get('text') === x.text && /Open X/.test(r.result.hint), r.result.hint);
  const clip = await readClip(page);
  if (clip) sameText('popup blocked: clipboard == text', clip.text, x.text);
  await context.close();
}

// ------------------------------------------------------------------ 4. export sheet
if (args.includes('--shots')) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  await page.goto(BASE + '?sheet=export');
  await page.waitForFunction(() => window.__done, null, { timeout: 60000 });
  const done = await page.evaluate(() => window.__done);
  for (const r of done.report) check(`export ${r.label}: PNG ${r.png[0]}x${r.png[1]}, SVG ${r.svg}, HTML ${r.html}`, r.png[2] > 0 && r.svg > 0 && r.html > 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/export_sheet_${browserName}.png`, fullPage: true });
  // the HTML pages at 1:1, as a viewer would open them
  const pages = await page.evaluate(() => window.__html);
  const view = await context.newPage();
  await view.setViewportSize({ width: 820, height: 560 });
  for (const [label, html] of Object.entries(pages)) {
    if (!/Braille/.test(label)) continue;
    await view.setContent(html);
    await view.waitForTimeout(300);
    const gap = await view.evaluate(() => getComputedStyle(document.querySelector('pre')).getPropertyValue('--gap'));
    check(`export HTML ${label}: blank width fix measured (--gap ${gap || 'none'})`, true);
    await view.screenshot({ path: `shots/export_html_${label.replace(/\W+/g, '_').toLowerCase()}_${browserName}.png` });
  }
  await context.close();
}

console.table(rows);
if (skipped.length) console.log('not tested here:\n  ' + skipped.join('\n  '));
if (errors.length) console.log(errors.slice(0, 20).join('\n'));
const failed = rows.filter(r => !r.pass).length;
if (crlfSeen) console.log('note: the OS clipboard held CRLF line breaks (Windows); payloads are LF.');
console.log(`${browserName}: ${rows.length - failed}/${rows.length} passed (clipboard read via ${readVia})`);
await browser.close();
process.exit(failed ? 1 : 0);

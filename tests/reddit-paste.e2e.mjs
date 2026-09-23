// Copy for Reddit, then a real Ctrl+V into a rich-text box (contenteditable), the way Reddit's
// rich-text editor receives it: the art must arrive as a <pre> code block with every row intact.
// And a paste into a plain <textarea> (Markdown mode) must get the 4-space-indented text.
//   node tests/reddit-paste.e2e.mjs      (Chromium: the only engine whose headless build pastes)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);
const ORIGIN = 'http://localhost:8860';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
await ctx.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, body: '{}' }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  -- ' + info}`); };

await page.goto(`${ORIGIN}/?for=reddit`);
await page.waitForFunction(() => window.TY && window.__done);
await page.setInputFiles('#fileInput', 'img/showcase/halo.jpg');
await page.waitForFunction(() => window.TY.grid && window.TY.state.target === 'reddit');

for (const mode of ['ascii', 'braille']) {
  await page.evaluate(m => { window.TY.set({ mode: m, cols: null }); window.TY.setInvert(true); }, mode);
  await page.waitForTimeout(300);
  const want = await page.evaluate(() => ({ text: TY.payload.text, rows: TY.payload.text.split('\n').map(l => l.slice(4)) }));
  await page.click('#topActions .btn.primary, #actionBar .btn.primary');
  await page.waitForTimeout(400);

  // 1. rich text: a contenteditable box, like reddit.com's default editor
  await page.evaluate(() => {
    document.getElementById('probe')?.remove();
    const d = Object.assign(document.createElement('div'), { id: 'probe', contentEditable: 'true' });
    d.style.cssText = 'position:fixed;left:10px;top:10px;width:900px;height:600px;background:#fff;z-index:99999';
    document.body.appendChild(d);
    d.focus();
  });
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(300);
  const rich = await page.evaluate(() => {
    const d = document.getElementById('probe');
    const pre = d.querySelector('pre');
    return { hasPre: !!pre, code: !!(pre && pre.querySelector('code')), text: pre ? pre.textContent : d.innerText };
  });
  check(`${mode}: rich-text paste arrives as a <pre> code block`, rich.hasPre, JSON.stringify(rich).slice(0, 200));
  check(`${mode}: the code block holds exactly the rows, no indent`, rich.text.replace(/\r\n/g, '\n').replace(/\n$/, '') === want.rows.join('\n'),
    `${rich.text.length} vs ${want.rows.join('\n').length}`);

  // 2. Markdown mode: a textarea only ever gets the plain text, i.e. the 4-space code block
  await page.evaluate(() => {
    document.getElementById('probe')?.remove();
    const t = Object.assign(document.createElement('textarea'), { id: 'probe' });
    t.style.cssText = 'position:fixed;left:10px;top:10px;width:900px;height:600px;z-index:99999';
    document.body.appendChild(t);
    t.focus();
  });
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(200);
  const md = await page.evaluate(() => document.getElementById('probe').value);
  check(`${mode}: Markdown-mode paste is the 4-space-indented text`, md.replace(/\r\n/g, '\n') === want.text, `${md.length} vs ${want.text.length}`);
  await page.evaluate(() => document.getElementById('probe')?.remove());
  await page.waitForTimeout(1700);
}
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

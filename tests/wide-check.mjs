// Screenshots of the too-wide cases: Telegram Letters with the Desktop preset (a desktop window),
// and a phone preset pushed wider than the phone (the art stays whole, the screen edge is marked).
//   node tests/wide-check.mjs [--browser chromium|webkit]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const name = process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : 'chromium';
const browser = await pw[name].launch({ headless: true });
const out = [];
for (const [vw, vh, dpr, theme] of [[1440, 900, 2, 'dark'], [390, 844, 2, 'light']]) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, colorScheme: theme });
  await ctx.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, body: '{}' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8860/?for=tg');
  await page.waitForFunction(() => window.TY && window.__done);
  await page.evaluate(() => window.TY.openSample('pet'));
  await page.waitForFunction(() => window.TY.grid, null, { timeout: 15000 });
  const cases = [
    ['desktop-preset', () => window.TY.set({ mode: 'ascii', targetOpts: { ...window.TY.state.targetOpts, tg: 'desktop' }, cols: null })],
    ['phone-too-wide', () => window.TY.set({ mode: 'ascii', targetOpts: { ...window.TY.state.targetOpts, tg: 'phone' }, cols: 60 })],
    ['braille-too-wide', () => window.TY.set({ mode: 'braille', targetOpts: { ...window.TY.state.targetOpts, tg: 'phone' }, cols: 40 })],
  ];
  for (const [label, fn] of cases) {
    await page.evaluate(fn);
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => ({
      grid: `${window.TY.grid.cols}x${window.TY.grid.rows}`, fit: document.getElementById('fitLine').textContent,
      wrapped: window.TY.cur.pv && window.TY.cur.pv.wrappedRows.length, edge: window.TY.cur.pv && window.TY.cur.pv.edge,
      screen: window.TY.cur.pv && window.TY.cur.pv.screenWidth,
      hscroll: document.documentElement.scrollWidth > window.innerWidth,
    }));
    const file = `shots/wide_${name}_${vw}_${label}.png`;
    await page.screenshot({ path: file });
    out.push({ file, ...info });
  }
  out.push({ vw, errors });
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();

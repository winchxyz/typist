// X Free / Premium switch: visible only on X, flips the budget, the auto-fit size and the fit line.
//   node tests/xplan-check.mjs [--browser chromium|webkit|firefox]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const name = process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : 'chromium';
const browser = await pw[name].launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await ctx.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, body: '{}' }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8860/?for=x');
await page.waitForFunction(() => window.TY && window.__done);
const tiles = await page.$$eval('.wtile', ts => ts.map(t => t.textContent.trim()));
await page.evaluate(() => window.TY.openSample('landmark'));
await page.waitForFunction(() => window.TY.grid && !document.getElementById('variantStrip').hidden, null, { timeout: 15000 });
const read = () => page.evaluate(() => ({
  shown: !document.getElementById('variantStrip').hidden,
  sel: document.querySelector('#stripSeg [aria-checked="true"]')?.dataset.v,
  fit: document.getElementById('fitLine').textContent,
  target: window.TY.payload.target, grid: `${window.TY.grid.cols}x${window.TY.grid.rows}`,
  count: window.TY.payload.count, limit: window.TY.payload.limit,
  primary: document.querySelector('#actionBar .btn.primary')?.textContent.trim(),
}));
const free = await read();
await page.screenshot({ path: `shots/xplan_${name}_free.png` });
await page.click('#stripSeg [data-v="long"]');
await page.waitForTimeout(250);
const prem = await read();
await page.screenshot({ path: `shots/xplan_${name}_premium.png` });
await page.evaluate(() => window.TY.setTarget('ig'));
await page.waitForTimeout(200);
const onIg = await read();
console.log(JSON.stringify({ tiles, free, prem, onIg: { shown: onIg.shown }, errors }, null, 1));
const ok = free.shown && free.sel === 'post' && free.target === 'x' && prem.sel === 'long' && prem.target === 'xlong' && prem.limit === 25000 && !onIg.shown && !errors.length;
console.log(ok ? 'PASS' : 'FAIL');
await browser.close();
process.exit(ok ? 0 : 1);

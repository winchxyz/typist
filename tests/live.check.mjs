// Check the live GitHub Pages site in real browsers: loads, no errors, a sample converts, the copy
// payload is exact, a PNG downloads.  node tests/live.check.mjs [--url https://winchxyz.github.io/typist/]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const i = process.argv.indexOf('--url');
const URL0 = i > 0 ? process.argv[i + 1] : 'https://winchxyz.github.io/typist/';
const results = [];
for (const name of ['chromium', 'firefox', 'webkit']) {
  const browser = await pw[name].launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], failed = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('response', r => { if (r.status() >= 400 && !/api\.github\.com/.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });
  const t0 = Date.now();
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TY && window.__done, null, { timeout: 30000 });
  await page.evaluate(() => window.TY.openSample('landmark'));
  await page.waitForFunction(() => window.TY.grid && window.TY.payload, null, { timeout: 30000 });
  const info = await page.evaluate(() => ({ grid: `${window.TY.grid.cols}x${window.TY.grid.rows}`, count: window.TY.payload.count,
    fit: document.getElementById('fitLine').textContent, title: document.title }));
  let png = null;
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#actionBar .png-btn')]);
    png = dl.suggestedFilename();
  } catch (e) { png = 'no download: ' + e.message.split('\n')[0]; }
  await page.screenshot({ path: `shots/live_${name}.png` });
  results.push({ name, ms: Date.now() - t0, ...info, png, errors, failed });
  await browser.close();
}
console.log(JSON.stringify(results, null, 1));

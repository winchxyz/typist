// Screenshots of the Reddit target with the showcase artwork: welcome (six tiles), the editor with
// Dots and with Letters, phone and desktop, light and dark.  node tests/reddit-shot.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const out = [];
for (const [engine, vw, vh, dpr, theme] of [['webkit', 390, 844, 2, 'light'], ['webkit', 390, 844, 2, 'dark'], ['chromium', 1440, 900, 1, 'light']]) {
  const browser = await pw[engine].launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, colorScheme: theme });
  await ctx.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, body: '{}' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const tag = `${vw < 800 ? 'phone' : 'desktop'}_${theme}`;
  await page.goto('http://localhost:8860/?welcome=1&for=reddit');
  await page.waitForFunction(() => window.TY && window.__done);
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `shots/reddit_${tag}_welcome.png` });
  await page.setInputFiles('#fileInput', 'img/showcase/halo.jpg');
  await page.waitForFunction(() => window.TY.grid && window.TY.state.target === 'reddit', null, { timeout: 15000 });
  // the dark preview should show the figure, not its negative: invert like a dark-mode reader
  if (theme === 'dark') await page.evaluate(() => window.TY.setInvert(true));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/reddit_${tag}_dots.png` });
  const dots = await page.evaluate(() => ({ grid: `${TY.grid.cols}x${TY.grid.rows}`, fit: document.getElementById('fitLine').textContent,
    label: document.querySelector('.btn.primary .lbl').textContent }));
  await page.evaluate(() => window.TY.set({ mode: 'ascii', cols: null }));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `shots/reddit_${tag}_letters.png` });
  const letters = await page.evaluate(() => ({ grid: `${TY.grid.cols}x${TY.grid.rows}`, fit: document.getElementById('fitLine').textContent }));
  out.push({ tag, dots, letters, errors, hscroll: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));

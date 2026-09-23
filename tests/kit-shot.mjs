// Screenshot the baked paste-test kit (shots/paste-test.artifact.html) as a phone would see it.
//   node tests/kit-shot.mjs [--browser webkit] [--dark]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = opt('browser', 'webkit');
const dark = args.includes('--dark');
const file = path.resolve('shots/paste-test.artifact.html');
const browser = await pw[name].launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL(file).href);
await page.waitForFunction(() => window.__kit && document.querySelectorAll('.card').length > 10);
const tag = `${name}_${dark ? 'dark' : 'light'}`;
await page.screenshot({ path: `shots/kitpub_${tag}_top.png` });
await page.click('#c-ig\\.stair\\.28 button[data-s="ok"]').catch(() => {});
await page.locator('#s-results').scrollIntoViewIfNeeded();
await page.screenshot({ path: `shots/kitpub_${tag}_results.png` });
const info = await page.evaluate(() => ({
  cards: document.querySelectorAll('.card').length,
  sync: document.getElementById('sync-status')?.textContent,
  hscroll: document.documentElement.scrollWidth > window.innerWidth,
}));
console.log(JSON.stringify({ ...info, errors }, null, 1));
await browser.close();

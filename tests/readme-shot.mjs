// Screenshot the README as GitHub renders it (repo home page).  node tests/readme-shot.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
await page.goto('https://github.com/winchxyz/typist', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('article.markdown-body', { timeout: 60000 });
// let the README images load (they come through GitHub's image proxy)
await page.waitForFunction(() => [...document.querySelectorAll('article.markdown-body img')].every(i => i.complete), null, { timeout: 60000 }).catch(() => {});
const info = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('article.markdown-body img')];
  return { images: imgs.length, broken: imgs.filter(i => !i.naturalWidth).map(i => i.alt.slice(0, 40)), height: document.querySelector('article.markdown-body').scrollHeight };
});
const art = await page.$('article.markdown-body');
await art.screenshot({ path: 'shots/readme_github.png' });
console.log(JSON.stringify(info));
await browser.close();

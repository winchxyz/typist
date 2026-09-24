// Screenshots of the Steam, YouTube and Twitch targets with the showcase artwork: every variant on
// a phone (light and dark) and on a desktop.  node tests/platforms-shot.mjs [id ...]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['steamc', 'steamp', 'steamb', 'ytc', 'ytlive', 'twitch'];
const out = [];
for (const [engine, vw, vh, dpr, theme] of [['webkit', 390, 844, 2, 'light'], ['webkit', 390, 844, 2, 'dark'], ['chromium', 1440, 900, 1, 'light']]) {
  const browser = await pw[engine].launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, colorScheme: theme });
  await ctx.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, body: '{}' }));
  const tag = `${vw < 800 ? 'phone' : 'desktop'}_${theme}`;
  for (const id of IDS) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://localhost:8860/?welcome=1&for=${id}`);
    await page.waitForFunction(() => window.TY && window.__done);
    await page.setInputFiles('#fileInput', 'img/showcase/halo.jpg');
    await page.waitForFunction(() => window.TY.grid && window.TY.payload, null, { timeout: 15000 });
    if (theme === 'dark') await page.evaluate(() => window.TY.setInvert(true));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `shots/plat_${id}_${tag}.png` });
    const info = await page.evaluate(() => ({
      target: TY.state.target, id: TY.payload.target, grid: `${TY.grid.cols}x${TY.grid.rows}`,
      count: TY.payload.count, limit: TY.payload.limit, unit: TY.payload.unit,
      fit: document.getElementById('fitLine').textContent,
      label: document.querySelector('.btn.primary .lbl')?.textContent,
      strip: [...document.querySelectorAll('#stripSeg button')].map(b => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')).join(' | '),
      warn: (TY.payload.warnings || []).map(w => w.code).join(','),
      cap: document.querySelector('.pv-flowcap')?.textContent || null,
      hscroll: document.documentElement.scrollWidth > innerWidth,
    }));
    // the chats on a desktop browser: the Windows preview uses the desktop chat column
    if (vw > 800 && (id === 'ytlive' || id === 'twitch')) {
      await page.evaluate(() => window.TY.set({ device: 'windows' }));
      await page.waitForTimeout(500);
      await page.screenshot({ path: `shots/plat_${id}_${tag}_windows.png` });
      info.windowsCap = await page.evaluate(() => document.querySelector('.pv-flowcap')?.textContent || null);
    }
    out.push({ tag, ...info, errors });
    await page.close();
  }
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));

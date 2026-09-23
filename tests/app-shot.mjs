// Screenshots of the real app, every screen, phone and desktop, light and dark.
//   node tests/app-shot.mjs [--device phone,desktop,narrow] [--browser chromium,webkit] [--theme light,dark]
//        [--screens welcome,editor-ig,...]
// Writes shots/app_<device>_<theme>_<screen>.png (phone shots also carry the engine:
// app_phone-webkit_<theme>_<screen>.png for WebKit). Phone 390 x 844 at dpr 2, desktop 1440 x 900,
// narrow 360 x 740. x.com, t.me and the GitHub API are stubbed. Needs the dev server on port 8860.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const devices = opt('device', 'phone,desktop,narrow').split(',');
const engines = opt('browser', 'chromium,webkit').split(',');
const themes = opt('theme', 'light,dark').split(',');
const SCREENS = ['welcome', 'editor-ig', 'editor-x', 'editor-tg-ascii', 'crop', 'copied-toast', 'look-tab', 'size-tab', 'tone-tab'];
const screens = opt('screens', SCREENS.join(',')).split(',');
const ORIGIN = `http://localhost:${opt('port', 8860)}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 }, narrow: { width: 360, height: 740 } };

const results = [];
for (const engine of engines) {
  const browser = await pw[engine].launch(engine === 'chromium'
    ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });
  for (const device of devices) {
    // desktop and the 360 px editor are shot in Chromium only
    if (device !== 'phone' && engine !== 'chromium') continue;
    for (const theme of themes) {
      const mobile = device !== 'desktop';
      const context = await browser.newContext({
        viewport: SIZES[device], deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce',
        hasTouch: mobile, isMobile: mobile && engine === 'chromium',
      });
      if (engine === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
      await context.route(/^https:\/\/(x\.com|t\.me)\//, r => r.fulfill({ status: 200, contentType: 'text/html', body: 'stub' }));
      await context.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
      const page = await context.newPage();
      const logs = [];
      page.on('console', m => { if (m.type() === 'error') logs.push('[console] ' + m.text()); });
      page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
      const tag = device === 'phone' && engine !== 'chromium' ? `${device}-${engine}` : device;
      const shot = async name => {
        await page.waitForTimeout(250);
        const out = path.join(root, 'shots', `app_${tag}_${theme}_${name}.png`);
        await page.screenshot({ path: out });
        results.push({ out: path.relative(root, out), logs: logs.splice(0) });
      };
      const want = n => screens.includes(n) && (device !== 'narrow' || n === 'editor-ig' || n === 'welcome');
      await page.goto(ORIGIN + '/?welcome=1');
      await page.waitForFunction(() => window.TY && window.TY.welcomeDone, null, { timeout: 30000 });
      if (want('welcome')) await shot('welcome');
      await page.evaluate(() => window.TY.openSample('pet'));
      await page.waitForFunction(() => window.TY.grid, null, { timeout: 20000 });
      await page.waitForTimeout(500);
      // a target switch, then the Resized note cleared (it lasts 4 s) so each shot shows the fit line
      const target = async t => { await page.click(`${device === 'desktop' ? '#targetCards' : '#targetRow'} [data-v="${t}"]`); await page.evaluate(() => window.TY.clearNote()); await page.waitForTimeout(150); };
      const tab = async t => { if (device !== 'desktop') { await page.click(`#tab-${t}`); } else await page.locator(`#panel-${t}`).scrollIntoViewIfNeeded(); };
      if (want('editor-ig')) { await target('ig'); await shot('editor-ig'); }
      if (want('editor-x')) { await target('x'); await shot('editor-x'); }
      if (want('editor-tg-ascii')) {
        await target('tg');
        await page.evaluate(() => { window.TY.state.mode = 'ascii'; window.TY.state.cols = null; window.TY.render(); });
        await shot('editor-tg-ascii');
        await page.evaluate(() => { window.TY.state.mode = 'braille'; window.TY.render(); });
      }
      await target('ig');
      if (want('crop')) {
        await page.click('#btnCrop');
        await page.waitForSelector('.ty-crop:not([hidden])');
        await page.waitForTimeout(500);
        await shot('crop');
        await page.click('.ty-crop [data-act="cancel"]');
      }
      if (want('copied-toast')) {
        await page.click(device === 'desktop' ? '#topActions .btn.primary' : '#actionBar .btn.primary');
        await page.waitForTimeout(200);
        await shot('copied-toast');
        await page.waitForTimeout(1800);
        await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
      }
      if (want('look-tab')) { await tab('look'); await page.waitForTimeout(400); await shot('look-tab'); }
      if (want('size-tab')) { await tab('size'); await shot('size-tab'); }
      if (want('tone-tab')) { await tab('tone'); await shot('tone-tab'); }
      if (device === 'narrow') {
        // the 360 px editor, scrolled to the controls too
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await shot('editor-ig-scrolled');
      }
      const hs = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (hs > 0) results.push({ out: `${tag}_${theme}`, logs: [`horizontal scroll ${hs}px`] });
      await context.close();
    }
  }
  await browser.close();
}
for (const r of results) console.log(r.out + (r.logs.length ? '  ' + r.logs.join(' | ') : ''));
process.exit(results.some(r => r.logs.length) ? 1 : 0);

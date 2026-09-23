// Screenshots of the welcome hero options (dev/hero.html), and of the real welcome for comparison.
//   node dev/hero-shot.mjs [--opts A,B,C,D] [--variants desk-dark,phone-light,phone-dark] [--app]
//        [--motion reduce|no-preference] [--at 1200]   (ms after load: a mid-animation frame instead of __done)
// Writes shots/hero_<opt>_<variant>.png (--app: shots/hero_app_<variant>.png, the current welcome).
// A DOM page cannot screenshot itself, so this drives Playwright directly (like tests/app-shot.mjs).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const opts = opt('opts', 'A,B,C,D').split(',');
const variants = opt('variants', 'desk-dark,phone-light,phone-dark').split(',');
const motion = opt('motion', 'reduce');
const at = +opt('at', 0);
const suffix = opt('suffix', '');
const app = args.includes('--app');
const ORIGIN = `http://localhost:${opt('port', 8860)}`;
const VARIANTS = {
  'desk-dark': { w: 785, h: 766, dpr: 1, theme: 'dark', mobile: false },
  'desk-light': { w: 785, h: 766, dpr: 1, theme: 'light', mobile: false },
  'phone-light': { w: 390, h: 844, dpr: 2, theme: 'light', mobile: true },
  'phone-dark': { w: 390, h: 844, dpr: 2, theme: 'dark', mobile: true },
  'short-dark': { w: 390, h: 664, dpr: 2, theme: 'dark', mobile: true },
  'wide-dark': { w: 1440, h: 900, dpr: 1, theme: 'dark', mobile: false },
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const jobs = app ? ['app'] : opts;
let failed = 0;
for (const o of jobs) {
  for (const v of variants) {
    const V = VARIANTS[v];
    const context = await browser.newContext({
      viewport: { width: V.w, height: V.h }, deviceScaleFactor: V.dpr, colorScheme: V.theme, reducedMotion: motion,
      hasTouch: V.mobile, isMobile: V.mobile,
    });
    await context.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    const page = await context.newPage();
    const logs = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
    page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
    const url = o === 'app' ? `${ORIGIN}/?welcome=1` : `${ORIGIN}/dev/hero.html?opt=${o}&theme=${V.theme}`;
    await page.goto(url);
    let done = null;
    if (at > 0) { await page.waitForTimeout(at); done = { at }; }
    else {
      try {
        await page.waitForFunction(() => window.__done || (window.TY && window.TY.welcomeDone), null, { timeout: 30000, polling: 100 });
        done = await page.evaluate(() => window.__done || { ok: true });
      } catch (e) { done = { ok: false, error: e.message.split('\n')[0] }; failed++; }
      await page.waitForTimeout(350);
    }
    const layout = await page.evaluate(() => {
      const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
      return { hero: r('#welcomeArt canvas') || r('#welcomeArt'), card: r('#welcome'), vh: innerHeight,
               hs: document.documentElement.scrollWidth - innerWidth, cardScroll: (() => { const e = document.querySelector('#welcome'); return e ? e.scrollHeight - e.clientHeight : 0; })() };
    });
    const out = path.join(root, 'shots', `hero_${o}_${v}${suffix}.png`);
    await page.screenshot({ path: out });
    console.log(path.relative(root, out), JSON.stringify(done), JSON.stringify(layout), logs.join(' | '));
    await context.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);

// Screenshots of the welcome hero options (dev/hero.html), and of the real welcome for comparison.
//   node dev/hero-shot.mjs [--opts A,B,C,D,E] [--variants desk-dark,phone-light,phone-dark] [--app]
//        [--motion reduce|no-preference] [--at 1200]   (ms after load: a mid-animation frame instead of __done)
//        [--q "look=soft;dither=threshold"] [--suffix _v1] [--port 8860]
//   node dev/hero-shot.mjs --lineup [--opts A,B,C,D,E]   the line-up sheet from the shots on disk
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
const opts = opt('opts', 'A,B,C,D,E').split(',');
const variants = opt('variants', 'desk-dark,phone-light,phone-dark').split(',');
const motion = opt('motion', 'reduce');
const at = +opt('at', 0);
const suffix = opt('suffix', '');
const extra = opt('q', '').replace(/;/g, '&');   // extra query for dev/hero.html (look=..;dither=..)
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

// --lineup: shots/hero_lineup.png, one column per option (phone light + desktop dark, a big
// letter and a one-line description), from the hero_<opt>_<variant>.png shots already on disk
const LINES = {
  A: 'Scenic: the lighthouse, typed in row by row',
  B: 'Before and after: cat photo | its dots, a wipe',
  C: 'Emblem: bold dots coming up like a print',
  D: 'In the chat: the art arrives in an IG comment',
  E: 'Night: the halo figure in glowing dots, typed in',
};
if (args.includes('--lineup')) {
  const ids = opt('opts', 'A,B,C,D,E').split(',');
  const PH = 660, pw = Math.round((390 / 844) * PH), dw = Math.round((785 / 766) * PH);
  const colW = pw + 16 + dw, gap = 64, pad = 48;
  const Wt = pad * 2 + ids.length * colW + (ids.length - 1) * gap;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #ebe8e2; font: 400 19px/1.3 Geist, "Segoe UI", sans-serif; color: #1c1b19; }
    .row { display: flex; gap: ${gap}px; padding: ${pad}px; width: ${Wt - 2 * pad}px; }
    .col { width: ${colW}px; flex: none; }
    h2 { display: flex; align-items: baseline; gap: 18px; margin: 0 0 18px; font-weight: 400; }
    h2 b { font: italic 400 76px/0.9 "Instrument Serif", Georgia, serif; }
    h2 span { font-size: 21px; color: #3a3833; }
    .pair { display: flex; gap: 16px; align-items: flex-start; }
    figure { margin: 0; } img { display: block; height: ${PH}px; border-radius: 6px; box-shadow: 0 0 0 1px rgba(0,0,0,.14), 0 8px 24px -12px rgba(0,0,0,.45); }
    figcaption { margin-top: 10px; font-size: 15px; color: #6d6961; }
  </style><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap">
  <div class="row">${ids.map(o => `<div class="col"><h2><b>${o}</b><span>${esc(LINES[o] || '')}</span></h2><div class="pair">
    <figure><img src="${ORIGIN}/shots/hero_${o}_phone-light.png?v=${Date.now()}" style="width:${pw}px"><figcaption>phone light 390 × 844</figcaption></figure>
    <figure><img src="${ORIGIN}/shots/hero_${o}_desk-dark.png?v=${Date.now()}" style="width:${dw}px"><figcaption>desktop dark 785 × 766</figcaption></figure>
  </div></div>`).join('')}</div>`;
  const page = await browser.newPage({ viewport: { width: Wt, height: 400 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const bad = await page.evaluate(() => [...document.images].filter(i => !i.naturalWidth).map(i => i.src));
  const out = path.join(root, 'shots', 'hero_lineup.png');
  await page.screenshot({ path: out, fullPage: true });
  console.log(path.relative(root, out), Wt, bad.length ? 'MISSING ' + bad.join(' ') : 'ok');
  await browser.close();
  process.exit(bad.length ? 1 : 0);
}

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
    const url = o === 'app' ? `${ORIGIN}/?welcome=1` : `${ORIGIN}/dev/hero.html?opt=${o}&theme=${V.theme}${extra ? '&' + extra : ''}`;
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

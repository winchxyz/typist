// Screenshot the real app in a headless browser, optionally after scripted steps.
//   node tests/app-shot.mjs --out shots/ui_desktop.png [--w 1440 --h 900 --dpr 2] [--browser chromium]
//        [--eval "await SP.applyLook('crayon')"] [--wait 1500] [--clip "#inspector"] [--theme dark|light]
//        [--mobile] [--path "/?x=1"]
// Waits until the app has geometry (window.SP.geom) and the reveal has finished, then shoots.
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium, firefox, webkit } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const browserName = opt('browser', 'chromium');
const out = path.resolve(opt('out', 'shots/app.png'));
const mobile = flag('mobile');
const W = +opt('w', mobile ? 390 : 1440), H = +opt('h', mobile ? 844 : 900), dpr = +opt('dpr', mobile ? 3 : 2);
const launchers = { chromium, firefox, webkit };
const browser = await launchers[browserName].launch(browserName === 'chromium'
  ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: dpr,
  colorScheme: opt('theme', 'light'), reducedMotion: flag('reduced') ? 'reduce' : 'no-preference',
  hasTouch: mobile, isMobile: mobile && browserName !== 'firefox',
});
const page = await context.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
page.on('requestfailed', r => logs.push('[requestfailed] ' + r.url()));
page.on('response', r => { if (r.status() >= 400) logs.push(`[${r.status()}] ${r.url()}`); });
await page.goto(`http://localhost:${opt('port', 8860)}${opt('path', '/')}`);
await page.waitForFunction(() => window.SP && window.SP.geom && !window.SP.play.playing, null, { timeout: 60000 }).catch(e => logs.push('wait: ' + e.message));
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--eval') {
    try { await page.evaluate(`(async () => { ${args[i + 1]} })()`); } catch (e) { logs.push('[eval] ' + e.message); }
    await page.waitForTimeout(+opt('step', 300));
  }
}
await page.waitForTimeout(+opt('wait', 900));
const clip = opt('clip', null);
if (clip) await page.locator(clip).first().screenshot({ path: out });
else await page.screenshot({ path: out, fullPage: false });
console.log(JSON.stringify({ out, browser: browserName, W, H, dpr }));
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
await browser.close();

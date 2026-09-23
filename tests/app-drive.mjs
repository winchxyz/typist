// Drive the real app in a headless browser and screenshot its screens.
//   node tests/app-drive.mjs [--browser chromium|firefox|webkit] [--only welcome,sample,hopper,desktop,...]
//        [--theme light|dark] [--dpr 2] [--prefix app]
// Needs the dev server on port 8860. Shots land in shots/<prefix>_<scene>_<browser>_<theme>.png.
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
const browserName = opt('browser', 'chromium');
const themes = opt('theme', 'light,dark').split(',');
const only = opt('only', 'welcome,sample,hopper,desktop').split(',');
const dpr = +opt('dpr', 2);
const prefix = opt('prefix', 'app');
const ORIGIN = `http://localhost:${opt('port', 8860)}`;

const browser = await pw[browserName].launch(browserName === 'chromium'
  ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });

const results = [];
async function scene(name, { w = 390, h = 844, mobile = true, theme = 'light', path: p = '/', steps = async () => {}, full = false, reduced = false }) {
  const context = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: dpr, colorScheme: theme,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    hasTouch: mobile, isMobile: mobile && browserName !== 'firefox',
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
  page.on('response', r => { if (r.status() >= 400) logs.push(`[${r.status()}] ${r.url()}`); });
  const t0 = Date.now();
  await page.goto(ORIGIN + p);
  let ok = true, info = null;
  try {
    await page.waitForFunction(() => window.__done, null, { timeout: 30000 });
    await steps(page);
    info = await page.evaluate(() => ({
      done: window.__done, mods: window.TY && window.TY.mods,
      fit: document.getElementById('fitLine')?.textContent, target: window.TY?.state.target,
      grid: window.TY?.grid ? [window.TY.grid.cols, window.TY.grid.rows, window.TY.grid.mode] : null,
      ms: window.TY?.cur?.ms,
    }));
  } catch (e) { ok = false; logs.push('[drive] ' + e.message); }
  await page.waitForTimeout(350);
  const out = path.join(root, 'shots', `${prefix}_${name}_${browserName}_${theme}.png`);
  await page.screenshot({ path: out, fullPage: full });
  results.push({ scene: name, theme, ok, secs: (Date.now() - t0) / 1000, out: path.relative(root, out), ...info, logs: logs.slice(0, 8) });
  await context.close();
}

const waitWelcome = async page => { await page.waitForFunction(() => window.TY && window.TY.welcomeDone, null, { timeout: 20000 }); };
const loadSample = id => async page => {
  await page.evaluate(i => window.TY.openSample(i), id);
  await page.waitForFunction(() => window.TY.grid, null, { timeout: 20000 });
  await page.waitForTimeout(600);   // idle thumbnails
};
const loadHopper = async page => {
  await page.setInputFiles('#fileInput', path.join(here, 'fixtures', 'photo_hopper.jpg'));
  await page.waitForFunction(() => window.TY.grid, null, { timeout: 20000 });
  await page.waitForTimeout(600);
};

for (const theme of themes) {
  if (only.includes('welcome')) await scene('welcome', { theme, steps: waitWelcome });
  if (only.includes('sample')) await scene('sample', { theme, path: '/?welcome=1', steps: loadSample('pet'), full: true });
  if (only.includes('hopper')) await scene('hopper', { theme, path: '/?welcome=1', steps: loadHopper, full: true });
  if (only.includes('tg')) await scene('tg', { theme, path: '/?for=tg', steps: async pg => { await loadSample('portrait')(pg); await pg.click('#tab-size'); await pg.waitForTimeout(200); }, full: true });
  if (only.includes('x')) await scene('x', { theme, path: '/?for=x', steps: async pg => { await loadSample('landmark')(pg); await pg.click('#tab-tone'); await pg.waitForTimeout(200); }, full: true });
  if (only.includes('over')) await scene('over', { theme, path: '/?for=x', steps: async pg => { await loadSample('pet')(pg); for (let i = 0; i < 4; i++) await pg.evaluate(() => window.TY.stepCols(1)); await pg.waitForTimeout(200); } });
  if (only.includes('desktop')) {
    await scene('desktop', { theme, w: 1440, h: 900, mobile: false, path: '/?welcome=1', steps: loadHopper });
  }
  if (only.includes('desktop1100')) await scene('desktop1100', { theme, w: 1100, h: 800, mobile: false, path: '/?welcome=1', steps: loadSample('pet') });
  if (only.includes('dwelcome')) await scene('dwelcome', { theme, w: 1440, h: 900, mobile: false, steps: waitWelcome });
  if (only.includes('w360')) await scene('w360', { theme, w: 360, h: 740, steps: waitWelcome });
  if (only.includes('crop')) await scene('crop', { theme, path: '/?welcome=1', steps: async pg => { await loadSample('pet')(pg); await pg.click('#btnCrop'); await pg.waitForTimeout(300); } });
  if (only.includes('compare')) await scene('compare', { theme, path: '/?welcome=1', steps: async pg => { await loadSample('pet')(pg); await pg.evaluate(() => window.TY.setCompare(true)); await pg.waitForTimeout(200); } });
}

for (const r of results) console.log(JSON.stringify(r));
await browser.close();
process.exit(results.every(r => r.ok) ? 0 : 1);

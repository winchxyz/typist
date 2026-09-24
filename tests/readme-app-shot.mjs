// The app screenshots the README frames (dev/readme-art.html ?shot=phones,chats,desktop): the
// showcase artwork, Texture look, inverted, dark. Phones 390 x 844 and desktop 1440 x 900, dpr 2.
//   node tests/readme-app-shot.mjs   -> shots/readme_app_phone_dark_<id>.png, shots/readme_app_desktop_dark.png
// Needs the dev server on port 8860.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const ORIGIN = 'http://localhost:8860';
const ART = 'img/showcase/halo.jpg';

const browser = await pw.chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const out = [];
async function shoot({ id, phone }) {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 2,
    colorScheme: 'dark', reducedMotion: 'reduce', hasTouch: phone, isMobile: phone,
  });
  await context.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ORIGIN}/?welcome=1&for=${id}`);
  await page.waitForFunction(() => window.TY && window.TY.welcomeDone, null, { timeout: 30000 });
  await page.setInputFiles('#fileInput', ART);
  await page.waitForFunction(() => window.TY.grid && window.TY.payload, null, { timeout: 20000 });
  await page.evaluate(() => { window.TY.set({ look: 'texture' }); window.TY.setInvert(true); window.TY.clearNote(); });
  await page.waitForTimeout(1200);
  const file = `shots/readme_app_${phone ? 'phone' : 'desktop'}_dark${phone ? '_' + id : ''}.png`;
  await page.screenshot({ path: file });
  out.push({ file, grid: await page.evaluate(() => `${TY.grid.cols}x${TY.grid.rows} ${TY.payload.count}/${TY.payload.limit} ${TY.payload.unit}`), errors });
  await context.close();
}
for (const id of ['ig', 'xlong', 'tg', 'steamb', 'ytlive', 'twitch']) await shoot({ id, phone: true });
await shoot({ id: 'ig', phone: false });
await browser.close();
console.log(JSON.stringify(out, null, 1));

// Download the PNG the app makes for a few targets and save them to shots/ to look at.
//   node tests/png-grab.mjs [--browser chromium]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const name = process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : 'chromium';
const browser = await pw[name].launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
await context.route(/^https:\/\/api\.github\.com\//, r => r.fulfill({ status: 404, body: '{}' }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8860/?for=ig');
await page.setInputFiles('#fileInput', 'tests/fixtures/photo_hopper.jpg');
await page.waitForFunction(() => window.TY && window.TY.grid && window.__done);
const out = [];
for (const [t, invert] of [['ig', false], ['x', false], ['tg', false], ['ig', true]]) {
  await page.evaluate(([t, inv]) => { window.TY.setTarget(t); window.TY.setInvert(inv); }, [t, invert]);
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#actionBar .png-btn')]);
  const file = `shots/png_${t}${invert ? '_inv' : ''}_${dl.suggestedFilename()}`;
  await dl.saveAs(file);
  const buf = fs.readFileSync(file);
  out.push({ file, bytes: buf.length, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
}
console.log(JSON.stringify({ out, errors, api: Object.keys(await page.evaluate(() => window.TY || {})) }, null, 1));
await browser.close();

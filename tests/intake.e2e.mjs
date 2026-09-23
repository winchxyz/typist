// Photo intake end-to-end: feed every fixture through the real file input and check the outcome.
//   node tests/intake.e2e.mjs [--browser chromium|firefox|webkit]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => path.join(here, 'fixtures', f);

const args = process.argv.slice(2);
const browserName = (() => { const i = args.indexOf('--browser'); return i >= 0 ? args[i + 1] : 'chromium'; })();

// expect: 'portrait' | 'landscape' | 'square' | 'error:<substring>' ; extra checks as functions of the state
const CASES = [
  { file: 'portrait_exif6.jpg', expect: 'portrait', note: 'EXIF 6 must display upright (portrait)' },
  { file: 'portrait_exif8.jpg', expect: 'portrait', note: 'EXIF 8 must display upright (portrait)' },
  { file: 'logo_alpha.png', expect: 'landscape', check: s => s.alphaBox && s.crop.zoom > 1, note: 'transparent PNG framed to its opaque box' },
  { file: 'huge_48mp.jpg', expect: 'landscape', check: s => Math.max(s.w, s.h) <= 2048, note: '48 MP downscaled to <= 2048' },
  { file: 'tiny.png', expect: 'square', toast: 'small', note: 'tiny photo warns' },
  { file: 'fake.heic', expect: 'error:HEIC' },
  { file: 'notes.txt', expect: 'error:isn\'t a photo' },
  { file: 'anim.gif', expect: 'square', note: 'first frame of a GIF' },
  { file: 'pano.jpg', expect: 'landscape' },
  { file: 'gray.png', expect: 'square' },
  { file: 'cmyk.jpg', expect: 'square' },
  { file: 'flat.png', expect: 'square', toast: 'flat', note: 'flat photo warns' },
  { file: 'dark.jpg', expect: 'portrait', check: s => s.coverage > 0.3 && s.coverage < 0.55, note: 'dark photo still reaches the ink target' },
];

const browser = await pw[browserName].launch(browserName === 'chromium'
  ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
await page.goto('http://localhost:8860/');
await page.waitForFunction(() => window.SP && window.SP.geom, null, { timeout: 60000 });

const rows = [];
for (const c of CASES) {
  const before = await page.evaluate(() => SP.photo?.id);
  await page.evaluate(() => { document.getElementById('toasts').replaceChildren(); });
  await page.setInputFiles('#fileInput', fx(c.file));
  let state;
  try {
    await page.waitForFunction(prev => (SP.photo && SP.photo.id !== prev && SP.geom) || document.querySelector('.toast.error'),
      before, { timeout: 30000 });
    await page.waitForTimeout(400);
    state = await page.evaluate(() => ({
      id: SP.photo?.id, w: SP.photo?.width, h: SP.photo?.height, alphaBox: SP.photo?.alphaBox, crop: SP.doc.crop,
      toast: document.getElementById('toasts').textContent, error: !!document.querySelector('.toast.error'),
      coverage: SP.toneStats?.coverage ?? null,
    }));
  } catch (e) {
    state = { timeout: true, toast: await page.textContent('#toasts') };
  }
  const changed = state.id !== before && !state.error;
  let pass;
  if (c.expect.startsWith('error:')) pass = state.error && state.toast.includes(c.expect.slice(6));
  else {
    const shape = state.w > state.h * 1.05 ? 'landscape' : state.h > state.w * 1.05 ? 'portrait' : 'square';
    pass = changed && shape === c.expect;
    if (pass && c.check) pass = !!c.check(state);
    if (pass && c.toast) pass = state.toast.toLowerCase().includes(c.toast);
  }
  rows.push({ file: c.file, pass, w: state.w, h: state.h, toast: (state.toast || '').slice(0, 80), note: c.note || '' });
}
console.table(rows);
if (errors.length) console.log(errors.slice(0, 20).join('\n'));
const failed = rows.filter(r => !r.pass).length;
console.log(`${browserName}: ${rows.length - failed}/${rows.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);

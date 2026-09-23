// Screenshot the preview contact sheet (DOM chrome, so the page cannot save itself).
//   node tests/preview-shot.mjs [--path "/dev/preview.html?phone=360"] [--out shots/preview_sheet.png]
//        [--dpr 1] [--rows 2] [--browser chromium|firefox|webkit]
// Waits for window.__done, prints it, saves the full page and one crop per target row at --rows dpr
// (shots/preview_row_<id>.png, or <out>_row_<id>.png for a custom --out).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const unmsys = a => a.replace(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](?=[a-z])/i, '/');
const path = unmsys(opt('path', '/dev/preview.html')).replace(/;/g, '&');
const out = opt('out', 'shots/preview_sheet.png');
const stem = out.replace(/\.png$/, '').replace(/_sheet$/, '');
const name = opt('browser', 'chromium');
const rowDpr = +opt('rows', 2);

async function shoot(dpr, fn) {
  const browser = await pw[name].launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  await page.goto(`http://localhost:${opt('port', 8860)}${path}`);
  await page.waitForFunction(() => window.__done, null, { timeout: 120000, polling: 200 });
  const done = await page.evaluate(() => window.__done);
  await fn(page, done);
  await browser.close();
  return { done, errors };
}

const full = await shoot(+opt('dpr', 1), async page => { await page.screenshot({ path: out, fullPage: true }); });
console.log(JSON.stringify(full.done, null, 1));
if (full.errors.length) console.log('console:\n' + full.errors.slice(0, 30).join('\n'));
if (rowDpr > 0) {
  const saved = [];
  await shoot(rowDpr, async page => {
    const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('.rowhead')].map(e => e.dataset.row))]);
    for (const id of ids) {
      // the union of the row header and its cells
      const box = await page.evaluate(rid => {
        const els = [...document.querySelectorAll(`[data-row="${rid}"]`)].map(e => e.getBoundingClientRect());
        const x = Math.min(...els.map(r => r.left)), y = Math.min(...els.map(r => r.top));
        const w = Math.max(...els.map(r => r.right)) - x, h = Math.max(...els.map(r => r.bottom)) - y;
        return { x: x + scrollX - 8, y: y + scrollY - 8, width: w + 16, height: h + 16 };
      }, id);
      const file = `${stem}_row_${id}.png`;
      await page.screenshot({ path: file, clip: box, fullPage: true });
      saved.push(file);
    }
  });
  console.log('rows: ' + saved.join(' '));
}
process.exit(full.done && full.done.ok ? 0 : 1);

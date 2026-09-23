// Render kit payloads as real text (the browser's own Braille font) to see Windows shear.
//   node tests/shear-shot.mjs [--browser chromium|firefox]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const name = (process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : 'chromium');
const html = fs.readFileSync('shots/paste-test.html', 'utf8');
const data = JSON.parse(html.match(/<script id="kit-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const byId = Object.fromEntries(data.cards.map(c => [c.id, c]));
const pick = ['tg.shapes.a', 'tg.shapes.b', 'tg.survive.a', 'tg.survive.b', 'tgc.art', 'tgc.art.inv'];
const post = byId['tgc.post'].text.split('\n');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cols = [
  ...pick.map(id => ({ id, text: byId[id].text })),
  { id: 'tgc.post rows 34-68 (cat)', text: post.slice(17, 34).join('\n') },
  { id: 'tgc.post rows 102-119 (lighthouse inv)', text: post.slice(101, 118).join('\n') },
  { id: 'tgc.post rows 17-34 with U+2840 blanks', text: post.slice(17, 34).join('\n').replace(/\u2800/g, '\u2840') },
];
const page = `<!doctype html><meta charset="utf-8"><style>
body{margin:16px;background:#fff;font:14px system-ui;display:flex;flex-wrap:wrap;gap:18px;width:1500px}
figure{margin:0} figcaption{font:12px system-ui;color:#555;margin-bottom:4px}
pre{margin:0;font:15px/1.3 system-ui,'Segoe UI',sans-serif;background:#f3f3f3;padding:8px}
</style>${cols.map(c => `<figure><figcaption>${esc(c.id)}</figcaption><pre>${esc(c.text)}</pre></figure>`).join('')}`;
const browser = await pw[name].launch({ headless: true });
const p = await browser.newPage({ viewport: { width: 1540, height: 900 } });
await p.setContent(page);
await p.screenshot({ path: `shots/shear_${name}.png`, fullPage: true });
const widths = await p.evaluate(() => {
  const c = document.createElement('canvas').getContext('2d');
  c.font = '15px system-ui';
  return { blank: c.measureText('\u2800').width, dot7: c.measureText('\u2840').width, full: c.measureText('\u28ff').width, one: c.measureText('\u2801').width };
});
console.log(name, JSON.stringify(widths));
await browser.close();

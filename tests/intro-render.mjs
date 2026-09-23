// Render the intro film frame by frame and encode it.
//   node tests/intro-render.mjs                     all 480 frames -> docs/typist-intro.mp4 + docs/intro-poster.jpg
//   node tests/intro-render.mjs --frames 0,45,120   only these frames -> shots/intro_f0045.png (for looking)
//        [--q "dotr=0.42;glow=0.5"]  extra query for dev/intro.html   [--out dir]  frame folder
// dev/intro.html exposes window.renderAt(t): every frame is a pure function of t, so each frame is
// drawn, then screenshotted (Playwright Chromium, 1920 x 1080 at dpr 1), then ffmpeg encodes the PNGs
// at exactly 30 fps. Needs the dev server on port 8860.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FPS = 30, N = 480;
const only = opt('frames', null);
const extra = opt('q', '').replace(/;/g, '&');
const frameDir = path.resolve(root, opt('out', 'shots/intro_frames'));
const ORIGIN = `http://localhost:${opt('port', 8860)}`;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
await page.goto(`${ORIGIN}/dev/intro.html${extra ? '?' + extra : ''}`);
await page.waitForFunction(() => window.__done, null, { timeout: 60000, polling: 100 });
console.log(JSON.stringify(await page.evaluate(() => window.__done)));

const frames = only ? only.split(',').map(Number) : Array.from({ length: N }, (_, i) => i);
if (!only) { fs.rmSync(frameDir, { recursive: true, force: true }); fs.mkdirSync(frameDir, { recursive: true }); }
const t0 = Date.now();
for (const i of frames) {
  await page.evaluate(t => new Promise(res => { window.renderAt(t); requestAnimationFrame(() => requestAnimationFrame(res)); }), i / FPS);
  const out = only
    ? path.join(root, 'shots', `intro_f${String(i).padStart(4, '0')}.png`)
    : path.join(frameDir, `frame_${String(i).padStart(4, '0')}.png`);
  await page.screenshot({ path: out });
  if (only) console.log(path.relative(root, out));
  else if (i % 60 === 0) console.log(`frame ${i} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
await browser.close();
if (errors.length) console.log('console:\n' + errors.slice(0, 20).join('\n'));

if (!only) {
  const mp4 = path.join(root, 'docs', 'typist-intro.mp4');
  const poster = path.join(root, 'docs', 'intro-poster.jpg');
  fs.mkdirSync(path.dirname(mp4), { recursive: true });
  const crf = opt('crf', '18');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frameDir, 'frame_%04d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], { stdio: 'inherit' });
  // the poster is the first frame itself, JPEG quality 90 (PIL, 4:4:4 so the gold stays crisp)
  execFileSync('python', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], quality=90, subsampling=0, optimize=True)',
    path.join(frameDir, 'frame_0000.png'), poster], { stdio: 'inherit' });
  console.log(`${path.relative(root, mp4)} ${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB, ${path.relative(root, poster)} ${(fs.statSync(poster).size / 1e3).toFixed(0)} kB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

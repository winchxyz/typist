// Cross-engine check of the converter: node tests/xbrowser.e2e.mjs   (needs the dev server on 8860)
//  1. Given identical lightness (and colour), everything after sampling must give byte-identical
//     Grids in node, Chromium, Firefox and WebKit: toneGrid + every encoder, and the whole
//     converter fed a pure RGBA source (sampleFromRGBA is plain JS).
//  2. sampleImage (canvas resample) may differ between engines: measure by how much, and how many
//     Braille cells that changes.
//  3. Inside each engine, the canvas path and the pure path must agree (rotation sign, crop centre).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const ORIGIN = 'http://localhost:8860';
const ENGINES = ['chromium', 'firefox', 'webkit'];

// Runs inside the page (and in node, with the same module URLs mapped to files).
async function pipeline(base, payload) {
  const tone = await import(base + '/js/tone.js');
  const conv = await import(base + '/js/convert.js');
  const dith = await import(base + '/js/dither.js');
  const blk = await import(base + '/js/blocks.js');
  const asc = await import(base + '/js/ascii.js');
  const b64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  // FNV-1a 32 over raw bytes (same in every engine)
  const fnv = (arr) => { const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); let h = 0x811c9dc5; for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
  const out = { hashes: {} };
  const rgba = new Uint8ClampedArray(b64(payload.rgba).buffer);
  const src = { width: payload.w, height: payload.h, data: rgba };

  // (1a) toneGrid + encoders on one fixed sample (pure resample of the shared bytes)
  const tones = [{}, { invert: true }, { brightness: 0.4, contrast: 0.3, edges: 0.6 }, { auto: false, gamma: 1.7, detail: 0.9 }];
  for (const [W, H, what] of [[80, 88, 'braille40'], [32, 36, 'braille16'], [320, 255, 'ascii40'], [80, 44, 'quad40']]) {
    const s = tone.sampleFromRGBA(rgba, payload.w, payload.h, W, H, { crop: { x: 0.5, y: 0.45, zoom: 1.2, rotation: 0 }, color: what === 'quad40' });
    out.hashes[`L:${what}`] = fnv(s.L);
    tones.forEach((t, ti) => {
      const L = tone.toneGrid(s, t, { target: 0.4, boost: what === 'braille16' ? 1 : 0 });
      out.hashes[`tone:${what}:${ti}`] = fnv(L);
      if (what.startsWith('braille')) for (const d of dith.DITHERS) out.hashes[`enc:${what}:${ti}:${d}`] = fnv(dith.encodeBraille(dith.ditherDots(L, W, H, d, { edge: L.edge, edges: t.edges || 0 }), W, H).cp);
      if (what === 'ascii40') for (const method of ['shape', 'ramp']) out.hashes[`enc:${what}:${ti}:${method}`] = fnv(asc.asciiCells(L, W, H, 40, 15, { method }));
      if (what === 'quad40') {
        const lab = blk.labGrid(s.rgb, L, W * H);
        const q = blk.blocksQuad(lab, W, H);
        out.hashes[`enc:${what}:${ti}:colour`] = fnv(q.cp) + fnv(q.fg) + fnv(q.bg);
        out.hashes[`enc:${what}:${ti}:mono`] = fnv(blk.blocksMono(L, W, H, { dither: 'atkinson', edge: L.edge }).cp);
      }
    });
  }
  // (1b) the whole converter on the shared bytes, every mode, with rotation
  const c = conv.createConverter();
  c.setSource(src);
  const modes = [
    { mode: 'braille', dither: 'atkinson' }, { mode: 'braille', dither: 'floyd' }, { mode: 'braille', dither: 'bayer' },
    { mode: 'ascii', ascii: 'shape' }, { mode: 'blocks', blocks: 'quad', color: true }, { mode: 'blocks', blocks: 'half' },
  ];
  for (const m of modes) for (const crop of [{}, { x: 0.45, y: 0.4, zoom: 1.5, rotation: 17 }]) {
    const g = c.run(crop, { ...m, cols: 32, rows: 16 });
    out.hashes[`run:${JSON.stringify(m)}:${crop.rotation || 0}`] = fnv(g.cp) + (g.fg ? fnv(g.fg) + fnv(g.bg) : '');
  }
  return out;
}

// Runs only in the page: canvas sampling of real files.
async function canvasPart(files) {
  const tone = await import('/js/tone.js');
  const conv = await import('/js/convert.js');
  const res = {};
  for (const f of files) {
    const blob = await (await fetch(f)).blob();
    const bmp = await createImageBitmap(blob);
    // native-size RGBA of the same bitmap, for the pure path
    // WebKit's Windows build has no OffscreenCanvas
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const id = cx.getImageData(0, 0, bmp.width, bmp.height);
    for (const crop of [{}, { x: 0.4, y: 0.55, zoom: 1.7, rotation: 30 }]) {
      const key = f.split('/').pop() + (crop.rotation ? ':rot30' : ':centre');
      const a = tone.sampleImage(bmp, crop, 80, 88);
      const p = tone.sampleFromRGBA(id.data, id.width, id.height, 80, 88, { crop });
      let md = 0, sd = 0;
      for (let i = 0; i < a.L.length; i++) { const d = Math.abs(a.L[i] - p.L[i]); sd += d; if (d > md) md = d; }
      const c = conv.createConverter();
      c.setSource(bmp);
      const g = c.run(crop, { mode: 'braille', cols: 40, rows: 22 });
      res[key] = { L: Array.from(a.L), canvasVsPure: { max: md, mean: sd / a.L.length }, cp: Array.from(g.cp), size: [bmp.width, bmp.height] };
    }
  }
  return res;
}

// ---------- node reference ----------
const sharpFree = async () => {
  // shared bytes: Chromium decodes the real portrait sample once; every engine and node then use those bytes
  const b = await pw.chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.goto(ORIGIN + '/SPEC.md');
  const data = await p.evaluate(async () => {
    const bmp = await createImageBitmap(await (await fetch('/img/samples/portrait.jpg')).blob());
    const cv = new OffscreenCanvas(384, 384);
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0, 384, 384);
    const d = cx.getImageData(0, 0, 384, 384).data;
    let s = '';
    for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
    return btoa(s);
  });
  await b.close();
  return { w: 384, h: 384, rgba: data };
};

globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');
const payload = await sharpFree();
const base = new URL('..', import.meta.url).href.replace(/\/$/, '');
const ref = await pipeline(base, payload);
console.log(`node: ${Object.keys(ref.hashes).length} hashes`);

const files = ['/img/samples/portrait.jpg', '/img/samples/logo.jpg', '/tests/fixtures/logo_alpha.png', '/tests/fixtures/portrait_exif6.jpg'];
const canvas = {};
let identicalFail = 0;
for (const name of ENGINES) {
  const opts = name === 'chromium' ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true };
  const browser = await pw[name].launch(opts);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/SPEC.md');
  const got = await page.evaluate(`(${pipeline.toString()})(location.origin, ${JSON.stringify(payload)})`);
  const bad = Object.keys(ref.hashes).filter(k => got.hashes[k] !== ref.hashes[k]);
  identicalFail += bad.length;
  console.log(`${name}: ${Object.keys(got.hashes).length - bad.length}/${Object.keys(ref.hashes).length} hashes identical to node` + (bad.length ? '  DIFF: ' + bad.join(', ') : ''));
  canvas[name] = await page.evaluate(`(${canvasPart.toString()})(${JSON.stringify(files)})`);
  if (errors.length) console.log(`${name} page errors: ${errors.join(' | ')}`);
  await browser.close();
}

// ---------- budget under 4x CPU throttling (Chromium via CDP; a mid-range phone) ----------
async function timing() {
  const conv = await import('/js/convert.js');
  const bmp = await createImageBitmap(await (await fetch('/img/samples/portrait.jpg')).blob());
  const c = conv.createConverter();
  c.setSource(bmp);
  const fresh = [], tone = [], big = [];
  c.run({ x: 0.5, y: 0.5 }, { mode: 'braille', cols: 60, rows: 40 });   // warm up the JIT
  for (let k = 0; k < 9; k++) {
    let t0 = performance.now();
    c.run({ x: 0.5, y: 0.5 + k * 0.001 }, { mode: 'braille', cols: 60, rows: 40 });
    fresh.push(performance.now() - t0);
    t0 = performance.now();
    c.run({ x: 0.5, y: 0.5 + k * 0.001 }, { mode: 'braille', cols: 60, rows: 40, tone: { brightness: 0.1 } });
    tone.push(performance.now() - t0);
  }
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    c.run({ x: 0.5, y: 0.5 - k * 0.001 }, { mode: 'braille', cols: 200, rows: 110 });
    big.push(performance.now() - t0);
  }
  const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  return { fresh: med(fresh), freshMax: Math.max(...fresh), tone: med(tone), toneMax: Math.max(...tone), big200: med(big) };
}
{
  const browser = await pw.chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  await page.goto(ORIGIN + '/SPEC.md');
  const r1 = await page.evaluate(`(${timing.toString()})()`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const r4 = await page.evaluate(`(${timing.toString()})()`);
  await browser.close();
  const f = r => `fresh 60x40 median ${r.fresh.toFixed(1)} ms (max ${r.freshMax.toFixed(1)}), tone change ${r.tone.toFixed(1)} ms (max ${r.toneMax.toFixed(1)}), 200x110 fresh ${r.big200.toFixed(0)} ms`;
  console.log('chromium 1x: ' + f(r1));
  console.log('chromium 4x throttled: ' + f(r4) + (r4.fresh < 30 && r4.tone < 10 ? '  (within the desktop budget)' : '  (over the desktop budget of 30 / 10 ms)'));
}

// ---------- canvas sampling: engine vs engine, and canvas vs pure inside each engine ----------
let pathFail = 0;
for (const key of Object.keys(canvas.chromium)) {
  const line = [key.padEnd(28)];
  for (const name of ENGINES) {
    const c = canvas[name][key].canvasVsPure;
    line.push(`${name} canvas-vs-pure max ${c.max.toFixed(3)} mean ${c.mean.toFixed(4)}`);
    if (c.mean > 0.02) pathFail++;
  }
  console.log(line.join(' | '));
  for (const [a, b] of [['chromium', 'firefox'], ['chromium', 'webkit'], ['firefox', 'webkit']]) {
    const A = canvas[a][key], B = canvas[b][key];
    let md = 0, sd = 0, cells = 0;
    for (let i = 0; i < A.L.length; i++) { const d = Math.abs(A.L[i] - B.L[i]); sd += d; if (d > md) md = d; }
    for (let i = 0; i < A.cp.length; i++) if (A.cp[i] !== B.cp[i]) cells++;
    console.log(`   ${a} vs ${b}: sampled L max diff ${md.toFixed(4)}, mean ${(sd / A.L.length).toFixed(5)}; Braille 40x22 cells differing ${cells}/${A.cp.length}; decoded size ${A.size} vs ${B.size}`);
  }
}
console.log(`RESULT identical-after-sampling mismatches: ${identicalFail}; canvas-vs-pure disagreements (mean > 0.02): ${pathFail}`);
process.exitCode = identicalFail || pathFail ? 1 : 0;

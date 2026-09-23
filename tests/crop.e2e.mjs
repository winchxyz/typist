// Crop frame end-to-end: drives dev/crop.html with synthetic pointer, wheel and key events and
// checks the crop values against the tone.js mapping, plus frame-vs-sampler agreement.
//   node tests/crop.e2e.mjs [--browser chromium|firefox|webkit|all] [--shots 0]
// Screenshots: shots/crop_<engine>_<state>.png at 390 x 844 (dpr 2).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const which = opt('browser', 'all');
const SHOTS = opt('shots', '1') !== '0';
const engines = which === 'all' ? ['chromium', 'firefox', 'webkit'] : [which];

// ---------------------------------------------------------------- the mapping under test (tone.js)
// screen = F + k * R(rot) * (P - C), k = size * zoom / min(w, h)
function screenOf([px, py], c, f, w, h) {
  const k = f.size * c.zoom / Math.min(w, h), r = c.rotation * Math.PI / 180;
  const dx = px - c.x * w, dy = py - c.y * h;
  return [f.left + f.cx + k * (dx * Math.cos(r) - dy * Math.sin(r)), f.top + f.cy + k * (dx * Math.sin(r) + dy * Math.cos(r))];
}
function photoOf([sx, sy], c, f, w, h) {
  const k = f.size * c.zoom / Math.min(w, h), r = c.rotation * Math.PI / 180;
  const ux = (sx - f.left - f.cx) / k, uy = (sy - f.top - f.cy) / k;
  return [c.x * w + ux * Math.cos(r) + uy * Math.sin(r), c.y * h - ux * Math.sin(r) + uy * Math.cos(r)];
}

let failures = 0;
const results = [];
function expect(engine, name, pass, detail = '') {
  results.push({ engine, name, pass, detail });
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${engine.padEnd(8)} ${name}${detail ? '  ' + detail : ''}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

for (const engine of engines) {
  const browser = await pw[engine].launch(engine === 'chromium'
    ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  const E = engine;

  // a portrait photo (EXIF 6 -> 1500 x 2000 upright) so x and y normalise differently
  await page.goto('http://localhost:8860/dev/crop.html?photo=portrait_exif6.jpg&crop=0.5,0.45,1.2,0');
  await page.waitForFunction(() => window.__done, null, { timeout: 60000 });
  const done = await page.evaluate(() => window.__done);
  expect(E, 'initial frame matches sampler', done.ok, JSON.stringify({ mad: done.check.mad, corr: done.check.corr }));

  // helpers in the page
  await page.evaluate(() => {
    const cv = CR.cropper.canvas;
    window.T = {
      ptr(type, id, x, y, kind = 'touch') {
        cv.dispatchEvent(new PointerEvent(type, {
          pointerId: id, clientX: x, clientY: y, pointerType: kind, isPrimary: id === 1,
          bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        }));
      },
      wheel(x, y, deltaY, deltaMode = 0, ctrlKey = false) {
        cv.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY, deltaMode, ctrlKey, bubbles: true, cancelable: true }));
      },
      frame() {
        const r = cv.getBoundingClientRect(), f = CR.cropper.frame();
        return { ...f, left: r.left, top: r.top };
      },
      set(c) { CR.cropper.setImage(CR.photo, c); },
    };
  });
  const [w, h] = await page.evaluate(() => CR.size);
  expect(E, 'photo is portrait 1500 x 2000 (EXIF applied)', w === 1500 && h === 2000, `${w} x ${h}`);
  const f = await page.evaluate(() => T.frame());
  const crop = () => page.evaluate(() => CR.cropper.crop);
  const F = [f.left + f.cx, f.top + f.cy];

  if (SHOTS) await page.screenshot({ path: `shots/crop_${E}_idle.png` });

  // ------------------------------------------------------------------ one-finger drag
  {
    const c0 = await crop();
    const P = photoOf([F[0] - 20, F[1] + 10], c0, f, w, h);   // photo point under the finger
    await page.evaluate(([x, y]) => {
      CR.log.length = 0;
      T.ptr('pointerdown', 1, x, y);
      for (let i = 1; i <= 4; i++) T.ptr('pointermove', 1, x + 12 * i, y - 9 * i);
    }, [F[0] - 20, F[1] + 10]);
    await page.evaluate(() => CR.nextFrame());
    if (SHOTS) await page.screenshot({ path: `shots/crop_${E}_drag.png` });
    await page.evaluate(([x, y]) => T.ptr('pointerup', 1, x + 48, y - 36), [F[0] - 20, F[1] + 10]);
    await page.evaluate(() => CR.nextFrame());
    const c1 = await crop();
    const k = f.size * c0.zoom / Math.min(w, h);
    const ex = c0.x - 48 / k / w, ey = c0.y + 36 / k / h;
    expect(E, 'drag pans by finger / scale', near(c1.x, ex, 2e-5) && near(c1.y, ey, 2e-5),
      `x ${c1.x} vs ${ex.toFixed(5)}, y ${c1.y} vs ${ey.toFixed(5)}`);
    const s = screenOf(P, c1, f, w, h);
    expect(E, 'drag keeps the photo point under the finger', Math.hypot(s[0] - (F[0] + 28), s[1] - (F[1] - 26)) < 0.05);
    const log = await page.evaluate(() => CR.log.map(([t, , live]) => `${t}:${live}`));
    expect(E, 'onChange live while dragging, settles after', log.includes('change:true') && log[log.length - 1] === 'change:false', log.slice(-3).join(' '));
  }

  // ------------------------------------------------------------------ wheel at the cursor
  {
    await page.evaluate(() => T.set({ x: 0.5, y: 0.5, zoom: 1, rotation: 0 }));
    const c0 = await crop();
    const A = [F[0] + 60, F[1] - 50];
    const P = photoOf(A, c0, f, w, h);
    await page.evaluate(([x, y]) => T.wheel(x, y, -100, 0), A);
    const c1 = await crop();
    expect(E, 'wheel (pixels) zooms exp(0.15)', near(c1.zoom, Math.exp(0.15), 1e-4), `zoom ${c1.zoom}`);
    const s = screenOf(P, c1, f, w, h);
    expect(E, 'wheel keeps the point under the cursor', Math.hypot(s[0] - A[0], s[1] - A[1]) < 0.1, `off ${Math.hypot(s[0] - A[0], s[1] - A[1]).toFixed(3)} px`);
    await page.evaluate(([x, y]) => T.wheel(x, y, 3, 1), A);
    const c2 = await crop();
    expect(E, 'wheel (lines) is deltaMode aware', near(c2.zoom, c1.zoom * Math.exp(-0.15), 1e-4), `zoom ${c2.zoom}`);
    await page.evaluate(([x, y]) => { for (let i = 0; i < 40; i++) T.wheel(x, y, -400, 0); }, A);
    const c3 = await crop();
    await page.evaluate(([x, y]) => { for (let i = 0; i < 40; i++) T.wheel(x, y, 400, 0); }, A);
    const c4 = await crop();
    expect(E, 'zoom clamps to 0.5..6', c3.zoom === 6 && c4.zoom === 0.5, `${c3.zoom} / ${c4.zoom}`);
  }

  // ------------------------------------------------------------------ two-finger pinch
  {
    await page.evaluate(() => T.set({ x: 0.5, y: 0.5, zoom: 1, rotation: 0 }));
    const c0 = await crop();
    const a = [F[0] - 50, F[1]], b0 = [F[0] + 50, F[1]];
    const P = photoOf([F[0], F[1]], c0, f, w, h);   // under the starting midpoint
    await page.evaluate(([a, b]) => {
      T.ptr('pointerdown', 1, a[0], a[1]); T.ptr('pointerdown', 2, b[0], b[1]);
      for (let i = 1; i <= 10; i++) T.ptr('pointermove', 2, b[0] + 10 * i, b[1]);
      T.ptr('pointerup', 2, b[0] + 100, b[1]); T.ptr('pointerup', 1, a[0], a[1]);
    }, [a, b0]);
    const c1 = await crop();
    expect(E, 'pinch 100 -> 200 px doubles the zoom', near(c1.zoom, 2, 1e-3), `zoom ${c1.zoom}`);
    const s = screenOf(P, c1, f, w, h);
    const mid = [F[0] + 50, F[1]];
    expect(E, 'pinch keeps the photo point under the midpoint', Math.hypot(s[0] - mid[0], s[1] - mid[1]) < 0.1,
      `off ${Math.hypot(s[0] - mid[0], s[1] - mid[1]).toFixed(3)} px`);
    expect(E, 'pinch without turning keeps rotation 0', c1.rotation === 0, `rot ${c1.rotation}`);
  }

  // ------------------------------------------------------------------ two-finger rotate + snap
  async function turn(deg, steps, from = { x: 0.5, y: 0.5, zoom: 1, rotation: 0 }) {
    if (from) await page.evaluate(c => T.set(c), from);
    return page.evaluate(([F, deg, steps]) => {
      const R = 80, a = [F[0] - R / 2, F[1]];
      T.ptr('pointerdown', 1, a[0], a[1]);
      T.ptr('pointerdown', 2, a[0] + R, a[1]);
      let x = a[0] + R, y = a[1];
      for (let i = 1; i <= steps; i++) {
        const t = deg * i / steps * Math.PI / 180;
        x = a[0] + R * Math.cos(t); y = a[1] + R * Math.sin(t);
        T.ptr('pointermove', 2, x, y);
      }
      T.ptr('pointerup', 2, x, y); T.ptr('pointerup', 1, a[0], a[1]);
      return CR.cropper.crop;
    }, [F, deg, steps]);
  }
  {
    const c1 = await turn(30, 30);   // 1 degree per event: the snap must not swallow a slow turn
    expect(E, 'slow two-finger turn reaches 30 deg (clockwise +)', near(c1.rotation, 30, 0.01), `rot ${c1.rotation}`);
    expect(E, 'turning keeps the zoom', near(c1.zoom, 1, 1e-6), `zoom ${c1.zoom}`);
    const c2 = await turn(3, 3);
    expect(E, 'turn of 3 deg snaps to 0', c2.rotation === 0, `rot ${c2.rotation}`);
    const c3 = await turn(-93, 31);
    expect(E, 'turn of -93 deg snaps to -90', c3.rotation === -90, `rot ${c3.rotation}`);
    const c4 = await turn(5, 5, { x: 0.5, y: 0.5, zoom: 1, rotation: 0 });
    expect(E, 'turn of 5 deg does not snap', near(c4.rotation, 5, 0.01), `rot ${c4.rotation}`);
  }

  // ------------------------------------------------------------------ frame vs sampler
  for (const c of [
    { x: 0.5, y: 0.4, zoom: 1.6, rotation: 90 },
    { x: 0.42, y: 0.38, zoom: 1.8, rotation: 30 },
    { x: -0.1, y: 0.2, zoom: 0.6, rotation: 0 },
    { x: 0.6, y: 0.55, zoom: 2.5, rotation: -135 },
  ]) {
    await page.evaluate(c => T.set(c), c);
    await page.evaluate(() => CR.nextFrame());
    const r = await page.evaluate(() => CR.check(24));
    expect(E, `frame == sampler at ${c.x},${c.y} z${c.zoom} r${c.rotation}`, r.ok, `MAD ${r.mad} r ${r.corr}`);
  }
  if (SHOTS) {
    await page.evaluate(() => T.set({ x: 0.42, y: 0.38, zoom: 1.8, rotation: 30 }));
    await page.evaluate(() => CR.nextFrame());
    await page.screenshot({ path: `shots/crop_${E}_turned.png` });
  }

  // ------------------------------------------------------------------ clamps
  {
    await page.evaluate(() => T.set({ x: 0.5, y: 0.5, zoom: 1, rotation: 0 }));
    await page.evaluate(([x, y]) => {
      T.ptr('pointerdown', 1, x, y);
      for (let i = 1; i <= 30; i++) T.ptr('pointermove', 1, x + 100 * i, y + 100 * i);
      T.ptr('pointerup', 1, x + 3000, y + 3000);
    }, F);
    const c = await crop();
    expect(E, 'pan clamps to -0.5', c.x === -0.5 && c.y === -0.5, `${c.x}, ${c.y}`);
  }

  // ------------------------------------------------------------------ keyboard
  {
    await page.evaluate(() => { T.set({ x: 0.5, y: 0.5, zoom: 1, rotation: 0 }); CR.cropper.canvas.focus(); CR.log.length = 0; });
    const c0 = await crop();
    await page.keyboard.press('ArrowRight');
    const c1 = await crop();
    const k = f.size * c0.zoom / Math.min(w, h);
    expect(E, 'ArrowRight moves the frame right 2%', near(c1.x - c0.x, 0.02 * f.size / k / w, 2e-5), `dx ${(c1.x - c0.x).toFixed(5)}`);
    await page.keyboard.press('Shift+ArrowUp');
    const c2 = await crop();
    expect(E, 'Shift+ArrowUp moves 10% up', near(c2.y - c1.y, -0.1 * f.size / k / h, 2e-5), `dy ${(c2.y - c1.y).toFixed(5)}`);
    await page.keyboard.press('+');
    const c3 = await crop();
    expect(E, '+ zooms 1.1x', near(c3.zoom, 1.1, 1e-4), `zoom ${c3.zoom}`);
    await page.keyboard.press('-');
    await page.keyboard.press('r');
    const c4 = await crop();
    expect(E, '- zooms back, R rotates 90', near(c4.zoom, 1, 1e-4) && c4.rotation === 90, `zoom ${c4.zoom} rot ${c4.rotation}`);
    await page.keyboard.press('Escape');
    const st = await page.evaluate(() => ({ active: CR.cropper.active, crop: CR.cropper.crop, log: CR.log.map(e => e[0]) }));
    expect(E, 'Escape cancels and restores the start crop', !st.active && st.log.at(-1) === 'cancel'
      && st.crop.x === 0.5 && st.crop.rotation === 0, JSON.stringify(st.crop));
    await page.evaluate(() => { CR.log.length = 0; CR.cropper.enter(); });
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    const st2 = await page.evaluate(() => ({ active: CR.cropper.active, last: CR.log.at(-1) }));
    expect(E, 'Enter commits (changed)', !st2.active && st2.last[0] === 'commit' && st2.last[2] === true, JSON.stringify(st2.last));
    // Done / Cancel buttons and Fit
    await page.evaluate(() => { CR.cropper.enter({ x: 0.3, y: 0.7, zoom: 2, rotation: 30 }); });
    await page.click('[data-act="fit"]');
    const cf = await crop();
    const zf = Math.abs(Math.cos(Math.PI / 6)) + Math.abs(Math.sin(Math.PI / 6));
    expect(E, 'Fit centres the largest square at 30 deg', cf.x === 0.5 && cf.y === 0.5 && near(cf.zoom, zf, 1e-4) && cf.rotation === 30,
      JSON.stringify(cf));
    await page.click('[data-act="done"]');
    const st3 = await page.evaluate(() => ({ active: CR.cropper.active, last: CR.log.at(-1) }));
    expect(E, 'Done button commits', !st3.active && st3.last[0] === 'commit');
  }

  if (SHOTS) {
    // dark theme, fresh load
    await page.goto('http://localhost:8860/dev/crop.html?photo=pet&crop=0.5,0.45,1.4,0&theme=dark');
    await page.waitForFunction(() => window.__done, null, { timeout: 60000 });
    await page.screenshot({ path: `shots/crop_${E}_dark.png` });
  }
  expect(E, 'no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

console.log(`\n${results.length - failures} / ${results.length} passed`);
process.exit(failures ? 1 : 0);

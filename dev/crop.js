// Crop frame lab: js/crop.js in a phone-sized host, with the frame's own pixels next to the art the
// converter makes from the same crop, and a numeric check that the two agree (tone.js semantics).
import { createCropper } from '../js/crop.js';
import { createConverter } from '../js/convert.js';
import { sampleImage } from '../js/tone.js';
import { drawGrid } from '../js/raster.js';
import { loadSample, SAMPLES } from '../js/samples.js';

const q = new URLSearchParams(location.search);
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme');
const $ = id => document.getElementById(id);

async function loadPhoto(name) {
  if (SAMPLES.some(s => s.id === name)) return loadSample(name);
  // an <img> applies EXIF orientation in every engine; bake it into a canvas
  const img = new Image();
  img.src = '/tests/fixtures/' + name;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

const photo = await loadPhoto(q.get('photo') || 'pet');
const [cx, cy, cz, cr] = (q.get('crop') || '0.5,0.5,1,0').split(',').map(Number);
const log = [];
const conv = createConverter();
conv.setSource(photo);

const cropper = createCropper({
  host: $('host'),
  image: photo,
  crop: { x: cx, y: cy, zoom: cz, rotation: cr },
  buttons: q.get('buttons') !== '0',
  onChange: (c, info) => { log.push(['change', c, info.live]); show(c); },
  onCommit: (c, info) => { log.push(['commit', c, info.changed]); show(c); },
  onCancel: c => { log.push(['cancel', c]); show(c); },
});

// behind the cropper: a way back in after Done / Cancel
const again = document.createElement('button');
again.textContent = 'Crop again';
again.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);height:44px;padding:0 18px;'
  + 'border-radius:10px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font:600 14px var(--sans)';
again.addEventListener('click', () => cropper.enter());
$('host').prepend(again);

let artT = 0;
function show(c) {
  $('vals').innerHTML = `x <b>${c.x.toFixed(3)}</b> · y <b>${c.y.toFixed(3)}</b> · zoom <b>${c.zoom.toFixed(2)}</b> · <b>${c.rotation}°</b>`;
  cancelAnimationFrame(artT);
  artT = requestAnimationFrame(() => { art(c); copyFrame(); });
}

/** The converter's Braille grid for crop `c`, drawn as exact dots in a square. */
function art(c = cropper.crop) {
  const cv = $('art'), g = cv.getContext('2d');
  const grid = conv.run(c, { mode: 'braille', cols: 40 });
  const cw = cv.width / grid.cols, ch = cv.height / grid.rows;
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  drawGrid(g, grid, { cellW: cw, cellH: ch, ink: '#17171a', dotR: 0.36 });
  return grid;
}

/** The frame's pixels from the cropper canvas (device px). */
function framePixels() {
  const f = cropper.frame(), d = f.dpr;
  const X = Math.round(f.x * d), Y = Math.round(f.y * d), S = Math.round(f.size * d);
  return { X, Y, S, canvas: cropper.canvas };
}
function copyFrame() {
  const { X, Y, S, canvas } = framePixels();
  const g = $('frameCopy').getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, X, Y, S, S, 0, 0, 340, 340);
}

/**
 * Numeric agreement: the frame's pixels area-averaged to N x N Rec. 709 luma vs
 * tone.js sampleImage(photo, crop, N, N).L. Returns { mad, corr, max }.
 */
function check(N = 24) {
  const c = cropper.crop;
  const { X, Y, S, canvas } = framePixels();
  const data = canvas.getContext('2d').getImageData(X, Y, S, S).data;
  const sum = new Float64Array(N * N), cnt = new Float64Array(N * N);
  for (let y = 0; y < S; y++) {
    const gy = Math.min(N - 1, Math.floor(y * N / S));
    for (let x = 0; x < S; x++) {
      const gx = Math.min(N - 1, Math.floor(x * N / S)), p = (y * S + x) * 4;
      sum[gy * N + gx] += (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
      cnt[gy * N + gx]++;
    }
  }
  const A = Array.from(sum, (s, i) => s / cnt[i]);
  const B = Array.from(sampleImage(photo, c, N, N).L);
  let mad = 0, max = 0, ma = 0, mb = 0;
  for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i] - B[i]); mad += d; max = Math.max(max, d); ma += A[i]; mb += B[i]; }
  mad /= A.length; ma /= A.length; mb /= A.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < A.length; i++) { sab += (A[i] - ma) * (B[i] - mb); saa += (A[i] - ma) ** 2; sbb += (B[i] - mb) ** 2; }
  const corr = saa && sbb ? sab / Math.sqrt(saa * sbb) : (mad < 0.01 ? 1 : 0);
  const r = { crop: c, N, mad: +mad.toFixed(4), max: +max.toFixed(4), corr: +corr.toFixed(4) };
  r.ok = r.mad < 0.035 && r.corr > 0.97;
  $('check').textContent = `frame vs sampler: MAD ${r.mad.toFixed(3)} · r ${r.corr.toFixed(3)}`;
  $('check').className = r.ok ? 'ok' : '';
  return r;
}

const nextFrame = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
window.CR = { cropper, photo, log, check, art, nextFrame, size: [photo.width, photo.height] };

cropper.enter();
await nextFrame();
show(cropper.crop);
await nextFrame();
const first = check();

if (q.get('shot')) {
  await nextFrame();
  const c = cropper.canvas;
  await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: q.get('shot'), data: c.toDataURL('image/png') }) });
}
window.__done = { ok: first.ok, check: first };

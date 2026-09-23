// node dev/var-detail-bench.mjs : toneVariant cost on a 120 x 88 dot grid (synthetic face-like image),
// plus determinism (two runs give identical output) and the toneGrid baseline for comparison.
import { toneVariant, ditherVariant } from './var-detail-tone.js';
import { toneGrid } from '../js/tone.js';

const W = 120, H = 88, N = W * H;
const L = new Float32Array(N);
for (let y = 0, i = 0; y < H; y++) {
  for (let x = 0; x < W; x++, i++) {
    const dx = (x - W / 2) / 30, dy = (y - H / 2) / 36;
    const face = dx * dx + dy * dy < 1 ? 0.75 - 0.2 * dx : 0.35;
    const eye = ((x - 50) ** 2 + (y - 36) ** 2 < 9 || (x - 70) ** 2 + (y - 36) ** 2 < 9) ? -0.4 : 0;
    L[i] = Math.max(0, Math.min(1, face + eye + 0.03 * Math.sin(x * 1.7 + y * 2.3)));
  }
}
const img = { W, H, L, A: null };
const time = (f, n = 200) => {
  for (let k = 0; k < 20; k++) f();
  const t0 = performance.now();
  for (let k = 0; k < n; k++) f();
  return (performance.now() - t0) / n;
};
const a = toneVariant(img, {}, { target: 0.4, boost: 0 });
const b = toneVariant(img, {}, { target: 0.4, boost: 0 });
let same = a.length === b.length;
for (let i = 0; i < N && same; i++) same = a[i] === b[i];
const inv = toneVariant(img, { invert: true }, { target: 0.4 });
let finite = true;
for (let i = 0; i < N; i++) if (!(inv[i] >= 0 && inv[i] <= 1) || !(a[i] >= 0 && a[i] <= 1)) finite = false;
console.log(JSON.stringify({
  grid: `${W}x${H}`,
  toneVariantMs: +time(() => toneVariant(img, {}, { target: 0.4 })).toFixed(3),
  ditherVariantMs: +time(() => ditherVariant(a, W, H, { edge: a.edge })).toFixed(3),
  toneGridMs: +time(() => toneGrid(img, {}, { target: 0.4 })).toFixed(3),
  deterministic: same, inRange: finite, stats: a.stats,
}));

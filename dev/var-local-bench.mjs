// node dev/var-local-bench.mjs  -> toneVariant vs toneGrid timings on a 120 x 88 dot grid, plus
// determinism and contract checks (length, range, .edge, .stats, invert, NaN-proof sliders).
import { toneGrid, TONE_DEFAULTS } from '../js/tone.js';
import { toneVariant } from './var-local-tone.js';

const W = 120, H = 88, N = W * H;
// a synthetic photo: dark backdrop, a bright disc "face" with faint features, a striped patch
const L = new Float32Array(N);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - 60) / 30, dy = (y - 44) / 34;
    let v = 0.15 + 0.1 * x / W;
    if (dx * dx + dy * dy < 1) v = 0.85 - (Math.abs(dy + 0.25) < 0.06 && Math.abs(Math.abs(dx) - 0.35) < 0.12 ? 0.08 : 0);
    if (x < 25 && y > 50) v = 0.3 + 0.06 * Math.sin(x * 1.3);
    L[y * W + x] = v;
  }
}
const img = { W, H, L, A: null };

function bench(fn, n = 300) {
  for (let i = 0; i < 50; i++) fn();
  const t = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  return { median: +t[n >> 1].toFixed(3), p95: +t[Math.floor(n * 0.95)].toFixed(3) };
}

const tone = { ...TONE_DEFAULTS };
const res = {
  grid: `${W}x${H}`,
  toneVariant: bench(() => toneVariant(img, tone, { target: 0.4, boost: 0 })),
  toneVariantInvert: bench(() => toneVariant(img, { ...tone, invert: true }, { target: 0.4, boost: 0.4 })),
  toneGrid: bench(() => toneGrid(img, tone, { target: 0.4, boost: 0 })),
};

let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL ' + msg); } };
const a = toneVariant(img, tone, { target: 0.4 }), b = toneVariant(img, tone, { target: 0.4 });
check(a.length === N, 'length');
check(a.every((v, i) => v === b[i]), 'deterministic');
check(a.every(v => v >= 0 && v <= 1), 'range 0..1');
check(a.edge && a.edge.mag.length === N && a.stats && Number.isFinite(a.stats.gamma), 'edge + stats');
const inv = toneVariant(img, { ...tone, invert: true }, { target: 0.4 });
check(inv[60 + 44 * W] < 0.5, 'invert: the bright disc becomes ink');
const nan = toneVariant(img, { ...tone, gamma: NaN, detail: 'x', contrast: -5 }, { target: 0.4 });
check(nan.every(v => Number.isFinite(v)), 'NaN sliders');
const tiny = toneVariant({ W: 2, H: 4, L: new Float32Array(8).fill(0.5), A: null }, tone, { target: 0.4 });
check(tiny.every(v => Number.isFinite(v)), 'tiny grid');
const flat = toneVariant({ W: 32, H: 36, L: new Float32Array(32 * 36).fill(0.97), A: null }, tone, { target: 0.4 });
check(flat.every(v => Number.isFinite(v)), 'flat grid');
res.checks = { total: 7, failed: fail };
console.log(JSON.stringify(res));
process.exit(fail ? 1 : 0);

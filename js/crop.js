// The square crop frame (the Crop screen): the whole photo, dimmed, with a fixed square cut out of
// it. One finger / the mouse moves the photo under the frame, two fingers pinch-zoom and turn it,
// the wheel zooms at the cursor. Lifted from Spiralist's framing code (app.js) into a module.
//
// Crop semantics are exactly js/tone.js sampling, so the frame shows what the art is made from:
//   crop.x, crop.y   frame centre in normalised image coords (clamped -0.5..1.5)
//   crop.zoom        1 = the frame side equals the photo's short side (0.5..6, logarithmic)
//   crop.rotation    clockwise degrees, [-180, 180)
// Screen mapping (CSS px): screen = F + k * R(rotation) * (P - C), k = side * zoom / min(w, h),
// the inverse of sampleDecoded's "inverse of a clockwise rotation about the crop centre".
//
// createCropper({ host, image, crop, onChange, onCommit, onCancel, controls, buttons, fitCrop })
//   onChange(crop, { live })   every frame the crop moves (live: true while a gesture is on)
//   onCommit(crop, { changed }) Done / Enter;  onCancel(startCrop) Cancel / Escape (after an
//   onChange(startCrop) when the crop had moved, so a live preview reverts by itself)
//   controls: false hides the bottom bar; buttons: false keeps Rotate / zoom / Fit but drops
//   Cancel / Done (when the app's own action bar carries them); fitCrop(image, crop) -> crop
//   replaces the default Fit (largest centred square on the photo at the current rotation).
// While active, the keys it handles are consumed in the window capture phase (preventDefault +
// stopImmediatePropagation), so app shortcuts do not fire underneath.
import { CROP_DEFAULTS } from './tone.js';
import { announce, paintRange } from './ui.js';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 6;
const PAN_MIN = -0.5, PAN_MAX = 1.5;
const SNAPS = [-180, -90, 0, 90, 180];
const SNAP_DEG = 4;
const DIM = 0.32;
const PAPER = '#ffffff';   // the sampler composites off-photo parts over white paper

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const normDeg = d => ((((d + 180) % 360) + 360) % 360) - 180;
const cosSin = deg => { const r = deg * Math.PI / 180; return [Math.cos(r), Math.sin(r)]; };
export const zoomToSlider = z => Math.round(Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN) * 1000);
export const sliderToZoom = v => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 1000);

/** A valid crop from anything (missing fields take CROP_DEFAULTS, NaN is dropped). */
export function cleanCrop(c) {
  const d = CROP_DEFAULTS, n = (v, def) => (Number.isFinite(+v) ? +v : def);
  const o = c || {};
  return {
    x: clamp(n(o.x, d.x), PAN_MIN, PAN_MAX),
    y: clamp(n(o.y, d.y), PAN_MIN, PAN_MAX),
    zoom: clamp(n(o.zoom, d.zoom), ZOOM_MIN, ZOOM_MAX),
    rotation: normDeg(n(o.rotation, d.rotation)),
  };
}

/** Default Fit: the largest centred square that stays on the photo at this rotation. */
export function fitCropFor(crop) {
  const [c, s] = cosSin(crop.rotation || 0);
  // a square of side a turned by r spans a * (|cos r| + |sin r|) on both axes
  const zoom = clamp(Math.abs(c) + Math.abs(s), 1, ZOOM_MAX);
  return { x: 0.5, y: 0.5, zoom: Math.round(zoom * 1e6) / 1e6, rotation: crop.rotation || 0 };
}

const r5 = v => Math.round(v * 1e5) / 1e5;
const snapshot = c => ({ x: r5(c.x), y: r5(c.y), zoom: r5(c.zoom), rotation: Math.round(c.rotation * 100) / 100 });
const keyOf = c => { const s = snapshot(c); return `${s.x},${s.y},${s.zoom},${s.rotation}`; };

const ICON_ROTATE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>';
const ICON_FIT = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/></svg>';

const CSS = `
.ty-crop { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--desk, #e7e3dc); color: var(--text, #1c1b19); font: 13px/1.4 var(--sans, system-ui, sans-serif);
  -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
.ty-crop[hidden] { display: none; }
.ty-crop-view { position: relative; flex: 1 1 auto; min-height: 0; }
.ty-crop-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  touch-action: none; cursor: grab; outline: none; }
.ty-crop.dragging .ty-crop-canvas { cursor: grabbing; }
.ty-crop-pill { position: absolute; left: 50%; transform: translate(-50%, 0); pointer-events: none;
  padding: 5px 11px; border-radius: 999px; background: rgba(18, 18, 20, .72); color: #fff;
  font-size: 12px; font-weight: 500; letter-spacing: .01em; white-space: nowrap; font-variant-numeric: tabular-nums;
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); opacity: 0; transition: opacity .18s var(--ease, ease); }
.ty-crop-pill.on { opacity: 1; }
.ty-crop-bar { flex: none; display: flex; flex-direction: column; gap: 10px; padding: 10px 16px 12px;
  background: var(--chrome, #faf9f6); border-top: 1px solid var(--border, rgba(28, 27, 25, .1)); }
.ty-crop-tools { display: flex; align-items: center; gap: 10px; height: 40px; }
.ty-crop-ic { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 40px; min-width: 40px; padding: 0 10px; border-radius: var(--radius-ctl, 8px);
  border: 1px solid var(--border-strong, rgba(28, 27, 25, .18)); background: var(--surface, #fff);
  color: var(--text, #1c1b19); font: 500 13px/1 var(--sans, system-ui, sans-serif); cursor: pointer; }
.ty-crop-ic:hover { background: var(--surface-2, #f3f1ec); }
.ty-crop-ic:active { transform: translateY(.5px); }
.ty-crop-zoom { flex: 1 1 auto; min-width: 60px; height: 40px; margin: 0; background: transparent;
  -webkit-appearance: none; appearance: none; cursor: pointer; --fill: 0%; }
.ty-crop-zoom::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--accent, #2448c8) var(--fill), var(--border-strong, rgba(28, 27, 25, .18)) var(--fill)); }
.ty-crop-zoom::-moz-range-track { height: 4px; border-radius: 2px; background: var(--border-strong, rgba(28, 27, 25, .18)); }
.ty-crop-zoom::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--accent, #2448c8); }
.ty-crop-zoom::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; margin-top: -9px;
  border-radius: 50%; background: #fff; border: 1px solid rgba(0, 0, 0, .14); box-shadow: 0 1px 3px rgba(0, 0, 0, .28); }
.ty-crop-zoom::-moz-range-thumb { width: 22px; height: 22px; border-radius: 50%; background: #fff;
  border: 1px solid rgba(0, 0, 0, .14); box-shadow: 0 1px 3px rgba(0, 0, 0, .28); }
.ty-crop-zoom:focus-visible { outline: 2px solid var(--focus, var(--accent, #2448c8)); outline-offset: 2px; border-radius: 6px; }
.ty-crop-zlabel { flex: none; width: 42px; text-align: right; color: var(--text-muted, #6e6a63);
  font-size: 12px; font-variant-numeric: tabular-nums; }
.ty-crop-actions { display: flex; gap: 10px; }
.ty-crop-btn { height: 48px; border-radius: var(--radius-chip, 10px); font: 600 15px/1 var(--sans, system-ui, sans-serif);
  cursor: pointer; border: 1px solid var(--border-strong, rgba(28, 27, 25, .18)); background: var(--surface, #fff);
  color: var(--text, #1c1b19); padding: 0 18px; }
.ty-crop-btn.primary { flex: 1 1 auto; background: var(--accent, #2448c8); border-color: transparent;
  color: var(--accent-ink, #fff); }
.ty-crop-btn:active { transform: translateY(.5px); }
.ty-crop-bar :focus-visible { outline: 2px solid var(--focus, var(--accent, #2448c8)); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .ty-crop-pill { transition: none; } }
`;

function injectCss() {
  if (document.getElementById('ty-crop-css')) return;
  const s = document.createElement('style');
  s.id = 'ty-crop-css';
  s.textContent = CSS;
  document.head.append(s);
}

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function createCropper({
  host, image, crop: crop0, onChange, onCommit, onCancel,
  controls = true, buttons = true, fitCrop = null,
} = {}) {
  injectCss();
  let img = image || null;
  let crop = cleanCrop(crop0);
  let start = { ...crop };
  let active = false;
  let returnFocus = null;

  // ---------------------------------------------------------------------------------- DOM
  const el = document.createElement('div');
  el.className = 'ty-crop';
  el.hidden = true;
  el.innerHTML = `<div class="ty-crop-view"><canvas class="ty-crop-canvas" tabindex="0" role="application"
      aria-roledescription="crop frame"></canvas><div class="ty-crop-pill" aria-hidden="true"></div></div>` +
    (controls ? `<div class="ty-crop-bar"><div class="ty-crop-tools">
      <button type="button" class="ty-crop-ic" data-act="rotate" aria-label="Rotate 90 degrees" title="Rotate 90° (R)">${ICON_ROTATE}</button>
      <input type="range" class="ty-crop-zoom" min="0" max="1000" step="1" aria-label="Zoom">
      <span class="ty-crop-zlabel" aria-hidden="true"></span>
      <button type="button" class="ty-crop-ic" data-act="fit" title="Fit the photo (double-click)">${ICON_FIT}<span>Fit</span></button>
    </div>` + (buttons ? `<div class="ty-crop-actions">
      <button type="button" class="ty-crop-btn" data-act="cancel">Cancel</button>
      <button type="button" class="ty-crop-btn primary" data-act="done">Done</button>
    </div>` : '') + '</div>' : '');
  const view = el.querySelector('.ty-crop-view');
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const pill = el.querySelector('.ty-crop-pill');
  const zoomIn = el.querySelector('.ty-crop-zoom');
  const zLabel = el.querySelector('.ty-crop-zlabel');
  canvas.setAttribute('aria-label', 'Crop frame. Drag to move the photo, pinch or scroll to zoom, turn with two '
    + 'fingers. Arrow keys move, plus and minus zoom, R rotates, Enter applies, Escape cancels.');
  if (host) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.append(el);
  }

  // ----------------------------------------------------------------------------- geometry
  const src = () => (img && img.canvas) || img;
  const imgW = () => { const s = src(); return (s && (s.naturalWidth || s.width)) || 1; };
  const imgH = () => { const s = src(); return (s && (s.naturalHeight || s.height)) || 1; };

  /** The frame in CSS px relative to the canvas, snapped to device pixels. */
  function frame() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const pad = W < 480 ? 16 : 24;
    const side = Math.max(24, Math.floor(Math.min(W - 2 * pad, H - 2 * pad) * dpr) / dpr);
    const x = Math.round((W - side) / 2 * dpr) / dpr;
    const y = Math.round((H - side) / 2 * dpr) / dpr;
    return { x, y, size: side, cx: x + side / 2, cy: y + side / 2, W, H, dpr };
  }
  const scale = f => f.size * crop.zoom / Math.min(imgW(), imgH());   // screen px per photo px

  /** Offset of a client point from the frame centre (CSS px). */
  function fromCentre(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), f = frame();
    return [clientX - r.left - f.cx, clientY - r.top - f.cy];
  }

  /** Move the photo by a screen offset (the photo point under a finger stays under it). */
  function pan(dx, dy) {
    const k = scale(frame());
    const [c, s] = cosSin(crop.rotation);
    // R(-rotation) * (dx, dy) / k in photo px
    const ix = (dx * c + dy * s) / k, iy = (-dx * s + dy * c) / k;
    crop.x = clamp(crop.x - ix / imgW(), PAN_MIN, PAN_MAX);
    crop.y = clamp(crop.y - iy / imgH(), PAN_MIN, PAN_MAX);
  }

  /** Zoom by a factor keeping the photo point at `anchor` (offset from the frame centre) fixed. */
  function zoomBy(factor, ax = 0, ay = 0) {
    const z0 = crop.zoom, z1 = clamp(z0 * factor, ZOOM_MIN, ZOOM_MAX);
    if (z1 === z0) return;
    const s = 1 - z0 / z1;
    pan(-ax * s, -ay * s);
    crop.zoom = z1;
  }

  // Two-finger (or trackpad) similarity: the photo point under m0 lands under m1, scaled by
  // `factor` and turned by dDeg. Rotation accumulates raw so the snap cannot swallow slow turns.
  let gesture = null;
  function similarity(m0, m1, factor, dDeg) {
    const f = frame(), k0 = scale(f), W = imgW(), H = imgH();
    const [c0, s0] = cosSin(crop.rotation);
    const px = crop.x * W + (m0[0] * c0 + m0[1] * s0) / k0;
    const py = crop.y * H + (-m0[0] * s0 + m0[1] * c0) / k0;
    crop.zoom = clamp(crop.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (!gesture) gesture = { raw: crop.rotation, snapped: null };
    gesture.raw += dDeg;
    let rot = normDeg(gesture.raw), snapped = null;
    for (const t of SNAPS) if (Math.abs(rot - t) < SNAP_DEG) { snapped = t; rot = normDeg(t); }
    if (snapped !== null && gesture.snapped === null && dDeg) buzz();
    gesture.snapped = snapped;
    crop.rotation = rot;
    const k1 = scale(f);
    const [c1, s1] = cosSin(rot);
    crop.x = clamp((px - (m1[0] * c1 + m1[1] * s1) / k1) / W, PAN_MIN, PAN_MAX);
    crop.y = clamp((py - (-m1[0] * s1 + m1[1] * c1) / k1) / H, PAN_MIN, PAN_MAX);
  }
  function buzz() { try { navigator.vibrate?.(8); } catch { /* not allowed: fine */ } }

  // ------------------------------------------------------------------------------ drawing
  let raf = 0, pendingLive = false, lastKey = keyOf(crop), lastLive = false, guidesUntil = 0, guideT = 0;
  let dragging = false;

  function update(live = dragging) {
    pendingLive = live;
    if (!raf) raf = requestAnimationFrame(frameTick);
  }
  function frameTick() {
    raf = 0;
    draw();
    syncSlider();
    const k = keyOf(crop);
    if (k !== lastKey || (lastLive && !pendingLive)) {
      lastKey = k; lastLive = pendingLive;
      if (onChange) onChange(snapshot(crop), { live: pendingLive });
    }
  }

  function draw() {
    const f = frame();
    const bw = Math.round(f.W * f.dpr), bh = Math.round(f.H * f.dpr);
    if (!bw || !bh) return;
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    const d = f.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    if (!src()) return;
    // device-pixel frame rect (integers: crisp edges at any DPR)
    const X = Math.round(f.x * d), Y = Math.round(f.y * d), S = Math.round(f.size * d);

    // the whole photo, faint, with the frame cut out (even-odd)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, bw, bh);
    ctx.rect(X, Y, S, S);
    ctx.clip('evenodd');
    ctx.globalAlpha = DIM;
    drawPhoto(f);
    ctx.restore();

    // inside: paper, then the photo at full strength (what the sampler sees)
    ctx.save();
    ctx.beginPath();
    ctx.rect(X, Y, S, S);
    ctx.clip();
    ctx.fillStyle = PAPER;
    ctx.fillRect(X, Y, S, S);
    drawPhoto(f);
    ctx.restore();

    // rule-of-thirds guides while a gesture is on
    if (dragging || performance.now() < guidesUntil) {
      ctx.save();
      const line = (x0, y0, x1, y1) => { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); };
      for (const [style, off] of [['rgba(0,0,0,.28)', 1], ['rgba(255,255,255,.72)', 0]]) {
        ctx.beginPath();
        for (const t of [1, 2]) {
          const gx = X + Math.round(S * t / 3) + 0.5 + off, gy = Y + Math.round(S * t / 3) + 0.5 + off;
          line(gx, Y, gx, Y + S); line(X, gy, X + S, gy);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = style;
        ctx.stroke();
      }
      ctx.restore();
    }

    // crisp 1 px outline in the accent, just outside the frame so it never covers the photo
    const lw = Math.max(1, Math.round(d));
    const col = accent();
    ctx.lineWidth = lw;
    ctx.strokeStyle = col;
    ctx.strokeRect(X - lw / 2, Y - lw / 2, S + lw, S + lw);
    // keyboard focus: a soft 2 px ring around the frame (not around the whole surface)
    if (focusVisible()) {
      const fw = 2 * lw, o = 3 * lw + fw / 2;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = fw;
      ctx.strokeRect(X - o, Y - o, S + 2 * o, S + 2 * o);
      ctx.globalAlpha = 1;
    }
  }
  function focusVisible() {
    try { return canvas.matches(':focus-visible'); } catch { return document.activeElement === canvas; }
  }

  function drawPhoto(f) {
    const d = f.dpr, k = scale(f);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.translate(f.cx, f.cy);
    ctx.scale(k, k);
    ctx.rotate(crop.rotation * Math.PI / 180);
    ctx.translate(-crop.x * imgW(), -crop.y * imgH());
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src(), 0, 0);
  }

  function accent() {
    const v = getComputedStyle(el).getPropertyValue('--accent').trim();
    return v || '#2448c8';
  }

  // --------------------------------------------------------------------------- readouts
  let pillT = 0, hintOn = false;
  function showPill(text, ms) {
    pill.textContent = text;
    pill.classList.add('on');
    const f = frame();
    pill.style.top = `${Math.round(f.y + 12)}px`;
    clearTimeout(pillT);
    if (ms) pillT = setTimeout(() => { pill.classList.remove('on'); hintOn = false; }, ms);
  }
  function readout() {
    hintOn = false;
    showPill(`${crop.zoom.toFixed(2)}×  ·  ${fmtDeg(crop.rotation)}`, 900);
  }
  const fmtDeg = r => `${Math.round(r * 10) / 10 === -180 ? 180 : Math.round(r * 10) / 10}°`;
  function hint() {
    hintOn = true;
    showPill(coarse() ? 'Drag to move · pinch to zoom or turn' : 'Drag to move · scroll to zoom', 3600);
  }
  function dropHint() { if (hintOn) { clearTimeout(pillT); pill.classList.remove('on'); hintOn = false; } }

  function syncSlider() {
    if (!zoomIn) return;
    if (document.activeElement !== zoomIn) zoomIn.value = zoomToSlider(crop.zoom);
    paintRange(zoomIn);
    zoomIn.setAttribute('aria-valuetext', `${crop.zoom.toFixed(1)} times`);
    zLabel.textContent = `${crop.zoom.toFixed(1)}×`;
  }

  // ----------------------------------------------------------------------------- pointers
  const ptrs = new Map();
  function onDown(e) {
    if (!active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or stale id */ }
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    gesture = null;   // a new finger starts a new two-finger gesture
    dragging = true;
    el.classList.add('dragging');
    dropHint();
    update(true);
  }
  function onMove(e) {
    if (!active || !ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId), cur = [e.clientX, e.clientY];
    if (ptrs.size === 1) {
      pan(cur[0] - prev[0], cur[1] - prev[1]);
    } else {
      let other = null;
      for (const [id, p] of ptrs) if (id !== e.pointerId) { other = p; break; }
      const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
      const d1 = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
      const a0 = Math.atan2(prev[1] - other[1], prev[0] - other[0]);
      const a1 = Math.atan2(cur[1] - other[1], cur[0] - other[0]);
      const m0 = fromCentre((prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2);
      const m1 = fromCentre((cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2);
      const factor = d0 > 4 && d1 > 4 ? d1 / d0 : 1;
      similarity(m0, m1, factor, normDeg((a1 - a0) * 180 / Math.PI));
      readout();
    }
    ptrs.set(e.pointerId, cur);
    update(true);
  }
  function onUp(e) {
    if (!ptrs.delete(e.pointerId)) return;
    gesture = null;
    if (!ptrs.size) {
      dragging = false;
      el.classList.remove('dragging');
      update(false);
    }
  }
  function onWheel(e) {
    if (!active) return;
    e.preventDefault();
    dropHint();
    // trackpad pinch arrives as ctrl + wheel in small pixel steps; lines / pages are coarse
    const k = e.ctrlKey ? 0.01 : [0.0015, 0.05, 0.5][e.deltaMode] ?? 0.0015;
    const [ax, ay] = fromCentre(e.clientX, e.clientY);
    zoomBy(Math.exp(-e.deltaY * k), ax, ay);
    guides(700);
    readout();
    update(true);
    clearTimeout(onWheel.t);
    onWheel.t = setTimeout(() => update(false), 180);
  }
  function guides(ms) {
    guidesUntil = performance.now() + ms;
    clearTimeout(guideT);
    guideT = setTimeout(() => update(), ms + 20);
  }
  // Safari's trackpad pinch / rotate (iOS touch goes through pointer events, hence the ptrs guard)
  let gs = null;
  function onGesture(e) {
    if (!active) return;
    e.preventDefault();
    if (ptrs.size) return;
    if (e.type === 'gesturestart') { gs = { scale: 1, rotation: 0 }; gesture = null; return; }
    if (!gs) return;
    if (e.type === 'gestureend') { gs = null; gesture = null; update(false); return; }
    const m = fromCentre(e.clientX, e.clientY);
    similarity(m, m, e.scale / gs.scale, e.rotation - gs.rotation);
    gs = { scale: e.scale, rotation: e.rotation };
    guides(700);
    readout();
    update(true);
  }

  // ----------------------------------------------------------------------------- keyboard
  function onKey(e) {
    if (!active || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target, k = e.key;
    // keys a focused control owns itself
    if (t && t !== canvas && el.contains(t)) {
      if (t.tagName === 'BUTTON' && (k === 'Enter' || k === ' ')) return;
      if (t === zoomIn && /^(Arrow|Home|End|Page)/.test(k)) return;
    } else if (t && t !== document.body && !el.contains(t)
      && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      return;
    }
    const f = frame();
    let handled = true;
    if (k === 'Enter') exit(true);
    else if (k === 'Escape') exit(false);
    else if (k.startsWith('Arrow')) {
      const step = (e.shiftKey ? 0.1 : 0.02) * f.size;
      // arrows move the frame over the photo (the photo goes the other way)
      pan(k === 'ArrowLeft' ? step : k === 'ArrowRight' ? -step : 0, k === 'ArrowUp' ? step : k === 'ArrowDown' ? -step : 0);
      guides(600);
      update(false);
    } else if (k === '+' || k === '=') { zoomBy(1.1); readout(); update(false); sayZoom(); }
    else if (k === '-' || k === '_') { zoomBy(1 / 1.1); readout(); update(false); sayZoom(); }
    else if (k === 'r' || k === 'R') rotate90();
    else if (k === '0') fit();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); dropHint(); }
  }
  let sayT = 0;
  function sayZoom() { clearTimeout(sayT); sayT = setTimeout(() => announce(`Zoom ${crop.zoom.toFixed(1)} times`), 400); }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', e => { if (active) { e.preventDefault(); fit(); } });
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) view.addEventListener(t, onGesture);
  // no context menu / image drag on a long press
  canvas.addEventListener('contextmenu', e => { if (active) e.preventDefault(); });
  canvas.addEventListener('focus', () => { if (active) update(); });
  canvas.addEventListener('blur', () => { if (active) update(); });

  if (controls) {
    el.querySelector('.ty-crop-bar').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'rotate') rotate90();
      else if (act === 'fit') fit();
      else if (act === 'cancel') exit(false);
      else if (act === 'done') exit(true);
    });
    zoomIn.addEventListener('input', () => {
      crop.zoom = clamp(sliderToZoom(+zoomIn.value), ZOOM_MIN, ZOOM_MAX);
      guides(500);
      update(true);
    });
    zoomIn.addEventListener('change', () => update(false));
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (active) update(); }) : null;
  ro?.observe(view);
  // theme flips change --accent: repaint
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const repaint = () => { if (active) update(); };
  mq.addEventListener?.('change', repaint);
  const mo = new MutationObserver(repaint);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  // --------------------------------------------------------------------------------- API
  function enter(c) {
    if (c) crop = cleanCrop(c);
    if (active) { start = { ...crop }; update(false); return; }
    active = true;
    start = { ...crop };
    lastKey = keyOf(crop); lastLive = false;
    returnFocus = document.activeElement;
    el.hidden = false;
    window.addEventListener('keydown', onKey, true);
    draw();
    syncSlider();
    hint();
    canvas.focus({ preventScroll: true });
    announce('Crop. Drag to move the photo, pinch or scroll to zoom. Enter to apply, Escape to cancel.');
  }

  function exit(apply = true) {
    if (!active) return;
    active = false;
    ptrs.clear(); gesture = null; dragging = false;
    el.classList.remove('dragging');
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(raf); raf = 0;
    clearTimeout(pillT); clearTimeout(guideT); clearTimeout(onWheel.t);
    pill.classList.remove('on');
    el.hidden = true;
    if (apply) {
      const out = snapshot(crop);
      if (onCommit) onCommit(out, { changed: keyOf(out) !== keyOf(start) });
    } else {
      const moved = keyOf(crop) !== keyOf(start);
      crop = { ...start };
      lastKey = keyOf(crop);
      if (moved && onChange) onChange(snapshot(crop), { live: false });
      if (onCancel) onCancel(snapshot(crop));
    }
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  function setImage(image2, c) {
    img = image2 || null;
    crop = cleanCrop(c);
    if (active) start = { ...crop };
    // a new photo / crop from outside: no leftover guides or readout from the last gesture
    guidesUntil = 0;
    clearTimeout(pillT);
    pill.classList.remove('on');
    hintOn = false;
    update(false);
  }

  function rotate90() {
    crop.rotation = normDeg(crop.rotation + 90);
    showPill(fmtDeg(crop.rotation), 900);
    announce(`Rotated to ${fmtDeg(crop.rotation).replace('°', ' degrees')}`);
    update(false);
  }

  function fit() {
    const next = fitCrop ? fitCrop(img, snapshot(crop)) : fitCropFor(crop);
    crop = cleanCrop({ ...crop, ...next });
    showPill('Fit', 700);
    update(false);
  }

  function destroy() {
    if (active) exit(false);
    ro?.disconnect();
    mo.disconnect();
    mq.removeEventListener?.('change', repaint);
    el.remove();
  }

  return {
    enter, exit, setImage, rotate90, fit, destroy, el,
    get crop() { return snapshot(crop); },
    get active() { return active; },
    /** The frame in CSS px relative to the canvas (tests, the app's own overlays). */
    frame, canvas,
  };
}

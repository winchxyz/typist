// Video encoding for the timelapse.
//
//   webcodecs  VideoEncoder H.264 -> MP4 through the vendored mp4-muxer (moov before mdat, so
//              the file starts playing before it is fully downloaded / shared). Frames are pulled
//              from `drawFrame` as fast as the encoder takes them; nothing depends on
//              requestAnimationFrame, so an export keeps going in a background tab.
//   recorder   MediaRecorder fallback: plays the frames in real time into canvas.captureStream(),
//              paced by the wall clock and paused while the tab is hidden (background timers are
//              throttled to 1 s, which would freeze the picture into the recording). Chrome and
//              Firefox write WebM without a Duration, which makes the file unseekable in most
//              players, so it is patched in afterwards.
//
// Every failure is an Error with .code: 'unsupported' | 'aborted' | 'encode'.
// Extra option: keyFrames (frame indices that must start a clean picture, e.g. where the film's
// camera comes to rest); the recorder cannot force keyframes and ignores it.
// onProgress(done, total, canvas) counts up; onProgress(0, total, null) means the export started
// over (hardware encoder failed -> software, or WebCodecs -> real-time recorder).

const KEYFRAME_SECONDS = 2;
const MAX_QUEUE = 4;                 // frames waiting inside the encoder before we stop feeding it
const STALL_MS = 20000;              // an encoder that makes no progress this long has hung
const AVC_PROFILES = ['6400', '4D00', '42E0'];   // High, Main, Constrained Baseline
const RECORDER_TYPES = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
const MIN_PUSH_GAP_MS = 20;          // recorder: at least one 60 Hz capture tick between frames
const MAX_RECORDER_PX = 3840 * 2160; // recorder: largest frame real-time capture keeps up with

let muxerLib = null;
const loadMuxer = () => (muxerLib ||= import('../vendor/mp4-muxer.mjs').catch(e => { muxerLib = null; throw e; }));

// ------------------------------------------------------------------------------ small helpers
function fail(code, message, cause) {
  const e = new Error(message, cause === undefined ? undefined : { cause });
  e.code = code;
  if (code === 'aborted') e.name = 'AbortError';
  return e;
}

const CODES = ['unsupported', 'aborted', 'encode'];
// Ours, not a DOMException (whose numeric .code would slip through a truthiness check).
const coded = e => !!e && CODES.includes(e.code);
const aborted = () => fail('aborted', 'Video export was cancelled');
function checkAbort(signal) { if (signal?.aborted) throw aborted(); }
const msg = e => (e && (e.message || e.name)) || String(e);

const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

// A macrotask boundary that is not a timer: timers are clamped to >= 1 s in background tabs,
// posted messages are not, so an export in a hidden tab runs at full speed.
let yieldPort = null;
const yieldQueue = [];
function yieldToLoop() {
  if (typeof MessageChannel === 'undefined') return sleep(0);
  if (!yieldPort) {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => yieldQueue.shift()?.();
    yieldPort = ch.port2;
  }
  return new Promise(r => { yieldQueue.push(r); yieldPort.postMessage(0); });
}

// Between frames: a posted-message yield, which keeps a hidden tab at full speed. Chrome paints
// between such tasks, Firefox's refresh driver barely does (UI at ~12 Hz on the heavy I420 path).
// A passive rAF heartbeat notices when the page has not painted for PAINT_GAP_MS; only then, and
// only while visible, the loop waits for the next frame to be painted (with a timeout). If the
// heartbeat has been silent for RAF_DEAD_MS, rAF is not running at all (an embedded iframe
// scrolled away or an occluded window can stop it while still 'visible') and we stop waiting.
// Costs nothing where painting already keeps up.
const PAINT_GAP_MS = 48, RAF_DEAD_MS = 500;
function paintYielder() {
  const raf = typeof requestAnimationFrame === 'function' && typeof document !== 'undefined';
  let last = performance.now(), id = 0, on = raf;
  const beat = () => { last = performance.now(); if (on) id = requestAnimationFrame(beat); };
  if (raf) id = requestAnimationFrame(beat);
  return {
    next() {
      const gap = performance.now() - last;
      if (!raf || document.visibilityState !== 'visible' || gap < PAINT_GAP_MS || gap > RAF_DEAD_MS) return yieldToLoop();
      return new Promise(resolve => {
        const t = setTimeout(resolve, 50);
        // resolve after the frame is painted, not inside the rAF callback (which precedes paint)
        requestAnimationFrame(() => { clearTimeout(t); yieldToLoop().then(resolve); });
      });
    },
    stop() { on = false; if (raf) cancelAnimationFrame(id); },
  };
}

// Resolves when `p` settles, rejects as soon as the signal aborts.
function raceAbort(p, signal) {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

function makeCanvas(width, height) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    return c;
  }
  return new OffscreenCanvas(width, height);
}

// drawFrame belongs to the caller: an error already carrying one of our codes passes through,
// anything else becomes 'encode' (with the original as .cause).
async function paint(drawFrame, i, ctx, canvas, signal) {
  try {
    await drawFrame(i, ctx, canvas);
  } catch (e) {
    if (signal?.aborted) throw aborted();
    if (coded(e)) throw e;
    throw fail('encode', `Frame ${i} could not be drawn: ${msg(e)}`, e);
  }
}

// So is onProgress, and it gets the same treatment on both paths.
function progress(onProgress, done, total, canvas) {
  if (!onProgress) return;
  try {
    onProgress(done, total, canvas);
  } catch (e) {
    if (coded(e)) throw e;
    throw fail('encode', `The progress callback failed at frame ${done}: ${msg(e)}`, e);
  }
}

// ------------------------------------------------------------------------------ bitrate & level
const BITRATE_ANCHORS = [[1080 * 1080, 8e6], [1080 * 1350, 9e6], [1080 * 1920, 12e6]];

/** Default VBR bitrate: 8 Mbps at 1080², 9 at 1080x1350, 12 at 1080x1920 (30 fps), scaled beyond. */
export function defaultBitrate(width, height, fps = 30) {
  const px = width * height, A = BITRATE_ANCHORS;
  let b;
  if (px <= A[0][0]) b = A[0][1] * Math.pow(px / A[0][0], 0.75);
  else if (px >= A[2][0]) b = A[2][1] * Math.pow(px / A[2][0], 0.75);
  else {
    const k = px < A[1][0] ? 0 : 1;
    const [p0, b0] = A[k], [p1, b1] = A[k + 1];
    b = b0 + (b1 - b0) * (px - p0) / (p1 - p0);
  }
  b *= Math.pow(fps / 30, 0.6);
  return Math.round(Math.min(50e6, Math.max(1e6, b)) / 1e5) * 1e5;
}

// Lowest H.264 level (4.0 at least) whose frame-size, macroblock-rate and bitrate limits fit
// (Table A-1; MaxBR as for Main, which High's 1.25x only loosens). 1080 x 1920 is 4.0 at 30 fps
// and 4.2 at 60 (8160 macroblocks x 60 = 489,600/s, over 4.0/4.1's 245,760).
const AVC_LEVELS = [   // level_idc, MaxFS (macroblocks), MaxMBPS, MaxBR (kbit/s)
  [0x28, 8192, 245760, 20000], [0x29, 8192, 245760, 50000], [0x2A, 8704, 522240, 50000],
  [0x32, 22080, 589824, 135000], [0x33, 36864, 983040, 240000], [0x34, 36864, 2073600, 240000],
  [0x3C, 139264, 4177920, 240000], [0x3D, 139264, 8355840, 480000], [0x3E, 139264, 16711680, 800000],
];
export function avcLevel(width, height, fps, bitrate = 0) {
  const mw = Math.ceil(width / 16), mh = Math.ceil(height / 16), fs = mw * mh;
  for (const [idc, maxFS, maxMBPS, maxBR] of AVC_LEVELS) {
    const maxDim = Math.sqrt(maxFS * 8);
    if (fs <= maxFS && fs * fps <= maxMBPS && mw <= maxDim && mh <= maxDim && bitrate <= maxBR * 1000) return idc;
  }
  return 0;
}

// The codec string of the stream actually written. Hardware encoders may pick their own level
// (Chrome + NVENC writes 5.0 when asked for 4.0) while decoderConfig.codec echoes the request;
// the avcC record (profile, constraints, level in bytes 1..3) is what players read.
function codecFromAvcC(desc) {
  const b = ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength) : new Uint8Array(desc);
  if (b.length < 4 || b[0] !== 1) return null;
  return 'avc1.' + [b[1], b[2], b[3]].map(x => x.toString(16).toUpperCase().padStart(2, '0')).join('');
}

// ------------------------------------------------------------------------------ H.264 details
// avcC as players need it. Firefox 150 duplicates each parameter set's NAL header byte in
// decoderConfig.description (67 67 64 .. / 68 68 ce ..) while the SPS/PPS it also sends in-band
// are right; a player that sets its decoder up from avcC alone (iOS, Android MediaCodec) could
// refuse such a file. When in-band parameter sets exist and differ, avcC is rebuilt from them.
function nalUnits(data, lengthSize = 4) {
  const out = [];
  for (let p = 0; p + lengthSize <= data.length;) {
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = len * 256 + data[p + k];
    if (!len || p + lengthSize + len > data.length) break;
    out.push(data.subarray(p + lengthSize, p + lengthSize + len));
    p += lengthSize + len;
  }
  return out;
}

function parseAvcC(desc) {
  if (!desc) return null;
  const b = ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength) : new Uint8Array(desc);
  if (b.length < 7 || b[0] !== 1) return null;
  const lengthSize = (b[4] & 3) + 1, sps = [], pps = [];
  let p = 6;
  const read = (n, list) => {
    for (let k = 0; k < n; k++) {
      if (p + 2 > b.length) return false;
      const len = (b[p] << 8) | b[p + 1];
      if (p + 2 + len > b.length) return false;
      list.push(b.subarray(p + 2, p + 2 + len));
      p += 2 + len;
    }
    return true;
  };
  if (!read(b[5] & 31, sps) || p >= b.length || !read(b[p++], pps)) return null;
  return { bytes: b, lengthSize, sps, pps };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => sameBytes(x, b[i]));

function repairAvcC(desc, keyData) {
  const parsed = parseAvcC(desc);
  const lengthSize = parsed?.lengthSize || 4;
  const nals = nalUnits(keyData, lengthSize);
  const sps = nals.filter(n => (n[0] & 31) === 7), pps = nals.filter(n => (n[0] & 31) === 8);
  if (!sps.length || !pps.length) return { desc, repaired: false };
  if (parsed && sameList(parsed.sps, sps) && sameList(parsed.pps, pps)) return { desc, repaired: false };
  const out = [1, sps[0][1], sps[0][2], sps[0][3], 0xFC | (lengthSize - 1), 0xE0 | sps.length];
  for (const s of sps) out.push(s.length >> 8, s.length & 255, ...s);
  out.push(pps.length);
  for (const s of pps) out.push(s.length >> 8, s.length & 255, ...s);
  if (sps[0][1] === 100) out.push(0xFD, 0xF8, 0xF8, 0x00);   // High: 4:2:0, 8 bit, no SPS ext
  return { desc: new Uint8Array(out), repaired: true };
}

// Firefox's encoder starts every frame with an access unit delimiter (NAL type 9). MP4 does not
// need one, and Firefox's own player then shows the frame after a keyframe when seeking to it
// (every keyframe of a 90-frame test; the same stream without delimiters seeks exactly).
function dropDelimiters(data, lengthSize = 4) {
  const nals = nalUnits(data, lengthSize);
  if (!nals.some(n => (n[0] & 31) === 9)) return data;
  if (nals.reduce((s, n) => s + lengthSize + n.length, 0) !== data.length) return data;   // not parsed whole
  const keep = nals.filter(n => (n[0] & 31) !== 9);
  const out = new Uint8Array(keep.reduce((s, n) => s + lengthSize + n.length, 0));
  let p = 0;
  for (const n of keep) {
    for (let k = lengthSize - 1, len = n.length; k >= 0; k--, len >>>= 8) out[p + k] = len & 255;
    out.set(n, p + lengthSize);
    p += lengthSize + n.length;
  }
  return out;
}

// The colr box is written from decoderConfig.colorSpace; mp4-muxer turns values outside its
// tables into 0 ("reserved"), so anything unknown becomes BT.709 limited range, which is what a
// correct encoder makes of sRGB canvas pixels (and what the I420 path below produces).
const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
function cleanColorSpace(cs) {
  const ok = cs && ['bt709', 'bt470bg', 'smpte170m'].includes(cs.primaries) &&
    ['bt709', 'smpte170m', 'iec61966-2-1'].includes(cs.transfer) &&
    ['bt709', 'bt470bg', 'smpte170m'].includes(cs.matrix);
  return ok ? { primaries: cs.primaries, transfer: cs.transfer, matrix: cs.matrix, fullRange: !!cs.fullRange } : BT709;
}

// RGBA -> I420, BT.709 limited range, 2x2 box chroma (16.16 fixed point; checked against
// Chrome's own conversion: identical Y/Cb/Cr on primaries and white).
function rgbaToI420(d, w, h, out) {
  const ySize = w * h, cw = w >> 1, ch = h >> 1, uOff = ySize, vOff = ySize + cw * ch;
  for (let i = 0, o = 0; i < ySize; i++, o += 4) {
    out[i] = (11966 * d[o] + 40254 * d[o + 1] + 4064 * d[o + 2] + 1081344) >> 16;
  }
  for (let y = 0; y < ch; y++) {
    let o = 8 * y * w, o2 = o + 4 * w, q = y * cw;
    for (let x = 0; x < cw; x++, o += 8, o2 += 8, q++) {
      const R = d[o] + d[o + 4] + d[o2] + d[o2 + 4];
      const G = d[o + 1] + d[o + 5] + d[o2 + 1] + d[o2 + 5];
      const B = d[o + 2] + d[o + 6] + d[o2 + 2] + d[o2 + 6];
      out[uOff + q] = (-6596 * R - 22189 * G + 28785 * B + 33685504) >> 18;
      out[vOff + q] = (28785 * R - 26145 * G - 2639 * B + 33685504) >> 18;
    }
  }
  return out;
}

const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

// Does this encoder turn canvas RGB into YUV with the matrix it declares? Firefox 150 converts
// with BT.601 but tags BT.709 (green comes back 40 levels too dark in every player). One frame of
// primaries is encoded, decoded as a player would (BT.709) and compared. Cached per config; any
// failure to measure means "trust the browser".
const CAL_COLOURS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
const calibrations = new Map();
function colourCheck(config, acceleration) {
  const key = `${config.codec}|${acceleration}|${config.width}x${config.height}`;
  if (!calibrations.has(key)) calibrations.set(key, measureColour(config, acceleration).catch(() => null));
  return calibrations.get(key);
}

async function measureColour(config, acceleration) {
  if (typeof VideoDecoder === 'undefined') return null;
  const { width: W, height: H } = config;
  const c = makeCanvas(W, H), g = c.getContext('2d', { alpha: false });
  CAL_COLOURS.forEach((rgb, k) => {
    g.fillStyle = `rgb(${rgb})`;
    g.fillRect(Math.round(k * W / 4), 0, Math.ceil(W / 4), H);
  });
  const chunks = [];
  let dcfg = null, err = null, frame = null;
  const enc = new VideoEncoder({ output: (ch, m) => { chunks.push(ch); if (m?.decoderConfig) dcfg = m.decoderConfig; }, error: e => { err = e; } });
  try {
    enc.configure({ ...config, hardwareAcceleration: acceleration });
    const f = new VideoFrame(c, { timestamp: 0, duration: 33333 });
    enc.encode(f, { keyFrame: true });
    f.close();
    await within(enc.flush(), 5000, 'calibration encode');
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
  if (err || !chunks.length || !dcfg) return null;
  const data = new Uint8Array(chunks[0].byteLength);
  chunks[0].copyTo(data);
  const dconf = { codec: dcfg.codec, codedWidth: W, codedHeight: H, colorSpace: BT709,
    description: repairAvcC(dcfg.description, data).desc };
  if (!(await VideoDecoder.isConfigSupported(dconf)).supported) return null;
  const dec = new VideoDecoder({ output: fr => { frame?.close(); frame = fr; }, error: e => { err = e; } });
  try {
    dec.configure(dconf);
    dec.decode(chunks[0]);
    await within(dec.flush(), 5000, 'calibration decode');
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
  if (err || !frame) { frame?.close(); return null; }
  const c2 = makeCanvas(W, H), g2 = c2.getContext('2d', { willReadFrequently: true });
  g2.drawImage(frame, 0, 0, W, H);
  frame.close();
  let worst = 0;
  CAL_COLOURS.forEach((rgb, k) => {
    const d = g2.getImageData(Math.round((k + 0.5) * W / 4) - 2, (H >> 1) - 2, 4, 4).data;
    for (let ch = 0; ch < 3; ch++) {
      let s = 0;
      for (let o = ch; o < d.length; o += 4) s += d[o];
      worst = Math.max(worst, Math.abs(s / 16 - rgb[ch]));
    }
  });
  return { worst: Math.round(worst), skewed: worst > 20 };
}

// ------------------------------------------------------------------------------ MP4 edit list
// A B-frame track is written the way ffmpeg writes x264 output, which Chromium, Firefox and
// ffmpeg all seek frame-exactly: decode times 0, 1, 2 ... frames, presentation times D frames
// later (D = reorder depth), and an edit list that starts the presentation at media time D.
// (Without the shift, the first B-frames force uneven decode steps; Chromium takes a sample's
// decode step as its duration and looks keyframes up by decode time, so seeks next to keyframes
// showed a neighbouring frame.) mp4-muxer writes no edit list, so one is inserted after tkhd; moov
// grows by 36 bytes and the chunk offsets into mdat (which follows moov) move with it. Movie and
// track header durations become `seconds` (what is shown), the media header the stts sum.
// Returns null for a layout it does not expect.
function addEditList(u8, shiftSeconds, seconds) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const boxes = (start, end) => {
    const out = {};
    for (let p = start; p + 8 <= end;) {
      let size = dv.getUint32(p), hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out[String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7])] ??= { at: p, end: p + size, hdr };
      p += size;
    }
    return out;
  };
  const inside = (b, ...names) => {
    for (const name of names) {
      if (!b || b.hdr !== 8) return null;
      b = boxes(b.at + 8, b.end)[name];
    }
    return b;
  };
  const moov = boxes(0, u8.length).moov, trak = inside(moov, 'trak'), mvhd = inside(moov, 'mvhd');
  const tkhd = inside(trak, 'tkhd'), mdia = inside(trak, 'mdia'), mdhd = inside(mdia, 'mdhd');
  const stbl = inside(mdia, 'minf', 'stbl'), stts = inside(stbl, 'stts');
  const stco = inside(stbl, 'stco'), co = stco || inside(stbl, 'co64');
  if (!mvhd || !tkhd || !mdhd || !stts || !co || inside(trak, 'edts')) return null;

  // version 0 / 1 full boxes: 32 / 64-bit times
  const v1 = b => u8[b.at + 8] === 1;
  const scale = b => dv.getUint32(b.at + (v1(b) ? 28 : 20));
  const setDuration = (b, at0, at1, x) => (v1(b) ? dv.setBigUint64(b.at + at1, BigInt(x)) : dv.setUint32(b.at + at0, x));
  let sum = 0;
  for (let k = 0, n = dv.getUint32(stts.at + 12); k < n; k++) sum += dv.getUint32(stts.at + 16 + k * 8) * dv.getUint32(stts.at + 20 + k * 8);
  const shown = Math.round(seconds * scale(mvhd)), shift = Math.round(shiftSeconds * scale(mdhd));
  if (!(shown > 0) || shown > 0xFFFFFFFF || !(shift > 0) || shift > 0x7FFFFFFF || sum > 0xFFFFFFFF) return null;
  const EDTS = 36, ins = tkhd.end, wide = !stco, count = dv.getUint32(co.at + 12);
  if (!wide && count && dv.getUint32(co.at + 16 + (count - 1) * 4) + EDTS > 0xFFFFFFFF) return null;
  // nothing can fail from here on
  setDuration(mvhd, 24, 32, shown);
  setDuration(tkhd, 28, 36, shown);
  setDuration(mdhd, 24, 32, sum);

  const out = new Uint8Array(u8.length + EDTS), o = new DataView(out.buffer);
  out.set(u8.subarray(0, ins));
  out.set(u8.subarray(ins), ins + EDTS);
  o.setUint32(ins, EDTS); out.set([0x65, 0x64, 0x74, 0x73], ins + 4);            // edts
  o.setUint32(ins + 8, EDTS - 8); out.set([0x65, 0x6C, 0x73, 0x74], ins + 12);   // elst, version 0
  o.setUint32(ins + 20, 1);                                                        // one entry:
  o.setUint32(ins + 24, shown); o.setInt32(ins + 28, shift); o.setUint16(ins + 32, 1);   // length, start, rate 1
  for (const b of [moov, trak]) o.setUint32(b.at, o.getUint32(b.at) + EDTS);
  for (let k = 0, at = co.at + EDTS; k < count; k++) {   // chunk offsets ascend: the last is the largest
    const q = at + 16 + k * (wide ? 8 : 4);
    if (wide) o.setBigUint64(q, o.getBigUint64(q) + BigInt(EDTS));
    else o.setUint32(q, o.getUint32(q) + EDTS);
  }
  return out;
}

// ------------------------------------------------------------------------------ probing
async function isSupported(config) {
  try { return !!(await VideoEncoder.isConfigSupported(config)).supported; } catch { return false; }
}

async function pickWebCodecs(width, height, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined' || !VideoEncoder.isConfigSupported) return null;
  const level = avcLevel(width, height, fps, bitrate);
  if (!level || width % 2 || height % 2) return null;
  const base = { width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
  // bitrateMode 'variable' is the spec default; say it explicitly, but do not let an
  // implementation that rejects the key cost us the whole path.
  for (const mode of [{ bitrateMode: 'variable' }, {}]) {
    for (const p of AVC_PROFILES) {
      const config = { codec: `avc1.${p}${level.toString(16).toUpperCase().padStart(2, '0')}`, ...base, ...mode };
      if (!(await isSupported(config))) continue;
      const hardware = await isSupported({ ...config, hardwareAcceleration: 'prefer-hardware' });
      return { codec: config.codec, hardware, config };
    }
  }
  return null;
}

// Software encoders get constant rate control. Firefox's (Media Foundation) ignores the bitrate
// in every mode, but in 'variable' it keeps stale blocks behind moving things (faint trails on
// flat paper, up to 35 levels off); 'constant' leaves about a quarter of them. Chrome's OpenH264
// writes byte-identical files in both modes. Hardware encoders stay on 'variable' (Chrome + NVENC
// in 'constant' starves the first frames).
async function softwareConfig(pick) {
  if (!pick.soft) {
    pick.soft = (async () => {
      if (pick.config.bitrateMode !== 'variable') return pick.config;
      const cbr = { ...pick.config, bitrateMode: 'constant' };
      return (await isSupported(cbr)) ? cbr : pick.config;
    })();
  }
  return pick.soft;
}

// The codec a recorder MIME type implies, as a WebCodecs string, to ask VideoEncoder whether this
// size can be encoded with it: false when no H.264 level fits, null when the codec is unknown.
function recorderCodec(type, width, height, fps) {
  const t = type.toLowerCase();
  if (/avc[13]|h264/.test(t) || (t.startsWith('video/mp4') && !t.includes('codecs='))) {
    const level = avcLevel(width, height, fps);
    return level ? `avc1.42E0${level.toString(16).toUpperCase().padStart(2, '0')}` : false;
  }
  if (/vp0?9/.test(t)) return 'vp09.00.10.08';
  if (/vp8/.test(t)) return 'vp8';
  if (/av01|av1/.test(t)) return 'av01.0.04M.08';
  return null;
}

// MediaRecorder cannot be asked whether it can record a given size, and Chrome's accepts sizes
// its H.264 encoder then rejects at run time (2x2, 4x4, 4096x4096). Where WebCodecs exists, its
// answer for the same codec predicts that exactly (Chrome records with the same encoders), so the
// first type it does not rule out is preferred. It only reorders: if it rules out every type, the
// first one is still tried, and a failure then surfaces as 'unsupported'.
async function pickRecorder(types = RECORDER_TYPES, size = null) {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' ||
      !HTMLCanvasElement.prototype.captureStream) return null;
  // Real time cannot keep up beyond UHD: Chrome kept 22 of 60 frames at 4096 x 4096 (VP9),
  // Firefox 1 of 3 at 8192 x 8192. A file with most frames missing is not a result.
  if (size && size.width * size.height > MAX_RECORDER_PX) return null;
  const candidates = types.filter(type => {
    try { return MediaRecorder.isTypeSupported(type); } catch { return false; }
  });
  if (!candidates.length) return null;
  let mimeType = candidates[0];
  if (size && typeof VideoEncoder !== 'undefined' && VideoEncoder.isConfigSupported) {
    const { width, height, fps } = size;
    for (const type of candidates) {
      const codec = recorderCodec(type, width, height, fps);
      if (codec === null || (codec && await isSupported({ codec, width, height, framerate: fps }))) { mimeType = type; break; }
    }
  }
  return { mimeType, ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' };
}

/** What this browser can do for a given size: { webcodecs: {codec, hardware}|null, recorder: {mimeType, ext}|null } */
export async function probeVideo({ width = 1080, height = 1920, fps = 30, bitrate } = {}) {
  const wc = await pickWebCodecs(width, height, fps, bitrate || defaultBitrate(width, height, fps));
  // Start the one-off colour check for this size now (cached), so the export itself starts at once.
  if (wc) colourCheck(wc.config, 'no-preference');
  return { webcodecs: wc && { codec: wc.codec, hardware: wc.hardware }, recorder: await pickRecorder(RECORDER_TYPES, { width, height, fps }) };
}

// ------------------------------------------------------------------------------ public entry
/**
 * Encode `frames` frames painted by `drawFrame(index, ctx2d, canvas)` into a video file.
 * Resolves { blob, mimeType, ext, engine, codec, width, height, fps, frames, bytes, ... }.
 */
export async function encodeVideo(opts) {
  const { width, height, fps = 30, frames, drawFrame, signal, onProgress, engine = 'auto',
    recorderTypes = RECORDER_TYPES } = opts || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width % 2 || height % 2) {
    throw fail('unsupported', `Video size must be even whole pixels (got ${width} x ${height})`);
  }
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw fail('unsupported', `Unsupported frame rate: ${fps}`);
  if (!Number.isInteger(frames) || frames < 1) throw fail('unsupported', `Frame count must be a positive integer (got ${frames})`);
  if (typeof drawFrame !== 'function') throw fail('unsupported', 'drawFrame must be a function');
  if (!['auto', 'webcodecs', 'recorder'].includes(engine)) throw fail('unsupported', `Unknown engine: ${engine}`);
  checkAbort(signal);

  const asked = Math.round(opts.bitrate);
  const keyFrames = new Set((Array.isArray(opts.keyFrames) ? opts.keyFrames : [])
    .filter(k => Number.isInteger(k) && k >= 0 && k < frames));
  const job = { width, height, fps, frames, drawFrame, signal, onProgress, keyFrames,
    bitrate: asked > 0 ? asked : defaultBitrate(width, height, fps), restarts: 0 };
  // Starting over (software retry, recorder fallback): the UI hears it at once, as progress 0.
  job.restart = () => { job.restarts++; progress(onProgress, 0, frames, null); };

  let wcError = null;
  if (engine !== 'recorder') {
    const wc = await pickWebCodecs(width, height, fps, job.bitrate);
    if (wc) {
      try {
        return Object.assign(await encodeWebCodecs(job, wc), { restarts: job.restarts });
      } catch (e) {
        // Only an encoder failure is worth a second, real-time attempt; a cancel or a
        // drawFrame error would just happen again.
        if (engine === 'webcodecs' || !e.fromEncoder) throw e;
        wcError = e;
      }
    } else if (engine === 'webcodecs') {
      throw fail('unsupported', `This browser cannot encode H.264 video at ${width} x ${height}`);
    }
  }
  const rec = await pickRecorder(recorderTypes, { width, height, fps });
  checkAbort(signal);
  if (!rec) {
    if (wcError) throw wcError;
    throw fail('unsupported', `This browser cannot make a ${width} x ${height} video (no WebCodecs H.264 encoder for it, and no MediaRecorder that can record it)`);
  }
  if (wcError) job.restart();
  const out = await encodeRecorder(job, rec);
  if (wcError) out.fallbackFrom = msg(wcError);
  out.restarts = job.restarts;
  return out;
}

// ------------------------------------------------------------------------------ WebCodecs path
async function encodeWebCodecs(job, pick) {
  let lib;
  try { lib = await loadMuxer(); } catch (e) { throw fail('unsupported', 'The MP4 muxer could not be loaded', e); }
  const pass = async acceleration => {
    const t = performance.now();
    const colour = await raceAbort(colourCheck(pick.config, acceleration), job.signal);
    checkAbort(job.signal);
    const out = await webCodecsPass(job, pick, lib, acceleration, colour);
    out.colourCheckMs = Math.round(out.startedAt - t);
    delete out.startedAt;
    return out;
  };
  try {
    return await pass('no-preference');
  } catch (e) {
    if (!e.fromEncoder || job.signal?.aborted) throw e;
    // A hardware encoder can accept a config and still fail once frames arrive (driver limits,
    // GPU reset). Software is slower but dependable.
    if (!(await isSupported({ ...pick.config, hardwareAcceleration: 'prefer-software' }))) throw e;
    job.restart();
    const out = await pass('prefer-software');
    out.retriedAfter = msg(e);
    return out;
  }
}

async function webCodecsPass(job, pick, { Muxer, ArrayBufferTarget }, acceleration, colour) {
  const { width, height, fps, frames, drawFrame, signal, onProgress, keyFrames } = job;
  const startedAt = performance.now();
  const encoderError = (text, cause) => Object.assign(fail('encode', text, cause), { fromEncoder: true });
  const frameUs = 1e6 / fps;

  // Software encoders: constant rate control (see softwareConfig) and a one-second warm-up. The
  // rate control of Firefox's encoder settles during its first second; until then it leaves
  // strong trails (79 levels off where the steady state has 23). So it is first fed `warm` copies
  // of frame 0 (timestamps 0 .. warm-1 frames), whose output is dropped; real frame i follows at
  // warm + i and frame 0 is a keyframe, so nothing kept refers to the warm-up. Cost: `warm` encodes
  // of one still picture (~0.1-0.3 s).
  const soft = acceleration === 'prefer-software' || !pick.hardware;
  const config = soft ? await softwareConfig(pick) : pick.config;
  checkAbort(signal);
  const warm = soft ? Math.min(60, Math.max(8, Math.round(fps))) : 0;

  // Muxing. Encoders differ in what they hand back: Chrome returns frames in order with our
  // timestamps; Firefox (Media Foundation) uses B-frames, so chunks arrive in decode order, and
  // stamps them one frame late in 100 ns steps. So each chunk is mapped back to its frame index
  // p (relative to the earliest timestamp), and the reorder depth D (how far the output position
  // k runs ahead of p) is measured over the first second of output. Then, as ffmpeg writes x264
  // files: decode time k, presentation time p + D (in frames; never before the decode time), and
  // with D > 0 an edit list that shows media time D as t = 0 (see addEditList). Every sample lasts
  // one frame, so the stts sum is the length whichever frame comes last in decode order (a B-frame
  // after an odd frame count or a forced keyframe). D = 0 (no B-frames): DTS = PTS, no edit list.
  const lookahead = Math.min(frames, Math.max(8, Math.round(fps)));
  const early = [];
  let target = null, muxer = null, base = 0, depth = 0, muxed = 0, maxP = -1;
  const openMuxer = () => {
    base = Math.min(...early.map(c => c.ts));
    early.forEach((c, k) => { depth = Math.max(depth, k - Math.round((c.ts - base) / frameUs)); });
    target = new ArrayBufferTarget();
    // Track timescale: a power-of-two multiple of fps of at least 10000 ticks/s, as ffmpeg picks
    // (15360 at 30 fps). With one tick per frame, Chromium rounded a seek target to the nearest
    // frame boundary: a seek into the late half of the frame before a keyframe showed the keyframe.
    let timescale = fps;
    while (timescale < 10000) timescale *= 2;
    muxer = new Muxer({
      target,
      video: { codec: 'avc', width, height, ...(Number.isInteger(fps) ? { frameRate: timescale } : {}) },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    for (const c of early.splice(0)) mux(c);
  };
  const mux = c => {
    const k = muxed, p = Math.round((c.ts - base) / frameUs);
    if (p < 0 || k > p + depth) throw new Error(`frame reordering deeper than ${depth} at output ${k}`);
    muxer.addVideoChunkRaw(c.data, c.type, (p + depth) * frameUs, frameUs, c.meta, (p + depth - k) * frameUs);
    maxP = Math.max(maxP, p);
    muxed++;
  };

  let failure = null, chunks = 0, lastOutput = performance.now(), codec = pick.codec, avcCRepaired = false;
  let firstTs = null, heldConfig = null, mp4 = null, nalLength = 4;
  // An encoder that gets canvas colours wrong is fed I420 we convert ourselves (see measureColour).
  const manualYuv = !!colour?.skewed;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        lastOutput = performance.now();
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (meta?.decoderConfig) {
          const fixed = repairAvcC(meta.decoderConfig.description, data);
          avcCRepaired ||= fixed.repaired;
          meta = { ...meta, decoderConfig: { ...meta.decoderConfig, description: fixed.desc,
            colorSpace: manualYuv ? BT709 : cleanColorSpace(meta.decoderConfig.colorSpace) } };
          codec = codecFromAvcC(fixed.desc) || codec;
          nalLength = parseAvcC(fixed.desc)?.lengthSize || nalLength;
        }
        // The first chunk out is the first keyframe, the earliest picture: warm-up frames are
        // counted from it. Dropped, but the stream header they carry goes with the first real frame.
        firstTs ??= chunk.timestamp;
        if (warm && Math.round((chunk.timestamp - firstTs) / frameUs) < warm) {
          if (meta?.decoderConfig) heldConfig = meta;
          return;
        }
        if (heldConfig) { if (!meta?.decoderConfig) meta = heldConfig; heldConfig = null; }
        const c = { data: dropDelimiters(data, nalLength), type: chunk.type, ts: chunk.timestamp, meta };
        chunks++;
        if (muxer) mux(c);
        else { early.push(c); if (early.length >= lookahead) openMuxer(); }
      } catch (e) { failure ||= e; }
    },
    error: e => { failure ||= e; },
  });
  const canvas = makeCanvas(width, height);
  // Opaque: a transparent pixel would otherwise reach the encoder as black.
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: manualYuv });
  const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));
  const yuv = manualYuv ? new Uint8Array(width * height * 3 / 2) : null;
  const spent = { draw: 0, frame: 0, wait: 0 };   // ms: drawFrame, frame capture/convert+encode call, backpressure+yield
  const breathe = paintYielder();

  const checkFailure = () => {
    if (failure) throw encoderError(`Video encoder failed: ${msg(failure)}`, failure);
    if (encoder.state === 'closed') throw encoderError('Video encoder was closed unexpectedly');
  };

  // Keep at most MAX_QUEUE frames inside the encoder: each one pins a full-size GPU/CPU image.
  const drain = () => new Promise(resolve => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      encoder.removeEventListener?.('dequeue', check);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const check = () => { if (encoder.encodeQueueSize <= MAX_QUEUE) done(); };
    encoder.addEventListener?.('dequeue', check);
    signal?.addEventListener('abort', done, { once: true });
    timer = setTimeout(done, 30);   // 'dequeue' is not everywhere; the caller re-checks
  });

  // Hands the picture on the canvas to the encoder as the frame at `slot` (in frame periods).
  // On the I420 path the conversion is done once per painted picture (`convert`).
  const encodeAt = (slot, keyFrame, convert, label) => {
    let frame;
    try {
      const timing = { timestamp: Math.round(slot * frameUs), duration: Math.round(frameUs) };
      if (manualYuv && convert) rgbaToI420(ctx.getImageData(0, 0, width, height).data, width, height, yuv);
      frame = manualYuv
        ? new VideoFrame(yuv, { ...timing, format: 'I420', codedWidth: width, codedHeight: height, colorSpace: BT709 })
        : new VideoFrame(canvas, timing);
      encoder.encode(frame, { keyFrame });
    } catch (e) {
      throw encoderError(`${label} could not be encoded: ${msg(failure || e)}`, failure || e);
    } finally {
      frame?.close();
    }
  };
  const settle = async label => {
    const queuedAt = performance.now();
    while (encoder.encodeQueueSize > MAX_QUEUE && !failure && !signal?.aborted) {
      await drain();
      if (performance.now() - Math.max(queuedAt, lastOutput) > STALL_MS) {
        throw encoderError(`Video encoder stopped responding at ${label}`);
      }
    }
    await breathe.next();
  };

  try {
    try {
      encoder.configure({ ...config, hardwareAcceleration: acceleration });
    } catch (e) {
      throw encoderError(`Video encoder rejected the configuration: ${msg(e)}`, e);
    }
    if (warm) {
      await paint(drawFrame, 0, ctx, canvas, signal);
      for (let k = 0; k < warm; k++) {
        checkAbort(signal);
        checkFailure();
        encodeAt(k, k === 0, k === 0, 'The warm-up frame');
        await settle('warm-up');
      }
    }
    for (let i = 0; i < frames; i++) {
      checkAbort(signal);
      checkFailure();
      const t0 = performance.now();
      await paint(drawFrame, i, ctx, canvas, signal);
      const t1 = performance.now();
      checkAbort(signal);
      checkFailure();
      encodeAt(warm + i, i % keyEvery === 0 || keyFrames.has(i), true, `Frame ${i}`);
      const t2 = performance.now();
      progress(onProgress, i + 1, frames, canvas);
      await settle(`frame ${i}`);
      spent.draw += t1 - t0; spent.frame += t2 - t1; spent.wait += performance.now() - t2;
    }
    checkAbort(signal);
    let stallTimer;
    const stall = new Promise((_, reject) => {
      stallTimer = setTimeout(() => reject(encoderError('Video encoder did not finish')), STALL_MS);
    });
    try {
      await raceAbort(Promise.race([encoder.flush(), stall]), signal);
    } catch (e) {
      if (coded(e)) throw e;
      throw encoderError(`Video encoder failed while finishing: ${msg(failure || e)}`, failure || e);
    } finally {
      clearTimeout(stallTimer);
    }
    checkFailure();
    // A dropped frame still leaves a correctly timed file (sample durations come from the
    // timestamps), so only an empty result is fatal; `encodedFrames` reports the real count.
    if (!chunks) throw encoderError('Video encoder returned no frames');
    try {
      if (!muxer) openMuxer();
      muxer.finalize();
      mp4 = new Uint8Array(target.buffer);
      if (depth) mp4 = addEditList(mp4, depth / fps, (maxP + 1) / fps);
      if (!mp4) throw new Error('unexpected MP4 layout for the edit list');
    } catch (e) { throw encoderError(`MP4 could not be written: ${msg(e)}`, e); }
  } finally {
    breathe.stop();
    if (encoder.state !== 'closed') { try { encoder.close(); } catch { /* already closed */ } }
  }

  const blob = new Blob([mp4], { type: 'video/mp4' });
  return {
    startedAt,
    blob, mimeType: 'video/mp4', ext: 'mp4', engine: 'webcodecs', codec,
    width, height, fps, frames, bytes: blob.size,
    bitrate: job.bitrate, bitrateMode: config.bitrateMode || null, acceleration, hardware: pick.hardware,
    warmupFrames: warm, encodedFrames: chunks, reorderDepth: depth,
    colourPath: manualYuv ? 'i420' : 'canvas', colourCheck: colour ? colour.worst : null, avcCRepaired,
    perFrameMs: Object.fromEntries(Object.entries(spent).map(([k, v]) => [k, +(v / frames).toFixed(2)])),
  };
}

// ------------------------------------------------------------------------------ MediaRecorder path
async function encodeRecorder(job, pick) {
  const { width, height, fps, frames, drawFrame, signal, onProgress, bitrate } = job;
  const canvas = makeCanvas(width, height);
  if (!canvas.captureStream) throw fail('unsupported', 'Canvas capture is not available here');
  const ctx = canvas.getContext('2d', { alpha: false });
  const frameMs = 1000 / fps;
  const minGap = Math.min(MIN_PUSH_GAP_MS, frameMs * 0.75);

  // captureStream(0) + requestFrame emits exactly the frames we paint (Chrome and Safari put
  // requestFrame on the track, Firefox on the stream). The capture is opened on the still
  // unpainted canvas: a canvas that already has content is captured immediately, before the
  // recorder runs, which stretches the first frame by the recorder's start-up time.
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0];
  let push = track && typeof track.requestFrame === 'function' ? () => track.requestFrame()
    : typeof stream.requestFrame === 'function' ? () => stream.requestFrame() : null;
  if (!push) {
    // No manual frames: let the browser sample the canvas, which must hold frame 0 first.
    stream.getTracks().forEach(t => t.stop());
    await paint(drawFrame, 0, ctx, canvas, signal);
    stream = canvas.captureStream(fps);
    track = stream.getVideoTracks()[0];
    push = () => {};
  }

  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: pick.mimeType, videoBitsPerSecond: bitrate });
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    throw fail('unsupported', `This browser cannot record ${pick.mimeType}: ${msg(e)}`, e);
  }

  const parts = [];
  let failure = null, onFailure = null;
  rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
  const stopped = new Promise(resolve => { rec.onstop = resolve; });
  rec.onerror = e => { failure ||= e.error || e; onFailure?.(); };
  // A recorder that fails before it delivered any data never ran this configuration: Chrome
  // accepts sizes its H.264 encoder rejects and reports an EncodingError right after 'start'.
  // That is 'unsupported'; a failure after data arrived is 'encode'.
  const recorderFailed = () => (parts.length
    ? fail('encode', `Video recorder failed: ${msg(failure)}`, failure)
    : fail('unsupported', `This browser cannot record ${width} x ${height} video as ${pick.mimeType}: ${msg(failure)}`, failure));

  // Clock that stands still while the tab is hidden (the recorder is paused then too).
  const hasDoc = typeof document !== 'undefined';
  let t0 = 0, hiddenAt = 0, hiddenMs = 0, wake = null, running = false;
  const now = () => (hiddenAt || performance.now()) - t0 - hiddenMs;
  const pause = () => { if (rec.state === 'recording') { rec.pause(); hiddenAt = performance.now(); } };
  // Listening from the very start: a tab that is hidden before or during the recorder's start-up
  // must still wake the export when it is shown again. Pausing only once the clock runs.
  const onVisibility = () => {
    if (!document.hidden) wake?.();
    else if (running) pause();
  };
  const whileHidden = () => new Promise(resolve => {
    const done = () => { wake = null; signal?.removeEventListener('abort', done); resolve(); };
    wake = done;
    signal?.addEventListener('abort', done, { once: true });
    if (!document.hidden) done();
  });
  if (hasDoc) document.addEventListener('visibilitychange', onVisibility);

  const cleanup = () => {
    if (hasDoc) document.removeEventListener('visibilitychange', onVisibility);
    stream.getTracks().forEach(t => t.stop());
  };

  let drawn = 1, dropped = 0, leadInMs = 0;
  try {
    if (hasDoc && document.hidden) await whileHidden();   // do not start into a paused timeline
    checkAbort(signal);
    // Chrome fires 'start' only once the first frame reached a freshly initialised encoder
    // (0.2-0.6 s at 1080x1920 with hardware encoding) and drops what arrives beyond ~10 frames in
    // flight until then (frames 11-22 of 30 in a test). So: frame 0 first, wait for 'start', and
    // only then start the clock. Frame 0 is held for that start-up time (a still lead-in, reported
    // as leadInMs). A cold first recorder in a page can still lose ~2 early frames inside Chrome;
    // the timeline stays right.
    const started = new Promise(resolve => { rec.onstart = resolve; onFailure = resolve; setTimeout(resolve, 3000); });
    rec.start(1000);
    await paint(drawFrame, 0, ctx, canvas, signal);
    const firstPush = performance.now();
    push();
    await raceAbort(started, signal);
    if (failure) throw recorderFailed();
    t0 = performance.now();
    leadInMs = Math.round(t0 - firstPush);
    running = true;
    // Hidden during start-up: pause at once; the loop below waits, resumes and repaints frame 0.
    if (hasDoc && document.hidden) pause();
    progress(onProgress, 1, frames, canvas);

    let i = 0, lastPush = performance.now();
    while (i < frames - 1) {
      // Wait for the next frame's slot on the wall clock, and never request two frames within
      // one capture tick (~16 ms): the browser keeps only one of them.
      const due = Math.max((i + 1) * frameMs - now(), minGap - (performance.now() - lastPush));
      if (due > 1) await sleep(due);
      checkAbort(signal);
      if (failure) throw recorderFailed();
      if (rec.state === 'paused') {
        await whileHidden();
        checkAbort(signal);
        hiddenMs += performance.now() - hiddenAt;
        hiddenAt = 0;
        rec.resume();
        // The frame on the canvas may have been requested just before the pause and never
        // captured (a hidden page does not render; Chrome then loses it). Paint it again (Chrome
        // captures only a canvas drawn after the request), one slot after resuming: Firefox
        // re-sends the last frame by itself on resume, and two frames a millisecond apart are
        // what some demuxers reject. Then give it a full slot. Costs ~1-3 frames of hold per hide.
        await sleep(frameMs);
        checkAbort(signal);
        await paint(drawFrame, i, ctx, canvas, signal);
        push();
        lastPush = performance.now();
        const over = now() - i * frameMs;
        if (over > 0) hiddenMs += over;
        continue;
      }
      // If drawing fell behind real time, skip to the frame that is due now so the video keeps
      // its length; the last frame is always drawn.
      const next = Math.min(frames - 1, Math.max(i + 1, Math.floor(now() / frameMs)));
      dropped += next - i - 1;
      i = next;
      await paint(drawFrame, i, ctx, canvas, signal);
      push();
      lastPush = performance.now();
      drawn++;
      progress(onProgress, i + 1, frames, canvas);
    }
    // Hold the last frame for its full duration before stopping.
    await sleep(frameMs * 1.5);
    checkAbort(signal);
    if (rec.state === 'paused') rec.resume();
    rec.stop();
    await raceAbort(stopped, signal);
  } catch (e) {
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
    cleanup();
    if (signal?.aborted) throw aborted();
    throw coded(e) ? e : fail('encode', `Video recording failed: ${msg(e)}`, e);
  }
  cleanup();
  if (failure) throw recorderFailed();

  const actualType = rec.mimeType || pick.mimeType;
  const container = actualType.startsWith('video/mp4') ? 'video/mp4' : 'video/webm';
  const codecMatch = /codecs="?([^";]+)/i.exec(actualType) || /codecs="?([^";]+)/i.exec(pick.mimeType);
  let blob = new Blob(parts, { type: container });
  // Nothing at all, and no error: the recorder never got going with this configuration.
  if (!blob.size) throw fail('unsupported', `This browser recorded nothing at ${width} x ${height} (${pick.mimeType})`);
  let durationPatched = false, durationMs = Math.round(frames * frameMs + leadInMs);
  if (container === 'video/webm') {
    const fixed = fixWebmDuration(new Uint8Array(await blob.arrayBuffer()), { frameMs, fallbackMs: durationMs });
    if (fixed.patched) blob = new Blob([fixed.bytes], { type: container });
    durationPatched = fixed.patched;
    durationMs = fixed.durationMs ?? durationMs;
  }
  return {
    blob, mimeType: container, ext: container === 'video/mp4' ? 'mp4' : 'webm', engine: 'recorder',
    codec: codecMatch ? codecMatch[1] : null, width, height, fps, frames, bytes: blob.size,
    bitrate, recorderType: actualType, drawn, dropped, leadInMs, durationPatched, durationMs,
  };
}

// ------------------------------------------------------------------------------ WebM Duration patch
// MediaRecorder streams WebM live, so Segment > Info carries no Duration and the file cannot be
// seeked in most players. Insert Duration (float64, in TimecodeScale units) into Info, computed
// from the last block timestamp. Positions in SeekHead/Cues are shifted to match.
const EBML = {
  header: 0x1A45DFA3, segment: 0x18538067, seekHead: 0x114D9B74, info: 0x1549A966, tracks: 0x1654AE6B,
  cluster: 0x1F43B675, cues: 0x1C53BB6B, tags: 0x1254C367, chapters: 0x1043A770, attachments: 0x1941A469,
  timecodeScale: 0x2AD7B1, duration: 0x4489, timecode: 0xE7, simpleBlock: 0xA3, blockGroup: 0xA0,
  block: 0xA1, blockDuration: 0x9B, seek: 0x4DBB, seekPosition: 0x53AC, cuePoint: 0xBB,
  cueTrackPositions: 0xB7, cueClusterPosition: 0xF1,
};
const LEVEL1 = new Set([EBML.seekHead, EBML.info, EBML.tracks, EBML.cluster, EBML.cues, EBML.tags,
  EBML.chapters, EBML.attachments, EBML.header, EBML.segment]);

function readVint(b, pos, keepMarker) {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let len = 1, mask = 0x80;
  while (!(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let k = 1; k < len; k++) {
    value = value * 256 + b[pos + k];
    if (b[pos + k] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readHead(b, pos) {
  const id = readVint(b, pos, true);
  if (!id || id.len > 4) return null;
  const size = readVint(b, pos + id.len, false);
  if (!size) return null;
  const dataStart = pos + id.len + size.len;
  return { id: id.value, start: pos, sizePos: pos + id.len, sizeLen: size.len, dataStart,
    size: size.unknown ? null : size.value, end: size.unknown ? null : dataStart + size.value };
}

function readUint(b, start, end) {
  let v = 0;
  for (let k = start; k < end; k++) v = v * 256 + b[k];
  return v;
}

function writeUintInPlace(b, start, end, value) {
  if (value >= Math.pow(256, end - start)) return false;
  for (let k = end - 1; k >= start; k--) { b[k] = value % 256; value = Math.floor(value / 256); }
  return true;
}

function writeSizeInPlace(b, head, value) {
  const len = head.sizeLen;
  if (value >= Math.pow(2, 7 * len) - 1) return false;
  let v = value;
  for (let k = len - 1; k >= 1; k--) { b[head.sizePos + k] = v % 256; v = Math.floor(v / 256); }
  b[head.sizePos] = (0x80 >> (len - 1)) | v;
  return true;
}

function* children(b, start, end) {
  for (let p = start; p < end;) {
    const h = readHead(b, p);
    if (!h || h.end === null || h.end > end) return;
    yield h;
    p = h.end;
  }
}

// Max block timestamp (in TimecodeScale ticks) in one cluster, and where the cluster ends.
function scanCluster(b, cl, limit) {
  const end = cl.end ?? limit;
  let base = 0, max = -Infinity, p = cl.dataStart;
  while (p < end) {
    const h = readHead(b, p);
    if (!h) break;
    if (cl.end === null && LEVEL1.has(h.id)) break;        // unknown-size cluster ends here
    if (h.end === null || h.end > limit) { p = limit; break; }
    if (h.id === EBML.timecode) base = readUint(b, h.dataStart, h.end);
    else if (h.id === EBML.simpleBlock || h.id === EBML.blockGroup) {
      let blk = h, extra = 0;
      if (h.id === EBML.blockGroup) {
        blk = null;
        for (const c of children(b, h.dataStart, h.end)) {
          if (c.id === EBML.block) blk = c;
          else if (c.id === EBML.blockDuration) extra = readUint(b, c.dataStart, c.end);
        }
      }
      if (blk) {
        const track = readVint(b, blk.dataStart, false);
        if (track) {
          const o = blk.dataStart + track.len;
          const rel = ((b[o] << 8) | b[o + 1]) << 16 >> 16;          // signed 16-bit
          max = Math.max(max, base + rel + extra);
        }
      }
    }
    p = h.end;
  }
  return { max, end: p };
}

/**
 * Add Segment > Info > Duration to a live-written WebM. Returns { bytes, patched, durationMs }.
 * Leaves the file untouched when it already has a duration or has a layout we do not understand.
 */
export function fixWebmDuration(bytes, { frameMs = 1000 / 30, fallbackMs = null } = {}) {
  const none = { bytes, patched: false, durationMs: null };
  const hdr = readHead(bytes, 0);
  if (!hdr || hdr.id !== EBML.header || hdr.end === null) return none;
  const seg = readHead(bytes, hdr.end);
  if (!seg || seg.id !== EBML.segment) return none;
  const segEnd = seg.end === null ? bytes.length : Math.min(bytes.length, seg.end);

  let info = null, seekHead = null, cues = null, maxTicks = -Infinity;
  for (let p = seg.dataStart; p < segEnd;) {
    const h = readHead(bytes, p);
    if (!h) break;
    if (h.id === EBML.cluster) {
      const r = scanCluster(bytes, h, segEnd);
      maxTicks = Math.max(maxTicks, r.max);
      if (r.end <= p) break;
      p = r.end;
      continue;
    }
    if (h.end === null) break;
    if (h.id === EBML.info) info = h;
    else if (h.id === EBML.seekHead) seekHead = h;
    else if (h.id === EBML.cues) cues = h;
    p = h.end;
  }
  if (!info) return none;

  let scale = 1e6, durEl = null;
  for (const c of children(bytes, info.dataStart, info.end)) {
    if (c.id === EBML.timecodeScale) scale = readUint(bytes, c.dataStart, c.end) || 1e6;
    else if (c.id === EBML.duration) durEl = c;
  }
  const view = (buf, at, len) => new DataView(buf.buffer, buf.byteOffset + at, len);
  if (durEl && durEl.size === 8 && view(bytes, durEl.dataStart, 8).getFloat64(0) > 0) return none;
  if (durEl && durEl.size === 4 && view(bytes, durEl.dataStart, 4).getFloat32(0) > 0) return none;

  const frameTicks = frameMs * 1e6 / scale;
  let ticks = Number.isFinite(maxTicks) && maxTicks >= 0 ? maxTicks + frameTicks
    : fallbackMs ? fallbackMs * 1e6 / scale : 0;
  if (!(ticks > 0)) return none;
  const durationMs = ticks * scale / 1e6;

  const out = bytes.slice();
  if (durEl && (durEl.size === 8 || durEl.size === 4)) {          // present but empty: fill in place
    if (durEl.size === 8) view(out, durEl.dataStart, 8).setFloat64(0, ticks);
    else view(out, durEl.dataStart, 4).setFloat32(0, ticks);
    return { bytes: out, patched: true, durationMs };
  }

  // New Info = ID + 8-byte size + old payload + Duration element (0x4489, size 8, float64).
  const payload = info.size;
  const idLen = info.sizePos - info.start;
  const newInfoLen = idLen + 8 + payload + 11;
  const delta = newInfoLen - (info.end - info.start);
  const infoRel = info.start - seg.dataStart;     // positions are relative to Segment data

  // Shift SeekHead / Cues positions that point past Info (in place: lengths do not change).
  const shift = (start, end, path) => {
    for (const c of children(out, start, end)) {
      if (c.id === path[0]) {
        if (path.length === 1) {
          const v = readUint(out, c.dataStart, c.end);
          if (v > infoRel && !writeUintInPlace(out, c.dataStart, c.end, v + delta)) return false;
        } else if (!shift(c.dataStart, c.end, path.slice(1))) return false;
      }
    }
    return true;
  };
  if (seekHead && !shift(seekHead.dataStart, seekHead.end, [EBML.seek, EBML.seekPosition])) return none;
  if (cues && !shift(cues.dataStart, cues.end, [EBML.cuePoint, EBML.cueTrackPositions, EBML.cueClusterPosition])) return none;
  if (seg.size !== null && !writeSizeInPlace(out, seg, seg.size + delta)) return none;

  const result = new Uint8Array(out.length + delta);
  result.set(out.subarray(0, info.start), 0);
  let w = info.start;
  result.set(out.subarray(info.start, info.sizePos), w); w += idLen;
  const size8 = [0x01, 0, 0, 0, 0, 0, 0, 0];
  let v = payload + 11;
  for (let k = 7; k >= 1; k--) { size8[k] = v % 256; v = Math.floor(v / 256); }
  result.set(size8, w); w += 8;
  result.set(out.subarray(info.dataStart, info.end), w); w += payload;
  result.set([0x44, 0x89, 0x88], w); w += 3;
  view(result, w, 8).setFloat64(0, ticks); w += 8;
  result.set(out.subarray(info.end), w);
  return { bytes: result, patched: true, durationMs };
}

// Photo intake: one decode path for every source (file picker, drop, paste, samples, session
// restore) so orientation and scaling can never disagree between preview and export.
//
// decodeImage(blobOrFile) -> { canvas, width, height, name, alphaBox, small }
//   canvas   the working image, EXIF-rotated, long edge <= WORK_MAX, transparent pixels kept
//   alphaBox normalised bounding box of opaque pixels when the image has real transparency

export const WORK_MAX = 2048;

export class ImageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MESSAGES = {
  type: "That file isn't a photo we can read. Try a JPG, PNG, WebP or GIF.",
  heic: "This browser can't read HEIC photos. Export it as JPG and try again.",
  decode: "That image couldn't be opened. It may be damaged — try another one.",
  empty: 'That image is empty.',
};

export function imageErrorMessage(err) {
  return (err && MESSAGES[err.code]) || MESSAGES.decode;
}

function looksLikeImage(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i.test(file.name || '');
}

async function isHeic(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const brand = String.fromCharCode(...head.slice(4, 12));
    return /^ftyp(heic|heix|hevc|hevx|mif1|msf1|heim|heis)/.test(brand);
  } catch { return false; }
}

async function toDrawable(blob) {
  // createImageBitmap applies EXIF orientation with 'from-image' (the default in current browsers).
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  // <img> also honours EXIF orientation (CSS image-orientation: from-image is the default).
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    // SVGs without intrinsic size report 0: give them a sensible one
    if (!img.naturalWidth || !img.naturalHeight) { img.width = 1024; img.height = 1024; }
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function sizeOf(src) {
  return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
}

/** Downscale with progressive halving for quality (drawImage alone aliases on big reductions). */
function downscale(src, maxSide) {
  let { w, h } = sizeOf(src);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
  let cur = src, cw = w, ch = h;
  while (cw / 2 >= tw * 1.01 && ch / 2 >= th * 1.01) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = makeCanvas(nw, nh);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nh);
    if (cur !== src) releaseCanvas(cur);
    cur = c; cw = nw; ch = nh;
  }
  const out = makeCanvas(tw, th);
  const g = out.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, tw, th);
  if (cur !== src) releaseCanvas(cur);
  return out;
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Safari keeps canvas memory until GC; zeroing the size frees it now. */
export function releaseCanvas(c) {
  if (c && c.width !== undefined && c.getContext) { c.width = 0; c.height = 0; }
}

/** Bounding box of pixels with alpha > 8, if a meaningful part of the image is transparent. */
function alphaBounds(canvas) {
  const w = canvas.width, h = canvas.height;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 512));
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1, clear = 0, total = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      total++;
      const a = data[(y * w + x) * 4 + 3];
      if (a > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      else clear++;
    }
  }
  if (maxX < 0) return { empty: true };
  if (clear / total < 0.04) return null;   // effectively opaque
  return { x0: minX / w, y0: minY / h, x1: (maxX + step) / w, y1: (maxY + step) / h };
}

/**
 * Decode a File/Blob into the working image. Throws ImageError(code) with a user-facing message.
 * @param blob File | Blob
 * @param name display name (defaults to File.name)
 */
export async function decodeImage(blob, name) {
  if (!blob) throw new ImageError('type');
  if (blob instanceof File && !looksLikeImage(blob)) throw new ImageError('type');
  let drawable;
  try {
    drawable = await toDrawable(blob);
  } catch {
    throw new ImageError(await isHeic(blob) ? 'heic' : (blob.type && !blob.type.startsWith('image/') ? 'type' : 'decode'));
  }
  return fromDrawable(drawable, name ?? blob.name ?? 'image');
}

/** Same pipeline for an already-decoded source (sample canvas, restored bitmap). */
export function fromDrawable(drawable, name = 'image') {
  const { w, h } = sizeOf(drawable);
  if (!w || !h) throw new ImageError('empty');
  const canvas = downscale(drawable, WORK_MAX);
  if (drawable.close) drawable.close();
  const box = alphaBounds(canvas);
  if (box && box.empty) throw new ImageError('empty');
  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    name: String(name).replace(/\.[a-z0-9]{2,5}$/i, '') || 'image',
    alphaBox: box,
    small: Math.min(w, h) < 360,
  };
}

/** Initial framing: cover-fit the circle; portraits bias upward (faces live in the upper half);
 *  cut-outs (transparent PNGs) frame their opaque bounding box plus a margin. */
export function autoCrop(img) {
  const { width: w, height: h, alphaBox } = img;
  if (alphaBox) {
    const bw = (alphaBox.x1 - alphaBox.x0) * w, bh = (alphaBox.y1 - alphaBox.y0) * h;
    const side = Math.max(bw, bh) * 1.12;
    return {
      x: (alphaBox.x0 + alphaBox.x1) / 2, y: (alphaBox.y0 + alphaBox.y1) / 2,
      zoom: Math.max(0.35, Math.min(6, Math.min(w, h) / side)), rotation: 0,
    };
  }
  const portrait = h > w * 1.15;
  return { x: 0.5, y: portrait ? Math.max(0.5 * w / h, 0.42) : 0.5, zoom: 1, rotation: 0 };
}

/** Encode the working image for session restore (small JPEG/WebP, keeps alpha when WebP is available). */
export function encodeForStorage(canvas, maxSide = 1600) {
  const src = Math.max(canvas.width, canvas.height) > maxSide ? downscale(canvas, maxSide) : canvas;
  return new Promise(resolve => {
    src.toBlob(b => {
      if (b && b.type === 'image/webp') return resolve(b);
      src.toBlob(j => resolve(j), 'image/png');
    }, 'image/webp', 0.9);
  });
}

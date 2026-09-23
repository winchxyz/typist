// Draw a Grid as an image (lab sheets, PNG export, previews). Braille and blocks are drawn as
// geometry, never with a font: fonts disagree on Braille (Windows' Segoe UI Symbol draws U+2800
// narrower than the other patterns) and on block glyph extents, and the film needs exactly this
// geometry so a frame of the film and the exported PNG show the same dots.

// Braille bit -> [column, row] inside the cell. Dots 1-3 = bits 0-2 (left column, rows 0-2),
// dots 4-6 = bits 3-5 (right column, rows 0-2), dot 7 = bit 6 (left, row 3), dot 8 = bit 7.
export const BRAILLE_SLOTS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];

// Block glyph -> quadrant mask (UL=1, UR=2, LL=4, LR=8), the same table blocks.js encodes with,
// plus the half blocks (▀ ▄ ▌ ▐) and the full block, which are unions of quadrants.
export const BLOCK_MASK = new Map([
  [0x20, 0], [0x2800, 0],
  [0x2598, 1], [0x259D, 2], [0x2580, 3], [0x2596, 4], [0x258C, 5], [0x259E, 6], [0x259B, 7],
  [0x2597, 8], [0x259A, 9], [0x2590, 10], [0x259C, 11], [0x2584, 12], [0x2599, 13], [0x259F, 14],
  [0x2588, 15],
]);

/**
 * Dot geometry of one Braille cell, shared with the film. Dots sit on a 2 x 4 lattice centred in
 * the cell; the radius is dotR x the column pitch (research r_glyph-render: about 0.32), capped
 * so vertical neighbours never touch when a cell is squat.
 * Returns { r, centers: [[dx, dy] x 8] } with offsets from the cell's top-left corner, by bit.
 */
export function brailleGeometry(cellW, cellH, dotR = 0.32) {
  const px = cellW / 2, py = cellH / 4;
  const r = Math.min(dotR * px, 0.46 * py, 0.46 * px);
  const centers = BRAILLE_SLOTS.map(([c, rr]) => [(c + 0.5) * px, (rr + 0.5) * py]);
  return { r, centers };
}

const hex = v => '#' + (v >>> 0 & 0xffffff).toString(16).padStart(6, '0');

/**
 * Draw `grid` at (x, y) with cells of cellW x cellH px.
 *   ink    colour of dots / glyphs / monochrome blocks
 *   paper  background colour, or null for transparent (colour blocks paint their own bg)
 *   font   CSS font family for ASCII (a monospace face; the glyph is centred in its cell)
 *   dotR   Braille dot radius relative to the column pitch
 *   ghost  0..1 alpha for unraised Braille dots (film macro shots); 0 = off
 * Returns { width, height } of the drawn area.
 */
export function drawGrid(ctx, grid, {
  x = 0, y = 0, cellW = 8, cellH = 16, ink = '#17171a', paper = null,
  font = 'monospace', dotR = 0.32, ghost = 0,
} = {}) {
  const { cols, rows, cp } = grid;
  const width = cols * cellW, height = rows * cellH;
  ctx.save();
  if (paper) { ctx.fillStyle = paper; ctx.fillRect(x, y, width, height); }
  if (grid.mode === 'braille') drawBraille(ctx, grid, x, y, cellW, cellH, ink, dotR, ghost);
  else if (grid.mode === 'blocks') drawBlocks(ctx, grid, x, y, cellW, cellH, ink);
  else drawText(ctx, grid, x, y, cellW, cellH, ink, font);
  ctx.restore();
  return { width, height };
}

function drawBraille(ctx, { cols, rows, cp }, x, y, cellW, cellH, ink, dotR, ghost) {
  const { r, centers } = brailleGeometry(cellW, cellH, dotR);
  // one path per pass: tens of thousands of arcs fill in a single call
  const pass = (want, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ink;
    ctx.beginPath();
    for (let row = 0; row < rows; row++) {
      const oy = y + row * cellH;
      for (let col = 0; col < cols; col++) {
        const v = cp[row * cols + col];
        // anything outside the Braille block (a stray space) draws as a blank cell
        const bits = v >= 0x2800 && v <= 0x28ff ? v - 0x2800 : 0;
        const ox = x + col * cellW;
        for (let k = 0; k < 8; k++) {
          if (((bits >> k) & 1) !== want) continue;
          const cx = ox + centers[k][0], cy = oy + centers[k][1];
          ctx.moveTo(cx + r, cy);
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
        }
      }
    }
    ctx.fill();
  };
  if (ghost > 0) pass(0, ghost);
  pass(1, 1);
  ctx.globalAlpha = 1;
}

function drawBlocks(ctx, { cols, rows, cp, fg, bg }, x, y, cellW, cellH, ink) {
  // Edges are snapped to whole pixels and shared by neighbours, so abutting rectangles leave no
  // anti-aliased seams (a hairline grid otherwise shows through solid colour areas).
  const X = i => Math.round(x + i * cellW / 2), Y = j => Math.round(y + j * cellH / 2);
  const quads = [[0, 0], [1, 0], [0, 1], [1, 1]];   // bit k -> (dx, dy) in half cells
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const mask = BLOCK_MASK.get(cp[i]) ?? 0;
      if (bg) {
        ctx.fillStyle = hex(bg[i]);
        ctx.fillRect(X(2 * col), Y(2 * row), X(2 * col + 2) - X(2 * col), Y(2 * row + 2) - Y(2 * row));
      }
      if (!mask) continue;
      ctx.fillStyle = fg ? hex(fg[i]) : ink;
      if (mask === 15) {
        ctx.fillRect(X(2 * col), Y(2 * row), X(2 * col + 2) - X(2 * col), Y(2 * row + 2) - Y(2 * row));
        continue;
      }
      for (let k = 0; k < 4; k++) {
        if (!((mask >> k) & 1)) continue;
        const qx = 2 * col + quads[k][0], qy = 2 * row + quads[k][1];
        ctx.fillRect(X(qx), Y(qy), X(qx + 1) - X(qx), Y(qy + 1) - Y(qy));
      }
    }
  }
}

// font size whose advance equals the cell width, cached per family and cell width
const fitCache = new Map();
function fitFont(ctx, family, cellW, cellH) {
  const key = family + '|' + cellW + '|' + cellH;
  let f = fitCache.get(key);
  if (f) return f;
  ctx.font = `100px ${family}`;
  const m = ctx.measureText('M');
  const adv = m.width / 100 || 0.6;
  // fit the advance to the cell, but never taller than the cell allows
  const px = Math.min(cellW / adv, cellH / 1.05);
  ctx.font = `${px}px ${family}`;
  const mm = ctx.measureText('Mg');
  const asc = mm.fontBoundingBoxAscent ?? px * 0.8, desc = mm.fontBoundingBoxDescent ?? px * 0.2;
  // baseline that centres the font's em box in the cell
  f = { css: `${px}px ${family}`, base: (cellH + asc - desc) / 2 };
  fitCache.set(key, f);
  return f;
}

function drawText(ctx, { cols, rows, cp }, x, y, cellW, cellH, ink, family) {
  const f = fitFont(ctx, family, cellW, cellH);
  ctx.font = f.css;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // one glyph per cell at its own centre: the grid stays exact whatever the font's advance
  for (let row = 0; row < rows; row++) {
    const by = y + row * cellH + f.base;
    for (let col = 0; col < cols; col++) {
      const v = cp[row * cols + col];
      if (v === 0x20 || v === 0x2800) continue;
      ctx.fillText(String.fromCodePoint(v), x + (col + 0.5) * cellW, by);
    }
  }
}

/** A Grid from payload text (formatFor().text minus any fence): what is drawn is what is pasted. */
export function gridFromText(text, mode) {
  const lines = text.split('\n');
  const cells = lines.map(l => Array.from(l, ch => ch.codePointAt(0)));
  const cols = Math.max(1, ...cells.map(c => c.length)), rows = lines.length;
  const blank = mode === 'braille' ? 0x2800 : 0x20;
  const cp = new Uint32Array(cols * rows).fill(blank);
  cells.forEach((c, r) => c.forEach((v, i) => { cp[r * cols + i] = v; }));
  return { mode, cols, rows, cp, fg: null, bg: null, ink: 0 };
}

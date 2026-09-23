# Typist — build spec and module contracts

A static, client-side web app: pick any photo and it becomes text art (Braille dots, classic ASCII
or blocks) that pastes cleanly into an Instagram comment, an X post or a Telegram message / channel
post, plus a cinematic MP4 film of the art being made. Plain ES modules, no framework, no build
step, no npm dependencies at runtime (vendor/ holds anything vendored). The photo never leaves the
device. Sibling of Spiralist (`C:/Users/oxman/everything/spiralist`): copy code from there when it
fits, never import across projects.

Dev server: `node dev-server.js 8860` (already running during the build; launch entry `typist`).
`POST /__shot {name, data: dataURL}` saves `shots/<name>.png|jpg`; `POST /__file?name=<file>` saves a
raw body to `shots/<file>`.

Headless driver: `node tests/shoot.mjs "/dev/lab.html?sheet=modes;w=40" [--browser chromium|firefox|webkit]`
— use `;` between query params (Windows shims swallow `&`). Chromium runs on the real GPU (RTX 4070
via ANGLE D3D11). Waits for `window.__done`, prints it plus console errors. Then Read the PNG/JPEG
to look at it. Playwright: playwright-core 1.60 at the path inside tests/shoot.mjs.

## Ground rules for every contributor
- Edit ONLY the files your task owns. If you need a change elsewhere, say so in your report.
- Style: ES modules, 2-space indent, single quotes, semicolons, concise comments that explain *why*.
- Text encoding: this project is about Unicode. Write files with the Write/Edit tools or node
  (utf-8). Never round-trip a file through PowerShell Get-Content/Set-Content (it double-encodes
  UTF-8). Bash heredocs with quotes/backticks break here: write scripts to files and run them;
  `node -e` with `&` or `>` in it gets mangled, use .mjs files.
- Line endings: LF only everywhere (the repo has `core.autocrlf false` and `.gitattributes eol=lf`).
  Payloads are LF only; a CR anywhere in a payload is a bug.
- Do not commit to git. Do not start/stop the dev server (it is shared). No downloads of files or
  packages (reading web pages with WebFetch for facts is fine).
- Verify with real runs and look at every image you produce.
- Name shots with your module prefix (`fmt_*`, `conv_*`, `ascii_*`, `sample_*`, `lab_*`, `kit_*`).

## Pipeline

```
photo (ImageBitmap / canvas) + crop {x, y, zoom, rotation}   (square crop, tone.js CROP_DEFAULTS)
  -> sample   W x H lightness grid (+ rgb for colour blocks)   W, H depend on mode and grid size
  -> tone     auto levels, brightness, contrast, gamma, detail, edges, invert
  -> encode   braille | ascii | blocks                       -> Grid
  -> formatFor(target, grid) -> payload text + counts + warnings
```

Polarity: lightness `L` in [0, 1], 1 = white / background, 0 = black. "Ink" = 1 - L. In Braille a
raised dot is ink (drawn in the text colour, dark on a light theme). "Invert for dark mode" flips L
before encoding, so dots stand for the light parts (light text on a dark theme).

### Grid (the one object every later stage consumes)
```js
{
  mode: 'braille' | 'ascii' | 'blocks',
  cols, rows,                      // cells
  cp: Uint32Array(cols * rows),    // code point per cell, row-major
  fg: Uint32Array | null,          // 0xRRGGBB per cell (colour blocks only)
  bg: Uint32Array | null,
  ink: number,                     // fraction of dots / ink coverage, for the UI
}
gridLines(grid) -> string[]        // raw rows; Braille blanks are U+2800, ASCII blanks U+0020
```
Braille: `cp = 0x2800 + bits`. Dot n (1..8) -> bit: dots 1,2,3 = bits 0,1,2 (left column, rows
0..2); dots 4,5,6 = bits 3,4,5 (right column, rows 0..2); dot 7 = bit 6 (left, row 3); dot 8 = bit 7
(right, row 3). A Braille grid never contains U+0020.
ASCII: printable 0x20..0x7E only, never the backtick (0x60).
Blocks: U+2580 ▀, U+2584 ▄, U+2588 █, U+258C ▌, U+2590 ▐, quadrants U+2596..U+259F, space.
Quadrant mask (UL=1, UR=2, LL=4, LR=8): 0 space, 1 ▘, 2 ▝, 3 ▀, 4 ▖, 5 ▌, 6 ▞, 7 ▛, 8 ▗, 9 ▚,
10 ▐, 11 ▜, 12 ▄, 13 ▙, 14 ▟, 15 █.

### Rows follow the crop
The crop is square. A cell is `cellAspect = cellWidth / cellHeight` as rendered on the target
(Braille in a proportional font ~0.55, ASCII in a monospace code block ~0.46; see FIT in
targets.js). `rowsFor(cols, cellAspect) = max(1, round(cols * cellAspect))`. The sampler maps the
square crop onto the W x H sample grid, so physical proportions survive.

## Modules

### js/tone.js (adapted from Spiralist) + js/convert.js + js/dither.js + js/blocks.js — converter
```js
export const TONE_DEFAULTS = { auto: true, brightness: 0, contrast: 0, gamma: 1, detail: 0.35,
                               edges: 0, invert: false }
  // auto: percentile levels + midtones solved for a target ink coverage (Spiralist's solveGamma);
  // brightness/contrast -1..1; gamma 0.3..3 (on top of auto); detail 0..1 unsharp mask;
  // edges 0..1 Sobel edge emphasis; invert: dark mode.
export function sampleImage(source, crop, W, H, { color = false } = {}) -> { W, H, L: Float32Array, rgb: Uint8ClampedArray | null }
  // DOM (canvas) resample of the square crop to W x H, composited over white; rotation respected.
export function sampleFromRGBA(rgba, srcW, srcH, W, H, opts) // pure variant for node tests
export function toneGrid(img, tone) -> Float32Array            // pure
export const DITHERS = ['atkinson', 'floyd', 'bayer', 'threshold']
export function createConverter() -> {
  setSource(source),               // ImageBitmap / canvas; clears caches
  run(crop, opts) -> Grid,         // memoised: a tone change never resamples, a mode change never re-tones
}
opts = { mode, cols, rows, tone, dither: 'atkinson', ascii: 'shape' | 'ramp', blocks: 'quad' | 'half',
         color: false }
```
Sample grid per mode: braille `2c x 4r` dots; blocks `2c x 2r` (quad) or `c x 2r` (half) + rgb;
ascii `c*SX x r*SY` with `[SX, SY] = ASCII_SUB` from ascii.js.
Budget: `run()` for 60 x 40 Braille from a fresh crop < 30 ms on desktop Chromium, a tone change
< 10 ms; also measured in Firefox and WebKit and with 4x CPU throttling (a mid-range phone).
Everything after sampling is pure and deterministic (no Math.random): the same lightness grid gives
the same Grid in every engine. Only `sampleImage`'s canvas resampling may differ slightly between
browsers; the film and the copy always use the Grid of the browser they run in.

### js/ascii.js + js/shape-vectors.js — classic ASCII
```js
export const ASCII_CHARSET   // the 94 printable ASCII glyphs 0x20..0x7E minus the backtick
export const RAMP            // default density ramp, dark -> light, no backtick
export const ASCII_SUB = [SX, SY]   // supersampling per cell the shape matcher needs
export function asciiCells(L, W, H, cols, rows, { method: 'shape' | 'ramp', ramp = RAMP, contrast }) -> Uint32Array
```
`shape` = the shape-vector method (Alex Harri, "ASCII characters are not pixels",
alexharri.com/blog/ascii-rendering): per-glyph vectors from sampling circles in a staggered grid,
per-cell vectors from the same circles, global + directional contrast enhancement, nearest
neighbour. Glyph vectors are committed data in `js/shape-vectors.js`, generated by
`dev/shapes.html` from a monospace font installed on this machine (record which), so the output is
identical in every browser. Edges must read as `/ \ | _ - ( )`.

### js/count.js + js/targets.js — counting and formatters
```js
// count.js
export function utf16Length(s)
export function xWeightedLength(s)      // twitter-text v3 rules, tested reimplementation (below)
export function xInvalidChars(s) -> string[]   // U+FFFE, U+FEFF, U+FFFF make a post invalid
export function findUrlsX(s) -> [{start, end}] // what X would auto-link (needs a valid TLD)

// targets.js
export const TARGETS = { ig, x, xlong, tg, tgc, plain }   // id, name, limit, counter, modes, …
export const FIT     // per target + mode: fontPx, cellEm, lineEm, bubble widths at phone 360/390/430
                     // and desktop; `calibrated: false` until the device tests fill it in
export function cellAspect(target, mode) -> number
export function rowsFor(cols, aspect) -> number
export function maxCols(target, mode, { phone = 390 } = {}) -> number
export function countFor(target, mode, cols, rows, opts) -> number   // analytic, equals formatFor().count
export function autoFit(target, mode, opts) -> { cols, rows }         // largest grid that fits both
export function formatFor(target, grid, opts = {}) -> {
  text, html,            // html: '<pre>…</pre>' for Telegram ASCII (desktop clipboard), else null
  count, limit, fits, over, cols, rows, maxCols, wraps, foldRow,
  warnings: [{ code, level: 'info' | 'warn' | 'error', message }],
}
opts = { blank: 'u2800' | 'dot' (U+2840 ⡀ instead of blank cells), caption: false (tgc: 1,024),
         phone: 390 }
```
Targets:
- `ig` Instagram comment: 2,200 UTF-16 units; Braille only (proportional font).
- `x` X post: 280 weighted; Braille only. `xlong` X long post (Premium): 25,000 weighted, the
  timeline folds after about 280 (report `foldRow`, the first row past the fold).
- `tg` Telegram message: 4,096 UTF-16 units; Braille plain (default) or ASCII in a ``` fence.
- `tgc` Telegram channel post: 4,096; `caption: true` = media caption 1,024.
- `plain`: no limit, any mode (downloads, blocks).

Rules (every one needs a unit test):
- LF only; no trailing newline; no CR anywhere; no U+FEFF/U+FFFE/U+FFFF; text NFC.
- Braille targets (ig, x, xlong, tg plain, tgc plain): every space is U+2800; every row padded to the
  same width with U+2800; blank rows filled with U+2800; no line starts or ends with U+0020; never
  ASCII or emoji in the art rows. `blank: 'dot'` swaps every U+2800 cell for U+2840.
- Telegram ASCII: "```\n" + rows + "\n```", fence alone on its line, no language tag; printable
  ASCII only inside; strip every backtick; counts include the fences.
- X: weighted count (twitter-text v3: weight 1 for U+0000-10FF, U+2000-200D, U+2010-201F,
  U+2032-2037; everything else 2 incl. Braille / blocks / box drawing / full-width; emoji 2; each
  URL 23; newline 1). Free: 2*cols*rows + (rows-1) <= 280 for Braille (16 x 8 = 263).
- Warnings: over budget; wider than the phone (`maxCols`); a mode the target cannot show
  (ASCII/blocks on ig/x misalign; blocks in a chat); X long fold; Instagram "more" collapse for
  tall comments; Instagram "Action Blocked" hint for repeated long pastes; URL-like text on X.

### js/samples.js — the four built-in photos
```js
export const SAMPLES = [{ id, name, alt }]   // portrait, pet, landmark, logo (in that order)
export async function loadSample(id) -> ImageBitmap   // from img/samples/<id>.jpg (baked)
```
The images are made procedurally by `dev/samples.html` (Spiralist's shader sample runner, adapted)
and baked to `img/samples/<id>.jpg` at 1024 px, so the app loads a small JPEG instead of compiling
shaders. They must read well as small text art (clear subject, strong shapes).

### js/raster.js — draw a Grid as an image (lab, PNG export, previews)
```js
export function drawGrid(ctx, grid, { x, y, cellW, cellH, ink = '#17171a', paper = null,
                                      font = 'monospace', dotR = 0.32 })
```
Braille dots and blocks are drawn geometrically (font-independent, exact); ASCII with a monospace
font. Same dot geometry the film will use.

### Labs and the device kit
- `dev/lab.html?sheet=modes` — contact sheet: 4 samples x (Braille atkinson / floyd / bayer /
  threshold, ASCII shape / ramp, colour blocks) at w=40, saved to `shots/lab_modes.png`.
- `dev/lab.html?sheet=targets` — each sample formatted for each target at its auto-fit size in a
  390 px wide frame. `sheet=perf` — timings.
- `dev/paste-test.html` — the real-device test kit (see its own header comment); `bake=1` writes a
  self-contained single-file copy to `shots/paste-test.html` for publishing.

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
export function utf8Length(s)           // Steam's limits are UTF-8 bytes
export function xWeightedLength(s)      // twitter-text v3 rules, tested reimplementation (below)
export function xInvalidChars(s) -> string[]   // U+FFFE, U+FEFF, U+FFFF make a post invalid
export function findUrlsX(s) -> [{start, end}] // what X would auto-link (needs a valid TLD)

// targets.js
export const TARGETS = { ig, x, xlong, tg, tgc, reddit, ytc, steamc, steamp, steamb, ytlive, twitch, plain }
                     // id, name, limit, counter ('utf16' | 'x' | 'utf8'), modes, indent, flow, …
export const FIT     // per target + mode: fontPx, cellEm, lineEm, bubble widths at phone 360/390/430
                     // and desktop; `calibrated: false` until the device tests fill it in
export function cellAspect(target, mode) -> number
export function rowsFor(cols, aspect) -> number
export function maxCols(target, mode, { phone = 390 } = {}) -> number
export function countFor(target, mode, cols, rows, opts) -> number   // analytic, equals formatFor().count
export function autoFit(target, mode, opts) -> { cols, rows }         // largest grid that fits both
export function unitOf(target) -> 'utf16' | 'weighted' | 'bytes'
export function chatWidth(target, mode, phone) -> px                  // flow targets: the chat column
export function flowRange(target, mode, cols) -> { min, max }         // chat widths that stack the rows
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
- `reddit` Reddit post or comment: see the Reddit section.
- `ytc` YouTube comment: 10,000 UTF-16 units; Braille rows like Instagram.
- `steamc` Steam comment 1,000, `steamp` profile summary 4,000, `steamb` Custom Info Box 8,000:
  UTF-8 bytes; Braille rows. See the Steam, YouTube and Twitch section.
- `ytlive` YouTube live chat 200, `twitch` Twitch chat 500: UTF-16 units; one line (`flow`).
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

## Device finding (paste kit, 2026-09-23) — shapes the previews
On Windows every app draws Braille with Segoe UI Symbol, where the blank U+2800 is 0.651 em but every
dot pattern 0.753 em (measured in Chromium and Firefox: 9.76 px vs 11.30 px at 15 px). Rows shift
left by 0.1 em per blank before their dots, so art on a white background shears in Telegram Desktop,
X / Instagram in a Windows browser and the Claude desktop app. The payload is intact; phones use
other Braille fonts (their widths come from the phone results). Telegram ASCII in a ``` fence is
perfect on Windows (all fence tests passed, 28-84 columns). The U+2840 blank keeps alignment but shows
a faint dot in every blank cell (the user marked that variant broken).
Consequences: previews never draw Braille with the viewer's own font; they draw exact dots with the
target device's cell metrics (js/raster.js geometry), and a "Windows" preview simulates the shear.

## App (phase 3): phone-first, target-first

The target (where the art is going) sets the style, width and dithering; tuning is secondary. The
preview is a generic phone chat bubble at 1:1 CSS px, drawn with the TARGET DEVICE's cell metrics, so
what fits here fits there. Every surface works at 360 px wide and in light and dark.

### Look and feel (sibling of Spiralist)
Spiralist's system, reused as is: warm desk `--desk #e7e3dc` / `#161514`, chrome `#faf9f6` / `#1f1e1c`,
surfaces, borders, radii 8/10/16, shadows, `--ease`, the three-state theme pattern (bare `:root` light,
`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`, `:root[data-theme="dark"]`).
Type: Instrument Serif italic for the wordmark and the few headings, Geist for UI, **Geist Mono** for
ASCII previews (Google Fonts link, like Spiralist, plus the service worker later). Typist's own accent
is a typewriter-ribbon blue so the two sites read as siblings, not copies: `--accent #2448c8`,
`--accent-soft rgba(36,72,200,.12)`, dark `--accent #8aa6ff`. Semantic colours, separate from the
accent: fits `#17803d` / `#5bd083`, tight (amber) `#b26a00` / `#f0b35a`, over / wraps `#d11f1f` /
`#ff7b70` (wrapped rows get a 14% band of it). Tabular numbers for every count.

### Screens (390 x 844 phone; design for the ~660 px visible in Safari)
1. **Welcome** (no photo yet, first visit): a bottom sheet over the stage, where a sample (the pet)
   types itself in as Braille row by row (static with reduced motion). The sheet holds: heading
   "Any photo. *In text.*", one line "Text art you can paste into a comment, a post or a chat.",
   "Where will you paste it?" with 2 x 2 target tiles (Instagram comment · X post · Telegram · Telegram
   channel; each shows its budget, e.g. "2,200 characters"; Instagram preselected) and a small "Just
   save a file" link, then the primary "Choose a photo" (44 px), "Take a photo" (file input with
   `capture`), the 4 sample thumbnails (img/samples/*-thumb.jpg), the privacy line "Runs in your
   browser. Your photo is never uploaded." and "by @winchxyz". Drag and drop and paste work anywhere,
   on every screen. `?for=ig|x|tg|tgc|file` preselects a target; the last target is remembered.
2. **Editor** (the main screen), top to bottom:
   - Top bar 48 px: wordmark "Typist" (serif italic), Undo, Redo, a ⋯ menu (New photo, Theme
     Auto/Light/Dark, Share Typist on X, Star on GitHub, About).
   - Target row 44 px, sideways-scrolling chips: Instagram · X · Telegram · Channel · File. Each chip
     carries a 3 px fit bar (green fits, amber tight, red over or wraps) for the CURRENT art.
   - Preview (the hero): the chat bubble at 1:1 with the art (see Preview). Top-left pills: Crop,
     Compare (hold to see the photo). Top-right: the preview theme (sun / moon; defaults to the
     device theme) and the device (iPhone · Android · Windows). When the art is dark on a dark
     preview, an "Invert for dark mode" chip appears on the bubble.
   - Fit meter 36 px: a 4 px bar and one line, e.g. `404 / 2,200 · 26 of 26 columns · Fits`; states
     Fits / Tight ("may wrap with larger text") / Over ("61 over") / Wraps ("rows wrap on a 390 px
     phone"). Auto-fit on target change says "Resized 40 → 26 wide · Undo" for 4 s.
   - Tabs 44 px: **Look** · **Size** · **Tone**, panel below (scrolls with the page on phones).
     - Look: 5 thumbnails of THEIR photo in the current target's size (Photo, Texture, Sketch, Soft,
       Poster; js/tone.js LOOKS), then Style (Dots / Letters / Blocks) filtered by the target:
       unavailable styles stay visible but disabled, and tapping one explains why ("Letters don't
       line up on Instagram: it uses a proportional font. They do in Telegram."). More: Dithering
       (Atkinson / Floyd–Steinberg / Ordered / Threshold) for Dots, Letters: Shape-aware / Density.
     - Size: width stepper `− 26 columns +` with an "Auto" badge (on when it equals autoFit) and a
       helper "Height follows the crop · 15 rows"; per target: X "Post · 280" / "Long post (Premium)",
       Telegram "Phone" / "Desktop (72)", Channel "Text post" / "Photo caption · 1,024"; Blank cells:
       "Clean" (U+2800, default) / "Windows-safe" (U+2840, faint dots) with one helper line about
       Windows fonts.
     - Tone: Invert for dark mode (switch + helper "Dark dots turn light on dark screens. Invert if
       most people will see it in dark mode."), Brightness, Contrast; More: Gamma, Detail, Edges,
       Auto levels (switch). Sliders: double-click / double-tap resets (Spiralist's sliderRow).
   - Action bar (fixed bottom, safe-area padding): a secondary 44 px button and the primary button
     filling the rest (48 px), label from the target: "Copy for Instagram", "Post on X" (≤ 280) /
     "Copy for X" (long), "Copy for Telegram", "Copy for the channel", "Download". Secondary: "Share"
     on Telegram targets (phones: Web Share; desktop: t.me link), "Copy" on X, "Film" otherwise
     (Film is disabled with the tooltip "Coming soon" until phase 4).
3. **Crop**: the photo replaces the preview with a square frame (outside dimmed); drag to pan, pinch
   or wheel to zoom (logarithmic 0.5–6), two-finger rotate snapping to 0/±90/180 within 4°, Rotate 90°,
   Fit, Cancel, Done. The art in the fit meter / chips updates live while dragging. Keyboard: arrows
   pan, +/- zoom, R rotate, Enter done, Esc cancel.
4. **Copied**: the primary button reads "Copied ✓" for 1.6 s, a toast says the one-line next step
   (Instagram "Copied. Paste it into a comment."; X "Opened X. The art is on your clipboard too.";
   X long "Copied. Paste it into a new post (Premium). The timeline shows N rows, then Show more.";
   Telegram "Copied. Paste it into any chat and send."; File "Saved typist-….txt"). Instagram shows
   once: "Pasting the same long comment again and again can get you an Action Blocked for a while."
5. **Errors**: over budget → primary becomes "Fit to 2,200 (26 wide)" with a small "Copy anyway";
   rows wrap → "Fit to phone (26 wide)" + "Copy anyway"; clipboard blocked → a sheet with the text
   pre-selected in a read-only textarea, "Select all", "Download .txt", and the line "This browser
   blocked copying. The art is selected: press and hold, then Copy."; pop-up blocked → toast with
   "Open X" action.

Desktop (≥ 1024 px): Spiralist's grid: top bar (wordmark, by @winchxyz, New photo, Star with the live
count, Undo/Redo, the primary copy button), stage in the middle with the 390 px phone preview at 1:1
(at ≥ 1280 px light and dark side by side), inspector 336 px on the right (target cards with their
fit bars first, then Look, Size, Tone). Keys: C copy, 1–5 targets, [ ] width, I invert, F crop,
\ compare (hold), Z/Shift+Z undo/redo.

### Preview (js/preview.js)
```js
renderPreview(host, { target, payload /* formatFor result */, grid, device: 'ios'|'android'|'windows',
                      theme: 'light'|'dark', phone: 390, opts }) -> { wrappedRows: number[], cellW, cellH }
```
Generic chrome only, with the platform's name as a text label, never logos: Instagram = a comment
row (32 px avatar circle, "you", the art, "Reply"); X = a post card (40 px avatar, name and handle
placeholders, the art, an action row of 4 generic icons); Telegram = an outgoing bubble (and a
monospace pre block inside it for Letters); Channel = a channel post card with a view counter.
The art is drawn on a canvas at devicePixelRatio: Braille as exact dots (js/raster.js
brailleGeometry, dot colour = the platform's text colour for the theme), ASCII in Geist Mono, blocks as
rectangles. Cell size = FIT fontPx x cellEm (width) and fontPx x lineEm (height) for the target and
mode; for `device: 'windows'` Braille blank cells are 0.651/0.753 as wide as dot cells (the shear is
shown honestly). Rows wider than the bubble wrap onto the next line exactly as the app would, with a
red band and a row number in the gutter; X long shows a dashed "Show more" fold after `foldRow`;
Instagram shows a "more" fold hint for tall comments. `aria-label` on the art: "Text art of your
photo, 26 by 15 characters, for an Instagram comment" (screen readers must not read U+2800 aloud).

### Copy (js/copy.js) and files (js/export.js)
```js
copyFor(target, payload, { event, device }) -> Promise<{ how: 'clipboard'|'intent'|'share'|'manual', hint }>
copyText(text, html = null)          // ClipboardItem built synchronously in the gesture (Safari);
                                     // text/html only for Telegram ASCII on a fine pointer; fallbacks:
                                     // writeText -> execCommand('copy') -> 'manual'
openXIntent(text)                    // x.com/intent/tweet (links.js), clipboard first, same gesture
shareTelegram(payload)               // phones: navigator.share({text}); desktop: t.me/share/url when
                                     // linkFits(), else clipboard
exportTxt(payload) · exportPNG(grid, {scale, ink, paper, transparent}) · exportSVG(grid, {ink, paper})
· exportHTML(grid, {ink, paper, colour}) · downloadBlob(blob, name) · fileName(parts, ext)
```
PNG / SVG / HTML draw the Grid (dots, glyphs in Geist Mono or a monospace stack, colour blocks with
fg/bg), not the photo. File names `typist-<target>-<cols>x<rows>.<ext>`.

### State and storage
`js/app.js` owns one state object `{ target, targetOpts: {x: 'post'|'long', tg: 'phone'|'desktop',
tgc: 'post'|'caption'}, mode, look, dither, ascii, cols (null = auto), blank: 'u2800'|'dot', tone,
crop, device, previewTheme }`, persisted with js/store.js (settings; the last photo in IndexedDB
so a reload keeps working) and undoable with js/history.js (one step per gesture). Test hooks:
`window.TY = { state, grid, payload, ready }` and `window.__done` once the first art is drawn.

### Download PNG for every art (user request, 2026-09-23 — MUST)
Every artwork can be saved as a PNG from every target, not only from File:
- The action bar always has a **PNG** button (download icon + "PNG", 44 px) next to the secondary
  button, on every target, on phones and desktop (desktop: in the top bar next to the copy button
  too). Keyboard: S. The File target additionally lists .txt, PNG, SVG and HTML.
- The PNG is exactly the art being copied: the same Grid and the same blank option, drawn with
  js/raster.js (Braille as dots, ASCII in Geist Mono, colour blocks with their colours) on paper,
  with a small margin. Theme follows invert: dark dots on white when not inverted, light dots on
  near-black when inverted. Scale: 2x the phone preview metrics by default (crisp on phones),
  with a "Large (4x)" choice in a small menu on long-press / the chevron.
- File name `typist-<target>-<cols>x<rows>.png`. On phones, when `navigator.canShare({files})`
  holds, hand the file to the share sheet (so it can go straight to Photos / Instagram), else
  download; toast "Saved typist-ig-26x15.png".
- Also offer PNG from each Look thumbnail's long-press / context menu (downloads that look's art).
- e2e: the download event fires with a valid PNG (check the signature and the pixel size) for every
  target and mode.

### Reddit target (2026-09-23)
`reddit` in js/targets.js: a post or a comment (limit 10,000, the comment budget; posts take
40,000). Reddit Markdown joins single lines into one paragraph, so the payload is a code block:
every row indented by 4 spaces (`TARGETS.reddit.indent`), which works on new Reddit, old.reddit and
the apps (``` does not work on old.reddit). Dots (U+2800 blanks, no U+0020 after the indent) or
Letters (printable ASCII, the fence rules). Counts include the indents. A code block scrolls
sideways instead of wrapping, so too-wide art warns that readers scroll. FIT.reddit: ~13 px
monospace, Braille 0.75 em, ASCII 0.6 em, text column = screen - 48. reddit.com's default rich-text
editor ignores the indent (it keeps the spaces and sets the rows in a proportional font), so the
payload also has `html` = `<pre><code>` of the unindented rows, written to the clipboard on every
device: the rich-text editor reads the HTML and makes a code block, Markdown mode and the apps read
the plain text (tests/reddit-paste.e2e.mjs pastes both ways). A one-time tip says to press Code
block if Reddit still shows plain lines. The preview is a generic comment with a grey code block.

### Steam, YouTube and Twitch targets (2026-09-24)
The UI is apps + variants: eight app chips (Instagram, X, Telegram, Reddit, Steam, YouTube, Twitch,
File) and, for apps with more than one place, a strip above the preview (X: Free / Premium;
Telegram: Chat / Channel / Caption; Steam: Comment / Summary / Info box; YouTube: Comment / Live
chat). `?for=` takes an app or a target id (`?for=steamb` opens Steam on Info box).
- Steam (`steamc` 1,000, `steamp` 4,000, `steamb` 8,000) counts UTF-8 bytes (`counter: 'utf8'`):
  a Braille cell is 3 bytes, a line break 1; `countFor` = 3 x cells + rows - 1. Steam has no code
  block and collapses spaces, so Dots only. Read on PCs: the preview is a desktop-width dark page
  (one preview, no light mode; the invert banner says Steam is dark), and the art auto-fits the
  desktop widths (FIT desktop 48 / 48 / 60). Warning `steam-bytes`: text past the limit is cut
  off when saved.
- YouTube comment (`ytc`): 10,000 UTF-16 units, Braille rows; warning `yt-review` (ASCII-art spam
  screening, "Read more" fold).
- Single-line chats (`flow: true`: `ytlive` 200, `twitch` 500): Enter sends, so no line breaks. The
  payload is one line: a blank lead-in row (so a username cannot pull row 1 onto its line), then
  every row as an unbroken Braille word, joined by single U+0020. `countFor` = (rows + 1) x cols +
  rows. The chat's word wrap stacks the rows iff a row fits and two rows plus a space do not:
  `flowRange` = [row width, 2 x row width + space] in px (FIT spaceEm 0.27); warnings `flow-width`
  (the range) and `flow-narrow` (the desktop chat, FIT chatDesktop 320 / 330 px, is outside it).
  Twitch 30 x 15 = 495 characters, YouTube live 17 x 10 = 197. Warnings `twitch-duplicate` (same
  message within 30 s), `yt-hold` (held for review).
- Preview families: `yt` (comment with avatar, @you, thumbs, Reply), `steam` (dark card: a comment
  with a square avatar, or a Summary / Custom Info Box label), `chat` (three chat lines, then
  `you` and the art laid out by `layoutFlow`, which reproduces the chat's greedy word wrap after
  the username; lines holding two rows get a red band; a caption names the widths that line up).
  On the Windows device the chat is the desktop column and the narrower Windows blanks count.
- The Windows slant note (fit line, "Windows-safe blanks") shows for Steam, YouTube and Twitch on
  every device, as for Telegram and Reddit: most of their readers are on PCs.

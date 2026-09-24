// Where the art is going, and the exact text each place needs.
//
// formatFor(target, grid) turns a Grid into the payload for one target and says whether it fits:
// the character budget (counted the platform's way, see count.js) and the width of a phone screen
// (a row wider than the bubble soft-wraps and destroys the art). Everything here is pure.
//
// Why the Braille rules: Instagram and X draw text in proportional fonts, where only Braille lines
// up (all 256 patterns share one width in the fallback font, except U+2800 on Windows' Segoe UI
// Symbol, hence the `blank: 'dot'` option). Both apps trim spaces at line ends and collapse empty
// lines, so a Braille payload never contains U+0020 and never an empty line: every blank cell is
// U+2800 (or U+2840 with blank 'dot') and every row has the same number of cells.
// Telegram turns a ``` fence into a monospace pre block that keeps spaces, the one place classic
// ASCII lines up; only printable ASCII goes inside and never a backtick.

import { utf16Length, utf8Length, xWeightedLength, findUrlsX, X_MAX } from './count.js';

export const PHONES = [360, 390, 430];

export const TARGETS = {
  ig: { id: 'ig', name: 'Instagram comment', short: 'Instagram', limit: 2200, counter: 'utf16',
        modes: ['braille'], defaultMode: 'braille' },
  x: { id: 'x', name: 'X post', short: 'X', limit: X_MAX, counter: 'x', modes: ['braille'], defaultMode: 'braille' },
  xlong: { id: 'xlong', name: 'X long post (Premium)', short: 'X Premium', limit: 25000, fold: X_MAX, counter: 'x',
           modes: ['braille'], defaultMode: 'braille' },
  tg: { id: 'tg', name: 'Telegram message', short: 'Telegram', limit: 4096, counter: 'utf16',
        modes: ['braille', 'ascii'], defaultMode: 'braille' },
  tgc: { id: 'tgc', name: 'Telegram channel post', short: 'Channel', limit: 4096, captionLimit: 1024, counter: 'utf16',
         modes: ['braille', 'ascii'], defaultMode: 'braille' },
  plain: { id: 'plain', name: 'Plain text', short: 'Text', limit: Infinity, counter: 'utf16',
           modes: ['braille', 'ascii', 'blocks'], defaultMode: 'braille' },
  // Reddit Markdown joins single lines into one paragraph, so art only survives in a code block:
  // every row indented by 4 spaces (works on new Reddit, old.reddit and the apps, unlike ```).
  // A comment takes 10,000 characters, a post 40,000; the smaller one is the budget.
  reddit: { id: 'reddit', name: 'Reddit post or comment', short: 'Reddit', limit: 10000, postLimit: 40000,
            counter: 'utf16', modes: ['braille', 'ascii'], defaultMode: 'braille', indent: 4 },
  // YouTube comments and Steam text keep line breaks and use proportional fonts: Dots, like Instagram
  ytc: { id: 'ytc', name: 'YouTube comment', short: 'YouTube', limit: 10000, counter: 'utf16',
         modes: ['braille'], defaultMode: 'braille' },
  // Steam counts UTF-8 bytes (a long-standing bug report): 1,000 bytes is ~333 Braille cells.
  // Profile fields may count characters; bytes is the safe side. No [code] in any of them.
  steamc: { id: 'steamc', name: 'Steam comment', short: 'Steam', limit: 1000, counter: 'utf8',
            modes: ['braille'], defaultMode: 'braille' },
  steamp: { id: 'steamp', name: 'Steam profile summary', short: 'Steam summary', limit: 4000, counter: 'utf8',
            modes: ['braille'], defaultMode: 'braille' },
  steamb: { id: 'steamb', name: 'Steam Custom Info Box', short: 'Steam info box', limit: 8000, counter: 'utf8',
            modes: ['braille'], defaultMode: 'braille' },
  // Single-line chats: Enter sends the message, so there are no line breaks. Each row is an unbroken
  // run of Braille and the rows are joined by single spaces: the chat's own word wrap stacks them,
  // as long as a row fits the chat and two rows do not (flowRange). A blank lead-in row goes
  // first, so a short username can never pull the first row up onto its line.
  ytlive: { id: 'ytlive', name: 'YouTube live chat', short: 'Live chat', limit: 200, counter: 'utf16',
            modes: ['braille'], defaultMode: 'braille', flow: true },
  twitch: { id: 'twitch', name: 'Twitch chat', short: 'Twitch', limit: 500, counter: 'utf16',
            modes: ['braille'], defaultMode: 'braille', flow: true },
};

// How big a cell is on the target and how wide its text column is, per mode.
//   fontPx   text size in CSS px;  cellEm  advance of one cell;  lineEm  line height
//   text     [scale, minus]: width of the text column = scale * screen - minus (CSS px)
//   cols     measured columns per screen width; once set it wins over the geometry
//   desktop  columns for the desktop apps
// Seeds from research (Segoe UI Symbol Braille 0.753 em, Noto Sans Symbols 2 0.700 em; monospace
// 0.6 em). `calibrated: false` until the paste-test kit results from real phones replace them.
const BRAILLE_PROP = { fontPx: 15, cellEm: 0.75, lineEm: 1.3 };
export const FIT = {
  calibrated: false,
  ig: { braille: { ...BRAILLE_PROP, text: [1, 88], desktop: 40 } },
  x: { braille: { ...BRAILLE_PROP, lineEm: 1.33, text: [1, 84], desktop: 40 } },
  xlong: { braille: { ...BRAILLE_PROP, lineEm: 1.33, text: [1, 84], desktop: 40 } },
  tg: {
    braille: { fontPx: 16, cellEm: 0.75, lineEm: 1.3, text: [0.8, 24], desktop: 48 },
    ascii: { fontPx: 15, cellEm: 0.6, lineEm: 1.3, text: [0.8, 24], desktop: 72 },
  },
  tgc: {
    braille: { fontPx: 16, cellEm: 0.75, lineEm: 1.3, text: [0.92, 24], desktop: 56 },
    ascii: { fontPx: 15, cellEm: 0.6, lineEm: 1.3, text: [0.92, 24], desktop: 80 },
  },
  plain: {
    braille: { ...BRAILLE_PROP, text: [1, 32], desktop: 100 },
    ascii: { fontPx: 15, cellEm: 0.6, lineEm: 1.3, text: [1, 32], desktop: 120 },
    blocks: { fontPx: 15, cellEm: 0.6, lineEm: 1.2, text: [1, 32], desktop: 120 },
  },
  // a code block in Reddit's monospace, about 13 px on phones; Braille glyphs come from the
  // system's Braille font (~0.75 em a cell) even inside it
  reddit: {
    braille: { fontPx: 13, cellEm: 0.75, lineEm: 1.35, text: [1, 48], desktop: 72 },
    ascii: { fontPx: 13, cellEm: 0.6, lineEm: 1.35, text: [1, 48], desktop: 96 },
  },
  ytc: { braille: { fontPx: 14, cellEm: 0.75, lineEm: 1.43, text: [1, 72], desktop: 60 } },
  // Steam is read on PCs: the desktop widths are the ones that count (the Info Box fits ~60 cells
  // according to Steam's own guides; the summary and comments are narrower)
  steamc: { braille: { fontPx: 13, cellEm: 0.753, lineEm: 1.4, text: [1, 40], desktop: 48 } },
  steamp: { braille: { fontPx: 13, cellEm: 0.753, lineEm: 1.4, text: [1, 40], desktop: 48 } },
  steamb: { braille: { fontPx: 13, cellEm: 0.753, lineEm: 1.4, text: [1, 40], desktop: 60 } },
  // flow targets: `text` is the chat column on a phone, `chatDesktop` its width in the desktop
  // chat (px); spaceEm: the width of the space that separates two rows
  ytlive: { braille: { fontPx: 13, cellEm: 0.75, lineEm: 1.23, text: [1, 60], chatDesktop: 330, spaceEm: 0.27 } },
  twitch: { braille: { fontPx: 13, cellEm: 0.75, lineEm: 1.54, text: [1, 20], chatDesktop: 320, spaceEm: 0.27 } },
};

const BLANK = 0x2800, BLANK_DOT = 0x2840;
const QUADS = new Set([0x20, 0x2580, 0x2584, 0x2588, 0x258c, 0x2590, 0x2596, 0x2597, 0x2598, 0x2599,
  0x259a, 0x259b, 0x259c, 0x259d, 0x259e, 0x259f]);

function target(id) {
  const t = TARGETS[id];
  if (!t) throw new Error(`Unknown target '${id}'`);
  return t;
}
const fitOf = (id, mode) => {
  const f = FIT[id] || FIT.plain;
  return f[mode] || f.braille || FIT.plain[mode] || FIT.plain.braille;
};
const fencedAscii = (id, mode) => mode === 'ascii' && (id === 'tg' || id === 'tgc');

export const modeAllowed = (id, mode) => target(id).modes.includes(mode);
export const limitFor = (id, opts = {}) => (id === 'tgc' && opts.caption ? TARGETS.tgc.captionLimit : target(id).limit);
export const unitOf = id => ({ x: 'weighted', utf8: 'bytes' }[target(id).counter] || 'utf16');

/** Cell width / height as the target renders it. */
export function cellAspect(id, mode) {
  const f = fitOf(id, mode);
  return f.cellEm / f.lineEm;
}

/** Rows that keep a square crop square on the target. */
export function rowsFor(cols, aspect) {
  return Math.max(1, Math.round(cols * aspect));
}

/** Widest grid that stays on one line per row. phone: 360 | 390 | 430 | 'desktop'. */
export function maxCols(id, mode, { phone = 390 } = {}) {
  const f = fitOf(id, mode);
  if (TARGETS[id] && TARGETS[id].flow) return Math.max(1, Math.floor(chatWidth(id, mode, phone) / (f.fontPx * f.cellEm)));
  if (phone === 'desktop') return f.desktop;
  if (f.cols && f.cols[phone]) return f.cols[phone];
  const [scale, minus] = f.text;
  return Math.max(1, Math.floor((scale * phone - minus) / (f.fontPx * f.cellEm)));
}

/** Width of a single-line chat's text column in CSS px (flow targets). */
export function chatWidth(id, mode, phone = 390) {
  const f = fitOf(id, mode);
  if (phone === 'desktop') return f.chatDesktop;
  const [scale, minus] = f.text;
  return scale * phone - minus;
}

/**
 * Chat widths (CSS px) in which `cols`-wide rows stack one per line: a row must fit (width >= a
 * row) and two rows plus the space between them must not (width < two rows + a space).
 */
export function flowRange(id, mode, cols) {
  const f = fitOf(id, mode);
  const row = cols * f.fontPx * f.cellEm, space = f.fontPx * (f.spaceEm || 0.27);
  return { min: Math.ceil(row), max: Math.floor(2 * row + space) };
}

/**
 * The payload's count without building it. Exact for every mode a target supports; for ASCII on a
 * proportional X target (unsupported) it is an upper bound (letters weigh 1, blanks 2).
 */
export function countFor(id, mode, cols, rows, opts = {}) {
  const t = target(id);
  const cells = cols * rows, breaks = Math.max(0, rows - 1);
  if (t.counter === 'x') return 2 * cells + breaks;
  // UTF-8: every Braille cell (a blank too) is 3 bytes, a line break 1
  if (t.counter === 'utf8') return 3 * cells + breaks;
  // flow: a blank lead-in row and one space before every row
  if (t.flow) return (rows + 1) * cols + rows;
  return cells + breaks + (fencedAscii(id, mode) ? 8 : 0) + (t.indent || 0) * rows;
}

/** Largest grid (square crop) that fits both the budget and the phone. */
export function autoFit(id, mode, opts = {}) {
  const aspect = opts.aspect || cellAspect(id, mode);
  const limit = limitFor(id, opts);
  const top = Math.max(1, Math.min(opts.maxCols || Infinity, maxCols(id, mode, opts)));
  for (let cols = top; cols >= 1; cols--) {
    const rows = rowsFor(cols, aspect);
    if (countFor(id, mode, cols, rows, opts) <= limit) return { cols, rows };
  }
  return { cols: 1, rows: 1 };
}

// ------------------------------------------------------------------------------------ rows

function cellsOf(grid) {
  const cols = Math.max(0, grid.cols | 0), rows = Math.max(0, grid.rows | 0);
  return { cols, rows, cp: grid.cp || [] };
}

/** Rows as arrays of code points after the target's per-cell rules. */
function mapRows(grid, fn) {
  const { cols, rows, cp } = cellsOf(grid);
  const out = [];
  let foreign = 0;
  for (let y = 0; y < rows; y++) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      const r = fn(cp[y * cols + x] ?? 0x20);
      if (r.foreign) foreign++;
      s += String.fromCodePoint(r.cp);
    }
    out.push(s);
  }
  return { lines: out, foreign };
}

const printable = c => c > 0x20 && c < 0x7f && c !== 0x60;

// A cell of a Braille grid: blank -> U+2800 (or U+2840), dots kept, anything else is a bug
// upstream and becomes a blank so the row keeps its width.
const brailleCell = blank => c => {
  if (c > BLANK && c <= 0x28ff) return { cp: c };
  if (c === BLANK || c === 0x20 || c === 0) return { cp: blank };
  return { cp: blank, foreign: true };
};
// Inside a Telegram fence: printable ASCII only; a backtick would close the fence -> apostrophe.
const fenceCell = c => {
  if (c === 0x60) return { cp: 0x27 };
  if (printable(c) || c === 0x20) return { cp: c };
  return { cp: 0x20, foreign: c !== 0 };
};
// Letters or blocks in a proportional chat: every space is a Braille blank so nothing is trimmed.
const chatCell = (mode, blank) => c => {
  if (mode === 'ascii' && printable(c)) return { cp: c };
  if (mode === 'ascii' && c === 0x60) return { cp: 0x27 };
  if (mode === 'blocks' && c !== 0x20 && QUADS.has(c)) return { cp: c };
  if (mode === 'braille') return brailleCell(blank)(c);
  return { cp: blank, foreign: !(c === 0x20 || c === 0 || c === BLANK) };
};
// Plain text (files): printable ASCII or the block set, spaces kept.
const plainCell = mode => c => {
  if (mode === 'ascii') return fenceCell(c);
  if (mode === 'blocks') return QUADS.has(c) ? { cp: c } : { cp: 0x20, foreign: c !== 0 && c !== BLANK };
  return brailleCell(BLANK)(c);
};

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------------------------ format

const MODE_WARN = {
  ascii: 'Letters don’t line up here: this app uses a proportional font. Use dots, or Telegram for letters.',
  blocks: 'Blocks only line up in files (PNG, SVG, HTML or .txt).',
};

/**
 * The exact payload for a target.
 * opts: { blank: 'u2800' | 'dot', caption: false (tgc: media caption), phone: 390 | 'desktop' }
 */
export function formatFor(id, grid, opts = {}) {
  const t = target(id);
  const mode = grid.mode;
  const blank = opts.blank === 'dot' ? BLANK_DOT : BLANK;
  const fenced = fencedAscii(id, mode);
  const warnings = [];
  const { cols, rows } = cellsOf(grid);

  // Reddit's code block is monospace like a Telegram pre block: printable ASCII for letters
  const codeBlock = !!t.indent;
  let cellFn;
  if (fenced || (codeBlock && mode === 'ascii')) cellFn = fenceCell;
  else if (mode === 'braille') cellFn = brailleCell(blank);
  else if (id === 'plain' || codeBlock) cellFn = plainCell(mode);
  else cellFn = chatCell(mode, blank);
  const { lines, foreign } = mapRows(grid, cellFn);

  const pad = ' '.repeat(t.indent || 0);
  const body = t.flow
    ? [String.fromCodePoint(blank).repeat(cols), ...lines].join(' ')
    : (pad ? lines.map(l => pad + l) : lines).join('\n');
  const text = (fenced ? '```\n' + body + '\n```' : body).normalize('NFC');
  // Reddit's rich-text editor ignores the Markdown indent (it keeps the spaces and sets the rows in
  // a proportional font) but turns pasted HTML <pre><code> into a code block: the clipboard carries
  // both, the plain text for Markdown mode and the apps, the HTML for the rich-text editor.
  const html = fenced ? '<pre>' + escapeHtml(body) + '</pre>'
    : codeBlock ? '<pre><code>' + escapeHtml(lines.join('\n')) + '</code></pre>' : null;

  const limit = limitFor(id, opts);
  const count = t.counter === 'x' ? xWeightedLength(text) : t.counter === 'utf8' ? utf8Length(text) : utf16Length(text);
  const fits = count <= limit;
  const over = Math.max(0, count - limit);
  const phone = opts.phone || 390;
  const widest = id === 'plain' ? Infinity : maxCols(id, mode, { phone });
  const wraps = cols > widest;

  let foldRow = null;
  if (t.fold) {
    let acc = 0;
    for (let y = 0; y < lines.length; y++) {
      acc += xWeightedLength(lines[y]) + (y ? 1 : 0);
      if (acc > t.fold) { foldRow = y; break; }
    }
  }

  if (!cols || !rows) warnings.push({ code: 'empty', level: 'error', message: 'There is no art to copy yet.' });
  if (!modeAllowed(id, mode) || (mode === 'blocks' && id !== 'plain')) {
    warnings.push({ code: 'mode', level: 'error', message: MODE_WARN[mode] || 'This style does not work here.' });
  }
  if (!fits) {
    const fit = autoFit(id, mode, opts);
    warnings.push({ code: 'over', level: 'error', fitCols: fit.cols,
      message: `${over.toLocaleString('en-US')} over the ${limit.toLocaleString('en-US')} limit. ${fit.cols} columns fit.` });
  }
  if (wraps) {
    // a Reddit code block does not wrap: it scrolls sideways, which hides the art's right side
    const what = codeBlock ? 'readers have to scroll sideways' : 'rows will wrap';
    warnings.push({ code: 'too-wide', level: 'warn', fitCols: widest,
      message: phone === 'desktop'
        ? `Wider than the desktop app (${widest} columns): ${what}.`
        : `Wider than a ${phone} px phone (${widest} columns): ${what}.` });
  }
  if (foreign) warnings.push({ code: 'foreign', level: 'warn', message: `${foreign} characters could not be shown and became blanks.` });
  if (t.counter === 'x' && findUrlsX(text).length) {
    warnings.push({ code: 'url', level: 'warn', message: 'Part of the art looks like a web address; X will turn it into a link.' });
  }
  if (foldRow != null) {
    warnings.push({ code: 'fold', level: 'info', foldRow,
      message: `The timeline shows about ${foldRow} rows, then “Show more”.` });
  }
  if (t.flow && cols && rows) {
    const range = flowRange(id, mode, cols), desk = chatWidth(id, mode, 'desktop');
    warnings.push({ code: 'flow-width', level: 'info', min: range.min, max: range.max,
      message: `Lines up in chats ${range.min}–${range.max} px wide.` });
    if (range.max <= desk) {
      warnings.push({ code: 'flow-narrow', level: 'warn',
        message: `In a ${desk} px chat two rows share a line: make the art wider.` });
    }
  }
  // what each place does to art, from its own help pages and long-running reports
  if (id === 'twitch') warnings.push({ code: 'twitch-duplicate', level: 'info',
    message: 'Twitch refuses the same message twice within 30 seconds, and some channels time out chat art.' });
  if (id === 'ytlive') warnings.push({ code: 'yt-hold', level: 'info',
    message: 'Creators can hold chat messages for review, so a stream may not show it.' });
  if (id === 'ytc') warnings.push({ code: 'yt-review', level: 'info',
    message: 'YouTube checks comments for ASCII-art spam and may hold one for review. Long comments fold behind “Read more”.' });
  if (t.counter === 'utf8') warnings.push({ code: 'steam-bytes', level: 'info',
    message: 'Steam counts bytes: each Braille character takes 3. Text past the limit is cut off when you save.' });
  if (codeBlock) {
    warnings.push({ code: 'reddit-markdown', level: 'info',
      message: 'If Reddit shows the art as plain lines, select it and press Code block (or paste it again in Markdown mode).' });
  }
  if (id === 'ig') {
    if (rows > 12) warnings.push({ code: 'ig-more', level: 'info', message: 'Long comments can fold behind “more”.' });
    if (count > 300) warnings.push({ code: 'ig-repeat', level: 'info',
      message: 'Pasting the same long comment again and again can get you an “Action Blocked” for a while.' });
  }

  return { target: id, mode, text, html, count, limit, unit: unitOf(id), fits, over, cols, rows,
           maxCols: widest, wraps, foldRow, warnings };
}

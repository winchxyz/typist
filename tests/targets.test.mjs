// Formatter tests (node, plain assert): node tests/targets.test.mjs
// One test per platform rule in SPEC.md, plus seeded property tests over random grids.
import assert from 'node:assert/strict';
import {
  TARGETS, FIT, PHONES, formatFor, autoFit, countFor, maxCols, rowsFor, cellAspect, limitFor, modeAllowed,
  chatWidth, flowRange, unitOf,
} from '../js/targets.js';
import { xWeightedLength } from '../js/count.js';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push('ok   ' + name); } catch (e) { fail++; results.push('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function grid(mode, cols, rows, f) {
  const cp = new Uint32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) cp[y * cols + x] = f(x, y);
  return { mode, cols, rows, cp, fg: null, bg: null, ink: 0.5 };
}
const B = 0x2800;
const lines = t => t.split('\n');
const cps = s => [...s].map(c => c.codePointAt(0));

// ---------------------------------------------------------------- common rules
test('LF only, no trailing newline, no CR, no BOM, NFC - every target and mode', () => {
  const r = rng(1);
  for (const id of Object.keys(TARGETS)) for (const mode of ['braille', 'ascii', 'blocks']) {
    const g = grid(mode, 9, 5, () => (mode === 'braille' ? B + ((r() * 256) | 0) : mode === 'ascii' ? 0x20 + ((r() * 95) | 0) : 0x2588));
    const { text } = formatFor(id, g);
    assert.ok(!text.includes('\r'), `${id}/${mode} CR`);
    assert.ok(!text.endsWith('\n') && !text.startsWith('\n'), `${id}/${mode} edge newline`);
    assert.ok(!/[﻿￾￿]/.test(text), `${id}/${mode} BOM`);
    assert.equal(text, text.normalize('NFC'));
  }
});

// ---------------------------------------------------------------- Braille rules (ig, x, xlong, tg, tgc)
const BRAILLE_IDS = ['ig', 'x', 'xlong', 'tg', 'tgc', 'plain'];
test('Braille: every space becomes U+2800, never U+0020 anywhere', () => {
  const g = grid('braille', 6, 3, (x) => (x % 2 ? 0x20 : 0x28ff));
  for (const id of BRAILLE_IDS) {
    const { text } = formatFor(id, g);
    assert.ok(!text.includes(' '), id);
    assert.equal(lines(text)[0], '⣿⠀⣿⠀⣿⠀');
  }
});

test('Braille: blank rows are filled with U+2800 and never collapse', () => {
  const g = grid('braille', 4, 5, (x, y) => (y % 2 ? B : 0x2801));
  for (const id of BRAILLE_IDS) {
    const ls = lines(formatFor(id, g).text);
    assert.equal(ls.length, 5, id);
    assert.equal(ls[1], '⠀'.repeat(4));
    assert.ok(!ls.some(l => l === ''), 'no empty line');
  }
});

test('Braille: no line starts or ends with U+0020, rows all the same width', () => {
  const g = grid('braille', 7, 4, (x) => (x === 0 || x === 6 ? 0x20 : 0x2812));
  for (const id of BRAILLE_IDS) {
    const ls = lines(formatFor(id, g).text);
    assert.ok(ls.every(l => !/^ | $/.test(l)), id);
    assert.equal(new Set(ls.map(l => [...l].length)).size, 1, id);
  }
});

test('Braille: blank "dot" swaps every blank cell for U+2840 and keeps the dots', () => {
  const g = grid('braille', 3, 2, (x) => (x === 1 ? 0x28ff : B));
  const { text } = formatFor('ig', g, { blank: 'dot' });
  assert.equal(text, '⡀⣿⡀\n⡀⣿⡀');
  assert.ok(!text.includes('⠀'));
});

test('Braille: never ASCII or emoji in the art rows (foreign code points become blanks, with a warning)', () => {
  const g = grid('braille', 4, 1, (x) => [0x41, 0x1f600, 0x2801, 0x2588][x]);
  const res = formatFor('x', g);
  assert.deepEqual(cps(res.text), [B, B, 0x2801, B]);
  assert.ok(res.warnings.some(w => w.code === 'foreign'));
});

// ---------------------------------------------------------------- Instagram
test('Instagram: 2,200 UTF-16 units, Braille is 1 unit per cell and newlines count', () => {
  assert.equal(limitFor('ig'), 2200);
  const g = grid('braille', 30, 20, () => 0x28ff);
  const res = formatFor('ig', g);
  assert.equal(res.count, 30 * 20 + 19);
  assert.equal(res.count, res.text.length);
  assert.ok(res.fits);
  const big = formatFor('ig', grid('braille', 50, 44, () => B));
  assert.equal(big.count, 50 * 44 + 43);
  assert.ok(!big.fits && big.over === big.count - 2200);
  assert.ok(big.warnings.some(w => w.code === 'over' && w.level === 'error'));
});

test('Instagram: long comments get the "more" and "Action Blocked" hints', () => {
  const res = formatFor('ig', grid('braille', 26, 15, () => B));
  const codes = res.warnings.map(w => w.code);
  assert.ok(codes.includes('ig-more') && codes.includes('ig-repeat'));
});

// ---------------------------------------------------------------- X
test('X: weighted count, Braille weighs 2, newline 1; free posts allow 280', () => {
  const res = formatFor('x', grid('braille', 15, 8, () => 0x2801));
  assert.equal(res.count, 2 * 15 * 8 + 7);
  assert.equal(res.count, xWeightedLength(res.text));
  assert.equal(res.limit, 280);
  assert.equal(res.unit, 'weighted');
  assert.ok(res.fits);
  assert.ok(!formatFor('x', grid('braille', 16, 9, () => B)).fits, '16 x 9 = 296');
});

test('X long: 25,000 with the timeline fold reported', () => {
  const res = formatFor('xlong', grid('braille', 20, 30, () => B));
  assert.equal(res.limit, 25000);
  assert.ok(res.fits);
  // rows of 40 weighted + 1 newline: rows 0..5 end at 40, 81, 122, 163, 204, 245; row 6 ends at 286
  assert.equal(res.foldRow, 6);
  assert.ok(res.warnings.some(w => w.code === 'fold'));
  assert.equal(formatFor('xlong', grid('braille', 10, 6, () => B)).foldRow, null);
});

test('X: letters and blocks warn that they cannot line up', () => {
  for (const mode of ['ascii', 'blocks']) {
    const res = formatFor('x', grid(mode, 5, 2, () => (mode === 'ascii' ? 0x41 : 0x2588)));
    assert.ok(res.warnings.some(w => w.code === 'mode' && w.level === 'error'), mode);
  }
});

test('X: URL-like letters warn and count 23', () => {
  const g = grid('ascii', 4, 1, (x) => cps('a.co')[x]);
  const res = formatFor('x', g);
  assert.ok(res.warnings.some(w => w.code === 'url'));
  assert.equal(res.count, 23);
});

// ---------------------------------------------------------------- Telegram
test('Telegram: Braille is plain (no fence) by default, 4,096 units', () => {
  const res = formatFor('tg', grid('braille', 3, 2, () => 0x2801));
  assert.equal(res.text, '⠁⠁⠁\n⠁⠁⠁');
  assert.equal(res.limit, 4096);
  assert.equal(res.html, null);
});

test('Telegram ASCII: fenced with the fence alone on its line, counts include the fences', () => {
  const g = grid('ascii', 5, 2, (x, y) => cps(y ? '(o o)' : ' /_\\ ')[x]);
  const res = formatFor('tg', g);
  assert.equal(res.text, '```\n /_\\ \n(o o)\n```');
  assert.equal(res.count, res.text.length);
  assert.equal(res.count, countFor('tg', 'ascii', 5, 2));
  assert.equal(res.html, '<pre> /_\\ \n(o o)</pre>');
});

test('Telegram ASCII: backticks and non-printables never get inside the fence, leading spaces kept', () => {
  const g = grid('ascii', 6, 1, (x) => [0x20, 0x20, 0x60, 0x09, 0x2800, 0x41][x]);
  const res = formatFor('tgc', g);
  assert.equal(res.text, "```\n  '  A\n```");
});

test('Telegram channel: caption budget is 1,024', () => {
  assert.equal(limitFor('tgc'), 4096);
  assert.equal(limitFor('tgc', { caption: true }), 1024);
  const res = formatFor('tgc', grid('braille', 40, 26, () => B), { caption: true });
  assert.equal(res.limit, 1024);
  assert.ok(!res.fits);
});

// ---------------------------------------------------------------- Reddit
test('Reddit: every row is a 4-space-indented code block line, Braille rows carry no other space', () => {
  const g = grid('braille', 5, 3, (x, y) => (x === y ? 0x28ff : x % 2 ? 0x20 : B));
  const res = formatFor('reddit', g);
  const ls = lines(res.text);
  assert.equal(ls.length, 3);
  for (const l of ls) {
    assert.ok(l.startsWith('    ') && !l.startsWith('     '), JSON.stringify(l));
    const art = l.slice(4);
    assert.ok(!art.includes(' '), 'no U+0020 inside a Braille row');
    assert.equal([...art].length, 5);
  }
  assert.equal(res.count, res.text.length);
  assert.equal(res.count, countFor('reddit', 'braille', 5, 3));
  assert.equal(res.limit, 10000);
  assert.ok(!res.text.includes('\r') && !res.text.endsWith('\n'));
  assert.ok(res.warnings.some(w => w.code === 'reddit-markdown' && w.level === 'info'));
});

test('Reddit: Letters are printable ASCII after the indent, backticks never survive, spacing kept', () => {
  const g = grid('ascii', 6, 2, (x, y) => (y ? cps(' (o o)')[x] : [0x60, 0x20, 0x2f, 0x5f, 0x5c, 0x09][x]));
  const res = formatFor('reddit', g);
  assert.equal(res.text, "    ' /_\\ \n     (o o)");
  assert.equal(res.count, countFor('reddit', 'ascii', 6, 2));
});

test('Reddit: the HTML twin is a <pre><code> block of the same rows without the indent, escaped', () => {
  const g = grid('ascii', 5, 2, (x, y) => cps(y ? '<o&o>' : ' /_\\ ')[x]);
  const res = formatFor('reddit', g);
  assert.equal(res.html, '<pre><code> /_\\ \n&lt;o&amp;o&gt;</code></pre>');
  const d = formatFor('reddit', grid('braille', 3, 2, (x) => (x === 1 ? 0x28ff : B)));
  assert.equal(d.html, '<pre><code>⠀⣿⠀\n⠀⣿⠀</code></pre>');
  assert.equal(formatFor('ig', grid('braille', 3, 2, () => B)).html, null, 'chats that read plain text get no HTML');
});

test('Reddit: blocks warn, too-wide art says readers scroll sideways, autoFit fits a phone', () => {
  assert.ok(formatFor('reddit', grid('blocks', 3, 1, () => 0x2588)).warnings.some(w => w.code === 'mode'));
  const w = maxCols('reddit', 'braille', { phone: 390 });
  const wide = formatFor('reddit', grid('braille', w + 3, 4, () => B));
  const warn = wide.warnings.find(x => x.code === 'too-wide');
  assert.ok(warn && /scroll sideways/.test(warn.message));
  const fit = autoFit('reddit', 'braille');
  assert.ok(fit.cols <= w && countFor('reddit', 'braille', fit.cols, fit.rows) <= 10000);
  assert.ok(autoFit('reddit', 'ascii').cols > fit.cols, 'letters are narrower cells, so more fit');
});

test('Blocks: file-only; in a chat they warn, in plain text they pass through', () => {
  const g = grid('blocks', 3, 1, (x) => [0x2588, 0x20, 0x259a][x]);
  assert.ok(formatFor('tg', g).warnings.some(w => w.code === 'mode'));
  const p = formatFor('plain', g);
  assert.equal(p.text, '█ ▚');
  assert.ok(!p.warnings.some(w => w.level === 'error'));
});

// ---------------------------------------------------------------- fit
test('FIT seeds: phone column limits land in the researched ranges', () => {
  assert.equal(FIT.calibrated, false);
  const at = (id, mode, phone) => maxCols(id, mode, { phone });
  assert.ok(at('ig', 'braille', 390) >= 24 && at('ig', 'braille', 390) <= 30, 'IG 24-30');
  assert.ok(at('x', 'braille', 390) <= 30, 'X <= 30');
  assert.equal(at('tg', 'ascii', 390), 32, 'Telegram mono default 32');
  assert.ok(at('tg', 'ascii', 'desktop') >= 60 && at('tg', 'ascii', 'desktop') <= 80);
  for (const id of ['ig', 'x', 'tg']) assert.ok(at(id, 'braille', 360) <= at(id, 'braille', 390) && at(id, 'braille', 390) <= at(id, 'braille', 430));
  assert.ok(Math.abs(cellAspect('tg', 'ascii') - 0.46) < 0.01);
  assert.equal(rowsFor(15, cellAspect('x', 'braille')), 8);
});

test('wraps: a grid wider than the phone warns and says what fits', () => {
  const w = maxCols('ig', 'braille', { phone: 390 });
  const ok = formatFor('ig', grid('braille', w, 4, () => B));
  const bad = formatFor('ig', grid('braille', w + 1, 4, () => B));
  assert.ok(!ok.wraps && bad.wraps);
  const warn = bad.warnings.find(x => x.code === 'too-wide');
  assert.equal(warn.fitCols, w);
  assert.ok(formatFor('ig', grid('braille', w + 1, 4, () => B), { phone: 430 }).wraps === (w + 1 > maxCols('ig', 'braille', { phone: 430 })));
});

test('autoFit: largest square grid inside both limits, for every target, mode and phone', () => {
  for (const id of Object.keys(TARGETS)) for (const mode of TARGETS[id].modes) for (const phone of [...PHONES, 'desktop']) for (const caption of [false, true]) {
    const opts = { phone, caption };
    const { cols, rows } = autoFit(id, mode, opts);
    const a = cellAspect(id, mode);
    assert.equal(rows, rowsFor(cols, a));
    assert.ok(cols <= maxCols(id, mode, opts), `${id}/${mode}/${phone} too wide`);
    assert.ok(countFor(id, mode, cols, rows, opts) <= limitFor(id, opts), `${id}/${mode}/${phone} over`);
    const next = cols + 1;
    if (next <= maxCols(id, mode, opts)) {
      assert.ok(countFor(id, mode, next, rowsFor(next, a), opts) > limitFor(id, opts), `${id}/${mode}/${phone}: ${next} would fit`);
    }
  }
  assert.deepEqual(autoFit('x', 'braille'), { cols: 15, rows: 8 });
});

// ---------------------------------------------------------------- properties
test('property: 3,000 random grids x targets x options obey every rule and countFor is exact', () => {
  const r = rng(7);
  let n = 0;
  for (let k = 0; k < 3000; k++) {
    const id = Object.keys(TARGETS)[(r() * 6) | 0];
    const mode = TARGETS[id].modes[(r() * TARGETS[id].modes.length) | 0];
    const cols = 1 + ((r() * 70) | 0), rows = 1 + ((r() * 40) | 0);
    const g = grid(mode, cols, rows, () => {
      const u = r();
      if (mode === 'braille') return u < 0.3 ? B : u < 0.35 ? 0x20 : B + ((r() * 256) | 0);
      if (mode === 'ascii') return u < 0.4 ? 0x20 : 0x21 + ((r() * 94) | 0);
      return [0x20, 0x2588, 0x2580, 0x259a][(u * 4) | 0];
    });
    const opts = { blank: r() < 0.5 ? 'dot' : 'u2800', caption: r() < 0.3, phone: PHONES[(r() * 3) | 0] };
    const res = formatFor(id, g, opts);
    const ls = lines(res.text);
    assert.ok(!res.text.includes('\r'));
    if (mode === 'braille') {
      assert.equal(ls.length, rows);
      assert.ok(!res.text.includes(' '));
      assert.ok(ls.every(l => [...l].length === cols && l.length > 0));
      assert.ok(ls.every(l => [...l].every(c => c.codePointAt(0) >= 0x2800 && c.codePointAt(0) <= 0x28ff)));
    }
    if (mode === 'ascii' && (id === 'tg' || id === 'tgc')) {
      assert.equal(ls[0], '```');
      assert.equal(ls[ls.length - 1], '```');
      assert.ok(ls.slice(1, -1).every(l => /^[\x20-\x5f\x61-\x7e]*$/.test(l) && l.length === cols));
    }
    assert.equal(res.count, id.startsWith('x') ? xWeightedLength(res.text) : res.text.length);
    if (modeAllowed(id, mode)) assert.equal(countFor(id, mode, cols, rows, opts), res.count, `${id}/${mode} ${cols}x${rows}`);
    assert.equal(res.fits, res.count <= res.limit);
    n++;
  }
  assert.equal(n, 3000);
});

// ---------------------------------------------------------------- Steam, YouTube, Twitch
const bytes = s => Buffer.byteLength(s, 'utf8');

test('Steam counts UTF-8 bytes: a Braille cell is 3, a line break 1; countFor agrees', () => {
  const r = rng(41);
  for (const id of ['steamc', 'steamp', 'steamb']) {
    assert.equal(unitOf(id), 'bytes');
    for (let i = 0; i < 40; i++) {
      const cols = 1 + ((r() * 70) | 0), rows = 1 + ((r() * 40) | 0);
      const g = grid('braille', cols, rows, () => (r() < 0.3 ? B : B + ((r() * 256) | 0)));
      const res = formatFor(id, g, { phone: 'desktop' });
      assert.equal(res.count, bytes(res.text), `${id} ${cols}x${rows}`);
      assert.equal(res.count, 3 * cols * rows + rows - 1);
      assert.equal(countFor(id, 'braille', cols, rows), res.count);
      assert.equal(res.fits, res.count <= res.limit);
      assert.ok(res.warnings.some(w => w.code === 'steam-bytes'));
    }
  }
  assert.deepEqual([limitFor('steamc'), limitFor('steamp'), limitFor('steamb')], [1000, 4000, 8000]);
});

test('Steam on a desktop: comment 25 x 13 (987 bytes), summary 48 wide, info box 60 wide', () => {
  const at = id => autoFit(id, 'braille', { phone: 'desktop' });
  assert.deepEqual(at('steamc'), { cols: 25, rows: 13 });
  assert.equal(countFor('steamc', 'braille', 25, 13), 987);
  assert.equal(at('steamp').cols, 48);
  assert.equal(at('steamb').cols, 60);
  for (const id of ['steamp', 'steamb']) {
    const { cols, rows } = at(id);
    assert.ok(countFor(id, 'braille', cols, rows) <= limitFor(id), id);
  }
});

test('YouTube comment: plain Braille rows, 10,000 characters, a spam-review note', () => {
  const g = grid('braille', 30, 16, (x, y) => B + ((x * 7 + y * 3) % 256));
  const res = formatFor('ytc', g);
  assert.equal(lines(res.text).length, 16);
  assert.equal(res.count, res.text.length);
  assert.equal(res.limit, 10000);
  assert.ok(res.warnings.some(w => w.code === 'yt-review'));
  assert.equal(res.html, null);
});

test('single-line chats: one line, a blank lead-in row, then the rows joined by single spaces', () => {
  const r = rng(43);
  for (const id of ['twitch', 'ytlive']) for (const blank of ['u2800', 'dot']) for (let i = 0; i < 30; i++) {
    const cols = 1 + ((r() * 40) | 0), rows = 1 + ((r() * 20) | 0);
    const g = grid('braille', cols, rows, () => (r() < 0.4 ? B : B + ((r() * 256) | 0)));
    const res = formatFor(id, g, { blank });
    assert.ok(!res.text.includes('\n'), `${id}: no line breaks`);
    const words = res.text.split(' ');
    assert.equal(words.length, rows + 1);
    assert.equal(words[0], String.fromCodePoint(blank === 'dot' ? 0x2840 : B).repeat(cols), 'blank lead-in row');
    for (let y = 0; y < rows; y++) {
      const w = cps(words[y + 1]);
      assert.equal(w.length, cols);
      for (let x = 0; x < cols; x++) {
        let want = g.cp[y * cols + x];
        if (want === B && blank === 'dot') want = 0x2840;
        assert.equal(w[x], want);
      }
    }
    assert.equal(res.count, res.text.length);
    assert.equal(countFor(id, 'braille', cols, rows), res.count, `${id} ${cols}x${rows}`);
    assert.equal(res.fits, res.count <= res.limit);
  }
});

test('chat budgets: Twitch 30 x 15 in 500 characters, YouTube live chat 17 x 10 in 200', () => {
  assert.deepEqual(autoFit('twitch', 'braille', {}), { cols: 30, rows: 15 });
  assert.equal(countFor('twitch', 'braille', 30, 15), 495);
  assert.deepEqual(autoFit('ytlive', 'braille', {}), { cols: 17, rows: 10 });
  assert.equal(countFor('ytlive', 'braille', 17, 10), 197);
  assert.ok(countFor('ytlive', 'braille', 18, 10) > 200);
});

test('flowRange: a row fits the chat and two rows plus a space do not; narrow art warns', () => {
  for (const id of ['twitch', 'ytlive']) {
    const f = FIT[id].braille, cw = f.fontPx * f.cellEm, sp = f.fontPx * f.spaceEm;
    for (const cols of [8, 17, 30]) {
      const { min, max } = flowRange(id, 'braille', cols);
      assert.equal(min, Math.ceil(cols * cw));
      assert.equal(max, Math.floor(2 * cols * cw + sp));
    }
    // the desktop chat column sits inside the range for the default size
    const { cols, rows } = autoFit(id, 'braille', {});
    const range = flowRange(id, 'braille', cols), desk = chatWidth(id, 'braille', 'desktop');
    assert.ok(range.min <= desk && desk < range.max, `${id}: ${range.min}-${range.max} vs ${desk}`);
    const res = formatFor(id, grid('braille', cols, rows, () => B + 1));
    assert.ok(res.warnings.some(w => w.code === 'flow-width'));
    assert.ok(!res.warnings.some(w => w.code === 'flow-narrow'));
    // art too narrow for the desktop chat: two rows would share a line
    const narrow = formatFor(id, grid('braille', 10, 5, () => B + 1));
    assert.ok(narrow.warnings.some(w => w.code === 'flow-narrow'), `${id}: flow-narrow`);
  }
  assert.ok(formatFor('twitch', grid('braille', 4, 2, () => B + 1)).warnings.some(w => w.code === 'twitch-duplicate'));
  assert.ok(formatFor('ytlive', grid('braille', 4, 2, () => B + 1)).warnings.some(w => w.code === 'yt-hold'));
});

console.log(results.join('\n'));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

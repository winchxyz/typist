// Export tests (node, plain assert): node tests/export.test.mjs
// TXT / SVG / HTML strings, file names and colour block runs. PNG needs a canvas: see
// tests/copy.e2e.mjs (it exports PNGs in the browser and checks their size and pixels).
import assert from 'node:assert/strict';
import {
  fileName, exportTxt, exportSVG, exportHTML, blockRects, colourSpans, cellMetrics, plainText,
  INK, PAPER, MONO_STACK,
} from '../js/export.js';
import { formatFor, FIT } from '../js/targets.js';
import { brailleGeometry } from '../js/raster.js';

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push('ok   ' + name); } catch (e) { fail++; results.push('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
}
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function grid(mode, cols, rows, f, colour = null) {
  const cp = new Uint32Array(cols * rows);
  const fg = colour ? new Uint32Array(cols * rows) : null, bg = colour ? new Uint32Array(cols * rows) : null;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * cols + x;
    cp[i] = f(x, y);
    if (colour) { const [a, b] = colour(x, y); fg[i] = a; bg[i] = b; }
  }
  return { mode, cols, rows, cp, fg, bg, ink: 0.5 };
}
const B = 0x2800;
const QUAD = [0x20, 0x2598, 0x259D, 0x2580, 0x2596, 0x258C, 0x259E, 0x259B, 0x2597, 0x259A, 0x2590, 0x259C, 0x2584, 0x2599, 0x259F, 0x2588];
const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const count = (s, re) => (s.match(re) || []).length;
const attrs = tag => Object.fromEntries([...tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
// crude XML well-formedness: every open tag closes in order
function balanced(xml) {
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) { assert.equal(stack.pop(), m[2], 'tag order'); } else stack.push(m[2]);
  }
  assert.equal(stack.length, 0, 'unclosed tags: ' + stack.join(','));
}

// ---------------------------------------------------------------- names
await test('fileName: typist-<target>-<cols>x<rows>.<ext> from parts or a payload', () => {
  assert.equal(fileName(['ig', '26x15'], 'png'), 'typist-ig-26x15.png');
  assert.equal(fileName({ target: 'tg', cols: 32, rows: 15 }, '.TXT'), 'typist-tg-32x15.txt');
  const g = grid('braille', 26, 15, () => B + 1);
  assert.equal(fileName(formatFor('ig', g), 'svg'), 'typist-ig-26x15.svg');
  assert.equal(fileName({ cols: 4, rows: 2 }, 'html'), 'typist-plain-4x2.html');
  assert.equal(fileName(['Typist', 'X Premium!', '10x6'], 'png'), 'typist-x-premium-10x6.png');
  assert.equal(fileName([], ''), 'typist');
});

// ---------------------------------------------------------------- txt
await test('exportTxt = formatFor(plain).text, utf-8, no BOM / CR / trailing newline', async () => {
  const r = rng(3);
  for (const mode of ['braille', 'ascii', 'blocks']) {
    const g = grid(mode, 11, 6, () => (mode === 'braille' ? B + ((r() * 256) | 0)
      : mode === 'ascii' ? 0x20 + ((r() * 95) | 0) : QUAD[(r() * 16) | 0]));
    const want = formatFor('plain', g).text;
    const blob = exportTxt(g);
    assert.equal(blob.type, 'text/plain;charset=utf-8');
    const got = await blob.text();
    assert.equal(got, want, mode);
    assert.ok(!got.includes('\r') && !got.endsWith('\n') && !got.startsWith('﻿'), mode);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.notDeepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    assert.equal(await exportTxt(formatFor('plain', g)).text(), want, 'from a plain payload');
    assert.ok(!(await exportTxt(g).text()).includes('`'), 'no backtick');
  }
});

await test('exportTxt of a Grid never carries the Telegram fence', async () => {
  const g = grid('ascii', 5, 2, (x) => 0x41 + x);
  assert.ok(formatFor('tg', g).text.startsWith('```'));
  assert.equal(await exportTxt(g).text(), 'ABCDE\nABCDE');
  assert.equal(plainText('raw'), 'raw');
});

// ---------------------------------------------------------------- svg
await test('SVG Braille: one circle per raised dot at raster.js geometry', () => {
  const r = rng(7);
  const g = grid('braille', 9, 5, () => B + ((r() * 256) | 0));
  let dots = 0;
  for (const v of g.cp) for (let k = 0; k < 8; k++) dots += ((v - B) >> k) & 1;
  const svg = exportSVG(g);
  balanced(svg);
  assert.equal(count(svg, /<circle /g), dots);
  const { cellW, cellH } = cellMetrics(g);
  const f = FIT.plain.braille;
  assert.equal(cellW, f.fontPx * f.cellEm);
  const root = attrs(svg.match(/<svg[^>]*>/)[0]);
  assert.equal(+root.width, Math.round(9 * cellW * 100) / 100);
  assert.equal(+root.height, Math.round(5 * cellH * 100) / 100);
  assert.ok(svg.includes(`fill="${INK}"`) && svg.includes(`fill="${PAPER}"`));
  for (const m of svg.matchAll(/<circle [^>]*>/g)) {
    const a = attrs(m[0]);
    assert.ok(+a.cx > 0 && +a.cx < +root.width && +a.cy > 0 && +a.cy < +root.height);
  }
  assert.ok(!svg.includes('\r'));
});

await test('SVG Braille: dot 1 and dot 8 land in the right corners', () => {
  const g = grid('braille', 2, 1, x => (x === 0 ? B + 0x01 : B + 0x80));
  const cw = 20, ch = 40;
  const svg = exportSVG(g, { cellW: cw, cellH: ch, paper: null });
  const { r, centers } = brailleGeometry(cw, ch);
  const cs = [...svg.matchAll(/<circle [^>]*>/g)].map(m => attrs(m[0]));
  assert.equal(cs.length, 2);
  assert.deepEqual([+cs[0].cx, +cs[0].cy], [centers[0][0], centers[0][1]]);        // left column, top row
  assert.deepEqual([+cs[1].cx, +cs[1].cy], [cw + centers[7][0], centers[7][1]]);   // right column, row 4
  assert.equal(+cs[0].r, Math.round(r * 100) / 100);
  assert.ok(!svg.includes('<rect'), 'transparent: no paper rect');
});

await test('SVG blocks: runs merge across columns and half rows', () => {
  const full = grid('blocks', 5, 2, () => 0x2588);
  let rs = blockRects(full);
  assert.equal(rs.fg.length, 1);
  assert.deepEqual(rs.fg[0], { x: 0, y: 0, w: 10, h: 4, fill: null });
  const top = grid('blocks', 3, 1, () => 0x2580);    // ▀▀▀
  rs = blockRects(top);
  assert.deepEqual(rs.fg, [{ x: 0, y: 0, w: 6, h: 1, fill: null }]);
  const sides = grid('blocks', 2, 1, x => (x === 0 ? 0x258C : 0x2590));   // ▌▐
  rs = blockRects(sides);
  assert.deepEqual(rs.fg, [{ x: 0, y: 0, w: 1, h: 2, fill: null }, { x: 3, y: 0, w: 1, h: 2, fill: null }]);
  const svg = exportSVG(sides, { cellW: 10, cellH: 20, paper: null });
  balanced(svg);
  const rects = [...svg.matchAll(/<rect [^>]*>/g)].map(m => attrs(m[0]));
  assert.deepEqual(rects.map(a => [+a.x, +a.y, +a.width, +a.height]), [[0, 0, 5, 20], [15, 0, 5, 20]]);
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
});

await test('SVG blocks: every quadrant of a random grid is covered exactly once', () => {
  const r = rng(11);
  const g = grid('blocks', 13, 7, () => QUAD[(r() * 16) | 0]);
  const { fg } = blockRects(g);
  const cover = new Uint8Array(26 * 14);
  for (const q of fg) for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) cover[y * 26 + x]++;
  for (let sy = 0; sy < 14; sy++) for (let sx = 0; sx < 26; sx++) {
    const m = QUAD.indexOf(g.cp[(sy >> 1) * 13 + (sx >> 1)]);
    const want = (m >> (((sy & 1) << 1) | (sx & 1))) & 1;
    assert.equal(cover[sy * 26 + sx], want, `${sx},${sy}`);
  }
});

await test('SVG colour blocks: bg runs of equal colour, fg runs per colour, hidden quadrants dropped', () => {
  const RED = 0xff0000, GREEN = 0x00ff00, BLUE = 0x0000ff;
  // ▀ red-on-blue x3, then ▀ green-on-blue, then █ blue-on-blue (invisible fg)
  const g = grid('blocks', 5, 1, x => (x < 4 ? 0x2580 : 0x2588), x => [x < 3 ? RED : x === 3 ? GREEN : BLUE, BLUE]);
  const { bg, fg } = blockRects(g);
  assert.deepEqual(bg, [{ x: 0, y: 0, w: 10, h: 2, fill: '#0000ff' }]);
  assert.deepEqual(fg, [{ x: 0, y: 0, w: 6, h: 1, fill: '#ff0000' }, { x: 6, y: 0, w: 2, h: 1, fill: '#00ff00' }]);
  const svg = exportSVG(g, { cellW: 10, cellH: 20 });
  assert.equal(count(svg, /<rect /g), 1 + 3);   // paper + bg + 2 fg
  assert.ok(svg.includes('fill="#ff0000"') && svg.includes('fill="#00ff00"') && svg.includes('fill="#0000ff"'));
});

await test('SVG ASCII: one <text> per row, escaped, spaces kept, exact row width', () => {
  const rows = ['<a&b>', ' /\\ "', '`x  |'];
  const g = grid('ascii', 5, 3, (x, y) => rows[y].codePointAt(x));
  const svg = exportSVG(g, { cellW: 9, cellH: 19.5 });
  balanced(svg);
  const texts = [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)];
  assert.equal(texts.length, 3);
  const want = formatFor('plain', g).text.split('\n');
  texts.forEach((m, i) => {
    assert.equal(unescape(m[2]), want[i]);
    const xs = attrs('<t ' + m[1] + '>').x.split(' ').map(Number);
    assert.deepEqual(xs, [4.5, 13.5, 22.5, 31.5, 40.5], 'one x per glyph at the cell centre');
    assert.ok(m[1].includes('xml:space="preserve"'));
  });
  assert.equal(unescape(texts[2][2]), "'x  |", 'backtick became an apostrophe');
  assert.ok(svg.includes('text-anchor="middle"'));
  assert.ok(svg.includes('font-family="' + MONO_STACK.replace(/"/g, '&quot;') + '"'));
});

// ---------------------------------------------------------------- html
const preOf = html => html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1];

await test('HTML: standalone page, <pre> holds exactly the plain text (Braille, ASCII, mono blocks)', () => {
  const r = rng(5);
  for (const mode of ['braille', 'ascii', 'blocks']) {
    const g = grid(mode, 12, 6, () => (mode === 'braille' ? B + ((r() * 256) | 0)
      : mode === 'ascii' ? 0x20 + ((r() * 95) | 0) : QUAD[(r() * 16) | 0]));
    const html = exportHTML(g);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<meta charset="utf-8">') && html.includes('name="viewport"'));
    assert.equal(count(html, /<pre/g), 1);
    assert.ok(!html.includes('<span'), 'no spans without colour');
    if (mode === 'blocks') assert.equal(count(preOf(html), /<b[ >]/g), 12 * 6, 'one fixed-size cell per character');
    if (mode === 'braille') {
      // random cells are rarely blank: check the blank runs on a grid that has some
      const holes = exportHTML(grid('braille', 6, 2, x => (x % 3 ? B : B + 0xff)));
      assert.ok(html.includes('--gap') && preOf(holes).includes('<i>\u2800\u2800</i>'), 'Windows blank fix');
    }
    assert.equal(unescape(preOf(html).replace(/<[^>]+>/g, '')), formatFor('plain', g).text, mode);
    assert.ok(!html.includes('\r') && !/<link|src=|https?:\/\//.test(html), 'self-contained');
    assert.equal(count(html, /<script/g), mode === 'braille' ? 1 : 0, 'script only for the Braille width fix');
    const f = FIT.plain[mode];
    assert.ok(html.includes(`line-height:${f.lineEm}`) && html.includes(`font-size:${f.fontPx}px`), mode + ' metrics');
    assert.ok(/aria-label="(Braille|ASCII|block) art, 12 by 6 characters"/.test(html));
  }
});

await test('HTML: target metrics and colours', () => {
  const g = grid('ascii', 4, 2, () => 0x23);
  const html = exportHTML(g, { target: 'tg', ink: '#eeeeee', paper: '#101010', title: 'A <b> title' });
  assert.ok(html.includes(`font-size:${FIT.tg.ascii.fontPx}px`));
  assert.ok(html.includes('background:#101010') && html.includes('color:#eeeeee'));
  assert.ok(html.includes('<title>A &lt;b&gt; title</title>'));
  assert.ok(html.includes('Geist Mono'));
  assert.ok(exportHTML(grid('braille', 2, 2, () => B + 1)).includes('Apple Braille'));
});

await test('HTML colour blocks: one span per run of equal fg + bg, text intact', () => {
  const RED = 0xff0000, BLUE = 0x0000ff, WHITE = 0xffffff;
  const g = grid('blocks', 6, 2, (x, y) => (y === 0 ? 0x2580 : 0x2584),
    (x, y) => (y === 0 ? (x < 4 ? [RED, BLUE] : [WHITE, BLUE]) : [RED, RED]));
  const { rows, runs, css } = colourSpans(g);
  assert.equal(runs, 3);
  assert.equal(rows.length, 2);
  assert.equal(count(rows[0], /<span/g), 2);
  assert.equal(count(rows[1], /<span/g), 1);
  assert.equal(count(css, /\{--f:/g), 3, 'three colour pairs, three classes');
  assert.equal(count(rows[0], /<b /g), 6, 'every ▀ cell is a quadrant cell');
  assert.ok(rows[0].includes('<b class="q3">▀</b>') && rows[1].includes('<b class="qc">▄</b>'));
  const html = exportHTML(g);
  const pre = preOf(html);
  assert.equal(unescape(pre.replace(/<[^>]+>/g, '')), '▀▀▀▀▀▀\n▄▄▄▄▄▄');
  assert.ok(html.includes('--f:#ff0000;--b:#0000ff'));
  assert.ok(/\.q3\{background-image:linear-gradient\(var\(--f\),var\(--f\)\),linear-gradient/.test(html), 'UL + UR layers');
  assert.ok(html.includes('background-position:0 0,100% 0}'), 'q3 = upper left + upper right');
  const cw = FIT.plain.blocks.cellEm, lh = FIT.plain.blocks.lineEm;
  assert.ok(html.includes(`pre b{display:inline-block;width:${cw}em;height:${lh}em;`), 'cells sized by FIT');
  assert.ok(html.includes(`line-height:${lh};`));
  const mono = exportHTML(g, { colour: false });
  assert.ok(!mono.includes('<span'), 'colour: false = plain text');
});

await test('HTML colour blocks: random grid, spans = runs, text round-trips', () => {
  const r = rng(9);
  const pal = [0x112233, 0xaabbcc, 0xff8800];
  const g = grid('blocks', 17, 9, () => QUAD[(r() * 16) | 0], () => [pal[(r() * 3) | 0], pal[(r() * 2) | 0]]);
  let want = 0;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 17; x++) {
    const i = y * 17 + x;
    if (x === 0 || g.fg[i] !== g.fg[i - 1] || g.bg[i] !== g.bg[i - 1]) want++;
  }
  const pre = preOf(exportHTML(g));
  assert.equal(count(pre, /<span/g), want);
  assert.equal(unescape(pre.replace(/<[^>]+>/g, '')), formatFor('plain', g).text);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

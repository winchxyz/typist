// Counting tests (node, plain assert): node tests/count.test.mjs
// Expected X weights are worked out by hand from twitter-text v3's config (weights 100/200, the four
// light ranges, emoji 2, URL 23, NFC first), not taken from the implementation.
import assert from 'node:assert/strict';
import { utf16Length, xWeightedLength, xInvalidChars, findUrlsX, X_MAX, X_URL } from '../js/count.js';
import { xIntentUrl, tgShareUrl, linkFits, SITE_URL, LINK_MAX } from '../js/links.js';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push('ok   ' + name); } catch (e) { fail++; results.push('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
}

test('constants', () => {
  assert.equal(X_MAX, 280);
  assert.equal(X_URL, 23);
});

test('utf16Length counts code units (astral = 2, Braille and blocks = 1)', () => {
  assert.equal(utf16Length(''), 0);
  assert.equal(utf16Length('⠀⣿\n█'), 4);
  assert.equal(utf16Length('\u{1F600}'), 2);
  assert.equal(utf16Length('a\nb'), 3);
});

test('X: light ranges weigh 1, their neighbours 2', () => {
  const cases = [
    ['\u0000', 1], ['a', 1], ['é', 1], ['ჿ', 1], ['ᄀ', 2],
    ['῿', 2], [' ', 1], ['‍', 1], ['‎', 2], ['‏', 2],
    ['‐', 1], ['‟', 1], ['†', 2], ['‱', 2], ['′', 1], ['‷', 1], ['‸', 2],
    ['⠀', 2], ['⣿', 2], ['█', 2], ['─', 2], ['Ａ', 2], ['一', 2],
    ['\n', 1], ['\r\n', 2], [' ', 1],
  ];
  for (const [s, w] of cases) assert.equal(xWeightedLength(s), w, 'U+' + s.codePointAt(0).toString(16));
});

test('X: Braille grids follow 2*cols*rows + rows - 1', () => {
  for (const [c, r] of [[1, 1], [16, 8], [15, 8], [28, 16], [140, 1]]) {
    const text = Array.from({ length: r }, () => '⣿'.repeat(c)).join('\n');
    assert.equal(xWeightedLength(text), 2 * c * r + r - 1, `${c}x${r}`);
  }
  assert.equal(xWeightedLength(Array.from({ length: 8 }, () => '⠀'.repeat(16)).join('\n')), 263);
});

test('X: NFC first (e + combining acute is one light character)', () => {
  assert.equal(xWeightedLength('é'), 1);
  assert.equal(xWeightedLength('é'), 1);
  // a decomposed Hangul syllable composes to one heavy character
  assert.equal(xWeightedLength('가'), 2);
});

test('X: an emoji sequence weighs 2 however many code points it has', () => {
  assert.equal(xWeightedLength('\u{1F600}'), 2);                       // grinning face
  assert.equal(xWeightedLength('\u{1F44D}\u{1F3FD}'), 2);              // thumbs up + skin tone
  assert.equal(xWeightedLength('\u{1F468}‍\u{1F469}‍\u{1F467}'), 2); // family ZWJ
  assert.equal(xWeightedLength('\u{1F1FA}\u{1F1F8}'), 2);              // flag
  assert.equal(xWeightedLength('1️⃣'), 2);                   // keycap
  assert.equal(xWeightedLength('❤️'), 2);                    // heart + VS16
  assert.equal(xWeightedLength('a\u{1F600}b'), 4);
  assert.equal(xWeightedLength('1'), 1, 'a plain digit is not an emoji');
});

test('X: URLs weigh 23 however long, and only real-looking ones', () => {
  assert.equal(xWeightedLength('https://example.com/a/very/long/path?q=1'), 23);
  assert.equal(xWeightedLength('see example.com now'), 4 + 23 + 4);
  assert.equal(xWeightedLength('a.co'), 23);
  assert.equal(xWeightedLength('a.b'), 3, 'one-letter TLD is not a link');
  assert.equal(xWeightedLength('..:;/\\|'), 7, 'ASCII art punctuation is not a link');
  assert.equal(findUrlsX('mail me at bob@example.com').length, 0, 'e-mail domain is not a bare link');
  assert.equal(findUrlsX('@example.com').length, 0);
  assert.deepEqual(findUrlsX('go to x.io.'), [{ start: 6, end: 10 }], 'trailing dot not in the link');
  assert.equal(findUrlsX('⠀⣿⠁').length, 0, 'Braille never links');
});

test('X: invalid characters are reported', () => {
  assert.deepEqual(xInvalidChars('abc'), []);
  assert.deepEqual(xInvalidChars('a﻿b﻿').length, 1);
  assert.equal(xInvalidChars('￾￿').length, 2);
});

test('links: X intent defaults to /intent/tweet, keeps newlines as %0A, no url unless asked', () => {
  const art = '⣿⠀\n⠀⣿';
  const href = xIntentUrl(art);
  assert.ok(href.startsWith('https://x.com/intent/tweet?text='));
  assert.ok(href.includes('%0A'));
  assert.ok(!href.includes('url='));
  assert.equal(decodeURIComponent(new URL(href).searchParams.get('text')), art);
  assert.equal(new URL(href).searchParams.get('text'), art);
  assert.ok(xIntentUrl(art, { path: 'post' }).startsWith('https://x.com/intent/post?'));
  assert.ok(xIntentUrl(art, 'post').startsWith('https://x.com/intent/post?'));
  assert.equal(new URL(xIntentUrl('a', { url: SITE_URL })).searchParams.get('url'), SITE_URL);
});

test('links: t.me share always carries the url and the exact text', () => {
  const art = '⣿⠀\n⠀⣿';
  const u = new URL(tgShareUrl(art));
  assert.equal(u.origin + u.pathname, 'https://t.me/share/url');
  assert.equal(u.searchParams.get('url'), SITE_URL);
  assert.equal(u.searchParams.get('text'), art);
  assert.equal(new URL(tgShareUrl('x', '')).searchParams.get('url'), SITE_URL);
});

test('links: long links fall back to the clipboard', () => {
  const cell = '⣿';
  assert.ok(linkFits(tgShareUrl(cell.repeat(100)), 'tg'));
  assert.ok(!linkFits(tgShareUrl(cell.repeat(400)), 'tg'), 'Braille costs 9 bytes a cell');
  assert.equal(LINK_MAX.tg, 2000);
  // a full free X post (140 Braille cells) stays well under the X limit
  assert.ok(linkFits(xIntentUrl(cell.repeat(140)), 'x'));
});

console.log(results.join('\n'));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

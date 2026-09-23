// Character counting the way each platform counts.
//
// Instagram and Telegram count UTF-16 code units (every Braille and block character is one unit).
// X counts "weighted" characters with twitter-text v3 rules (config/v3.json): after NFC, a code
// point in the light ranges weighs 1, everything else 2 (Braille, blocks, box drawing, CJK), an
// emoji sequence weighs 2 however many code points it has, and a URL weighs 23 however long it is.
// A CRLF is two characters there, which is one reason payloads are LF-only.

export const X_MAX = 280;
export const X_URL = 23;

/** Instagram / Telegram length: UTF-16 code units, exactly what String#length gives. */
export const utf16Length = s => s.length;

const LIGHT = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];
const lightWeight = c => {
  for (const [a, b] of LIGHT) if (c >= a && c <= b) return true;
  return false;
};

// One emoji = flags, keycaps, and pictographs with their modifiers / variation selectors / ZWJ
// joins / tag sequences. Built with the 'u' flag only (older Safari rejects the 'v' flag at parse).
const PICTO = '\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?';
const EMOJI = new RegExp(
  '\\p{Regional_Indicator}\\p{Regional_Indicator}' +
  '|[#*0-9]\\uFE0F?\\u20E3' +
  `|${PICTO}(?:[\\u{E0020}-\\u{E007E}]+\\u{E007F})?(?:\\u200D${PICTO})*`,
  'gu');

// Pictographs that are plain text unless followed by U+FE0F (twemoji leaves them alone too):
// copyright, registered, trade mark, double exclamation and friends inside the light range.
const textDefault = (s, start, end) => end - start === 1 && s.codePointAt(start) <= 0x10ff;

// URLs: what X would link. Conservative on purpose: when in doubt a match counts 23, which can only
// make the budget stricter. Common generic TLDs plus every two-letter country code.
const GTLD = 'com|net|org|info|biz|name|pro|edu|gov|mil|int|io|ai|app|dev|xyz|me|tv|co|ly|gg|fm|am|to|so|sh' +
  '|art|blog|shop|store|online|site|tech|space|club|live|news|design|studio|world|today|link|page|cloud|social';
const DOMAIN = `(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${GTLD}|[a-z]{2})`;
const URL_RE = new RegExp(
  `(?:https?:\\/\\/[^\\s]+)|(?:${DOMAIN})(?![a-z0-9-])(?::\\d{1,5})?(?:[/?#][^\\s]*)?`, 'gi');

/**
 * Spans X would auto-link, as [{start, end}] in UTF-16 indices of the NFC text. A bare domain
 * must not continue a word, an @handle or an e-mail address (checked by hand: no lookbehind,
 * which older Safari cannot parse).
 */
export function findUrlsX(text) {
  const s = text.normalize('NFC');
  const out = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s))) {
    const start = m.index;
    const prev = start > 0 ? s[start - 1] : '';
    if (!/^https?:/i.test(m[0]) && /[\w@.\-/]/.test(prev)) continue;
    // trailing punctuation is not part of a link
    let end = start + m[0].length;
    while (end > start && /[.,;:!?)\]'"]/.test(s[end - 1])) end--;
    if (end > start) out.push({ start, end });
  }
  return out;
}

/**
 * X's weighted length (twitter-text v3). Emoji and URLs are measured on the NFC text, as
 * parseTweet does.
 */
export function xWeightedLength(text) {
  const s = text.normalize('NFC');
  // spans that weigh a fixed amount: URLs (23) first, then emoji (2) outside them
  const spans = findUrlsX(s).map(u => ({ ...u, w: X_URL }));
  EMOJI.lastIndex = 0;
  let m;
  while ((m = EMOJI.exec(s))) {
    const start = m.index, end = start + m[0].length;
    if (textDefault(s, start, end)) continue;
    if (spans.some(u => start < u.end && end > u.start)) continue;
    spans.push({ start, end, w: 2 });
  }
  spans.sort((a, b) => a.start - b.start);
  let w = 0, i = 0, k = 0;
  while (i < s.length) {
    if (k < spans.length && i === spans[k].start) { w += spans[k].w; i = spans[k].end; k++; continue; }
    const c = s.codePointAt(i);
    w += lightWeight(c) ? 1 : 2;
    i += c > 0xffff ? 2 : 1;
  }
  return w;
}

/** Characters that make an X post invalid outright. */
export function xInvalidChars(text) {
  return [...new Set(text.match(/[﻿￾￿]/g) || [])];
}

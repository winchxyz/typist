// Final Reddit text art of the showcase artwork (after tools/reddit-art.mjs picked the settings).
//   node tools/reddit-final.mjs
// Writes, in shots/reddit/:
//   typist-reddit-dots.txt / typist-reddit-letters.txt   ready to paste: every line indented by
//     4 spaces, which is a code block in Reddit Markdown (new Reddit, old.reddit and the apps), the
//     one place where line breaks and spacing survive;
//   dots-plain.txt / letters-plain.txt                    the same art without the indent.
import fs from 'node:fs';
import { createConverter } from '../js/convert.js';
import { TONE_DEFAULTS } from '../js/tone.js';
import { formatFor, rowsFor, cellAspect } from '../js/targets.js';

const dir = 'shots/reddit';
const meta = JSON.parse(fs.readFileSync(`${dir}/halo.json`, 'utf8'));
const conv = createConverter();
conv.setSource({ width: meta.width, height: meta.height, data: new Uint8ClampedArray(fs.readFileSync(`${dir}/halo.rgba`)) });
const CROP = { x: 0.5, y: 0.45, zoom: 1, rotation: 0 };

function art(mode, cols, opts) {
  const aspect = mode === 'braille' ? cellAspect('ig', 'braille') : cellAspect('tg', 'ascii');
  const grid = conv.run(CROP, { mode, cols, rows: rowsFor(cols, aspect), ...opts, tone: { ...TONE_DEFAULTS, ...opts.tone, invert: true } });
  let rows = formatFor('plain', grid).text.split('\n');
  if (mode === 'ascii') {
    // letters: trailing spaces carry nothing in a code block; fully blank rows at the top and the
    // bottom only add height
    rows = rows.map(r => r.replace(/ +$/, ''));
    while (rows.length && !rows[0].trim()) rows.shift();
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  }
  return { grid, rows };
}

const dots = art('braille', 40, { dither: 'threshold', tone: { look: 'soft' } });
const letters = art('ascii', 60, { ascii: 'shape', tone: { look: 'poster' } });

for (const [name, a] of [['dots', dots], ['letters', letters]]) {
  const plain = a.rows.join('\n');
  const reddit = a.rows.map(r => '    ' + r).join('\n');
  // the rules a code block needs: LF only, nothing but the 4-space indent before each row
  if (/\r/.test(reddit)) throw new Error('CR');
  if (name === 'dots' && a.rows.some(r => / /.test(r))) throw new Error('U+0020 inside a Braille row');
  if (a.rows.some(r => /`/.test(r))) throw new Error('backtick');
  fs.writeFileSync(`${dir}/${name}-plain.txt`, plain, 'utf8');
  fs.writeFileSync(`${dir}/typist-reddit-${name}.txt`, reddit + '\n', 'utf8');
  const width = Math.max(...a.rows.map(r => [...r].length));
  console.log(`${name}: ${width} x ${a.rows.length}, ${reddit.length} characters with the indent`);
}

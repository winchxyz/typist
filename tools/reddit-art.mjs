// Text art of the showcase artwork for Reddit, made with the app's own converter in Node.
//   python writes shots/reddit/halo.rgba (raw RGBA) first; then: node tools/reddit-art.mjs
// Writes shots/reddit/cand_<name>.txt (the plain rows) for every candidate + candidates.json.
import fs from 'node:fs';
import { createConverter } from '../js/convert.js';
import { TONE_DEFAULTS } from '../js/tone.js';
import { formatFor, rowsFor, cellAspect } from '../js/targets.js';

const dir = 'shots/reddit';
const meta = JSON.parse(fs.readFileSync(`${dir}/halo.json`, 'utf8'));
const data = new Uint8ClampedArray(fs.readFileSync(`${dir}/halo.rgba`));
const conv = createConverter();
conv.setSource({ width: meta.width, height: meta.height, data });

// The artwork is portrait (4:5) and the converter crops squares: centre the square a little above
// the middle so the halo and the hand both stay in.
const CROP = { x: 0.5, y: 0.45, zoom: 1, rotation: 0 };
// Braille in a code block sits in a monospace font whose Braille glyphs come from a fallback font:
// cells are about as wide as a Braille cell in a chat, so use the chat aspect. ASCII: monospace.
const aspect = { braille: cellAspect('ig', 'braille'), ascii: cellAspect('tg', 'ascii') };

const cands = [];
for (const cols of [34, 44]) for (const look of ['photo', 'texture', 'soft', 'sketch']) for (const dither of ['atkinson', 'threshold']) {
  cands.push({ name: `dots_${cols}_${look}_${dither}`, mode: 'braille', cols, look, dither });
}
for (const cols of [48, 60]) for (const look of ['poster', 'photo', 'soft', 'sketch']) for (const ascii of ['shape', 'ramp']) {
  cands.push({ name: `letters_${cols}_${look}_${ascii}`, mode: 'ascii', cols, look, ascii });
}

const out = [];
for (const c of cands) {
  const rows = rowsFor(c.cols, aspect[c.mode]);
  const grid = conv.run(CROP, {
    mode: c.mode, cols: c.cols, rows, dither: c.dither || 'atkinson', ascii: c.ascii || 'shape',
    // the figure is the light part of a black picture: dots (or letters) stand for the light
    tone: { ...TONE_DEFAULTS, look: c.look, invert: true },
  });
  const f = formatFor('plain', grid);
  fs.writeFileSync(`${dir}/cand_${c.name}.txt`, f.text, 'utf8');
  out.push({ ...c, rows, chars: f.text.length, ink: +grid.ink.toFixed(3) });
}
fs.writeFileSync(`${dir}/candidates.json`, JSON.stringify(out, null, 1), 'utf8');
console.log(out.map(o => `${o.name} ${o.cols}x${o.rows} ink ${o.ink}`).join('\n'));

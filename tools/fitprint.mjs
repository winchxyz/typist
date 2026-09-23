import { TARGETS, autoFit, maxCols, cellAspect } from '../js/targets.js';
for (const id of Object.keys(TARGETS)) for (const mode of TARGETS[id].modes) {
  const row = [360, 390, 430, 'desktop'].map(p => { const f = autoFit(id, mode, { phone: p }); return `${p}: max ${maxCols(id, mode, { phone: p })} fit ${f.cols}x${f.rows}`; });
  console.log(id.padEnd(6), mode.padEnd(8), 'aspect', cellAspect(id, mode).toFixed(3), '|', row.join(' | '));
}

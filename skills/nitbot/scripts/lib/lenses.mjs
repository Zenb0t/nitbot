// Rolls review lenses. The script, not the model, picks them: asked to choose,
// a model picks the same three safe angles every time. Weighted toward the
// registers present in the diff, seeded so a run can be reproduced.
import fs from 'node:fs';
import { randomInt } from 'node:crypto';

const DECK = JSON.parse(fs.readFileSync(new URL('../data/lenses.json', import.meta.url), 'utf8'));

export function rollLenses({ count = 2, registers = [], seed, exclude = [] } = {}) {
  const s = seed ?? randomInt(1, 2 ** 31 - 1);
  const rand = mulberry32(s);
  const pool = DECK.filter((l) => !exclude.includes(l.id)).map((l) => ({
    lens: l,
    weight: 1 + 2 * l.boost.filter((b) => registers.includes(b)).length,
  }));
  const picked = [];
  while (picked.length < count && pool.length) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let r = rand() * total;
    const i = pool.findIndex((p) => (r -= p.weight) < 0);
    picked.push(pool.splice(i === -1 ? pool.length - 1 : i, 1)[0].lens);
  }
  return { seed: s, lenses: picked.map(({ id, name, prompt }) => ({ id, name, prompt })) };
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

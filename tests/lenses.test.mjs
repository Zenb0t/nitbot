import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollLenses } from '../skills/nitbot/scripts/lib/lenses.mjs';

test('the same seed rolls the same lenses; count and exclusions hold', () => {
  const a = rollLenses({ count: 3, registers: ['data'], seed: 42 });
  const b = rollLenses({ count: 3, registers: ['data'], seed: 42 });
  assert.deepEqual(a, b);
  assert.equal(a.lenses.length, 3);
  assert.equal(new Set(a.lenses.map((l) => l.id)).size, 3);

  const excluded = rollLenses({ count: 5, seed: 42, exclude: a.lenses.map((l) => l.id) });
  assert.ok(excluded.lenses.every((l) => !a.lenses.some((x) => x.id === l.id)));
});

test('different seeds explore different lenses', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 30; seed++) for (const l of rollLenses({ count: 2, seed }).lenses) seen.add(l.id);
  assert.ok(seen.size >= 12, `only ${seen.size} distinct lenses across 30 runs`);
});

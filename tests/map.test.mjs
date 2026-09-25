import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from './helpers.mjs';
import { resolveTarget } from '../skills/nitbot/scripts/lib/git.mjs';
import { classify } from '../skills/nitbot/scripts/lib/registers.mjs';
import { buildMap, riskScore } from '../skills/nitbot/scripts/lib/map.mjs';

test('call sites, module-private symbols, co-change gaps and fix history', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('src/price.js', 'export function total(items) {\n  return 0;\n}\nfunction helper() {}\n');
  r.write('src/cart.js', "import { total } from './price.js';\nexport const sum = () => total([]);\n");
  r.write('src/checkout.js', "import { total } from './price.js';\ntotal([]);\ntotal([1]);\n");
  r.write('docs/pricing.md', 'v0\n');
  r.commit('init');
  // price.js and pricing.md always change together...
  for (const v of [1, 2, 3]) {
    r.write('src/price.js', `export function total(items) {\n  return ${v};\n}\nfunction helper() {}\n`);
    r.write('docs/pricing.md', `v${v}\n`);
    r.commit(v === 2 ? 'fix: rounding bug in total' : `pricing v${v}`);
  }
  // ...except this time.
  r.write('src/price.js', 'export function total(items) {\n  return 42;\n}\nfunction helper() {\n  return 1;\n}\n');

  const target = resolveTarget(r.dir);
  const { registers } = classify(target.files);
  const map = buildMap(r.dir, target.files, { registers });

  const total = map.symbols.find((s) => s.name === 'total');
  assert.equal(total.scope, 'repo');
  assert.equal(total.callSites, 3);
  assert.deepEqual(total.callerFiles.sort(), ['src/cart.js', 'src/checkout.js']);
  assert.equal(map.symbols.find((s) => s.name === 'helper')?.scope, 'file');

  assert.deepEqual(map.coChange.map((c) => [c.file, c.partner]), [['src/price.js', 'docs/pricing.md']]);
  assert.equal(map.history[0].fixes, 1);
  assert.equal(map.untestedChange, true);
});

test('risk: docs-only is low; security plus data is high', () => {
  const empty = { symbols: [], coChange: [], history: [], siblings: [], untestedChange: false };
  assert.equal(riskScore({ registers: { docs: ['a.md'] }, map: empty, changedLines: 900 }).mode, 'quick');
  const high = riskScore({ registers: { app: ['a'], security: ['auth.js'], data: ['m.sql'] }, map: { ...empty, untestedChange: true }, changedLines: 50 });
  assert.equal(high.level, 'high');
  assert.equal(high.lenses, 3);
  assert.equal(riskScore({ registers: { app: ['a.js'] }, map: empty, changedLines: 20 }).level, 'low');
});

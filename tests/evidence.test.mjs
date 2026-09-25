import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { resolveTarget } from '../skills/nitbot/scripts/lib/git.mjs';
import { gatherEvidence, formatEvidence } from '../skills/nitbot/scripts/lib/evidence.mjs';

const config = { detector: { ignoreRules: [], ignoreFiles: [] } };

test('diff coverage from a fresh lcov report, ignored when stale', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('src/a.js', 'a\nb\n');
  r.commit('init');
  r.write('src/a.js', 'a\nb\nc\nd\n');
  r.write('coverage/lcov.info', `SF:${path.join(r.dir, 'src/a.js')}\nDA:1,1\nDA:2,1\nDA:3,4\nDA:4,0\nend_of_record\n`);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(r.dir, 'coverage/lcov.info'), future, future);

  const ev = gatherEvidence(r.dir, resolveTarget(r.dir), { config });
  assert.deepEqual(ev.coverage.uncovered, [{ file: 'src/a.js', lines: '4' }]);
  assert.match(formatEvidence(ev), /never executed by tests: src\/a\.js:4/);

  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(r.dir, 'coverage/lcov.info'), past, past);
  assert.equal(gatherEvidence(r.dir, resolveTarget(r.dir), { config }).coverage.stale, true);
});

test('a project with no tooling still gets the detector, and says so plainly', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.py', 'x = 1\n');
  r.commit('init');
  r.write('a.py', 'x = 1\nbreakpoint()\n');
  const ev = gatherEvidence(r.dir, resolveTarget(r.dir), { config });
  assert.deepEqual(ev.tools, []);
  assert.equal(ev.tests, null);
  assert.deepEqual(ev.detector.map((f) => f.rule), ['debugger']);
});

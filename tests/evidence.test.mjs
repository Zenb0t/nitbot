import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { resolveTarget } from '../skills/nitbot/scripts/lib/git.mjs';
import { gatherEvidence, formatEvidence } from '../skills/nitbot/scripts/lib/evidence.mjs';

const config = { detector: { ignoreRules: [], ignoreFiles: [] } };

test('diff coverage from a fresh lcov report, ignored when stale', async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('src/a.js', 'a\nb\n');
  r.commit('init');
  r.write('src/a.js', 'a\nb\nc\nd\n');
  r.write('coverage/lcov.info', `SF:${path.join(r.dir, 'src/a.js')}\nDA:1,1\nDA:2,1\nDA:3,4\nDA:4,0\nend_of_record\n`);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(r.dir, 'coverage/lcov.info'), future, future);

  const ev = await gatherEvidence(r.dir, resolveTarget(r.dir), { config, tools: [] });
  assert.deepEqual(ev.coverage.uncovered, [{ file: 'src/a.js', lines: '4' }]);
  assert.match(formatEvidence(ev), /never executed by tests: src\/a\.js:4/);

  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(r.dir, 'coverage/lcov.info'), past, past);
  assert.equal((await gatherEvidence(r.dir, resolveTarget(r.dir), { config, tools: [] })).coverage.stale, true);
});

test('a project with no tooling still gets the detector, and says so plainly', async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.py', 'x = 1\n');
  r.commit('init');
  r.write('a.py', 'x = 1\nbreakpoint()\n');
  const ev = await gatherEvidence(r.dir, resolveTarget(r.dir), { config, tools: [] });
  assert.deepEqual(ev.tools, []);
  assert.deepEqual(ev.tests, []);
  assert.deepEqual(ev.detector.map((f) => f.rule), ['debugger']);
});

// A tool that runs this Node with a snippet, so no real linter is needed.
const node = (code) => () => [process.execPath, '-e', code];

test('every test runner is reported, so one passing suite cannot hide a failing one', async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'x\n');
  r.commit('init');
  r.write('a.js', 'y\n');
  const tools = [
    { id: 'npm-test', kind: 'test', scope: 'project', parse: 'test', argv: node('console.error("FAIL a.test.js"); process.exit(1)') },
    { id: 'go-test', kind: 'test', scope: 'project', parse: 'test', argv: node('0') },
  ];
  const ev = await gatherEvidence(r.dir, resolveTarget(r.dir), { config, tools, runTests: true });
  assert.deepEqual(ev.tests.map((x) => [x.tool, x.status]), [['npm-test', 'failed'], ['go-test', 'passed']]);
  const text = formatEvidence(ev);
  assert.match(text, /tests \(npm-test\): failed\n  FAIL a\.test\.js/);
  assert.match(text, /tests \(go-test\): passed/);
});

test('a per-file tool that hits its run cap says which files it did not scan', async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'a\n');
  r.write('b.js', 'b\n');
  r.write('c.js', 'c\n');
  const tools = [{ id: 'gitleaks', kind: 'secrets', scope: 'files', perFile: true, parse: 'lines', argv: node('0') }];
  const ev = await gatherEvidence(r.dir, resolveTarget(r.dir), { config, tools, maxPerFileRuns: 2 });
  assert.deepEqual(ev.tools[0].unscanned, ['c.js']);
  assert.match(formatEvidence(ev), /gitleaks: 0 on changed lines; only 2 of 3 changed files scanned, the rest are unchecked/);
});

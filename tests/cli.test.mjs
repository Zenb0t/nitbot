import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';

test('context writes the run state and ends with directives', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('src/auth.js', 'export function login() {}\n');
  r.commit('init');
  r.write('src/auth.js', 'export function login(user) {\n  return user.id;\n}\n');

  const { code, out } = r.cli('context', '--seed', '3');
  assert.equal(code, 0, out);
  assert.match(out, /registers: .*security/);
  assert.match(out, /DIRECTIVES:/);
  assert.match(out, /INTENT_MISSING/);
  for (const f of ['current.diff', 'intent.md', 'map.md', 'run.json']) assert.ok(fs.existsSync(path.join(r.dir, '.nitbot/state', f)), f);
  const run = JSON.parse(fs.readFileSync(path.join(r.dir, '.nitbot/state/run.json'), 'utf8'));
  assert.equal(run.lensSeed, 3);
  assert.ok(run.rulebooks.includes('reference/registers/security.md'));
  assert.ok(fs.readFileSync(path.join(r.dir, '.nitbot/.gitignore'), 'utf8').includes('state/'));
});

test('evidence stdout is contentless unless --print', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'x\n');
  r.commit('init');
  r.write('a.js', 'x\n  debugger;\n');
  r.cli('context');
  const quiet = r.cli('evidence', '--no-tests');
  assert.match(quiet.out, /Read it only after the Reviewer returns/);
  assert.doesNotMatch(quiet.out, /debugger/);
  assert.match(r.cli('evidence', '--no-tests', '--print').out, /debugger/);
});

test('save refuses an invalid review and says how to fix it', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'x\n');
  r.commit('init');
  r.write('a.js', 'y\n');
  r.cli('context');
  r.write('bad.json', JSON.stringify({ verdict: 'maybe', method: 'dual', gates: [], findings: [] }));
  const res = r.cli('save', 'bad.json');
  assert.equal(res.code, 1);
  assert.match(res.out, /REVIEW_REJECTED[\s\S]*verdict must be one of/);
});

test('detect exits 2 on findings and 0 when clean', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'x\n');
  r.commit('init');
  r.write('a.js', '<<<<<<< HEAD\n');
  assert.equal(r.cli('detect').code, 2);
  r.write('a.js', 'y\n');
  assert.equal(r.cli('detect').code, 0);
});

test("evidence checks the diff context saved, even after nitbot's first run creates .nitbot/", (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'x\n');
  r.commit('init');
  r.write('a.js', 'x\n  debugger;\n');
  r.commit('add a breakpoint');

  const first = r.cli('context');
  assert.match(first.out, /target:\s+last commit .* add a breakpoint/);
  assert.match(r.cli('context').out, /target:\s+last commit/, 'the second run is not "uncommitted changes" to .nitbot/');
  const ev = r.cli('evidence', '--no-tests', '--print').out;
  assert.match(ev, /EVIDENCE for last commit/);
  assert.match(ev, /a\.js:2 debugger/);
  assert.doesNotMatch(ev, /WARNING/);

  r.write('b.js', 'b\n');
  r.commit('another');
  const moved = r.cli('evidence', '--no-tests', '--print').out;
  assert.match(moved, /EVIDENCE for last commit .* add a breakpoint/, 'still the reviewed change');
  assert.match(moved, /WARNING: HEAD moved/);
});

test('a config file that is not valid JSON is reported, and never overwritten', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'x\n');
  r.commit('init');
  const broken = '{\n  "review": { "mode": "full" },\n}\n';
  r.write('.nitbot/config.json', broken);

  const res = r.cli('ignore', 'rule', 'swallowed-error');
  assert.equal(res.code, 1);
  assert.match(res.out, /CONFIG_INVALID: \.nitbot\/config\.json is not valid JSON/);
  assert.equal(fs.readFileSync(path.join(r.dir, '.nitbot/config.json'), 'utf8'), broken, 'the team file is untouched');

  assert.match(r.cli('context').out, /CONFIG_INVALID: \.nitbot\/config\.json: .*NOT applied/);
  assert.match(r.cli('hooks').out, /INVALID \(not applied\): \.nitbot\/config\.json/);

  r.write('.nitbot/config.json', '{ "review": { "mode": "full" } }\n');
  assert.equal(r.cli('ignore', 'rule', 'swallowed-error').code, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(r.dir, '.nitbot/config.json'), 'utf8'));
  assert.deepEqual(saved, { review: { mode: 'full' }, detector: { ignoreRules: ['swallowed-error'] } }, 'existing keys kept');
});

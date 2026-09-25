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

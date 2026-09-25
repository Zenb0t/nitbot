import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { runHook } from '../skills/nitbot/scripts/lib/hook.mjs';

const AWS = 'AKIA' + 'Z'.repeat(16);

function repo(t) {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('src/a.js', 'export const a = 1;\n');
  r.commit('init');
  return r;
}

test('post-edit blocks a leaked key on the lines just written, stays silent otherwise', (t) => {
  const r = repo(t);
  r.write('src/a.js', `export const a = 1;\nexport const key = "${AWS}";\n`);
  const edit = { cwd: r.dir, tool_input: { file_path: path.join(r.dir, 'src/a.js') } };
  const res = runHook('post-edit', edit);
  assert.equal(res.decision, 'block');
  assert.match(res.reason, /cloud-token/);
  assert.ok(!res.reason.includes(AWS), 'the key itself is redacted');

  r.write('src/a.js', 'export const a = 2;\n');
  assert.equal(runHook('post-edit', edit), null);
});

test('post-edit ignores pre-existing problems in untouched lines', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('src/a.js', '  debugger;\n');
  r.commit('old debt');
  r.write('src/a.js', '  debugger;\nconst b = 1;\n');
  assert.equal(runHook('post-edit', { cwd: r.dir, tool_input: { file_path: path.join(r.dir, 'src/a.js') } }), null);
});

test('commit gate denies staged focused tests and defers to a repo pre-commit setup', (t) => {
  const r = repo(t);
  r.write('src/a.test.js', "it.only('x', () => {});\n");
  r.git('add', '-A');
  const bash = (command) => runHook('pre-bash', { cwd: r.dir, tool_input: { command } });

  assert.equal(bash('git commit -m "wip"').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(bash('cd sub && git -c x=y commit -am wip').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(bash('git status'), null);
  assert.equal(bash('echo "git commit is great"'), null);

  r.write('.pre-commit-config.yaml', 'repos: []\n');
  assert.equal(bash('git commit -m "wip"'), null, 'auto mode steps aside for pre-commit');
});

test('stop pass reports deferred findings once, and only when enabled', (t) => {
  const r = repo(t);
  const edit = { cwd: r.dir, session_id: 's1', tool_input: { file_path: path.join(r.dir, 'src/a.js') } };
  r.write('src/a.js', 'export const a = 1;\ntry { go() } catch (e) {}\n');

  runHook('post-edit', edit);
  assert.equal(runHook('stop', { cwd: r.dir, session_id: 's1' }), null, 'off by default');

  r.write('.nitbot/config.json', JSON.stringify({ hook: { stopPass: true } }));
  runHook('post-edit', edit);
  const first = runHook('stop', { cwd: r.dir, session_id: 's1' });
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /swallowed-error/);
  assert.equal(runHook('stop', { cwd: r.dir, session_id: 's1' }), null, 'reported once');
  assert.equal(runHook('stop', { cwd: r.dir, session_id: 's1', stop_hook_active: true }), null);
});

test('hooks can be switched off', (t) => {
  const r = repo(t);
  r.write('.nitbot/config.json', JSON.stringify({ hook: { enabled: false } }));
  r.write('src/a.js', '<<<<<<< HEAD\n');
  assert.equal(runHook('post-edit', { cwd: r.dir, tool_input: { file_path: path.join(r.dir, 'src/a.js') } }), null);
});

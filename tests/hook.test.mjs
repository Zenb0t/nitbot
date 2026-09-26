import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { runHook, shellWords, commitArgs } from '../skills/nitbot/scripts/lib/hook.mjs';

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

test('commit gate: flag-like words inside a commit message are not flags', (t) => {
  const r = repo(t);
  r.write('src/wip.js', 'export const w = 1;\n');
  r.commit('wip file');
  r.write('src/wip.js', 'export const w = 1;\n  debugger;\n'); // unstaged, not part of the commit
  r.write('src/a.js', 'export const a = 2;\n');
  r.git('add', 'src/a.js');
  const bash = (command) => runHook('pre-bash', { cwd: r.dir, tool_input: { command } });

  assert.equal(bash('git commit -m "support --all"'), null);
  assert.equal(bash("git commit -m 'Add -all flag'"), null);
  assert.equal(bash('git commit --message="-a is now the default" && git push'), null);
  const heredoc = 'git commit -m "$(cat <<\'EOF\'\nsupport --all, "quoted" and (parens\n\n-a too\nEOF\n)"';
  assert.equal(bash(heredoc), null, 'a heredoc message is one word, quotes and parens included');
  assert.equal(bash('git commit -am "wip"').hookSpecificOutput.permissionDecision, 'deny', '-a still checks unstaged work');
  assert.equal(bash('git commit --all -m wip').hookSpecificOutput.permissionDecision, 'deny');
});

test('commit gate: `git commit <paths>` is checked against those files on disk', (t) => {
  const r = repo(t);
  r.write('src/b.js', 'export const b = 1;\n');
  r.commit('b');
  r.write('src/b.js', 'export const b = 1;\n  debugger;\n'); // unstaged
  r.write('src/a.test.js', "it.only('x', () => {});\n");
  r.git('add', 'src/a.test.js'); // staged, but not in a pathspec commit
  r.write('src/a.js', 'export const a = 2;\n');
  const bash = (command) => runHook('pre-bash', { cwd: r.dir, tool_input: { command } });

  assert.match(bash('git commit src/b.js -m "tidy"').hookSpecificOutput.permissionDecisionReason, /debugger/);
  assert.equal(bash('git commit -m "tidy" -- src/a.js'), null, 'the staged focused test is not in this commit');
  const include = bash('git commit -i src/a.js -m x').hookSpecificOutput.permissionDecisionReason;
  assert.match(include, /focused-test/, '--include keeps what is staged');
});

test('shellWords and commitArgs', () => {
  assert.deepEqual(shellWords(String.raw`-m "a b" 'c d' e\ f; rm x`), ['-m', 'a b', 'c d', 'e f']);
  assert.deepEqual(commitArgs(shellWords('-qm msg -- "my file.js" 2> /dev/null')), { all: false, include: false, paths: ['my file.js'] });
  assert.deepEqual(commitArgs(['-F', '-', '<<EOF']), { all: false, include: false, paths: [] });
  assert.deepEqual(commitArgs(['-uno', '-S', 'a.js']), { all: false, include: false, paths: ['a.js'] });
  assert.equal(commitArgs(['-va']).all, true);
});

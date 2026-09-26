import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from './helpers.mjs';
import { resolveTarget } from '../skills/nitbot/scripts/lib/git.mjs';

const paths = (t) => t.files.map((f) => f.path).sort();

test('initial repo: staged and untracked files', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'x\n');
  const target = resolveTarget(r.dir);
  assert.equal(target.kind, 'initial');
  assert.deepEqual(paths(target), ['a.js']);
});

test('feature branch: committed, uncommitted and untracked changes vs the merge-base', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', 'function a() {\n  return 1;\n}\n');
  r.commit('init');
  r.git('checkout', '-q', '-b', 'feat/thing');
  r.write('a.js', 'function a() {\n  return 2;\n}\n');
  r.commit('feat: return two');
  r.write('b.js', 'new\n');

  const target = resolveTarget(r.dir);
  assert.equal(target.kind, 'branch');
  assert.equal(target.slug, 'feat-thing');
  assert.deepEqual(paths(target), ['a.js', 'b.js']);
  assert.match(target.intent, /feat: return two/);
  assert.match(target.fnDiffText, /function a\(\) \{/, 'reviewer diff carries whole functions');
});

test('clean default branch reviews the last commit', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', '1\n');
  r.commit('one');
  r.write('a.js', '2\n');
  r.commit('two');
  const target = resolveTarget(r.dir);
  assert.equal(target.kind, 'commit');
  assert.match(target.label, /two/);
});

test('dirty default branch reviews uncommitted changes', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', '1\n');
  r.commit('one');
  r.write('a.js', '2\n');
  assert.equal(resolveTarget(r.dir).kind, 'worktree');
});

test('explicit targets: staged, commit, range, path', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', '1\n');
  r.write('src/b.js', 'b\n');
  r.commit('one');
  r.write('a.js', '2\n');
  r.commit('two');
  r.write('a.js', '3\n');
  r.git('add', 'a.js');

  assert.equal(resolveTarget(r.dir, 'staged').kind, 'staged');
  assert.equal(resolveTarget(r.dir, 'HEAD').kind, 'commit');
  assert.equal(resolveTarget(r.dir, 'HEAD~1..HEAD').kind, 'range');
  const unchanged = resolveTarget(r.dir, 'src/b.js');
  assert.equal(unchanged.kind, 'path');
  assert.match(unchanged.label, /full contents/);
  assert.throws(() => resolveTarget(r.dir, 'no-such-thing'), /Unrecognized target/);
});

test("nitbot's own .nitbot/ folder never makes a clean tree look dirty", (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('a.js', '1\n');
  r.commit('one');
  r.write('a.js', '2\n');
  r.commit('two');
  r.write('.nitbot/.gitignore', 'state/\n');
  r.write('.nitbot/config.json', '{}\n');
  const target = resolveTarget(r.dir);
  assert.equal(target.kind, 'commit', 'still the last commit, not "uncommitted changes"');
  assert.deepEqual(paths(target), ['a.js']);

  r.git('checkout', '-q', '-b', 'feat');
  r.write('b.js', 'b\n');
  r.git('add', 'b.js');
  r.git('commit', '-q', '-m', 'feat');
  assert.deepEqual(paths(resolveTarget(r.dir)), ['b.js'], 'untracked .nitbot files stay out of a branch review');
});

test('paths with spaces come out of git without the trailing tab', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('my file.js', '1\n');
  r.commit('one');
  r.write('my file.js', '2\n');
  assert.deepEqual(paths(resolveTarget(r.dir)), ['my file.js']);
});

test('a path target includes untracked files under it', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('src/feature/old.js', 'a\n');
  r.write('src/other.js', 'o\n');
  r.commit('init');

  r.write('src/feature/new.js', 'n\n');
  const onlyNew = resolveTarget(r.dir, 'src/feature');
  assert.match(onlyNew.label, /uncommitted changes/);
  assert.deepEqual(paths(onlyNew), ['src/feature/new.js'], 'the new file, not the unchanged one as "added"');

  r.write('src/feature/old.js', 'b\n');
  r.write('src/other-new.js', 'x\n');
  assert.deepEqual(paths(resolveTarget(r.dir, 'src/feature')), ['src/feature/new.js', 'src/feature/old.js']);
});

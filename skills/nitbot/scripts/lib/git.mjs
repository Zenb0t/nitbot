// Resolves "what are we reviewing" into one diff. Every consumer (context,
// detect, hooks) goes through here so the reviewer, the evidence agent and the
// hooks all see the same change set.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseDiff, fileAsAdded } from './diff.mjs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DIFF = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '-U3'];
const MAX_UNTRACKED_BYTES = 1024 * 1024;

export function run(cmd, args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (allowFail) return null;
    const msg = (err.stderr || err.message || '').toString().trim();
    throw new Error(`${cmd} ${args.join(' ')} failed: ${msg}`);
  }
}

export const git = (root, args, opts = {}) => run('git', args, { cwd: root, ...opts });
const tryGit = (root, args) => git(root, args, { allowFail: true })?.trim() || null;
// For commands whose success prints nothing (show-ref --quiet, cat-file -e).
const gitOk = (root, args) => git(root, args, { allowFail: true }) !== null;

export function repoRoot(cwd = process.cwd()) {
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  return top ? path.resolve(top.trim()) : null;
}

export function defaultBranch(root) {
  const remoteHead = tryGit(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master', 'trunk', 'develop']) {
    if (tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
}

// target: undefined (auto) | "staged" | PR number/URL | "a..b" / "a...b" | branch | commit | path
export function resolveTarget(root, target) {
  const hasHead = Boolean(tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']));
  const branch = hasHead ? tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) : tryGit(root, ['symbolic-ref', '--short', 'HEAD']);
  const t = (target ?? '').trim();

  if (!t) return autoTarget(root, { hasHead, branch });
  if (t === 'staged' || t === '--staged') {
    return build(root, {
      kind: 'staged',
      label: 'staged changes',
      slug: slugify(branch || 'staged'),
      diffArgs: ['--cached', hasHead ? 'HEAD' : EMPTY_TREE],
    });
  }
  const pr = t.match(/^#?(\d+)$/) || t.match(/\/pull\/(\d+)/);
  if (pr) return prTarget(root, pr[1]);

  if (t.includes('..')) {
    const [a, b] = t.split(/\.{2,3}/);
    const threeDot = t.includes('...');
    return build(root, {
      kind: 'range',
      label: `range ${t}`,
      slug: slugify(t),
      diffArgs: [threeDot ? `${a}...${b || 'HEAD'}` : `${a}..${b || 'HEAD'}`],
      intentRange: `${a}..${b || 'HEAD'}`,
    });
  }

  const onDisk = path.resolve(root, t);
  if (fs.existsSync(onDisk) && !tryGit(root, ['rev-parse', '--verify', '--quiet', `${t}^{commit}`])) {
    return pathTarget(root, path.relative(root, onDisk).split(path.sep).join('/'), hasHead);
  }

  if (tryGit(root, ['rev-parse', '--verify', '--quiet', `${t}^{commit}`])) {
    const isBranch = gitOk(root, ['show-ref', '--verify', '--quiet', `refs/heads/${t}`]) ||
      gitOk(root, ['show-ref', '--verify', '--quiet', `refs/remotes/${t}`]);
    if (isBranch) {
      const def = defaultBranch(root);
      const base = def && tryGit(root, ['merge-base', def, t]);
      if (!base) throw new Error(`Cannot find a merge-base between ${def ?? '(no default branch)'} and ${t}.`);
      return build(root, {
        kind: 'branch',
        label: `branch ${t} vs ${def} (merge-base ${base.slice(0, 7)})`,
        slug: slugify(t),
        diffArgs: [base, t],
        intentRange: `${base}..${t}`,
      });
    }
    const sha = tryGit(root, ['rev-parse', '--short', t]);
    const parent = tryGit(root, ['rev-parse', '--verify', '--quiet', `${t}^`]) ?? EMPTY_TREE;
    return build(root, {
      kind: 'commit',
      label: `commit ${sha} ${tryGit(root, ['log', '-1', '--format=%s', t]) ?? ''}`.trim(),
      slug: `commit-${sha}`,
      diffArgs: [parent, t],
      intentRange: `${parent === EMPTY_TREE ? '' : parent + '..'}${t}`,
    });
  }

  throw new Error(`Unrecognized target "${t}". Use a PR number, branch, commit, range (a..b), path, or "staged".`);
}

function autoTarget(root, { hasHead, branch }) {
  if (!hasHead) {
    return build(root, {
      kind: 'initial',
      label: 'initial import (no commits yet): staged + untracked files',
      slug: slugify(branch || 'initial'),
      diffArgs: ['--cached', EMPTY_TREE],
      untracked: true,
    });
  }
  const dirty = Boolean(tryGit(root, ['status', '--porcelain']));
  const def = defaultBranch(root);
  const base = def && tryGit(root, ['merge-base', def, 'HEAD']);
  const head = tryGit(root, ['rev-parse', 'HEAD']);

  if (base && base !== head) {
    return build(root, {
      kind: 'branch',
      label: `${branch} vs ${def} (merge-base ${base.slice(0, 7)})${dirty ? ' + uncommitted changes' : ''}`,
      slug: slugify(branch),
      diffArgs: [base],
      untracked: true,
      intentRange: `${base}..HEAD`,
    });
  }
  if (dirty) {
    return build(root, {
      kind: 'worktree',
      label: 'uncommitted changes vs HEAD',
      slug: slugify(branch || 'worktree'),
      diffArgs: ['HEAD'],
      untracked: true,
    });
  }
  const parent = tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^']) ?? EMPTY_TREE;
  return build(root, {
    kind: 'commit',
    label: `last commit ${head.slice(0, 7)} ${tryGit(root, ['log', '-1', '--format=%s']) ?? ''} (tree is clean and has nothing ahead of ${def ?? 'a default branch'})`,
    slug: `commit-${head.slice(0, 7)}`,
    diffArgs: [parent, 'HEAD'],
    intentRange: parent === EMPTY_TREE ? 'HEAD' : `${parent}..HEAD`,
  });
}

function pathTarget(root, rel, hasHead) {
  const changed = hasHead ? git(root, [...DIFF, 'HEAD', '--', rel], { allowFail: true }) : null;
  if (changed && changed.trim()) {
    return build(root, { kind: 'path', label: `uncommitted changes in ${rel}`, slug: slugify(rel), diffArgs: ['HEAD', '--', rel] });
  }
  // Unchanged path: review the code as it stands, every line as "added".
  const files = [];
  const stat = fs.statSync(path.join(root, rel));
  const list = stat.isDirectory() ? (tryGit(root, ['ls-files', '--', rel]) ?? '').split('\n').filter(Boolean) : [rel];
  let text = '';
  for (const p of list) {
    const content = readSmallText(path.join(root, p));
    if (content === null) continue;
    files.push(fileAsAdded(p, content));
    text += syntheticDiff(p, content);
  }
  return { kind: 'path', label: `full contents of ${rel} (no pending changes)`, slug: slugify(rel), diffText: text, files, intent: '' };
}

function prTarget(root, number) {
  if (!run('gh', ['--version'], { allowFail: true })) {
    throw new Error('GH_MISSING: reviewing a PR needs the GitHub CLI (gh). Install it and run `gh auth login`, or pass a branch instead.');
  }
  const meta = JSON.parse(run('gh', ['pr', 'view', number, '--json', 'number,title,body,baseRefName,headRefName,headRefOid,url,isDraft'], { cwd: root }));
  const diffText = run('gh', ['pr', 'diff', number], { cwd: root });
  const headLocal = tryGit(root, ['rev-parse', 'HEAD']);
  // Make the PR head readable with `git show <sha>:<path>` even when it is not checked out.
  if (!gitOk(root, ['cat-file', '-e', `${meta.headRefOid}^{commit}`])) {
    git(root, ['fetch', '--quiet', 'origin', `pull/${number}/head`], { allowFail: true });
  }
  return {
    kind: 'pr',
    label: `PR #${meta.number} ${meta.title} (${meta.headRefName} -> ${meta.baseRefName})${meta.isDraft ? ' [draft]' : ''}`,
    slug: `pr-${meta.number}`,
    diffText,
    files: parseDiff(diffText),
    intent: `# ${meta.title}\n\n${meta.body ?? ''}`.trim(),
    pr: { ...meta, checkedOut: headLocal === meta.headRefOid, headAvailable: gitOk(root, ['cat-file', '-e', `${meta.headRefOid}^{commit}`]) },
  };
}

function build(root, spec) {
  let diffText = git(root, [...DIFF, ...spec.diffArgs]);
  // The reviewer's copy shows whole enclosing functions instead of 3 lines of
  // context: the cheapest context upgrade there is, and it costs no tool calls.
  let fnDiffText = git(root, [...DIFF, '--function-context', ...spec.diffArgs], { allowFail: true }) ?? diffText;
  if (spec.untracked) {
    const untracked = (tryGit(root, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean);
    for (const p of untracked) {
      const content = readSmallText(path.join(root, p));
      if (content === null) continue;
      diffText += syntheticDiff(p, content);
      fnDiffText += syntheticDiff(p, content);
    }
  }
  const intent = spec.intentRange
    ? (tryGit(root, ['log', '--format=- %s%n%b', '--no-merges', '-n', '30', spec.intentRange]) ?? '').replace(/\n{2,}/g, '\n').trim()
    : '';
  return { kind: spec.kind, label: spec.label, slug: spec.slug, diffText, fnDiffText, files: parseDiff(diffText), intent };
}

// Diff text for a file git does not track yet, so reviewers read one format.
export function syntheticDiff(p, content) {
  const lines = content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`;
}

export function readSmallText(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return null;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// Diff of one file against HEAD, or the whole file when git does not know it.
// Used by the per-edit hook so only lines this session added are judged.
export function fileChanges(root, rel) {
  const tracked = gitOk(root, ['ls-files', '--error-unmatch', '--', rel]);
  const hasHead = Boolean(tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']));
  if (tracked && hasHead) {
    const text = git(root, [...DIFF, 'HEAD', '--', rel], { allowFail: true }) ?? '';
    return parseDiff(text);
  }
  const content = readSmallText(path.join(root, rel));
  return content === null ? [] : [fileAsAdded(rel, content)];
}

export function slugify(s) {
  return (s || 'review').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'review';
}

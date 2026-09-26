// Claude Code hook handlers. Silent when clean (zero tokens); a message only
// when something fires. Every handler fails open: a bug in nitbot must never
// block the user's work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, nitbotDir, ensureNitbotDir, readJson } from './config.mjs';
import { detect, formatFindings } from './detect.mjs';
import { repoRoot, fileChanges, git, defaultBranch } from './git.mjs';
import { parseDiff } from './diff.mjs';
import { commitFramework } from './toolchain.mjs';

const IGNORE_HINT =
  'If a finding is a deliberate fixture (for example a fake key in a test), put `nitbot-ignore: <rule>` on that line and tell the user why. Never add an ignore just to get past the check.';

export function runHook(event, payload) {
  try {
    const cwd = payload.cwd || process.cwd();
    const root = repoRoot(cwd);
    if (!root) return null;
    const config = loadConfig(root);
    if (!config.hook.enabled) return null;
    if (event === 'post-edit') return postEdit(root, config, payload);
    if (event === 'pre-bash') return preBash(root, config, payload);
    if (event === 'stop') return stop(root, config, payload);
  } catch (err) {
    process.stderr.write(`nitbot hook ${event} skipped: ${err.message}\n`);
  }
  return null;
}

function postEdit(root, config, payload) {
  if (!config.hook.editCheck) return null;
  const abs = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!abs) return null;
  const rel = path.relative(root, path.resolve(payload.cwd || root, abs)).split(path.sep).join('/');
  if (rel.startsWith('..') || rel.startsWith('.nitbot/')) return null;

  if (config.hook.stopPass && payload.session_id) remember(root, payload.session_id, rel);

  const findings = detect(fileChanges(root, rel), { config, tiers: ['immediate'] });
  if (!findings.length) return null;
  return {
    decision: 'block',
    reason: `nitbot: ${findings.length} blocking issue(s) in lines you just wrote:\n${formatFindings(findings)}\nFix these now. ${IGNORE_HINT}`,
  };
}

const GIT_CMD = String.raw`(?:^|[;&|(]\s*|\s)git\s+((?:-[cC]\s+\S+\s+)*)`;
const COMMIT = new RegExp(`${GIT_CMD}commit\\b`);
const PUSH = new RegExp(`${GIT_CMD}push\\b`);
const CD = /(?:^|[;&|(\n]|\s)(?:cd|pushd)(?:\s|$)/;

function preBash(root, config, payload) {
  const gate = config.hook.commitGate;
  if (gate === false || (gate === 'auto' && commitFramework(root))) return null;
  const cmd = payload.tool_input?.command ?? '';

  // Each entry is one `git diff` argument list; results are merged by path.
  let diffSets = null;
  let what = '';
  // Pathspecs are relative to where the command runs, not the repo root.
  let cwd = payload.cwd || root;
  const commit = COMMIT.exec(cmd);
  if (commit) {
    const { all, include, paths } = commitArgs(shellWords(cmd, commit.index + commit[0].length));
    const opts = shellWords(commit[1]);
    // A -C naming $VAR, $(...) or ~user resolves to no real directory, where
    // git diff would fail and check nothing. Fall back to the root.
    let unknownDir = false;
    for (let i = 0; i < opts.length; i += 2) {
      if (opts[i] !== '-C' || unknownDir) continue;
      const dir = path.resolve(cwd, opts[i + 1].replace(/^~(?=$|[/\\])/, () => os.homedir()));
      if (fs.existsSync(dir)) cwd = dir;
      else [unknownDir, cwd] = [true, root];
    }
    if (all) {
      diffSets = [['HEAD']];
      what = 'this commit (-a)';
    } else if (paths.length && (unknownDir || CD.test(cmd.slice(0, commit.index)))) {
      // A cd before the commit, or a -C we cannot resolve, leaves the
      // pathspecs' directory unknown: check every tracked change, a superset
      // of what the commit takes.
      diffSets = [['HEAD']];
      const where = unknownDir ? 'under a -C directory nitbot cannot resolve' : 'after a cd';
      what = `the uncommitted changes (this commit names ${paths.join(' ')} ${where}, so all of them were checked)`;
    } else if (paths.length) {
      // `git commit <paths>` commits those files as they are on disk, not the index.
      diffSets = include ? [['--cached'], ['HEAD', '--', ...paths]] : [['HEAD', '--', ...paths]];
      what = `this commit (${paths.join(' ')})`;
    } else {
      diffSets = [['--cached']];
      what = 'the staged changes';
    }
  } else if (PUSH.test(cmd)) {
    const upstream = git(root, ['rev-parse', '--verify', '--quiet', '@{u}'], { allowFail: true })?.trim();
    const def = defaultBranch(root);
    const base = upstream || (def && git(root, ['merge-base', def, 'HEAD'], { allowFail: true })?.trim());
    if (!base) return null;
    diffSets = [[base, 'HEAD']];
    what = 'the commits being pushed';
  } else {
    return null;
  }

  const files = new Map();
  for (const args of diffSets) {
    const text = git(cwd, ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-U1', ...args], { allowFail: true }) ?? '';
    for (const f of parseDiff(text)) files.set(f.path, f);
  }
  const findings = detect([...files.values()], { config, tiers: ['immediate'] });
  if (!findings.length) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `nitbot blocked this: ${what} contain ${findings.length} blocking issue(s):\n${formatFindings(findings)}\nFix them and retry. ${IGNORE_HINT}`,
    },
  };
}

// git commit options that take their value as the next word (or attached,
// as in -mfoo / --message=foo). Their values are never flags or paths.
const VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file']);
const VALUE_SHORT = 'mFCct';
const OPTIONAL_SHORT = 'uS'; // value only when attached: -uno, -S<keyid>
const REDIRECT = /^\d*[<>]/;

export function commitArgs(words) {
  let all = false;
  let include = false;
  let endOfOptions = false;
  const paths = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (REDIRECT.test(w)) {
      if (/^\d*[<>]+&?$/.test(w)) i++; // bare operator: its target is the next word
      continue;
    }
    if (endOfOptions || !w.startsWith('-') || w === '-') {
      paths.push(w);
    } else if (w === '--') {
      endOfOptions = true;
    } else if (w.startsWith('--')) {
      const name = w.split('=')[0];
      if (name === '--all') all = true;
      else if (name === '--include') include = true;
      else if (VALUE_LONG.has(name) && !w.includes('=')) i++;
    } else {
      for (let j = 1; j < w.length; j++) {
        const f = w[j];
        if (f === 'a') all = true;
        else if (f === 'i') include = true;
        else if (VALUE_SHORT.includes(f)) {
          if (j === w.length - 1) i++;
          break;
        } else if (OPTIONAL_SHORT.includes(f)) break;
      }
    }
  }
  return { all, include, paths };
}

// The words of one simple command, starting at `start` and stopping at an
// unquoted ; & | ( ) or newline. Quotes, escapes, backticks and $(...)
// (heredocs inside it included) stay within their word, so a commit message
// is always one word however much it looks like flags.
export function shellWords(s, start = 0) {
  const words = [];
  let word = null;
  let i = start;
  const add = (text) => (word = (word ?? '') + text);
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] !== '\n') add(s[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const end = closing(s, "'", i + 1);
      add(s.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      const end = endOfDoubleQuote(s, i + 1);
      add(s.slice(i + 1, end));
      i = end + 1;
    } else if (c === '`') {
      const end = closing(s, '`', i + 1);
      add(s.slice(i, end + 1));
      i = end + 1;
    } else if (c === '$' && s[i + 1] === '(') {
      const end = endOfSubstitution(s, i + 2);
      add(s.slice(i, end));
      i = end;
    } else if (/[;&|()\n]/.test(c)) {
      break;
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
      i++;
    } else {
      add(c);
      i++;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const closing = (s, ch, from) => {
  const end = s.indexOf(ch, from);
  return end < 0 ? s.length : end;
};

// Index of the closing " (or the end), skipping escapes and nested $(...).
function endOfDoubleQuote(s, i) {
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === '"') return i;
    else if (s[i] === '$' && s[i + 1] === '(') i = endOfSubstitution(s, i + 2);
    else if (s[i] === '`') i = closing(s, '`', i + 1) + 1;
    else i++;
  }
  return s.length;
}

// Index just past the ) that closes a $( opened before `i`. Heredoc bodies
// are skipped whole: a commit message there may hold quotes and parens.
function endOfSubstitution(s, i) {
  let depth = 1;
  const heredocs = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = closing(s, "'", i + 1) + 1;
    else if (c === '"') i = endOfDoubleQuote(s, i + 1) + 1;
    else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(s.slice(i));
      if (m) heredocs.push({ delim: m[3], tabs: m[1] === '-' });
      i += m ? m[0].length : 2;
    } else if (c === '\n' && heredocs.length) {
      for (const h of heredocs.splice(0)) {
        const re = new RegExp(`\\n${h.tabs ? '\\t*' : ''}${h.delim.replace(/[.-]/g, '\\$&')}(?=\\n|$)`, 'g');
        re.lastIndex = i;
        const m = re.exec(s);
        i = m ? m.index + m[0].length : s.length;
      }
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      i++;
      if (--depth === 0) return i;
    } else i++;
  }
  return s.length;
}

function stop(root, config, payload) {
  if (!config.hook.stopPass || payload.stop_hook_active || !payload.session_id) return null;
  const sessionFile = path.join(nitbotDir(root), 'state', `session-${safe(payload.session_id)}.json`);
  const touched = readJson(sessionFile, { files: [] }).files;
  if (!touched.length) return null;

  const seenFile = path.join(nitbotDir(root), 'state', 'seen.json');
  const seen = new Set(readJson(seenFile, []));
  const findings = touched
    .flatMap((rel) => detect(fileChanges(root, rel), { config, tiers: ['deferred'] }))
    .filter((f) => !seen.has(f.fingerprint));
  if (!findings.length) return null;

  for (const f of findings) seen.add(f.fingerprint);
  fs.writeFileSync(seenFile, JSON.stringify([...seen].slice(-2000)));
  return {
    decision: 'block',
    reason: `nitbot end-of-session pass: ${findings.length} issue(s) in files you edited (reported once):\n${formatFindings(findings)}\nFix the real ones, then finish. For a false positive, tell the user and suggest \`/nitbot dismiss\`.`,
  };
}

function remember(root, sessionId, rel) {
  ensureNitbotDir(root);
  const file = path.join(nitbotDir(root), 'state', `session-${safe(sessionId)}.json`);
  const state = readJson(file, { files: [] });
  if (!state.files.includes(rel)) {
    state.files.push(rel);
    fs.writeFileSync(file, JSON.stringify(state));
  }
}

const safe = (s) => String(s).replace(/[^\w-]/g, '').slice(0, 64);

// Claude Code hook handlers. Silent when clean (zero tokens); a message only
// when something fires. Every handler fails open: a bug in nitbot must never
// block the user's work.
import fs from 'node:fs';
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

const GIT_CMD = String.raw`(?:^|[;&|(]\s*|\s)git\s+(?:-[cC]\s+\S+\s+)*`;
const COMMIT = new RegExp(`${GIT_CMD}commit\\b(.*)`);
const PUSH = new RegExp(`${GIT_CMD}push\\b`);

function preBash(root, config, payload) {
  const gate = config.hook.commitGate;
  if (gate === false || (gate === 'auto' && commitFramework(root))) return null;
  const cmd = payload.tool_input?.command ?? '';

  let diffArgs = null;
  let what = '';
  const commit = cmd.match(COMMIT);
  if (commit) {
    const all = /\s-[a-zA-Z]*a[a-zA-Z]*\b|\s--all\b/.test(` ${commit[1]}`);
    diffArgs = all ? ['HEAD'] : ['--cached'];
    what = all ? 'this commit (-a)' : 'the staged changes';
  } else if (PUSH.test(cmd)) {
    const upstream = git(root, ['rev-parse', '--verify', '--quiet', '@{u}'], { allowFail: true })?.trim();
    const def = defaultBranch(root);
    const base = upstream || (def && git(root, ['merge-base', def, 'HEAD'], { allowFail: true })?.trim());
    if (!base) return null;
    diffArgs = [base, 'HEAD'];
    what = 'the commits being pushed';
  } else {
    return null;
  }

  const text = git(root, ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-U1', ...diffArgs], { allowFail: true }) ?? '';
  const findings = detect(parseDiff(text), { config, tiers: ['immediate'] });
  if (!findings.length) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `nitbot blocked this: ${what} contain ${findings.length} blocking issue(s):\n${formatFindings(findings)}\nFix them and retry. ${IGNORE_HINT}`,
    },
  };
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

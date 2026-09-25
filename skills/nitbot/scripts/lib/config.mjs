// Project config lives in .nitbot/: config.json is shared (committed),
// config.local.json is per-developer (gitignored). Local wins, key by key.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  hook: {
    enabled: true, // master switch for every automatic hook
    editCheck: true, // PostToolUse: immediate-tier findings after each edit
    // PreToolUse: refuse `git commit` / `git push` with immediate-tier findings.
    // "auto" steps aside when the repo has its own pre-commit/husky/lefthook.
    commitGate: 'auto',
    stopPass: false, // Stop: one deferred-tier pass over files touched this session
  },
  detector: {
    ignoreRules: [],
    ignoreFiles: [],
  },
  evidence: {
    runTests: true, // related tests when the runner supports it, else the suite
    toolTimeoutSec: 120,
    testTimeoutSec: 300,
  },
  review: {
    mode: 'auto', // auto | quick | full: auto follows the risk score
    maxFindings: 15,
    maxNits: 3,
    largeDiffLines: 1500,
    splitLines: 800,
  },
};

export function nitbotDir(root) {
  return path.join(root, '.nitbot');
}

export function loadConfig(root) {
  const shared = readJson(path.join(nitbotDir(root), 'config.json'));
  const local = readJson(path.join(nitbotDir(root), 'config.local.json'));
  const merged = merge(merge(structuredClone(DEFAULTS), shared), local);
  // Ignore lists concatenate instead of replacing, so a private ignore never
  // silently drops the team's.
  for (const key of ['ignoreRules', 'ignoreFiles']) {
    merged.detector[key] = [...(shared.detector?.[key] ?? []), ...(local.detector?.[key] ?? [])];
  }
  if (process.env.NITBOT_HOOK_DISABLED === '1') merged.hook.enabled = false;
  return merged;
}

export function updateConfig(root, mutate, { local = false } = {}) {
  const file = path.join(nitbotDir(root), local ? 'config.local.json' : 'config.json');
  const current = readJson(file);
  mutate(current);
  ensureNitbotDir(root);
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  return file;
}

// Creates .nitbot/ with its own .gitignore so run state and review archives
// never need an edit to the project's .gitignore. Dismissals, conventions, and
// config.json stay committed: they are team knowledge.
export function ensureNitbotDir(root) {
  const dir = nitbotDir(root);
  const created = !fs.existsSync(dir);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'state/\nreviews/\nconfig.local.json\n');
  return created;
}

export function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Minimal glob: ** crosses directories, * and ? stay within one segment.
// A pattern with no slash matches the basename anywhere, like .gitignore.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

export function matchesAny(filePath, globs) {
  return globs.some((g) => globToRegExp(g.replace(/^\.\//, '')).test(filePath));
}

function merge(target, source) {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object') merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

// The change map: everything a reviewer would otherwise spend turns (and
// tokens) discovering, computed with git and grep for free. The reviewer reads
// the map first and then opens files on purpose instead of wandering.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs|e2e)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const CODE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|py|rb|go|rs|java|kt|cs|php|swift|scala|dart|ex|exs)$/;
const FIX = /\b(fix(es|ed)?|bug|hotfix|regression|revert|patch)\b/i;
const STOP = new Set(['if', 'for', 'while', 'switch', 'return', 'function', 'constructor', 'render', 'main', 'init', 'test', 'describe', 'setup', 'get', 'set', 'default', 'index', 'new', 'self', 'this', 'async', 'await', 'catch', 'then', 'else']);
const DEF_PATTERNS = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:class|interface|type|enum|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/,
  /\bdef\s+([A-Za-z_]\w*)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /\bfn\s+([A-Za-z_]\w*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:public|private|protected|static|async|override|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/,
];

export function buildMap(root, files, { registers = {}, hasHead = true } = {}) {
  const live = files.filter((f) => f.status !== 'deleted' && !f.binary);
  const changedPaths = new Set(files.map((f) => f.path));
  // Symbols other code can reach carry the blast radius, so they win the cut.
  const symbols = changedSymbols(live)
    .slice(0, 60)
    .map((s) => ({ ...s, ...usages(root, s) }))
    .sort((a, b) => (a.scope === 'file') - (b.scope === 'file') || b.callSites - a.callSites)
    .slice(0, 20);
  const log = hasHead ? readLog(root) : [];
  return {
    symbols,
    coChange: coChange(log, files, changedPaths, root),
    history: history(log, live),
    siblings: siblings(root, live, changedPaths),
    untestedChange: Boolean(registers.app?.length || registers.contract?.length) && !registers.tests?.length,
  };
}

function changedSymbols(files) {
  const seen = new Map();
  const add = (name, file, kind) => {
    if (!name || name.length < 3 || STOP.has(name) || seen.has(name)) return;
    seen.set(name, { name, file: file.path, kind });
  };
  for (const f of files.filter((x) => CODE.test(x.path) && !TEST_PATH.test(x.path))) {
    // An added line belongs to the nearest definition above it in its hunk;
    // git's hunk header names the enclosing function when that is off-screen.
    let hunk = -1;
    let enclosing = null;
    f.lines.forEach((l, i) => {
      if (i === 0 || l.n !== f.lines[i - 1].n + 1) enclosing = matchDef(f.hunks[++hunk]?.context);
      const def = matchDef(l.text);
      if (def) enclosing = def;
      if (!l.added) return;
      if (def) add(def, f, 'defined');
      else add(enclosing, f, 'modified');
    });
  }
  return [...seen.values()];
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|<!--)/;

function matchDef(text) {
  if (!text || COMMENT.test(text)) return null;
  for (const re of DEF_PATTERNS) {
    const m = text?.match(re);
    if (m) return m[1];
  }
  return null;
}

// Where a symbol can be called from. A module-private symbol cannot have
// callers outside its file (or package, for Go), so searching further only
// finds namesakes.
function reach(root, sym) {
  const ext = sym.file.split('.').pop();
  if (/^(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte)$/.test(ext)) {
    const src = readHead(root, sym.file, Infinity);
    const n = sym.name.replace(/[$]/g, '\\$');
    const exported = new RegExp(`export\\s+(default\\s+)?(async\\s+)?(function\\*?|class|const|let|var|type|interface|enum)\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b|module\\.exports|exports\\.${n}\\b`).test(src);
    return exported ? 'repo' : 'file';
  }
  if (ext === 'py') return sym.name.startsWith('_') ? 'file' : 'repo';
  if (ext === 'go') return /^[a-z]/.test(sym.name) ? 'package' : 'repo';
  return 'repo';
}

function usages(root, sym) {
  const scope = reach(root, sym);
  if (scope === 'file') return { scope, callSites: 0, callerFiles: [], moreCallerFiles: 0, testFiles: [] };
  const where = scope === 'package' ? path.posix.dirname(sym.file) : '.';
  // Types and classes are referenced by name; functions are called. Matching
  // `name(` keeps short names like `run` from counting every English "run".
  const pattern = /^[A-Z]/.test(sym.name)
    ? ['-w', '-F', '-e', sym.name]
    : ['-E', '-e', `(^|[^A-Za-z0-9_$.])${sym.name.replace(/\$/g, '\\$')}[[:space:]]*\\(`];
  const raw = git(root, ['grep', '-c', '-I', '--untracked', ...pattern, '--', where], { allowFail: true }) ?? '';
  const counts = raw.split('\n').filter(Boolean).map((l) => {
    const i = l.lastIndexOf(':');
    return { file: l.slice(0, i), n: Number(l.slice(i + 1)) };
  });
  const others = counts.filter((c) => c.file !== sym.file);
  const callers = others.filter((c) => !TEST_PATH.test(c.file)).sort((a, b) => b.n - a.n);
  return {
    scope,
    callSites: callers.reduce((s, c) => s + c.n, 0),
    callerFiles: callers.slice(0, 5).map((c) => c.file),
    moreCallerFiles: Math.max(0, callers.length - 5),
    testFiles: others.filter((c) => TEST_PATH.test(c.file)).slice(0, 3).map((c) => c.file),
  };
}

function readLog(root) {
  const raw = git(root, ['log', '--no-merges', '--name-only', '--format=@@%h %s', '-n', '400'], { allowFail: true }) ?? '';
  const commits = [];
  for (const block of raw.split('@@').filter(Boolean)) {
    const [head, ...rest] = block.split('\n');
    const files = rest.map((s) => s.trim()).filter(Boolean);
    if (files.length > 30) continue; // bulk renames and formatting sweeps say nothing about coupling
    commits.push({ subject: head.slice(head.indexOf(' ') + 1), files });
  }
  return commits;
}

// "When X changed in the past, Y changed with it" - and Y is not in this diff.
function coChange(log, files, changedPaths, root) {
  const out = [];
  for (const f of files.filter((x) => x.status !== 'added')) {
    const withF = log.filter((c) => c.files.includes(f.path));
    if (withF.length < 3) continue;
    const partners = new Map();
    for (const c of withF) for (const p of c.files) if (p !== f.path) partners.set(p, (partners.get(p) ?? 0) + 1);
    for (const [p, support] of partners) {
      const confidence = support / withF.length;
      if (support >= 3 && confidence >= 0.5 && !changedPaths.has(p) && fs.existsSync(path.join(root, p))) {
        out.push({ file: f.path, partner: p, support, confidence: Math.round(confidence * 100) / 100 });
      }
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

function history(log, files) {
  return files
    .map((f) => {
      const touching = log.filter((c) => c.files.includes(f.path));
      const fixes = touching.filter((c) => FIX.test(c.subject));
      return { file: f.path, commits: touching.length, fixes: fixes.length, lastFix: fixes[0]?.subject ?? null };
    })
    .filter((h) => h.fixes > 0)
    .sort((a, b) => b.fixes - a.fixes)
    .slice(0, 10);
}

// The files most like each changed file: same folder, same naming pattern,
// most shared imports. One of them shows the house way of doing this thing.
function siblings(root, files, changedPaths) {
  const out = [];
  for (const f of files.filter((x) => CODE.test(x.path) && !TEST_PATH.test(x.path)).slice(0, 6)) {
    const dir = path.posix.dirname(f.path);
    const name = path.posix.basename(f.path);
    const suffix = name.includes('.') ? name.slice(name.indexOf('.')) : '';
    const listed = (git(root, ['ls-files', '--', dir === '.' ? '.' : dir], { allowFail: true }) ?? '').split('\n').filter(Boolean);
    const candidates = listed.filter((p) => path.posix.dirname(p) === dir && p !== f.path && !changedPaths.has(p) && !TEST_PATH.test(p) && p.endsWith(suffix));
    if (!candidates.length) continue;
    const mine = imports(readHead(root, f.path));
    const ranked = candidates
      .slice(0, 40)
      .map((p) => ({ p, score: overlap(mine, imports(readHead(root, p))) }))
      .sort((a, b) => b.score - a.score);
    out.push({ file: f.path, examples: ranked.slice(0, 2).map((r) => r.p) });
  }
  return out;
}

function readHead(root, rel, lines = 80) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8').split('\n').slice(0, lines).join('\n');
  } catch {
    return '';
  }
}

function imports(text) {
  const set = new Set();
  for (const m of text.matchAll(/(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]?([\w./@-]+)|^\s*from\s+([\w.]+)\s+import|^\s*use\s+([\w:]+))/gm)) {
    set.add(m.slice(1).find(Boolean));
  }
  return set;
}

function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

const REGISTER_RISK = { security: 3, data: 3, contract: 2, infra: 2, deps: 1, app: 1 };

// Chooses how much review this change deserves. Size is one input, not the
// input: a one-line auth change outranks a 300-line new component.
export function riskScore({ registers, map, changedLines }) {
  const reasons = [];
  let score = 0;
  for (const [r, w] of Object.entries(REGISTER_RISK)) {
    if (registers[r]?.length) {
      score += w;
      if (w >= 2) reasons.push(`${r} code changed`);
    }
  }
  const bump = (n, reason) => {
    score += n;
    reasons.push(reason);
  };
  const fanout = Math.max(0, ...map.symbols.map((s) => s.callSites));
  if (fanout >= 5) bump(fanout >= 20 ? 2 : 1, `a changed symbol has ${fanout} call sites`);
  if (map.history.some((h) => h.fixes >= 2)) bump(1, 'touches files with repeated bug fixes');
  if (map.coChange.length) bump(1, 'files that usually change together were left out');
  if (map.untestedChange) bump(1, 'code changed without test changes');
  if (changedLines > 400) bump(changedLines > 1500 ? 2 : 1, `${changedLines} changed lines`);

  const onlyLowRisk = Object.keys(registers).every((r) => r === 'docs' || r === 'tests');
  if (onlyLowRisk) return { score: 0, level: 'low', mode: 'quick', reasons: ['docs/tests only'] };
  const level = score <= 2 ? 'low' : score <= 5 ? 'medium' : 'high';
  return { score, level, mode: level === 'low' ? 'quick' : 'full', lenses: level === 'high' ? 3 : 2, reasons };
}

export function formatMap(map) {
  const out = [];
  if (map.symbols.length) {
    out.push('changed symbols (call sites outside the defining file):');
    for (const s of map.symbols) {
      if (s.scope === 'file') {
        out.push(`  ${s.name} [${s.kind}, ${s.file}] module-private`);
        continue;
      }
      const callers = s.callerFiles.length ? ` <- ${s.callerFiles.join(', ')}${s.moreCallerFiles ? ` +${s.moreCallerFiles} more` : ''}` : '';
      out.push(`  ${s.name} [${s.kind}, ${s.file}] ${s.callSites} call site(s)${callers} | ${s.testFiles.length ? `tests: ${s.testFiles.join(', ')}` : 'no tests reference it'}`);
    }
  }
  if (map.coChange.length) {
    out.push('usually changes together, NOT in this diff:');
    for (const c of map.coChange) out.push(`  ${c.file} -> ${c.partner} (${Math.round(c.confidence * 100)}% of ${c.support}+ commits)`);
  }
  if (map.history.length) {
    out.push('bug-fix history:');
    for (const h of map.history) out.push(`  ${h.file}: ${h.fixes} fix commit(s) of last ${h.commits}; latest "${h.lastFix}"`);
  }
  if (map.siblings.length) {
    out.push('house examples (similar files, read one before judging conventions):');
    for (const s of map.siblings) out.push(`  ${s.file} ~ ${s.examples.join(', ')}`);
  }
  if (map.untestedChange) out.push('no test files changed alongside code changes');
  return out.join('\n');
}

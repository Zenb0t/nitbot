// Assessment B as a script. Everything here is deterministic: run the
// project's tools, keep what lands on changed lines, read coverage and CI.
// No model tokens are spent until the parent reads the bounded summary, and
// the parent reads it only after the Reviewer has returned (anchoring).
import fs from 'node:fs';
import path from 'node:path';
import { exec, discoverTools } from './toolchain.mjs';
import { detect } from './detect.mjs';
import { run } from './git.mjs';

const TYPECHECK_OUTSIDE_SAMPLE = 5;

export function gatherEvidence(root, target, { config, runTests = false, toolTimeout = 120_000, testTimeout = 300_000 } = {}) {
  const changed = target.files.filter((f) => f.status !== 'deleted' && !f.binary);
  const added = new Map(changed.map((f) => [f.path, new Set(f.lines.filter((l) => l.added).map((l) => l.n))]));
  const changedFiles = changed.map((f) => f.path).filter((p) => fs.existsSync(path.join(root, p)));

  const evidence = {
    generatedAt: new Date().toISOString(),
    target: target.label,
    tools: [],
    tests: null,
    coverage: coverage(root, changed),
    ci: target.pr ? ciStatus(root, target.pr.number) : null,
    detector: detect(target.files, { config, exists: (p) => fs.existsSync(path.join(root, p)) }),
  };

  // A PR head that is not checked out cannot be linted or tested locally;
  // CI results for that commit are the evidence instead.
  const localCodeMatches = !target.pr || target.pr.checkedOut;

  for (const tool of discoverTools(root)) {
    if (tool.kind === 'test') {
      if (!runTests || !localCodeMatches) {
        evidence.tests = { tool: tool.id, status: 'not-run', reason: !localCodeMatches ? 'PR head not checked out; see CI' : 'tests not requested (--tests)' };
        continue;
      }
      evidence.tests = runTestTool(root, tool, changedFiles, testTimeout);
      continue;
    }
    if (!localCodeMatches) {
      evidence.tools.push({ id: tool.id, kind: tool.kind, status: 'skipped', note: 'PR head not checked out; see CI' });
      continue;
    }
    evidence.tools.push(runAnalysisTool(root, tool, changedFiles, added, toolTimeout));
  }

  return evidence;
}

function runAnalysisTool(root, tool, changedFiles, added, timeout) {
  const files = tool.exts ? changedFiles.filter((f) => tool.exts.includes(f.split('.').pop())) : changedFiles;
  if (tool.scope === 'files' && !files.length) return { id: tool.id, kind: tool.kind, status: 'skipped', note: 'no matching changed files' };

  const runs = tool.perFile ? files.slice(0, 50).map((f) => [f]) : [files];
  const issues = [];
  let status = 'ok';
  let ms = 0;
  for (const batch of runs) {
    const res = exec(tool.argv(batch), { cwd: root, timeout });
    ms += res.ms;
    if (res.missing) return { id: tool.id, kind: tool.kind, status: 'unavailable', note: firstLine(res.stderr) };
    if (res.timedOut) {
      status = 'timeout';
      break;
    }
    const parsed = parseOutput(tool.parse, res, root);
    if (parsed === null) {
      // Non-zero exit with nothing we can read: report it, do not guess.
      if (res.code !== 0) return { id: tool.id, kind: tool.kind, status: 'failed', ms, note: tail(res.stderr || res.stdout, 6) };
      continue;
    }
    issues.push(...parsed);
  }

  const onDiff = [];
  const inChangedFiles = [];
  const elsewhere = [];
  for (const i of issues) {
    const lines = added.get(i.file);
    if (lines?.has(i.line)) onDiff.push(i);
    else if (lines) inChangedFiles.push(i);
    else elsewhere.push(i);
  }
  const result = { id: tool.id, kind: tool.kind, status, ms, onDiff, preexistingInChangedFiles: inChangedFiles.length };
  // A type error in an untouched caller is often CAUSED by the change (a new
  // signature). Keep a sample; lint noise elsewhere is dropped to a count.
  if (tool.kind === 'typecheck') {
    result.elsewhere = elsewhere.length;
    result.elsewhereSample = elsewhere.slice(0, TYPECHECK_OUTSIDE_SAMPLE);
  } else {
    result.elsewhere = elsewhere.length;
  }
  return result;
}

function runTestTool(root, tool, changedFiles, timeout) {
  const files = tool.exts ? changedFiles.filter((f) => tool.exts.includes(f.split('.').pop())) : changedFiles;
  if (tool.scope === 'files' && !files.length) return { tool: tool.id, status: 'not-run', reason: 'no matching changed files' };
  const res = exec(tool.argv(files), { cwd: root, timeout });
  if (res.missing) return { tool: tool.id, status: 'unavailable' };
  if (res.timedOut) return { tool: tool.id, status: 'timeout', ms: res.ms };
  const out = `${res.stdout}\n${res.stderr}`;
  return {
    tool: tool.id,
    status: res.code === 0 ? 'passed' : 'failed',
    ms: res.ms,
    // Failures only: a 4,000-line passing log is worth zero tokens.
    failures: res.code === 0 ? [] : failureLines(out),
  };
}

function parseOutput(kind, res, root) {
  const rel = (p) => normalize(root, p);
  try {
    if (kind === 'eslint-json') {
      return JSON.parse(res.stdout).flatMap((f) =>
        f.messages.map((m) => ({ file: rel(f.filePath), line: m.line, rule: m.ruleId ?? 'eslint', message: m.message, severity: m.severity === 2 ? 'error' : 'warning' })),
      );
    }
    if (kind === 'ruff-json') {
      return JSON.parse(res.stdout).map((m) => ({ file: rel(m.filename), line: m.location.row, rule: m.code, message: m.message }));
    }
    if (kind === 'semgrep-json') {
      return JSON.parse(res.stdout).results.map((r) => ({ file: rel(r.path), line: r.start.line, rule: r.check_id, message: r.extra?.message ?? '' }));
    }
    if (kind === 'gitleaks-json') {
      const text = res.stdout.trim();
      if (!text.startsWith('[')) return null;
      return JSON.parse(text).map((r) => ({ file: rel(r.File), line: r.StartLine, rule: r.RuleID, message: r.Description }));
    }
  } catch {
    return null;
  }
  if (kind === 'lines') {
    const issues = parseLines(`${res.stdout}\n${res.stderr}`, rel);
    // A failing exit with nothing parseable is a broken run, not a clean one.
    return issues.length || res.code === 0 ? issues : null;
  }
  return null;
}

// Generic "path:line[:col]: message" and "path(line,col): message" output
// (tsc, mypy, go vet, clippy --message-format=short, biome github reporter).
function parseLines(text, rel) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^::\w+ file=([^,]+),line=(\d+)[^:]*::/, '$1:$2: ');
    const m = line.match(/^\s*(?:\.\/)?([^\s:()][^:()]*?\.[A-Za-z0-9]+)(?::(\d+)(?::\d+)?:|\((\d+),\d+\):)\s*(.*)$/);
    if (!m) continue;
    out.push({ file: rel(m[1]), line: Number(m[2] ?? m[3]), rule: (m[4].match(/\b(TS\d+|[A-Z]\d{3,4}|error|warning)\b/) ?? ['issue'])[0], message: m[4].trim() });
  }
  return out;
}

// Diff coverage from an existing report. nitbot never runs coverage itself;
// it reads the report if one is fresher than every changed file.
function coverage(root, changed) {
  const candidates = ['coverage/lcov.info', 'lcov.info', 'coverage/cobertura-coverage.xml', 'coverage.xml', 'cobertura.xml'];
  const report = candidates.map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  if (!report) return null;
  const reportTime = fs.statSync(report).mtimeMs;
  const newest = Math.max(0, ...changed.map((f) => { try { return fs.statSync(path.join(root, f.path)).mtimeMs; } catch { return 0; } }));
  const rel = path.relative(root, report).split(path.sep).join('/');
  if (newest > reportTime) return { report: rel, stale: true };

  const hits = report.endsWith('.info') ? readLcov(fs.readFileSync(report, 'utf8'), root) : readCobertura(fs.readFileSync(report, 'utf8'), root);
  const uncovered = [];
  for (const f of changed) {
    const fileHits = hits.get(f.path);
    if (!fileHits) continue; // not instrumented: say nothing rather than guess
    const lines = f.lines.filter((l) => l.added && fileHits.get(l.n) === 0).map((l) => l.n);
    if (lines.length) uncovered.push({ file: f.path, lines: ranges(lines) });
  }
  return { report: rel, stale: false, uncovered };
}

function readLcov(text, root) {
  const out = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = new Map();
      out.set(normalize(root, line.slice(3)), current);
    } else if (line.startsWith('DA:') && current) {
      const [n, count] = line.slice(3).split(',');
      current.set(Number(n), Number(count));
    }
  }
  return out;
}

function readCobertura(text, root) {
  const out = new Map();
  const classRe = /<class\b[^>]*filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;
  for (const [, file, body] of text.matchAll(classRe)) {
    const lines = out.get(normalize(root, file)) ?? new Map();
    for (const [, n, count] of body.matchAll(/<line\b[^>]*number="(\d+)"[^>]*hits="(\d+)"/g)) lines.set(Number(n), Number(count));
    out.set(normalize(root, file), lines);
  }
  return out;
}

function ciStatus(root, number) {
  const raw = run('gh', ['pr', 'checks', String(number), '--json', 'name,state,bucket,link'], { cwd: root, allowFail: true });
  if (!raw) return { status: 'unavailable' };
  try {
    const checks = JSON.parse(raw);
    const failed = checks.filter((c) => c.bucket === 'fail');
    return {
      status: failed.length ? 'failing' : checks.some((c) => c.bucket === 'pending') ? 'pending' : 'passing',
      total: checks.length,
      failed: failed.map((c) => ({ name: c.name, link: c.link })),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

// Bounded text for the parent's context. Everything else stays in the JSON.
export function formatEvidence(ev, { maxItems = 25 } = {}) {
  const out = [`EVIDENCE for ${ev.target}`];
  if (ev.ci) {
    out.push(`CI: ${ev.ci.status}${ev.ci.failed?.length ? ` (${ev.ci.failed.map((f) => f.name).join(', ')}); read failures with: gh run view <id> --log-failed` : ''}`);
  }
  for (const t of ev.tools) {
    if (t.status !== 'ok') {
      out.push(`${t.id}: ${t.status}${t.note ? ` - ${t.note}` : ''}`);
      continue;
    }
    const extra = [t.preexistingInChangedFiles ? `${t.preexistingInChangedFiles} pre-existing in changed files` : '', t.elsewhere ? `${t.elsewhere} elsewhere` : ''].filter(Boolean).join(', ');
    out.push(`${t.id}: ${t.onDiff.length} on changed lines${extra ? ` (${extra}, not shown)` : ''}`);
    for (const i of t.onDiff.slice(0, maxItems)) out.push(`  ${i.file}:${i.line} ${i.rule}: ${i.message}`);
    if (t.onDiff.length > maxItems) out.push(`  ... ${t.onDiff.length - maxItems} more in evidence.json`);
    for (const i of t.elsewhereSample ?? []) out.push(`  (outside diff, may be caused by it) ${i.file}:${i.line} ${i.rule}: ${i.message}`);
  }
  if (ev.tests) {
    const t = ev.tests;
    out.push(`tests (${t.tool}): ${t.status}${t.reason ? ` - ${t.reason}` : ''}`);
    for (const f of t.failures ?? []) out.push(`  ${f}`);
  }
  if (ev.coverage) {
    if (ev.coverage.stale) out.push(`coverage: ${ev.coverage.report} is older than the changed files; ignored`);
    else if (!ev.coverage.uncovered.length) out.push(`coverage: every instrumented changed line is executed by tests`);
    else out.push(`coverage: changed lines never executed by tests: ${ev.coverage.uncovered.map((u) => `${u.file}:${u.lines}`).join('; ')}`);
  }
  if (ev.detector.length) {
    out.push(`nitbot detector: ${ev.detector.length} finding(s)`);
    for (const f of ev.detector.slice(0, maxItems)) out.push(`  [${f.severity}] ${f.file}:${f.line} ${f.rule}: ${f.message}`);
  } else {
    out.push('nitbot detector: clean');
  }
  return out.join('\n');
}

function failureLines(out) {
  const lines = out.split(/\r?\n/);
  const hits = lines.filter((l) => /\b(FAIL|FAILED|failed|Error|AssertionError|panicked|✕|×)\b/.test(l)).map((l) => l.trim()).filter(Boolean);
  return (hits.length ? hits : lines.slice(-15)).slice(0, 20).map((l) => l.slice(0, 200));
}

function normalize(root, p) {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  return path.relative(root, abs).split(path.sep).join('/');
}

function ranges(nums) {
  const out = [];
  let start = nums[0];
  let prev = nums[0];
  for (const n of nums.slice(1).concat(Infinity)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  return out.join(',');
}

const firstLine = (s) => (s || '').trim().split(/\r?\n/)[0]?.slice(0, 160) ?? '';
const tail = (s, n) => (s || '').trim().split(/\r?\n/).slice(-n).join(' | ').slice(0, 400);

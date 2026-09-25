// Runs the rule set over a parsed change set.
import { createHash } from 'node:crypto';
import { LINE_RULES, FILE_RULES } from './rules.mjs';
import { matchesAny } from './config.mjs';

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs|e2e|fixtures?)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|\.next|coverage|target)\/|\.min\.(js|css)$|\.(lock|lockb|snap|svg|map)$|-lock\.(json|yaml)$/;
const SUPPRESS = /nitbot-ignore(?:-line)?(?::\s*([\w,\s-]+))?/;
const SUPPRESS_NEXT = /nitbot-ignore-next-line(?::\s*([\w,\s-]+))?/;

export function detect(files, { config, exists = () => false, tiers = ['immediate', 'deferred'] } = {}) {
  const ignoreRules = new Set(config?.detector?.ignoreRules ?? []);
  const ignoreFiles = config?.detector?.ignoreFiles ?? [];
  const changedPaths = new Set(files.map((f) => f.path));
  const findings = [];

  for (const raw of files) {
    if (raw.binary || raw.status === 'deleted' || SKIP_PATH.test(raw.path)) continue;
    if (ignoreFiles.length && matchesAny(raw.path, ignoreFiles)) continue;
    const file = { ...raw, ext: extOf(raw.path), isTest: TEST_PATH.test(raw.path) };

    for (const rule of FILE_RULES) {
      if (!tiers.includes(rule.tier) || ignoreRules.has(rule.id)) continue;
      if (rule.test(file, { changedPaths, exists })) {
        findings.push(finding(rule, file, file.lines.find((l) => l.added)?.n ?? 1, ''));
      }
    }

    file.lines.forEach((line, index) => {
      if (!line.added) return;
      for (const rule of LINE_RULES) {
        if (!tiers.includes(rule.tier) || ignoreRules.has(rule.id)) continue;
        if (rule.langs && !rule.langs.includes(file.ext)) continue;
        if (rule.skipTests && file.isTest) continue;
        if (rule.onlyTests && !file.isTest) continue;
        if (suppressed(rule.id, line.text, file.lines[index - 1]?.text)) continue;
        // Code-shape rules must not fire on code quoted inside a string
        // (test fixtures, generators, docs in code); secret rules must.
        const text = rule.code ? blankStrings(line.text) : line.text;
        if (rule.test(text, { file, lines: file.lines, index })) {
          findings.push(finding(rule, file, line.n, line.text));
        }
      }
    });
  }

  const order = { P0: 0, P1: 1, P2: 2, nit: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

export function summarize(findings) {
  const bySeverity = { P0: 0, P1: 0, P2: 0, nit: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  return { total: findings.length, ...bySeverity };
}

export function formatFindings(findings, { limit = 50 } = {}) {
  const out = findings.slice(0, limit).map((f) => `  [${f.severity}] ${f.file}:${f.line}  ${f.rule}: ${f.message}${f.excerpt ? `\n        ${f.excerpt}` : ''}`);
  if (findings.length > limit) out.push(`  ... ${findings.length - limit} more`);
  return out.join('\n');
}

function finding(rule, file, line, text) {
  const excerpt = redact(text.trim()).slice(0, 160);
  return {
    rule: rule.id,
    tier: rule.tier,
    severity: rule.severity,
    file: file.path,
    line,
    message: rule.message,
    excerpt,
    // Stable across unrelated edits above the line: keyed on content, not position.
    fingerprint: createHash('sha1').update(`${rule.id}\0${file.path}\0${text.trim()}`).digest('hex').slice(0, 12),
  };
}

// Never echo a secret back into a transcript or a hook message.
function redact(text) {
  return text
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----).*/, '$1 [redacted]')
    .replace(/\b(AKIA|gh[pousr]_|github_pat_|xox[baprs]-|sk-ant-|sk-proj-|sk-|AIza|sk_live_|rk_live_)[A-Za-z0-9_-]{6,}/g, '$1[redacted]')
    .replace(/((password|passwd|pwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'])[^"']{4,}(["'])/gi, '$1[redacted]$3');
}

// Replaces the contents of '...', "..." and `...` literals on one line with
// spaces, keeping the quotes and the length. Unterminated quotes run to EOL.
export function blankStrings(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') {
        out += '  ';
        i++;
      } else if (c === quote) {
        out += c;
        quote = null;
      } else out += ' ';
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
    }
  }
  return out;
}

function suppressed(ruleId, text, prevText) {
  const hit = (m) => m && (!m[1] || m[1].split(/[\s,]+/).includes(ruleId));
  return hit(text.match(SUPPRESS)) || hit(prevText?.match(SUPPRESS_NEXT));
}

function extOf(p) {
  const name = p.split('/').pop();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

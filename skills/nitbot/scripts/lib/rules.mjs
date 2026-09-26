// nitbot's own rules: a zero-install floor, not a linter. Anything the
// project's linters, type checkers, semgrep or gitleaks already cover belongs
// to them (see evidence.mjs). What stays here is either catastrophic and cheap
// to catch in every repo, or only visible in a diff ("a NEW suppression").
//
// Two tiers, the same split Impeccable uses:
//   immediate - near-zero false positives. Worth interrupting an edit or
//               refusing a commit for.
//   deferred  - real signal but judgment-adjacent. Goes to the review as
//               evidence and to the optional end-of-session pass.
//
// Line rules see only added lines. `test(text, ctx)` returns true on a hit;
// ctx = { file, lines, index } so a rule can look at the neighbouring line.
// `code: true` rules see the line with string-literal contents blanked out.
// `skipDocs: true` rules ignore prose files (.md, .txt, ...); `skipComments:
// true` rules ignore lines that are only a comment.

const JS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'];
const PY = ['py'];
const BRACE = [...JS, 'java', 'kt', 'cs', 'php', 'swift', 'scala', 'dart', 'go'];

export const LINE_RULES = [
  {
    id: 'conflict-marker',
    tier: 'immediate',
    severity: 'P0',
    message: 'Unresolved merge-conflict marker.',
    test: (t) => /^(<{7}|>{7}|\|{7})( |$)/.test(t),
  },
  {
    id: 'private-key',
    tier: 'immediate',
    severity: 'P0',
    message: 'Private key material committed. Rotate it; deleting the line does not un-leak it.',
    test: (t) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t),
  },
  {
    id: 'cloud-token',
    tier: 'immediate',
    severity: 'P0',
    message: 'Live-looking API token. Move it to a secret store and rotate it.',
    test: (t) =>
      !/EXAMPLE/.test(t) &&
      [
        /\bAKIA[0-9A-Z]{16}\b/,
        /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
        /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
        /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
        /\bsk-ant-[A-Za-z0-9_-]{20,}/,
        /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/,
        /\bAIza[0-9A-Za-z_-]{35}\b/,
        /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/,
      ].some((re) => re.test(t)),
  },
  {
    id: 'focused-test',
    code: true,
    tier: 'immediate',
    severity: 'P0',
    langs: JS,
    message: 'Focused test (.only / fit / fdescribe) silently skips the rest of the suite in CI.',
    test: (t) => /\b(describe|it|test|context|suite)\.only\s*\(/.test(t) || /(^|[^\w.])(fit|fdescribe)\s*\(/.test(t),
  },
  {
    id: 'debugger',
    code: true,
    tier: 'immediate',
    severity: 'P1',
    message: 'Debugger breakpoint left in code.',
    test: (t, { file }) => {
      const e = file.ext;
      if (JS.includes(e)) return /^\s*debugger\s*;?\s*(\/\/.*)?$/.test(t);
      if (PY.includes(e)) return /^\s*(breakpoint\(\)|(i?pdb|pudb)\.set_trace\(\)|import i?pdb\s*;)/.test(t);
      if (e === 'rb') return /^\s*(binding\.(pry|irb)|byebug|debugger)\s*$/.test(t);
      if (e === 'rs') return /\bdbg!\(/.test(t);
      return false;
    },
  },
  {
    // Not `code: true`: the env var's '0' is often a string, and YAML, .env
    // and Dockerfiles count. Prose and comments that mention it do not.
    id: 'tls-disabled',
    tier: 'immediate',
    severity: 'P1',
    skipDocs: true,
    skipComments: true,
    message: 'TLS certificate verification disabled.',
    test: (t) =>
      /rejectUnauthorized\s*:\s*false/.test(t) ||
      /NODE_TLS_REJECT_UNAUTHORIZED["']?(?:\s*(?::|=(?!=))|\s)\s*["']?0\b/.test(t) ||
      /\bverify\s*=\s*False\b/.test(t) ||
      /InsecureSkipVerify\s*:\s*true/.test(t) ||
      /CURLOPT_SSL_VERIFY(PEER|HOST)\W+(false|0)\b/i.test(t),
  },

  {
    id: 'swallowed-error',
    code: true,
    tier: 'deferred',
    severity: 'P1',
    message: 'Error swallowed silently. Handle it, log it, or comment why ignoring it is correct.',
    test: (t, { file, lines, index }) => {
      if (BRACE.includes(file.ext)) {
        if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(t)) return true;
        if (/\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|null|undefined)\s*\)/.test(t)) return true;
        return file.ext === 'go' && /^\s*_\s*=\s*err\s*$/.test(t);
      }
      if (PY.includes(file.ext)) {
        if (/^\s*except\b[^:]*:\s*pass\s*(#.*)?$/.test(t)) return true;
        if (/^\s*except\b[^:]*:\s*(#.*)?$/.test(t)) {
          const next = lines[index + 1];
          return Boolean(next && next.added && /^\s*pass\s*$/.test(next.text));
        }
      }
      return false;
    },
  },
  {
    id: 'new-suppression',
    code: true,
    tier: 'deferred',
    severity: 'P2',
    message: 'New lint/type suppression. Fix the underlying issue or say why the checker is wrong here.',
    test: (t) =>
      /eslint-disable(?!-line\s+\S+\s+--)/.test(t) ||
      /@ts-(ignore|nocheck)\b/.test(t) ||
      /@ts-expect-error\s*$/.test(t) ||
      /#\s*type:\s*ignore(?!\[)/.test(t) ||
      /#\s*noqa\s*$/.test(t) ||
      /\/\/\s*nolint\s*$/.test(t) ||
      /#\s*pylint:\s*disable/.test(t) ||
      /rubocop:disable/.test(t),
  },
  {
    id: 'skipped-test',
    code: true,
    tier: 'deferred',
    severity: 'P2',
    message: 'Test disabled. Link the issue that tracks re-enabling it, or delete it.',
    test: (t) =>
      /\b(describe|it|test|context|suite)\.skip\s*\(/.test(t) ||
      /(^|[^\w.])(xit|xdescribe|xtest)\s*\(/.test(t) ||
      /@pytest\.mark\.skip\b|@unittest\.skip\b/.test(t) ||
      /#\[ignore\]/.test(t) ||
      /\bt\.Skip(Now|f)?\(/.test(t) ||
      /@(Disabled|Ignore)\b/.test(t),
  },
  {
    id: 'sleep-in-test',
    code: true,
    tier: 'deferred',
    severity: 'P2',
    onlyTests: true,
    message: 'Fixed sleep in a test: slow when the wait is long enough, flaky when it is not. Wait on the condition instead.',
    test: (t) => /\b(time\.sleep|Thread\.sleep|setTimeout|sleep)\s*\(\s*\d/.test(t) || /new Promise\(\s*\w+\s*=>\s*setTimeout\(/.test(t),
  },
];

const LOCKFILES = {
  'package.json': ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'],
  'pyproject.toml': ['poetry.lock', 'uv.lock', 'pdm.lock'],
  Pipfile: ['Pipfile.lock'],
  'Cargo.toml': ['Cargo.lock'],
  'go.mod': ['go.sum'],
  Gemfile: ['Gemfile.lock'],
  'composer.json': ['composer.lock'],
};

export const FILE_RULES = [
  {
    id: 'secret-file',
    tier: 'immediate',
    severity: 'P0',
    message: 'Secrets file added to the repository.',
    test: (file) => {
      if (file.status !== 'added') return false;
      const name = file.path.split('/').pop();
      if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist|defaults?)$/.test(name);
      return /\.(pem|p12|pfx|key|keystore|jks)$/.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name);
    },
  },
  {
    id: 'lockfile-drift',
    tier: 'deferred',
    severity: 'P2',
    message: 'Dependency versions changed but no lockfile changed with them; CI and teammates will resolve different versions.',
    test: (file, { changedPaths, exists }) => {
      const name = file.path.split('/').pop();
      const locks = LOCKFILES[name];
      if (!locks) return false;
      const dir = file.path.slice(0, file.path.length - name.length);
      const lockHere = locks.map((l) => dir + l).filter(exists);
      if (!lockHere.length || lockHere.some((l) => changedPaths.has(l))) return false;
      // Only when a line that looks like a dependency pin was added.
      return file.lines.some(
        (l) =>
          l.added &&
          (/^\s*"[@\w./-]+"\s*:\s*"(?:[~^<>=]|\d|workspace:|npm:)/.test(l.text) ||
            /^\s*[\w.-]+\s*=\s*(\{.*version|["'][~^<>=\d])/.test(l.text) ||
            /^\s*require\s+\S+\s+v\d|^\s*[\w./-]+\s+v\d/.test(l.text) ||
            /^\s*gem\s+["']/.test(l.text)),
      );
    },
  },
];

export const ALL_RULE_IDS = [...LINE_RULES, ...FILE_RULES].map((r) => r.id);

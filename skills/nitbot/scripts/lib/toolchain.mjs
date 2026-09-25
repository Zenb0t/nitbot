// Finds the project's own verification tools and says how to read their
// output. nitbot never re-implements what these do; it runs them and keeps
// only what lands on the changed lines.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson } from './config.mjs';

const WIN = process.platform === 'win32';
const JS_EXT = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'];

// Runs a command without a shell on POSIX; on Windows through cmd.exe so
// npx/.cmd shims resolve. Never throws: a missing tool is a status, not a crash.
export function exec(argv, { cwd, timeout = 120_000 } = {}) {
  const started = Date.now();
  const opts = { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true };
  const res = WIN
    ? spawnSync(argv.map(quoteWin).join(' '), { ...opts, shell: true })
    : spawnSync(argv[0], argv.slice(1), opts);
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: res.error?.code === 'ETIMEDOUT' || (res.signal === 'SIGTERM' && Date.now() - started >= timeout),
    missing: res.error?.code === 'ENOENT' || (WIN && res.status === 1 && /is not recognized as an internal or external command/.test(res.stderr ?? '')),
    ms: Date.now() - started,
  };
}

function quoteWin(a) {
  return /^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

const onPath = (bin) => {
  const r = exec([bin, '--version'], { timeout: 15_000 });
  return !r.missing && r.code === 0;
};

// Each tool: { id, kind, argv(files) -> string[], scope: 'files'|'project',
// exts?, parse }. `scope: files` tools get only the changed files that match
// `exts`; project tools run once over the whole project.
export function discoverTools(root) {
  const has = (p) => fs.existsSync(path.join(root, p));
  const bin = (name) => has(`node_modules/.bin/${name}`) || has(`node_modules/.bin/${name}.cmd`);
  const read = (p) => {
    try {
      return fs.readFileSync(path.join(root, p), 'utf8');
    } catch {
      return '';
    }
  };
  const tools = [];
  const pkg = has('package.json') ? readJson(path.join(root, 'package.json')) : null;
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};

  if (pkg) {
    if (bin('eslint')) {
      tools.push({ id: 'eslint', kind: 'lint', scope: 'files', exts: JS_EXT, parse: 'eslint-json', argv: (f) => ['npx', '--no-install', 'eslint', '--format', 'json', ...f] });
    } else if (bin('biome')) {
      tools.push({ id: 'biome', kind: 'lint', scope: 'files', exts: JS_EXT, parse: 'lines', argv: (f) => ['npx', '--no-install', 'biome', 'lint', '--reporter=github', ...f] });
    }
    if (has('tsconfig.json') && bin('tsc')) {
      tools.push({ id: 'tsc', kind: 'typecheck', scope: 'project', parse: 'lines', argv: () => ['npx', '--no-install', 'tsc', '--noEmit', '--pretty', 'false'] });
    }
    if (deps.vitest && bin('vitest')) {
      tools.push({ id: 'vitest', kind: 'test', scope: 'files', exts: JS_EXT, parse: 'test', argv: (f) => ['npx', '--no-install', 'vitest', 'related', '--run', ...f] });
    } else if (deps.jest && bin('jest')) {
      tools.push({ id: 'jest', kind: 'test', scope: 'files', exts: JS_EXT, parse: 'test', argv: (f) => ['npx', '--no-install', 'jest', '--ci', '--findRelatedTests', ...f] });
    } else if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
      tools.push({ id: 'npm-test', kind: 'test', scope: 'project', parse: 'test', argv: () => ['npm', 'test', '--silent'] });
    }
  }

  const pyDeps = read('pyproject.toml') + read('requirements.txt') + read('requirements-dev.txt') + read('setup.cfg');
  const isPy = pyDeps || has('setup.py');
  if (isPy) {
    if (onPath('ruff')) tools.push({ id: 'ruff', kind: 'lint', scope: 'files', exts: ['py'], parse: 'ruff-json', argv: (f) => ['ruff', 'check', '--output-format', 'json', ...f] });
    if (/\bmypy\b/.test(pyDeps) && onPath('mypy')) tools.push({ id: 'mypy', kind: 'typecheck', scope: 'files', exts: ['py'], parse: 'lines', argv: (f) => ['mypy', '--no-error-summary', '--show-column-numbers', ...f] });
    if ((/\bpytest\b/.test(pyDeps) || has('pytest.ini') || has('conftest.py')) && onPath('pytest')) {
      tools.push({ id: 'pytest', kind: 'test', scope: 'project', parse: 'test', argv: () => ['pytest', '-q', '-x', '--no-header'] });
    }
  }

  if (has('go.mod') && onPath('go')) {
    tools.push({ id: 'go-vet', kind: 'typecheck', scope: 'project', parse: 'lines', argv: () => ['go', 'vet', './...'] });
    tools.push({ id: 'go-test', kind: 'test', scope: 'project', parse: 'test', argv: () => ['go', 'test', './...'] });
  }

  if (has('Cargo.toml') && onPath('cargo')) {
    tools.push({ id: 'clippy', kind: 'lint', scope: 'project', parse: 'lines', argv: () => ['cargo', 'clippy', '--all-targets', '--message-format=short', '-q'] });
    tools.push({ id: 'cargo-test', kind: 'test', scope: 'project', parse: 'test', argv: () => ['cargo', 'test', '-q'] });
  }

  const semgrepConfig = ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].find(has);
  if (semgrepConfig && onPath('semgrep')) {
    tools.push({ id: 'semgrep', kind: 'sast', scope: 'files', parse: 'semgrep-json', argv: (f) => ['semgrep', 'scan', '--json', '--quiet', '--metrics=off', '--config', semgrepConfig, ...f] });
  }
  if (onPath('gitleaks')) {
    tools.push({ id: 'gitleaks', kind: 'secrets', scope: 'files', parse: 'gitleaks-json', perFile: true, argv: (f) => ['gitleaks', 'detect', '--no-git', '--no-banner', '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', '-', '--source', f[0]] });
  }

  return tools;
}

// Repo-owned commit hooks. When one exists, nitbot's commit gate defers to it
// by default rather than running a second, overlapping gate.
export function commitFramework(root) {
  const has = (p) => fs.existsSync(path.join(root, p));
  if (has('.pre-commit-config.yaml')) return 'pre-commit';
  if (has('.husky')) return 'husky';
  if (has('lefthook.yml') || has('lefthook.yaml') || has('.lefthook.yml')) return 'lefthook';
  return null;
}

export function describeTools(tools) {
  return tools.map((t) => `${t.id} (${t.kind})`).join(', ') || 'none detected';
}

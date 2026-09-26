// Finds the project's own verification tools and says how to read their
// output. nitbot never re-implements what these do; it runs them and keeps
// only what lands on the changed lines.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readJson } from './config.mjs';

const WIN = process.platform === 'win32';
const JS_EXT = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte'];
const MAX_OUTPUT = 64 * 1024 * 1024;
// After the child exits, or after a timeout kill, how long to wait for its
// pipes. A grandchild that inherited them can hold them open indefinitely.
const PIPE_GRACE_MS = 2000;
const live = new Set();

// Runs a command without a shell on POSIX; on Windows through cmd.exe so
// npx/.cmd shims resolve. Never throws: a missing tool is a status, not a crash.
// A timeout kills the whole process tree: killing only cmd.exe or npx leaves
// the real tool running and the run hanging on its output.
export function exec(argv, { cwd, timeout = 120_000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child;

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const stderr = Buffer.concat(err).toString('utf8') || (error && !timedOut ? error.message : '');
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr,
        timedOut,
        missing: error?.code === 'ENOENT' || (WIN && code === 1 && /is not recognized as an internal or external command/.test(stderr)),
        ms: Date.now() - started,
      });
    };

    // stdin is the null device: a tool that reads it when it is not a TTY
    // gets EOF at once instead of waiting on an open pipe until the timeout.
    const stdio = ['ignore', 'pipe', 'pipe'];
    try {
      child = WIN
        ? spawn(argv.map(quoteWin).join(' '), { cwd, stdio, shell: true, windowsHide: true })
        : spawn(argv[0], argv.slice(1), { cwd, stdio, detached: true }); // own process group, killed as one
    } catch (e) {
      return finish(null, e);
    }
    live.add(child);
    watchSignals();
    const collect = (into) => (chunk) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) into.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(timedOut ? null : code));
    // Grace timers are unref'd: once finished they must not hold the process open.
    // A tool that exited on its own did not time out, however long its pipes stay held.
    child.on('exit', (code) => {
      clearTimeout(timer);
      setTimeout(() => finish(timedOut ? null : code), PIPE_GRACE_MS).unref();
    });
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish(null), PIPE_GRACE_MS).unref();
    }, timeout);
  });
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// POSIX children run in their own process group so a timeout can kill them
// as a unit; that also means Ctrl-C no longer reaches them, so pass it on.
let watching = false;
function watchSignals() {
  if (WIN || watching) return;
  watching = true;
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(sig, () => {
      for (const c of live) killTree(c);
      process.exit(code);
    });
  }
}

function quoteWin(a) {
  return /^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

// Most tools answer --version. go has only the `go version` subcommand:
// `go --version` exits 2 with "flag provided but not defined: -version".
const VERSION_ARGS = { go: ['version'] };

async function onPath(bin) {
  const r = await exec([bin, ...(VERSION_ARGS[bin] ?? ['--version'])], { timeout: 15_000 });
  return !r.missing && r.code === 0;
}

// Each tool: { id, kind, argv(files) -> string[], scope: 'files'|'project',
// exts?, parse, bin? }. `scope: files` tools get only the changed files that
// match `exts`; project tools run once over the whole project. A tool with
// `bin` is kept only if that binary answers its version probe. `probes` (bin -> bool)
// caches those answers: known ones are reused, new ones are written into it.
export async function discoverTools(root, { probes = {} } = {}) {
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
    tools.push({ id: 'ruff', bin: 'ruff', kind: 'lint', scope: 'files', exts: ['py'], parse: 'ruff-json', argv: (f) => ['ruff', 'check', '--output-format', 'json', ...f] });
    if (/\bmypy\b/.test(pyDeps)) tools.push({ id: 'mypy', bin: 'mypy', kind: 'typecheck', scope: 'files', exts: ['py'], parse: 'lines', argv: (f) => ['mypy', '--no-error-summary', '--show-column-numbers', ...f] });
    if (/\bpytest\b/.test(pyDeps) || has('pytest.ini') || has('conftest.py')) {
      tools.push({ id: 'pytest', bin: 'pytest', kind: 'test', scope: 'project', parse: 'test', argv: () => ['pytest', '-q', '-x', '--no-header'] });
    }
  }

  if (has('go.mod')) {
    tools.push({ id: 'go-vet', bin: 'go', kind: 'typecheck', scope: 'project', parse: 'lines', argv: () => ['go', 'vet', './...'] });
    tools.push({ id: 'go-test', bin: 'go', kind: 'test', scope: 'project', parse: 'test', argv: () => ['go', 'test', './...'] });
  }

  if (has('Cargo.toml')) {
    tools.push({ id: 'clippy', bin: 'cargo', kind: 'lint', scope: 'project', parse: 'lines', argv: () => ['cargo', 'clippy', '--all-targets', '--message-format=short', '-q'] });
    tools.push({ id: 'cargo-test', bin: 'cargo', kind: 'test', scope: 'project', parse: 'test', argv: () => ['cargo', 'test', '-q'] });
  }

  const semgrepConfig = ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].find(has);
  if (semgrepConfig) {
    tools.push({ id: 'semgrep', bin: 'semgrep', kind: 'sast', scope: 'files', parse: 'semgrep-json', argv: (f) => ['semgrep', 'scan', '--json', '--quiet', '--metrics=off', '--config', semgrepConfig, ...f] });
  }
  tools.push({ id: 'gitleaks', bin: 'gitleaks', kind: 'secrets', scope: 'files', parse: 'gitleaks-json', perFile: true, argv: (f) => ['gitleaks', 'detect', '--no-git', '--no-banner', '--redact', '--exit-code', '0', '--report-format', 'json', '--report-path', '-', '--source', f[0]] });

  // Probe concurrently: each can take seconds, and most will say "not here".
  const unknown = [...new Set(tools.map((t) => t.bin).filter((b) => b && !(b in probes)))];
  await Promise.all(unknown.map(async (b) => (probes[b] = await onPath(b))));
  return tools.filter((t) => !t.bin || probes[t.bin]);
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

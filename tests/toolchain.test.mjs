import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tempRepo } from './helpers.mjs';
import { exec, discoverTools } from '../skills/nitbot/scripts/lib/toolchain.mjs';

test('a timeout kills the whole process tree, even a grandchild holding the output pipes', { timeout: 30_000 }, async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const pidFile = path.join(r.dir, 'grandchild.pid');
  // Like npx -> node: the child starts a grandchild that inherits stdout and
  // outlives the timeout. The grandchild records its pid as soon as it runs.
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000)`;
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setTimeout(() => {}, 20000)`;
  fs.writeFileSync(path.join(r.dir, 'child.js'), child);

  const started = Date.now();
  const res = await exec([process.execPath, 'child.js'], { cwd: r.dir, timeout: 1000 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - started < 8000, `returned after ${Date.now() - started}ms, not when the grandchild let go`);

  // Without a grandchild there was no tree to kill, and nothing below proves anything.
  assert.ok(fs.existsSync(pidFile), 'the grandchild was running before the timeout');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 2000; // a POSIX kill lands asynchronously
  while (alive() && Date.now() < deadline) await sleep(50); // nitbot-ignore: sleep-in-test (polls a condition)
  assert.equal(alive(), false, 'the grandchild was killed with its parent');
});

test('a tool that exits just before its timeout is not reported as timed out, even with its pipes still held', { timeout: 30_000 }, async (t) => {
  const r = tempRepo();
  const pidFile = path.join(r.dir, 'grandchild.pid');
  t.after(() => {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
    } catch {} // nitbot-ignore: swallowed-error (already gone)
    r.cleanup();
  });
  // The child exits 0 at once; a grandchild keeps the pipes open past the
  // timeout, so exec waits out its pipe grace after the exit. Detached so
  // Windows does not kill it with its parent's job object, and run outside
  // the repo so it cannot block the repo's removal.
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 10000)`;
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit', detached: true, windowsHide: true, cwd: require('os').tmpdir() }); console.log('done'); setTimeout(() => process.exit(0), 100)`;
  fs.writeFileSync(path.join(r.dir, 'child.js'), child);

  const res = await exec([process.execPath, 'child.js'], { cwd: r.dir, timeout: 1500 });
  assert.ok(fs.existsSync(pidFile), 'the grandchild was holding the pipes');
  assert.equal(res.timedOut, false);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /done/, 'the output is kept');
});

test('a tool that reads stdin sees it closed, not an open pipe it waits on until the timeout', { timeout: 30_000 }, async () => {
  const reader = "let n = 0; process.stdin.on('data', (d) => (n += d.length)); process.stdin.on('end', () => console.log('eof ' + n));";
  const res = await exec([process.execPath, '-e', reader], { timeout: 5000 });
  assert.equal(res.timedOut, false);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), 'eof 0');
});

test('exec reports exit codes, output, and missing binaries', async () => {
  const ok = await exec([process.execPath, '-e', 'console.log("hi"); process.exit(3)']);
  assert.equal(ok.code, 3);
  assert.equal(ok.stdout.trim(), 'hi');
  assert.equal(ok.timedOut, false);
  assert.equal((await exec(['nitbot-no-such-binary-xyz'])).missing, true);
});

test('tool discovery reuses probe answers it is given', async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('go.mod', 'module x\n');
  const ids = async (probes) => (await discoverTools(r.dir, { probes })).map((x) => x.id);
  assert.deepEqual(await ids({ go: true, gitleaks: false }), ['go-vet', 'go-test']);
  assert.deepEqual(await ids({ go: false, gitleaks: true }), ['gitleaks']);
});

test('tool discovery finds go through `go version`, the only version probe go answers', async (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  r.write('go.mod', 'module x\n');
  // A stand-in go with the real CLI contract: `go version` exits 0,
  // `go --version` exits 2 with "flag provided but not defined: -version".
  const bin = path.join(r.dir, 'fake-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'go'), '#!/bin/sh\n[ "$1" = version ] && { echo go version go1.99; exit 0; }\necho "flag provided but not defined: -version" >&2\nexit 2\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'go.cmd'), '@echo off\r\nif "%~1"=="version" (echo go version go1.99& exit /b 0)\r\necho flag provided but not defined: -version 1>&2\r\nexit /b 2\r\n');
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  t.after(() => (process.env.PATH = oldPath));

  const tools = await discoverTools(r.dir, { probes: { gitleaks: false } });
  assert.deepEqual(tools.map((x) => x.id), ['go-vet', 'go-test']);
});

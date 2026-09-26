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

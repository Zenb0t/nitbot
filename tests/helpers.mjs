import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CLI = path.resolve(import.meta.dirname, '../skills/nitbot/scripts/nitbot.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

// A throwaway repository. realpath avoids Windows 8.3 short names, which git
// reports in long form and would break path comparisons.
export function tempRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nitbot-')));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  const write = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  return { dir, git, write, commit, cli, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

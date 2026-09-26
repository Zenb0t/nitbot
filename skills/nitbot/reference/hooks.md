# hooks

nitbot installs three Claude Code hooks with the plugin. They cost nothing when the code is clean: a hook only produces output when it fires.

| Hook | When | Checks | Default |
|---|---|---|---|
| Edit check | after every Edit/Write | immediate tier on the lines just added: leaked keys, private keys, conflict markers, `.only` tests, debugger statements, disabled TLS, committed `.env`/key files | on |
| Commit gate | before `git commit` / `git push` via the Bash tool | the same immediate tier on what the commit will contain (the staged changes; all tracked changes for `-a`; the named files for `git commit <paths>`) or the commits being pushed | `auto`: on, unless the repo has its own pre-commit, husky, or lefthook setup |
| Stop pass | when the session is about to end | the deferred tier (swallowed errors, new suppressions, skipped tests, sleeps in tests, lockfile drift) on files edited this session, each reported once | off |

## Commands

Run `node <skill-dir>/scripts/nitbot.mjs hooks <args>` and relay its output verbatim.

- `status` (default): current state.
- `on` / `off`: master switch for this project (`.nitbot/config.json`). `NITBOT_HOOK_DISABLED=1` in the environment also turns them off.
- `stop-pass on|off`, `commit-gate on|off|auto`.

After `off`, add: "New edits and commits won't be checked in this project until you run `/nitbot hooks on`."

## Triage

When a hook blocks an edit or a commit, sort each finding:

- **Real problem:** fix it. Never add an ignore to get a commit through.
- **Deliberate and evidenced** (a fake key in a test fixture, a conflict marker inside a doc explaining conflict markers): put `nitbot-ignore: <rule>` on that line, or `nitbot-ignore-next-line: <rule>` on the line above, and tell the user what you ignored and why. For a whole file or directory, `nitbot ignore file <glob>`.
- **Unsure:** leave it and ask the user in one line.

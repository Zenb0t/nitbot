# nitbot

A Claude Code plugin: the `nitbot` code-review skill, its two sub-agents, and its hooks. See README.md.

- Scripts under `skills/nitbot/scripts/` are plain Node ESM with zero dependencies. Keep it that way; the plugin must work with nothing installed but Node and git.
- Script stdout is read by a model. Keep it short, factual, and end in `DIRECTIVES:` when the skill must act on something.
- Detector rules belong in `lib/rules.mjs` only if no standard tool covers them, or they are only visible in a diff. Everything else is the project's own tooling, run by `lib/evidence.mjs`.
- `rules.mjs` and `tests/fixtures/` are excluded from nitbot's own detector in `.nitbot/config.json`. Tests build secret-looking strings by concatenation so no literal token is ever committed.
- Run `npm test` after any script change.

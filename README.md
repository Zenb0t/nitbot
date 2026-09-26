# nitbot

Adversarial code review for Claude Code, built on the techniques from Paul Bakaus's [Impeccable](https://github.com/pbakaus/impeccable) talk and adapted to code review.

```
/nitbot                 review the current change (branch, else uncommitted, else last commit)
/nitbot 123             review PR #123
/nitbot quick           fast pass: evidence + one reviewer
/nitbot explain         a reading guide for a human reviewer, no findings
/nitbot fix N1 N3       apply fixes from the latest review
/nitbot dismiss N2 "caller validates it (cart.ts:40)"
/nitbot hooks status
```

## How a review runs

```
nitbot context  (script, 0 tokens)
  resolve target -> .nitbot/state/current.diff  (whole changed functions)
                    intent.md  (PR body / commits / your request: claims to verify)
                    map.md     (callers, co-change gaps, fix history, house examples)
                    run.json   (registers, risk score -> mode, rolled lenses)
        |
        +-- nitbot evidence (script, 0 tokens) ---------------------------+
        |     same diff as context; linters, type checker, related tests, |
        |     semgrep/gitleaks                                            |
        |     if configured, diff coverage, PR CI status; filtered to the |
        |     changed lines; written to a file the parent reads LATER     |
        |                                                                 |
        +-- Reviewer sub-agent (blind: no session context, no evidence)   |
                    |                                                     |
                    v                                                     v
              Skeptic sub-agent: tries to refute every candidate  <-- judgment items
                    |
                    v
              Synthesis (parent): merge, rank, cap. Cannot add findings.
              -> report, .nitbot/reviews/<slug>/, ask what to fix
```

Low-risk changes (docs, tests, small self-contained app code) run **quick** mode: evidence plus one Reviewer, no Skeptic. Changes touching security, data, public contracts, heavily-called symbols, or files with a history of bug fixes run **full** mode, with three lenses when the risk is high. The risk score is computed by the script, not guessed.

## What it does not do

nitbot runs the project's own tools and never re-implements them. It does not comment on formatting, does not re-find lint or type errors, does not rerun CI for a PR (it reads the results), and steps aside from the commit gate when the repo has pre-commit, husky, or lefthook. Its own detector is a small zero-install floor (leaked keys, conflict markers, `.only` tests, debugger statements, disabled TLS) plus a few diff-only signals (a *new* suppression, a *new* skipped test, lockfile drift).

## Techniques, mapped

| Impeccable technique | nitbot |
|---|---|
| Make it argue | Blind Reviewer, then a Skeptic that only tries to refute. The session that wrote the code never judges it |
| Force divergence | 21 review lenses rolled by a seeded script, weighted by what the diff touches. The Reviewer must drop generic comments that have no failure scenario |
| Route like mixture of experts | Sub-commands; per-register rulebooks (app, contract, data, infra, deps, security, tests, docs); risk-routed quick/full |
| Memory | `dismissed.json` and `conventions.md` (committed, fed to agents), review archive (gitignored, used only in synthesis so it cannot anchor) |
| Scripts that talk back | `nitbot context` ends in DIRECTIVES; `nitbot save` rejects malformed reviews with the fix |
| Hooks that fight back | Post-edit check, commit/push gate, optional end-of-session pass. Silent, and free, when clean |
| Use the harness | `gh` for PR diffs, CI checks, and optional PR comments; background evidence while the Reviewer works |
| Design for the weakest model | Gates G1-G7 logged in every report; a `DEGRADED` banner when sub-agents are unavailable |

## Install

In Claude Code:

```
/plugin marketplace add Zenb0t/nitbot
/plugin install nitbot@nitbot
```

Or from a local clone: `/plugin marketplace add /path/to/nitbot`.

Requires Node 20+ and git. `gh` is needed for PR targets and CI status.

## Configuration

`.nitbot/config.json` (committed) and `.nitbot/config.local.json` (personal, gitignored):

```json
{
  "hook": { "enabled": true, "editCheck": true, "commitGate": "auto", "stopPass": false },
  "detector": { "ignoreRules": [], "ignoreFiles": ["tests/fixtures/**"] },
  "evidence": { "runTests": true, "toolTimeoutSec": 120, "testTimeoutSec": 300 },
  "review": { "mode": "auto", "maxFindings": 15, "maxNits": 3, "largeDiffLines": 1500, "splitLines": 800 }
}
```

Inline: `// nitbot-ignore: <rule>` on a line, or `// nitbot-ignore-next-line: <rule>` above it.

## Development

```
npm test                                  # node:test, no dependencies
node skills/nitbot/scripts/nitbot.mjs help
```

Layout: `skills/nitbot/SKILL.md` (router), `skills/nitbot/reference/` (playbooks and register rulebooks), `skills/nitbot/scripts/` (the zero-token engine), `agents/` (Reviewer and Skeptic), `hooks/hooks.json`. The eval plan is in [evals/README.md](evals/README.md).

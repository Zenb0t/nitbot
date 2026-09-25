---
name: nitbot
description: Adversarial code review of a diff, branch, commit, path, or GitHub PR. Runs the project's own tools first, then a blind reviewer sub-agent and a skeptic sub-agent that tries to refute every finding, so only verified issues reach the user. Use when the user asks to review code or a PR, check changes before committing or merging, find bugs in a change, or asks whether something is safe to ship. Also explains a change for a human reviewer, applies review fixes, and manages nitbot's hooks, dismissals, and conventions. Not for writing features or reviewing prose.
argument-hint: "[review|quick|full|explain|fix|dismiss|conventions|hooks|help] [PR# | branch | commit | a..b | path | staged]"
user-invocable: true
license: Apache-2.0
---

nitbot reviews changes the way a careful senior engineer would: it reads the change in the context of the codebase, checks it against what it claims to do, and reports only problems it can back with a concrete failure. It does not grade its own homework, re-find what tools already found, or pad reports.

## Setup

1. Run `node <skill-dir>/scripts/nitbot.mjs context [target]` once, with the user's working directory unchanged. `<skill-dir>` is the directory containing this SKILL.md. Pass `--mode quick` or `--mode full` only when the user asked for one. The script resolves the target, writes the diff, intent, change map, and run metadata to `.nitbot/state/`, scores risk, rolls review lenses, and ends with DIRECTIVES. Follow every directive. Do not rerun it, and do not recompute anything it already printed.
2. Load the command's reference from the table below and follow it.

**Script unavailable** (Node missing or the command fails): say in a separate message before your next tool call, "nitbot's context script did not run; I'll review without its map and checks." Then follow reference/review.md in degraded mode.

## Principles

- **The author never grades the work.** Judgment happens in sub-agents that start without this session's context. This session coordinates and synthesizes; it does not add findings of its own.
- **Scripts before tokens.** Anything a formatter, linter, type checker, test, or the nitbot detector can decide is decided by them. Never comment on formatting or on anything a configured tool reports.
- **Every finding has a failure scenario:** the concrete input or state, at `file:line`, that produces a wrong result. No scenario means no finding. Unverifiable suspicions become questions.
- **Precision over volume.** Two real findings beat twelve mixed ones. Respect the caps in reference/review.md.
- **Evidence after judgment.** Tool output is read only after the Reviewer has returned, so it cannot anchor the review.
- **Pass paths, not payloads.** Agent prompts carry file paths under `.nitbot/state/`, never pasted diffs or file contents.

## Commands

| Command | What it does | Reference |
|---|---|---|
| `review [target]` (default) | Risk-routed review: quick or full, chosen by the context script | [reference/review.md](reference/review.md) |
| `quick [target]` | Force quick mode: evidence + one Reviewer, no Skeptic | [reference/review.md](reference/review.md) |
| `full [target]` | Force full mode: evidence + Reviewer(s) + Skeptic | [reference/review.md](reference/review.md) |
| `explain [target]` | Reviewer's guide for a human: intent, risk map, reading order. No findings | [reference/explain.md](reference/explain.md) |
| `fix [ids]` | Apply fixes for findings from the latest review | [reference/fix.md](reference/fix.md) |
| `dismiss <finding> <reason>` | Record a false positive so it is never raised again | [reference/memory.md](reference/memory.md) |
| `conventions [learn]` | Show or grow the team's confirmed house rules | [reference/memory.md](reference/memory.md) |
| `hooks [status\|on\|off\|stop-pass on\|off\|commit-gate on\|off\|auto]` | Manage the automatic guardrails | [reference/hooks.md](reference/hooks.md) |
| `help` | Print this table and the target syntax; run nothing | none |

Routing:
- **No argument:** run `review` on the automatic target (branch vs default branch, else uncommitted changes, else the last commit).
- **A target alone** (`/nitbot 123`, `/nitbot feature/x`): `review` that target.
- **`--comment`** on review/quick/full: after the report, offer to post the findings as PR comments; post only after the user confirms (see reference/review.md).
- **Hook findings mid-task** (a nitbot hook blocked an edit or commit): read [reference/hooks.md](reference/hooks.md) § Triage.

## Harness notes

- **Sub-agents are required** for review and full. On a harness that needs the user's permission to spawn sub-agents (Codex), stop and ask for it before continuing; do not quietly run inline. Only when no sub-agent tool exists, or the user declines, run degraded mode as reference/review.md describes, and open the report with the degraded banner. A silent degraded review is a failed review.
- **Asking questions:** use the harness's question tool when it has one. Where it does not (or it only works in plan mode), ask in plain text as the last thing in your message and stop.
- **Background commands:** where background shell tasks exist, run `nitbot evidence` in the background while the Reviewer works. Where they do not, run it in the foreground before spawning the Reviewer; its output is deliberately contentless, so running it first does not anchor anything.

# review / quick / full

Resolve one target, gather deterministic evidence, get an independent judgment from a Reviewer that has never seen this session, have a Skeptic try to refute it, and report only what survives. The chat report is the deliverable; the saved review is its archive.

## Hard invariants

- Record every gate G1 to G7 in the report header as `ok`, `skipped: <reason>`, or `failed: <reason>`. A gate that can be skipped will be; write down why when you do.
- The Reviewer and the Skeptic run as sub-agents whenever a sub-agent tool exists. Running either inline is a degraded run and needs the banner: `⚠️ DEGRADED: single-context (<reason>)` as the report's first line.
- Do not read `.nitbot/state/evidence.txt` until every Reviewer has returned.
- This session may merge, deduplicate, order, and cap findings. It may not add findings, and it may not lower the severity of a CONFIRMED finding without citing the Skeptic's evidence.
- Agent prompts carry paths, never pasted diffs or file contents.
- The question to the user is the last thing in the response. Nothing follows it.

## Modes

The context script printed `mode:`. Use it unless the user named a mode.

| | quick | full |
|---|---|---|
| Evidence (G3) | `nitbot evidence --no-tests` | `nitbot evidence` (runs related tests) |
| Reviewer (G4) | one, or one per area | one per area; high risk gets the 3 lenses the script rolled |
| Skeptic (G6) | skipped; the Reviewer must quote the code behind every finding | required |

## Flow

### G1 Context
Done in Setup. Every DIRECTIVE was followed. If `NOTHING_TO_REVIEW`, tell the user and stop.

### G2 Scope
- `LARGE_DIFF`: one Reviewer per area listed in `.nitbot/state/run.json` → `areas`. Tell the user the split in one line.
- `INTENT_MISSING` and this session wrote the change: write the user's original request, verbatim, into `.nitbot/state/intent.md` now. It is the spec.
- `PR_NOT_CHECKED_OUT`: include the `git show <sha>:<path>` rule in every agent prompt.

### G3 Evidence
Run `node <skill-dir>/scripts/nitbot.mjs evidence` (quick: add `--no-tests`), in the background when the harness supports it. It runs the project's linters, type checker, related tests, secret and SAST scanners when configured, reads diff coverage and CI status, and writes `.nitbot/state/evidence.txt`. Its stdout only says where the file is. Do not open that file yet.

### G4 Reviewer
Spawn the Reviewer sub-agent (`nitbot:nitbot-reviewer` when installed as a plugin, otherwise `nitbot-reviewer`; if neither type exists, a general-purpose sub-agent told to read and follow `<skill-dir>/../../agents/nitbot-reviewer.md`). With several areas, spawn all Reviewers in one message so they run in parallel. Prompt, with paths filled in and nothing else added:

```
Review this change. Inputs (read them yourself):
- run metadata: .nitbot/state/run.json   (files, registers, lenses, rulebooks)
- diff (whole changed functions): .nitbot/state/current.diff
- stated intent, as claims to verify: .nitbot/state/intent.md
- change map: .nitbot/state/map.md
- rulebooks: <skill-dir>/<each path in run.json rulebooks>
- house rules: .nitbot/conventions.md          (only if the CONVENTIONS directive appeared)
- known false positives: .nitbot/dismissed.json (only if the DISMISSED directive appeared)
Your area: <all files | the file list of area N>
<PR rule if PR_NOT_CHECKED_OUT>
Mode: <quick|full>.
```

Do not add your own summary of the change, your opinion of it, why it was written this way, or what to look for. That is exactly the anchoring the sub-agent exists to avoid.

### G5 Evidence read
After every Reviewer has returned, read `.nitbot/state/evidence.txt` (and `evidence.json` only if you need a detail the text omits). Sort it into:
- **Tool facts:** lint, type, and test failures on changed lines; failed CI checks; secret-scanner hits. These are reported as they are, with no Skeptic needed. Never re-derive or re-run them.
- **Needs judgment:** nitbot detector `deferred` findings, type errors outside the diff that may be caused by it, uncovered changed lines. These join the candidates.

### G6 Skeptic (full mode)
Write `.nitbot/state/candidates.json`: the Reviewer findings plus the judgment items, as an array of `{id, severity, title, file, line, scenario}`. Deduplicate first (same file, overlapping lines, same failure). At most 15 candidates, highest severity first; say how many were cut. Spawn the Skeptic (`nitbot:nitbot-skeptic` / `nitbot-skeptic` / general-purpose reading `<skill-dir>/../../agents/nitbot-skeptic.md`):

```
Try to refute each candidate finding.
- candidates: .nitbot/state/candidates.json
- diff: .nitbot/state/current.diff
- run metadata: .nitbot/state/run.json
<PR rule if PR_NOT_CHECKED_OUT>
```

The Skeptic does not get the Reviewer's reasoning or confidence, only the claims.

### G7 Synthesis, save, ask
1. Keep CONFIRMED findings. Keep PLAUSIBLE ones marked `(unverified)`. Drop REFUTED ones and report only their count. The Skeptic's UNDECIDED items become Questions. In quick mode, keep only Reviewer findings that quote the code they rely on.
2. Previous review (`PREVIOUS_REVIEW` directive): for each open finding, check the current diff and mark it fixed or still open. Never pass these to the agents.
3. Apply caps: at most `review.maxFindings` (15) findings and `review.maxNits` (3) nits; state what was cut.
4. Verdict: any P0 → `do-not-ship`; any P1 → `ship-with-fixes`; otherwise `ship`. Failing tests or CI count as P1 unless shown to predate the change.
5. Write the report (format below).
6. Save it: write `.nitbot/state/review.json` as `{verdict, method: "dual"|"quick"|"degraded", gates: ["G1:ok", ...], findings: [{id, severity, title, file, line, scenario, fix, status: "open"}], questions: [...]}` and run `node <skill-dir>/scripts/nitbot.mjs save .nitbot/state/review.json`. If it prints REVIEW_REJECTED, fix the listed fields and run save again.
7. Ask what to do next (last thing in the response). Options: fix all P0/P1, fix selected findings by id, dismiss some as false positives, or nothing now. With `--comment`, add "post these as PR review comments" and post only after an explicit yes (`gh pr review <n> --comment --body-file <file>`, one body listing the findings with file:line).

## Report format

```
Method: dual (Reviewer ×<n> · Skeptic) | quick | ⚠️ DEGRADED: single-context (<reason>)
Gates: G1 ok · G2 ok · G3 ok · G4 ok · G5 ok · G6 ok · G7 ok
Target: <label> · risk <level> · lenses <names>
Verdict: <ship | ship with fixes | do not ship>, <one sentence why>
```

Then, in this order, omitting empty sections:

- **Findings.** One block per finding, highest severity first:
  `N1 [P1] <title>` / `<file>:<line>` / the scenario in one or two sentences / the fix in one sentence / `(unverified)` when PLAUSIBLE.
- **Tool results.** Tool facts from G5, grouped by tool, with file:line. "tsc: clean · eslint: 2 on changed lines · tests: 14 passed".
- **Since last review.** Fixed and still-open findings from the previous run.
- **Questions.** Things the review could not verify, each answerable by the author in a line.
- **Spec check.** From the Reviewer: promises kept, promises not kept, and changed behavior the intent never mentioned.
- **Dropped.** "The Skeptic refuted N findings; M cut by the cap." Counts only.

No praise section, no restating the diff, no generic advice.

## Degraded mode

Only when no sub-agent tool exists, or the user declined sub-agents. Run the same gates in sequence in this session:
1. G3 evidence runs first (its output is still not read).
2. G4: review as the Reviewer brief (`<skill-dir>/../../agents/nitbot-reviewer.md`) describes, and write your findings to `.nitbot/state/review-a.md` before reading anything else.
3. G5: read evidence.
4. G6: for each finding, re-read the cited code with the Skeptic brief and try to refute it. Record the verdict next to the finding.
5. G7 as usual, with the degraded banner as the first line and `method: "degraded"` in the saved review.

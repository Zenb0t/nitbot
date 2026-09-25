# fix

Apply fixes for findings from the latest saved review of the current target.

## Flow

1. Setup has run `nitbot context`. Read the newest file in `.nitbot/reviews/<slug>/` (the slug is in the context output). If there is none, say so and offer `/nitbot review`; stop.
2. Pick the findings: the ids the user named, or "all P0/P1" if they said so. Skip findings already `fixed` or `dismissed`. If the selection is ambiguous, ask once.
3. For each finding, smallest change that removes the failure scenario. Do not refactor around it, do not fix things no finding names, and keep behavior outside the finding unchanged. If a fix needs a decision the review cannot make (an API change, a product choice), stop on that finding and ask.
4. Add or adjust a test that fails without the fix when the finding is about logic and the project has tests for that code.
5. Verify: run `node <skill-dir>/scripts/nitbot.mjs evidence --print`. It re-runs the project's tools on the new diff. Report anything it shows on the lines you changed.
6. Update the review: write the same review JSON with each fixed finding's `status` set to `fixed` and save it with `nitbot save`.
7. Report: one line per finding (fixed / skipped and why), the evidence result, and offer `/nitbot quick` to re-review the fixes with fresh eyes. The session that wrote a fix does not get to declare it correct on its own.

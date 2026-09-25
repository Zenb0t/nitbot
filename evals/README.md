# Evals (plan, not built yet)

nitbot's claims have to be measured, not asserted: that blind review plus a Skeptic is more precise than a single pass, that the lenses find things a checklist does not, and that the token cost is worth it. Every component stays only if an ablation shows it pays.

## Metrics

- **Recall:** share of known bugs the review reports (at P0/P1, at the right file and line ±5).
- **Precision:** share of reported findings a human accepts. The number users feel.
- **Cost:** input, cache, and output tokens per review, from the harness's usage data, per mode.
- **Cost per accepted finding:** the number to optimize.

## Datasets

1. **Seeded bugs.** Small real-world-shaped repos with one planted defect each (off-by-one, missing ownership check, swallowed error, migration without default, retry that double-charges), plus clean controls with no defect. Controls measure false positives.
2. **Your own history (SZZ).** Mine commits whose message says they fix a bug, trace the fixed lines back with `git blame` to the commit that introduced them, and replay nitbot on that introducing commit. Did it flag the lines the fix later changed? This benchmark comes from the code nitbot will actually review.
3. **Human-reviewed PRs.** Merged PRs with review comments: which of nitbot's findings match what humans raised, and which did humans miss that later needed a fix?

## Ablations

Run each dataset with one component removed at a time: Skeptic, lenses (fixed checklist instead), change map, function-context diff, register rulebooks, evidence-before-judgment (evidence shown to the Reviewer up front). Track precision, recall, and cost for each. Remove what does not earn its tokens.

## Models

Run the Reviewer on Opus, Sonnet, and Haiku, and the Skeptic on Sonnet and Haiku, to find the cheapest pairing that holds precision. Test weaker models deliberately: gates exist because they skip steps.
